// Synthetic original files + isolated notes.db only.
const { app } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { createTxtIndexService } = require("../src/utils/main/txt-index-store");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-txt-worker-"));
app.setPath("userData", path.join(temporary, "profile")); app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const report = process.argv[2] || path.join(temporary, "result.json");
let db; const services = [];
app.whenReady().then(async () => {
  const Database = require("better-sqlite3");
  const storage = path.join(temporary, "library"), bookDir = path.join(storage, "book");
  fs.mkdirSync(bookDir, { recursive: true }); fs.mkdirSync(path.join(storage, "config"));
  db = new Database(path.join(storage, "config", "notes.db"));
  db.exec("PRAGMA journal_mode=WAL;CREATE TABLE notes(key TEXT PRIMARY KEY,notes TEXT);INSERT INTO notes VALUES('keep','formal fixture content')");
  let starts = 0, batchHook = async () => {};
  const make = (options = {}) => { const service = createTxtIndexService({ getConnection: () => db, taskOptions: { onWorker: () => starts++, beforeBatch: rows => batchHook(rows), ...options } }); services.push(service); return service; };
  const service = make();
  const request = (bookId = "large", parserRegex = "^Chapter ") => ({ action: "open", dbName: "notes", operation: "txt-index", storagePath: storage, bookId, charset: "utf-8", parserRegex, bookPath: "" });
  const call = (source, action, extra = {}, owner = source.owner || 1, engine = service) => engine({ ...request(), ticket: source.ticket, action, ...extra }, owner);
  const open = async (book = "large", regex = "^Chapter ", owner = 1, engine = service) => ({ ...await engine(request(book, regex), owner), owner });
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (condition, message) => { const until = Date.now() + 15000; while (Date.now() < until) { if (await condition()) return; await pause(10); } throw Error(message); };
  const noBuilding = () => assert.equal(db.prepare("SELECT count(*) n FROM txt_index_generations WHERE state='building'").get().n, 0);
  const active = () => db.prepare("SELECT active_generation g FROM txt_index_documents WHERE book_id='large'").get()?.g;
  let cases = 0, metrics;
  const check = async (name, run) => { await run(); assert.equal(db.prepare("SELECT notes FROM notes WHERE key='keep'").get().notes, "formal fixture content"); console.log("PASS: " + name); cases++; };
  // Write a 100MiB-ish fixture in bounded chunks; never keep the whole file.
  const file = path.join(bookDir, "large.txt"), fd = fs.openSync(file, "w");
  for (let i = 0; i < 7700; i++) fs.writeSync(fd, "Chapter " + (i + 1) + "\r\n" + "x".repeat(13600) + "😀\r\n");
  fs.closeSync(fd);
  fs.writeFileSync(path.join(bookDir, "preview.txt"), Array.from({ length: 300 }, (_, i) => "Chapter " + (i + 1) + "\n正文\n").join(""));
  let baseline, old;
  await check("100MiB cold Worker scan is responsive, batched, metadata-only and atomically ready; hot open starts no Worker", async () => {
    const openBegan = performance.now(); old = await open(); const coldOpenMs = performance.now() - openBegan;
    let ticks = 0, maximumGap = 0, previous = performance.now();
    const heartbeat = setInterval(() => { const now = performance.now(); maximumGap = Math.max(maximumGap, now - previous); previous = now; ticks++; }, 10);
    const began = performance.now();
    try { baseline = (await call(old, "prepare")).index; } finally { clearInterval(heartbeat); }
    const coldPrepareMs = performance.now() - began;
    assert.equal(baseline.chapters.length, 7700); assert.equal(starts, 1); assert(ticks > 2);
    assert.equal(JSON.stringify(baseline).includes("x".repeat(100)), false);
    noBuilding();
    const warmBegan = performance.now(), warm = await open(), warmOpenMs = performance.now() - warmBegan; assert(warm.cacheHit); assert.equal(warm.buffer, undefined); assert.equal(starts, 1);
    metrics = { bytes: fs.statSync(file).size, chapters: baseline.chapters.length, coldOpenMs: Math.round(coldOpenMs), coldPrepareMs: Math.round(coldPrepareMs), warmOpenMs: Math.round(warmOpenMs), mainHeartbeatTicks: ticks, maximumMainHeartbeatGapMs: Math.round(maximumGap * 10) / 10, warmWorkerStarts: 0 };
    await call(warm, "close");
  });
  // Subsequent fault tests use a small original, with a legitimate old ready index.
  fs.writeFileSync(file, "Chapter 1\r\n正文😀\r\nChapter 2\n末尾\n");
  const fresh = await open(); baseline = (await call(fresh, "prepare")).index; await call(fresh, "close");
  await check("same-book windows share one Worker; closing one consumer preserves the other; temporary preview cannot annotate", async () => {
    let release; const held = new Promise(r => release = r); let entered = false;
    batchHook = async () => { entered = true; await held; };
    const a = await open(), b = await open("large", "^Chapter ", 2); const count = starts;
    const pa = call(a, "prepare"); const rejected = assert.rejects(pa, /cancelled/);
    const pb = call(b, "prepare");
    await wait(() => entered, "batch not reached");
    assert.equal(starts, count + 1);
    await call(a, "close"); await rejected; release();
    const result = await pb;
    assert.equal((await call(b, "read-directory")).generation, active()); assert.equal(result.index.chapters.length, 2);
    await call(b, "close"); batchHook = async () => {}; noBuilding();
  });
  await check("first finalized range is readable before ready and is rejected as a formal anchor", async () => {
    let release; const held = new Promise(r => release = r); let batches = 0;
    batchHook = async () => { if (++batches === 2) await held; };
    const source = await open("preview");
    const job = call(source, "prepare");
    await wait(async () => (await call(source, "build-status")).canPreview, "preview missing");
    const text = new TextDecoder().decode((await call(source, "read-preview")).buffer);
    assert(text.includes("正文")); assert.equal(db.prepare("SELECT active_generation FROM txt_index_documents WHERE book_id='preview'").get(), undefined);
    await assert.rejects(() => service.describeChapter(1, source.ticket, 0, "not-ready", false), /unavailable/);
    await assert.rejects(() => call(source, "read-directory"), /unavailable/);
    release(); await job; await call(source, "close"); batchHook = async () => {}; noBuilding();
  });
  await check("last-consumer cancel aborts Worker and discards building rows while retaining the old index", async () => {
    let release; const held = new Promise(r => release = r); let entered = false;
    batchHook = async () => { entered = true; await held; };
    const source = await open(), previous = active(), job = call(source, "prepare"), rejected = assert.rejects(job, /cancelled/);
    await wait(() => entered, "cancel batch not reached");
    await call(source, "cancel-build"); await rejected; release();
    await wait(() => db.prepare("SELECT count(*) n FROM txt_index_generations WHERE state='building'").get().n === 0, "cancel cleanup missing");
    assert.equal(active(), previous); await call(source, "close"); batchHook = async () => {};
  });
  await check("file replacement during indexing fails without publishing or deleting old data", async () => {
    let release; const held = new Promise(r => release = r); let entered = false;
    batchHook = async () => { entered = true; await held; };
    const source = await open(), previous = active(), job = call(source, "prepare"), rejected = assert.rejects(job, /changed/);
    await wait(() => entered, "replacement batch not reached"); fs.appendFileSync(file, "\nchanged"); release(); await rejected;
    assert.equal(active(), previous); noBuilding(); await call(source, "close"); batchHook = async () => {};
    const rebuilt = await open(); baseline = (await call(rebuilt, "prepare")).index; await call(rebuilt, "close");
  });
  await check("Worker crash and invalid bytes leave no half index", async () => {
    const crashing = make({ onWorker: worker => { starts++; setTimeout(() => worker.terminate(), 1); } });
    const source = await open("large", "^Chapter ", 1, crashing), previous = active();
    await assert.rejects(() => call(source, "prepare", {}, 1, crashing), /exited/); assert.equal(active(), previous); noBuilding();
    fs.writeFileSync(path.join(bookDir, "invalid.txt"), Buffer.from([0xf0, 0x9f]));
    const invalid = await open("invalid"); await assert.rejects(() => call(invalid, "prepare"), /encoded|encoding|valid/i); noBuilding();
  });
  await check("pathological regex is terminated by the watchdog while main remains responsive", async () => {
    fs.writeFileSync(path.join(bookDir, "regex.txt"), "a".repeat(20000) + "!");
    const guarded = make({ stallTimeoutMs: 300 });
    const source = await open("regex", "(a+)+$", 1, guarded);
    let ticks = 0; const heartbeat = setInterval(() => ticks++, 10);
    try { await assert.rejects(() => call(source, "prepare", {}, 1, guarded), /timed out/); } finally { clearInterval(heartbeat); }
    assert(ticks > 5); noBuilding();
  });
  await check("slow metadata consumption is bounded and does not trigger a CPU watchdog while waiting for acknowledgement", async () => {
    const slow = make({ stallTimeoutMs: 500, beforeBatch: async rows => { assert(rows.length <= 128); await pause(750); } });
    const source = await open("large", "^Chapter ", 1, slow);
    await call(source, "prepare", {}, 1, slow); noBuilding();
  });
  await check("batch SQL failure rolls back building work and preserves the active generation", async () => {
    const source = await open(), previous = active();
    db.exec("CREATE TRIGGER fail_worker BEFORE INSERT ON txt_index_chapters BEGIN SELECT RAISE(ABORT,'worker fixture failure'); END");
    try { await assert.rejects(() => call(source, "prepare"), /fixture failure/); } finally { db.exec("DROP TRIGGER fail_worker"); }
    assert.equal(active(), previous); noBuilding(); await call(source, "close");
  });
  await check("concurrent winner cannot be overwritten by late Worker publication", async () => {
    let release; const held = new Promise(r => release = r); let entered = false;
    batchHook = async () => { entered = true; await held; };
    const source = await open(), competitor = await open(), job = call(source, "prepare");
    const rejected = assert.rejects(job, /concurrently/);
    await wait(() => entered, "CAS batch not reached");
    await call(competitor, "commit", { index: baseline }); const winner = active(); release(); await rejected;
    assert.equal(active(), winner); noBuilding(); batchHook = async () => {};
  });
  await check("orphan building generations from an interrupted process are removed without affecting ready data", async () => {
    db.prepare("INSERT INTO txt_index_generations VALUES('large','orphan','building','{}','{}','orphan',0)").run();
    const source = await open(); await call(source, "prepare"); noBuilding();
  });
  await check("range reads use async handles and reject changed sources", async () => {
    const source = await open(), chapter = source.index.chapters[0], original = fs.readSync;
    fs.readSync = () => { throw Error("synchronous source read"); };
    try { assert((await call(source, "read-chapter", { chapterId: chapter.chapterId, chapterIndex: 0, offset: 0, length: 4 })).buffer.length === 4); } finally { fs.readSync = original; }
    fs.appendFileSync(file, "!"); await assert.rejects(() => call(source, "read-chapter", { chapterId: chapter.chapterId, chapterIndex: 0, offset: 0, length: 4 }), /changed/);
  });
  await check("renderer destruction cancels its last consumer and removes staged work", async () => {
    let release; const gate = new Promise(resolve => release = resolve); let entered = false;
    batchHook = async () => { entered = true; await gate; };
    const source = await open("preview", "^Chapter ", 99), job = call(source, "prepare");
    const rejected = assert.rejects(job, /cancelled/);
    await wait(() => entered, "owner release batch missing"); service.releaseOwner(99); await rejected; release();
    await wait(() => db.prepare("SELECT count(*) n FROM txt_index_generations WHERE state='building'").get().n === 0, "owner cleanup missing");
    batchHook = async () => {};
  });
  await check("late async batch callbacks cannot write orphan chapters after a Worker failure", async () => {
    let release, worker, entered = false; const gate = new Promise(resolve => release = resolve);
    const interrupted = make({ onWorker: w => { worker = w; starts++; }, beforeBatch: async () => { entered = true; await gate; } });
    const source = await open("preview", "^Chapter ", 1, interrupted), job = call(source, "prepare", {}, 1, interrupted);
    const rejected = assert.rejects(job, /exited/);
    await wait(() => entered, "late batch fixture missing"); await worker.terminate(); await rejected; release(); await pause(30);
    noBuilding();
    assert.equal(db.prepare("SELECT count(*) n FROM txt_index_chapters c WHERE NOT EXISTS(SELECT 1 FROM txt_index_generations g WHERE g.book_id=c.book_id AND g.generation=c.generation)").get().n, 0);
  });
  await check("custom regex line limits fail explicitly instead of buffering an unbounded line", async () => {
    fs.writeFileSync(path.join(bookDir, "long-line.txt"), "正文".repeat(40000));
    const source = await open("long-line", "^Chapter ");
    await assert.rejects(() => call(source, "prepare"), /custom parser line exceeds/); noBuilding();
  });
  await check("owner destruction while async open is pending cannot register a late source ticket", async () => {
    const pending = open("preview", "^Chapter ", 101);
    service.releaseOwner(101);
    await assert.rejects(pending, /closed while opening/);
    const reopened = await open("preview", "^Chapter ", 101); await call(reopened, "close");
  });
  await check("packaged ASAR resources resolve the Worker and pure scanner without source-tree dependencies", async () => {
    const asar = require("@electron/asar"), resources = path.join(temporary, "resources"), archive = path.join(temporary, "app.asar");
    fs.mkdirSync(resources);
    for (const name of ["txt-index-worker.js", "txt-source.js", "txt-scanner.cjs"])
      fs.copyFileSync(path.join(__dirname, "../src/utils/main", name), path.join(resources, name));
    await asar.createPackage(resources, archive);
    const packaged = make({ workerPath: path.join(archive, "txt-index-worker.js") });
    const source = await open("preview", "^Chapter ", 1, packaged);
    const result = await call(source, "prepare", {}, 1, packaged);
    assert.equal(result.index.chapters.length, 300); noBuilding();
    assert(require("../package.json").build.files.includes("src/utils/main/**/*.cjs"));
  });
  for (const s of services) s.shutdown();
  fs.writeFileSync(report, JSON.stringify({ passed: true, cases, metrics, userDatabaseOpened: false }, null, 2));
  console.log(JSON.stringify({ passed: true, cases, metrics })); db.close(); app.exit(0);
}).catch(error => { console.error(error); for (const s of services) s.shutdown(); fs.writeFileSync(report, JSON.stringify({ passed: false, error: error.message })); if (db?.open) db.close(); app.exit(1); });
