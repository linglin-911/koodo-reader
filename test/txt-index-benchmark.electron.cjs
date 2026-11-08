// Legacy phase-3 in-process adapter benchmark. Stage 6 normal Worker measurements
// live in txt-index-worker.electron.cjs; this adapter deliberately exercises read-source.
// Synthetic benchmark only. Usage: electron.exe test/txt-index-benchmark.electron.cjs <kookit-source> <report.json>
// Never opens user storage or submits synthetic body text to Git.
const { app } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "koodo-txt-benchmark-")
);
app.setPath("userData", path.join(temporary, "profile"));
app.disableHardwareAcceleration();
const sourceRoot = process.argv[2],
  reportPath = process.argv[3] || path.join(temporary, "result.json");
app
  .whenReady()
  .then(async () => {
    assert.ok(sourceRoot, "Pass the Kookit source repository path");
    const Database = require("better-sqlite3");
    const {
      createTxtIndexService,
    } = require("../src/utils/main/txt-index-store");
    const createLoader = require(
      path.join(sourceRoot, "test/helpers/load-typescript.cjs")
    );
    const silent = {
      beginDiagnostic: () => () => {},
      diagnosticError: () => {},
      diagnosticLog: () => {},
    };
    const actual = createLoader({ "../utils/diagnostics": silent })(
      path.join(sourceRoot, "src/libs/txtIndex.ts")
    );
    let scans = 0;
    const TxtRender = createLoader({
      "./GeneralRender": class {},
      "../utils/layoutUtil": {},
      "../libs/cache.js": {},
      "../utils/generalParser": {},
      "../utils/diagnostics": silent,
      "../libs/txtIndex": {
        ...actual,
        buildPersistentTxtIndex: (...args) => {
          scans++;
          return actual.buildPersistentTxtIndex(...args);
        },
      },
    })(path.join(sourceRoot, "src/renders/TxtRender.ts")).default;
    const results = [];
    const count = 7700;
    for (const targetBytes of [76083283, 100 * 1024 * 1024]) {
      const storage = path.join(temporary, String(targetBytes));
      fs.mkdirSync(path.join(storage, "book"), { recursive: true });
      fs.mkdirSync(path.join(storage, "config"));
      const sourceFile = path.join(storage, "book", "synthetic.txt");
      // ~50 lines per chapter in the smaller fixture, mixed UTF-8 and CRLF.
      const line = Buffer.from("合成测试正文甲乙丙丁".repeat(6) + "😀\r\n");
      let content = Buffer.alloc(targetBytes, 120);
      for (let i = 0; i < count; i++) {
        const start = Math.floor((i * targetBytes) / count),
          end = Math.floor(((i + 1) * targetBytes) / count);
        const header = Buffer.from(`Chapter ${i + 1}\r\n`);
        header.copy(content, start);
        let offset = start + header.length;
        while (offset + line.length <= end - 2) {
          line.copy(content, offset);
          offset += line.length;
        }
        content.write("\r\n", end - 2, "ascii");
      }
      fs.writeFileSync(sourceFile, content);
      content = null;
      const db = new Database(path.join(storage, "config", "notes.db"));
      db.pragma("journal_mode=WAL");
      db.exec("CREATE TABLE notes(key TEXT PRIMARY KEY)");
      const service = createTxtIndexService({ getConnection: () => db });
      const request = {
        operation: "txt-index",
        action: "open",
        dbName: "notes",
        storagePath: storage,
        bookId: "synthetic",
        bookPath: "",
        charset: "utf-8",
        parserRegex: "^Chapter \\d+",
      };
      const record = { synthetic: true, bytes: targetBytes, sections: count };
      const coldScanStart = scans;
      try {
        for (const phase of ["cold", "hot"]) {
          const phaseScans = scans;
          const started = performance.now();
          const opened = await service(request, 1);
          const openMs = performance.now() - started;
          let commitDiagnostics = null,
            sourceReads = 0,
            bodyBytes = 0;
          const readChapters = [];
          const config = {
            charset: opened.encoding,
            parserRegex: request.parserRegex,
            txtIndexStore: {
              load: async (force) => (force ? null : opened.index),
              readSource: async () => {
                sourceReads++;
                const result = await service(
                  { ...request, action: "read-source", ticket: opened.ticket },
                  1
                );
                return result.buffer;
              },
              readChapter: async (chapter) => {
                readChapters.push(chapter.index);
                const decoder = new TextDecoder(opened.encoding, {
                  fatal: true,
                  ignoreBOM: true,
                });
                const parts = [];
                for (
                  let offset = 0;
                  offset < chapter.byteEnd - chapter.byteStart;
                ) {
                  const length = Math.min(
                    256 * 1024,
                    chapter.byteEnd - chapter.byteStart - offset
                  );
                  const result = await service(
                    {
                      ...request,
                      action: "read-chapter",
                      ticket: opened.ticket,
                      chapterIndex: chapter.index,
                      chapterId: chapter.chapterId,
                      offset,
                      length,
                    },
                    1
                  );
                  bodyBytes += result.buffer.byteLength;
                  parts.push(decoder.decode(result.buffer, { stream: true }));
                  offset += length;
                }
                parts.push(decoder.decode());
                return parts.join("").replace(/\r\n?/g, "\n");
              },
              save: async (index) => {
                const committed = await service(
                  {
                    operation: "txt-index",
                    action: "commit",
                    dbName: "notes",
                    storagePath: storage,
                    ticket: opened.ticket,
                    index,
                  },
                  1
                );
                scans++;
                commitDiagnostics = committed.diagnostics;
              },
            },
          };
          const renderer = new TxtRender(new ArrayBuffer(0), config);
          const parseStarted = performance.now();
          await renderer.parse();
          const parseMs = performance.now() - parseStarted;
          assert.equal(renderer.book.sections.length, count);
          const jumps = [];
          for (const chapter of [1, 1600, 6800]) {
            const at = performance.now(),
              url = await renderer.book.sections[chapter - 1].load();
            try {
              const html = await (await fetch(url)).text();
              assert.ok(html.includes(`Chapter ${chapter}`));
            } finally {
              URL.revokeObjectURL(url);
            }
            jumps.push({ chapter, htmlAndBlobMs: performance.now() - at });
          }
          record[phase] = {
            cacheHit: opened.cacheHit,
            openMs,
            parseMs,
            wholeSourceReads: sourceReads,
            retainedSourceBytes: renderer.txtBuffer.byteLength,
            bodyBytes,
            readChapters,
            chapterScans: scans - phaseScans,
            totalChapterScans: scans - coldScanStart,
            ...opened.diagnostics,
            ...commitDiagnostics,
            jumps,
            memory: process.memoryUsage(),
          };
          assert.equal(opened.cacheHit, phase === "hot");
          assert.equal(sourceReads, phase === "hot" ? 0 : 1);
          assert.equal(renderer.txtBuffer.byteLength, 0);
          assert.deepEqual(readChapters, [0, 1599, 6799]);
          renderer.book.destroy();
          await service(
            { ...request, action: "close", ticket: opened.ticket },
            1
          );
          assert.equal(
            scans - coldScanStart,
            1,
            "Hot open must not scan chapter headings"
          );
        }
      } finally {
        db.close();
      }
      results.push(record);
      console.log(JSON.stringify(record));
    }
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          passed: true,
          synthetic: true,
          electron: process.versions.electron,
          userDatabaseOpened: false,
          results,
        },
        null,
        2
      )
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ passed: false, error: error.message })
    );
    app.exit(1);
  });
