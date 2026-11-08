// Isolated synthetic legacy indexes only. Formal entities are never disposable.
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'koodo-txt-checkpoints-'));
app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
const report = process.argv[2] || path.join(temporary, 'result.json');
let db, service;
app.whenReady().then(async () => {
  const Database = require('better-sqlite3');
  const { createTxtIndexService } = require('../src/utils/main/txt-index-store');
  const { createAnnotationService } = require('../src/utils/main/annotation-store');
  const storage = path.join(temporary, 'library');
  fs.mkdirSync(path.join(storage, 'book'), { recursive: true }); fs.mkdirSync(path.join(storage, 'config'));
  db = new Database(path.join(storage, 'config', 'notes.db'));
  db.exec('CREATE TABLE notes(key TEXT PRIMARY KEY,notes TEXT)');
  let workers = 0, hook = async () => {};
  service = createTxtIndexService({ getConnection: () => db, taskOptions: { onWorker: () => workers++, beforeBatch: rows => hook(rows) } });
  const annotations = createAnnotationService({ getConnection: () => db, describeTxt: (...args) => service.describeChapter(...args), loadRegistry: async () => ({}), Database });
  const base = { dbName: 'notes', storagePath: storage, charset: 'utf-8', parserRegex: '', bookPath: '' };
  const call = (source, action, owner = source.owner || 1) => service({ ...base, ticket: source.ticket, action }, owner);
  const open = async (bookId, owner = 1) => ({ ...await service({ ...base, action: 'open', bookId }, owner), owner });
  const legacy = async bookId => {
    fs.writeFileSync(path.join(storage, 'book', bookId + '.txt'), Array.from({ length: 60 }, (_, i) => 'Chapter ' + (i + 1) + '\r\n' + '正文😀 &<>\n'.repeat(80)).join(''));
    const source = await open(bookId), index = (await call(source, 'prepare')).index;
    const directory = await call(source, 'read-directory');
    db.prepare("UPDATE txt_index_generations SET index_json=json_remove(index_json,'$.checkpoints') WHERE book_id=? AND generation=?").run(bookId, directory.generation);
    return { source, index, directory };
  };
  const formal = () => JSON.stringify(['notes', 'note_bindings', 'chapter_bindings', 'range_bindings'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()));
  const cache = bookId => JSON.stringify(['txt_index_documents', 'txt_index_generations', 'txt_index_chapters'].map(table => db.prepare('SELECT * FROM ' + table + " WHERE book_id=? AND " + (table === 'txt_index_generations' ? "state='ready'" : '1') + ' ORDER BY rowid').all(bookId)));
  const noBuilding = () => assert.equal(db.prepare("SELECT count(*) n FROM txt_index_generations WHERE state='building'").get().n, 0);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async condition => { const until = Date.now() + 10000; while (!condition()) { if (Date.now() > until) throw Error('Worker checkpoint batch not reached'); await pause(10); } };
  let cases = 0; const check = async (name, run) => { await run(); cases++; noBuilding(); console.log('PASS: ' + name); };
  const original = await legacy('preserved');
  const note = await annotations({ ...base, action: 'create', note: { bookKey: 'preserved', kind: 'small', notes: 'PROTECTED FORMAL CONTENT', tag: [] }, binding: { format: 'TXT', sourceTicket: original.source.ticket, chapterIndex: 0, chapterId: original.index.chapters[0].chapterId, start: 0, end: 5 } }, 1);
  const beforeFormal = formal(), beforeDirectory = JSON.stringify(original.directory);
  const beforeRevision = JSON.stringify(db.prepare("SELECT active_generation,document_revision FROM txt_index_documents WHERE book_id='preserved'").get());
  await check('one legacy scan appends checkpoints and preserves chapter IDs, generation, revision and all formal entities verbatim', async () => {
    const count = workers, result = await call(original.source, 'ensure-blocks');
    assert(result.index.checkpoints.length > 1); assert.equal(workers, count + 1);
    assert.deepEqual(result.index.chapters, original.index.chapters);
    assert.equal(formal(), beforeFormal); assert.equal(JSON.stringify(await call(original.source, 'read-directory')), beforeDirectory);
    assert.equal(JSON.stringify(db.prepare("SELECT active_generation,document_revision FROM txt_index_documents WHERE book_id='preserved'").get()), beforeRevision);
    assert.equal((await annotations({ ...base, action: 'get', key: note.key }, 1)).bindings[0].status, 'active');
  });
  await check('repeated ensure and a hot reopen read cached checkpoints without any Worker scan', async () => {
    const count = workers; assert.equal((await call(original.source, 'ensure-blocks')).diagnostics.workerScans, 0);
    const hot = await open('preserved'); assert(hot.cacheHit && hot.index.checkpoints); await call(hot, 'ensure-blocks');
    assert.equal(workers, count); await call(hot, 'close');
  });
  await check('foreign tickets cannot trigger metadata upgrades', async () => { await assert.rejects(call(original.source, 'ensure-blocks', 99)); });
  await check('two readers share the upgrade, and closing one preserves the surviving reader and the old generation', async () => {
    const current = await legacy('shared'), other = await open('shared', 2); let release, entered = false;
    const held = new Promise(resolve => release = resolve); hook = async () => { entered = true; await held; };
    const count = workers, first = call(current.source, 'ensure-blocks'), rejection = assert.rejects(first, /cancelled/), second = call(other, 'ensure-blocks');
    await wait(() => entered); await call(current.source, 'close'); await rejection; release();
    const result = await second; hook = async () => {};
    assert.equal(workers, count + 1); assert(result.index.checkpoints); assert.equal((await call(other, 'read-directory')).generation, current.directory.generation); await call(other, 'close');
  });
  await check('last consumer cancellation discards only temporary rows, preserves the old cache and can retry', async () => {
    const current = await legacy('cancel'), before = cache('cancel'); let release, entered = false;
    const held = new Promise(resolve => release = resolve); hook = async () => { entered = true; await held; };
    const job = call(current.source, 'ensure-blocks'), rejection = assert.rejects(job, /cancelled/);
    await wait(() => entered); await call(current.source, 'cancel-build'); await rejection; release(); hook = async () => {};
    await wait(() => db.prepare("SELECT count(*) n FROM txt_index_generations WHERE state='building'").get().n === 0);
    assert.equal(cache('cancel'), before); assert.equal(formal(), beforeFormal);
    assert((await call(current.source, 'ensure-blocks')).index.checkpoints); await call(current.source, 'close');
  });
  await check('chapter snapshot mismatch refuses the upgrade instead of rotating IDs or invalidating bindings', async () => {
    const current = await legacy('mismatch'); db.prepare("UPDATE txt_index_chapters SET name='Different snapshot' WHERE book_id='mismatch' AND chapter_index=0").run();
    const before = cache('mismatch'); await assert.rejects(call(current.source, 'ensure-blocks'), /does not match/);
    assert.equal(cache('mismatch'), before); assert.equal(formal(), beforeFormal); await call(current.source, 'close');
  });
  await check('SQL publication failure rolls back checkpoint-only updates and preserves all old data', async () => {
    const current = await legacy('sql-fail'), before = cache('sql-fail');
    db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF index_json ON txt_index_generations WHEN OLD.book_id='sql-fail' BEGIN SELECT RAISE(ABORT,'synthetic checkpoint failure'); END");
    await assert.rejects(call(current.source, 'ensure-blocks'), /synthetic checkpoint failure/); db.exec('DROP TRIGGER fail_checkpoint');
    assert.equal(cache('sql-fail'), before); assert.equal(formal(), beforeFormal); await call(current.source, 'close');
  });
  await check('active generation CAS loss cannot publish into a retired snapshot', async () => {
    const current = await legacy('cas'); let release, entered = false;
    const held = new Promise(resolve => release = resolve); hook = async () => { entered = true; await held; };
    const job = call(current.source, 'ensure-blocks'), rejection = assert.rejects(job, /changed while/);
    await wait(() => entered); await call(current.source, 'invalidate'); release(); await rejection; hook = async () => {};
    assert.equal(db.prepare("SELECT json_type(index_json,'$.checkpoints') present FROM txt_index_generations WHERE book_id='cas' AND state='ready'").get().present, null);
    assert.equal(formal(), beforeFormal); await call(current.source, 'close');
  });
  await check('a changed source fails before checkpoint publication and retains the ready index and formal data', async () => {
    const current = await legacy('changed'), before = cache('changed'); let release, entered = false;
    const held = new Promise(resolve => release = resolve); hook = async () => { entered = true; await held; };
    const job = call(current.source, 'ensure-blocks'), rejection = assert.rejects(job, /changed/);
    await wait(() => entered); fs.appendFileSync(path.join(storage, 'book', 'changed.txt'), '\nchanged'); release(); await rejection; hook = async () => {};
    assert.equal(cache('changed'), before); assert.equal(formal(), beforeFormal); await call(current.source, 'close');
  });
  await call(original.source, 'close'); service.shutdown(); db.close();
  fs.writeFileSync(report, JSON.stringify({ passed: true, cases, userDatabaseOpened: false, nativeSqlite: true }, null, 2)); app.exit(0);
}).catch(error => { console.error(error); fs.writeFileSync(report, JSON.stringify({ passed: false, error: error.message })); service?.shutdown(); if (db?.open) db.close(); app.exit(1); });
