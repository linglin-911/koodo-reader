// Run with Electron, never against a real profile or user database.
const { app, BrowserWindow, ipcMain } = require("electron");
app.disableHardwareAcceleration();
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const {
  createTxtIndexService,
  ensureSchema,
  CONTRACT,
} = require("../src/utils/main/txt-index-store");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-txt-index-"));
app.setPath("userData", path.join(temporary, "profile"));
const reportPath = process.argv[2] || path.join(temporary, "result.json");
app
  .whenReady()
  .then(async () => {
    const Database = require("better-sqlite3");
    const connections = new Map();
    const getConnection = (storage) => {
      const file = path.join(storage, "config", "notes.db");
      if (!connections.has(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const db = new Database(file);
        db.pragma("journal_mode=WAL");
        db.exec(
          "CREATE TABLE IF NOT EXISTS notes(key TEXT PRIMARY KEY,notes TEXT); INSERT OR IGNORE INTO notes VALUES('keep','protected fixture')"
        );
        connections.set(file, db);
      }
      return connections.get(file);
    };
    let service = createTxtIndexService({ getConnection });
    const storage = path.join(temporary, "library");
    const bookDir = path.join(storage, "book");
    fs.mkdirSync(bookDir, { recursive: true });
    const file = path.join(bookDir, "book-1.txt");
    const source = "第一章\r\n正文甲😀\r\n第二章\r正文乙𠀀\n";
    fs.writeFileSync(file, source);
    const request = {
      action: "open",
      operation: "txt-index",
      dbName: "notes",
      storagePath: storage,
      bookId: "book-1",
      bookPath: "",
      charset: "utf-8",
      parserRegex: "",
    };
    const fixture = () => {
      const text = source.replace(/\r\n?/g, "\n");
      const split = text.indexOf("第二章"),
        rawSplit = source.indexOf("第二章");
      const chapters = [
        {
          start: 0,
          end: split - 1,
          bodyStart: 4,
          rawStart: 0,
          rawEnd: rawSplit - 2,
          rawBody: 5,
          label: "第一章",
        },
        {
          start: split,
          end: text.length,
          bodyStart: split + 4,
          rawStart: rawSplit,
          rawEnd: source.length,
          rawBody: rawSplit + 4,
          label: "第二章",
        },
      ].map((c, i) => ({
        index: i,
        label: c.label,
        start: c.start,
        end: c.end,
        bodyStart: c.bodyStart,
        byteStart: Buffer.byteLength(source.slice(0, c.rawStart)),
        byteEnd: Buffer.byteLength(source.slice(0, c.rawEnd)),
        bodyByteStart: Buffer.byteLength(source.slice(0, c.rawBody)),
        chapterId: `chapter-${i}`,
        firstChars: "正文",
        lastChars: i ? "乙𠀀" : "甲😀",
        recognition: "heading",
        hasTitle: true,
        fixedChunk: false,
        lineCount: i ? 3 : 2,
        size: 100,
      }));
      return {
        contract: { ...CONTRACT },
        encoding: "utf-8",
        bomBytes: 0,
        textLength: text.length,
        byteLength: Buffer.byteLength(source),
        lineCount: 5,
        mode: "chapter-headings",
        chapters,
      };
    };
    let passed = 0;
    const check = async (name, body) => {
      await body();
      passed++;
      console.log(`PASS: ${name}`);
    };
    const commit = (opened, index = fixture(), owner = 1) =>
      service(
        {
          action: "commit",
          operation: "txt-index",
          dbName: "notes",
          storagePath: storage,
          ticket: opened.ticket,
          index,
        },
        owner
      );
    const db = getConnection(storage);
    let cold, firstGeneration;
    try {
      await check(
        "transactional v1 migration preserves legacy notes and user_version",
        async () => {
          await ensureSchema(db);
          await ensureSchema(db);
          assert.equal(
            db.prepare("SELECT version FROM txt_index_schema").get().version,
            1
          );
          assert.equal(
            db.prepare("SELECT notes FROM notes WHERE key='keep'").get().notes,
            "protected fixture"
          );
          assert.equal(db.pragma("user_version", { simple: true }), 0);
          const backupName = fs
            .readdirSync(path.join(storage, "config"))
            .find((name) => name.includes("pre-txt-index-v1"));
          assert.ok(backupName);
          const backup = new Database(
            path.join(storage, "config", backupName),
            { readonly: true }
          );
          try {
            assert.equal(
              backup.prepare("SELECT notes FROM notes WHERE key='keep'").get()
                .notes,
              "protected fixture"
            );
            assert.equal(
              backup
                .prepare(
                  "SELECT count(*) AS n FROM sqlite_master WHERE name='txt_index_schema'"
                )
                .get().n,
              0
            );
          } finally {
            backup.close();
          }
        }
      );
      await check(
        "failed migration rolls back all new schema changes",
        async () => {
          const broken = new Database(":memory:");
          try {
            broken.exec("CREATE TABLE txt_index_chapters(dummy)");
            await assert.rejects(() => ensureSchema(broken));
            assert.equal(
              broken
                .prepare(
                  "SELECT count(*) AS n FROM sqlite_master WHERE name='txt_index_schema'"
                )
                .get().n,
              0
            );
            assert.equal(
              broken
                .prepare(
                  "SELECT count(*) AS n FROM sqlite_master WHERE name='txt_index_documents'"
                )
                .get().n,
              0
            );
          } finally {
            broken.close();
          }
        }
      );
      await check(
        "cold open reads actual TXT once, commits all chapters and activates ready generation",
        async () => {
          cold = await service(request, 1);
          assert.equal(cold.cacheHit, false);
          assert.equal(Buffer.from(cold.buffer).toString(), source);
          firstGeneration = (await commit(cold)).generation;
          assert.equal(
            db
              .prepare("SELECT active_generation FROM txt_index_documents")
              .get().active_generation,
            firstGeneration
          );
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM txt_index_chapters").get().n,
            2
          );
          assert.equal(
            db.prepare("SELECT state FROM txt_index_generations").get().state,
            "ready"
          );
        }
      );
      await check(
        "new service and reopened connection load identical SQLite coordinates on hot open",
        async () => {
          db.close();
          connections.clear();
          service = createTxtIndexService({ getConnection });
          cold = await service(request, 1);
          assert.equal(cold.cacheHit, true);
          assert.deepEqual(cold.index, fixture());
        }
      );
      await check(
        "changed parsing config, encoding or contract never reuses old offsets",
        async () => {
          assert.equal(
            (await service({ ...request, parserRegex: "^CHAPTER" }, 2))
              .cacheHit,
            false
          );
          assert.equal(
            (await service({ ...request, charset: "gbk" }, 2)).cacheHit,
            false
          );
          const d = getConnection(storage);
          const row = d
            .prepare(
              "SELECT metadata_json FROM txt_index_generations WHERE generation=?"
            )
            .get(firstGeneration);
          const meta = JSON.parse(row.metadata_json);
          meta.contract.parserVersion++;
          d.prepare(
            "UPDATE txt_index_generations SET metadata_json=? WHERE generation=?"
          ).run(JSON.stringify(meta), firstGeneration);
          assert.equal((await service(request, 2)).cacheHit, false);
          d.prepare(
            "UPDATE txt_index_generations SET metadata_json=? WHERE generation=?"
          ).run(row.metadata_json, firstGeneration);
        }
      );
      await check(
        "same-size changes with preserved mtime invalidate cache; failed rebuild retains active index",
        async () => {
          const before = fs.statSync(file);
          const opened = await service(request, 1);
          fs.writeFileSync(file, source.replace("甲", "丙"));
          fs.utimesSync(file, before.atime, before.mtime);
          const changed = await service(request, 2);
          assert.equal(changed.cacheHit, false);
          assert.equal(changed.index, null);
          await assert.rejects(() => commit(opened), /changed/);
          assert.equal(
            getConnection(storage)
              .prepare("SELECT active_generation FROM txt_index_documents")
              .get().active_generation,
            firstGeneration
          );
          fs.writeFileSync(file, source);
        }
      );
      await check(
        "actual library file has priority; external fallback path has separate identity",
        async () => {
          const external = path.join(temporary, "external.txt");
          fs.writeFileSync(external, source.replace("甲", "丙"));
          const library = await service({ ...request, bookPath: external }, 1);
          assert.equal(Buffer.from(library.buffer).toString(), source);
          await commit(library);
          const moved = path.join(bookDir, "held.txt");
          fs.renameSync(file, moved);
          const fallback = await service({ ...request, bookPath: external }, 2);
          assert.equal(fallback.cacheHit, false);
          assert.equal(
            Buffer.from(fallback.buffer).toString(),
            source.replace("甲", "丙")
          );
          fs.renameSync(moved, file);
        }
      );
      await check(
        "malformed coordinates and foreign tickets are rejected before writing",
        async () => {
          const opened = await service(request, 1);
          await assert.rejects(() => commit(opened, fixture(), 999), /foreign/);
          const index = fixture();
          index.chapters[0].bodyByteStart = index.byteLength + 1;
          await assert.rejects(() => commit(opened, index), /coordinates/);
          await assert.rejects(
            () => service({ ...request, bookId: "../escape" }, 1),
            /Invalid/
          );
          await assert.rejects(
            () => service({ ...request, dbName: "books" }, 1),
            /Invalid/
          );
        }
      );
      await check(
        "SQL batch failure rolls back generation, chapter rows and active pointer",
        async () => {
          const d = getConnection(storage);
          const opened = await service(request, 1);
          const before = d
            .prepare("SELECT active_generation FROM txt_index_documents")
            .get().active_generation;
          const count = d
            .prepare("SELECT count(*) AS n FROM txt_index_generations")
            .get().n;
          d.exec(
            "CREATE TRIGGER fail_batch BEFORE INSERT ON txt_index_chapters WHEN NEW.chapter_index=1 BEGIN SELECT RAISE(ABORT,'injected failure'); END"
          );
          await assert.rejects(() => commit(opened), /injected failure/);
          d.exec("DROP TRIGGER fail_batch");
          assert.equal(
            d.prepare("SELECT active_generation FROM txt_index_documents").get()
              .active_generation,
            before
          );
          assert.equal(
            d.prepare("SELECT count(*) AS n FROM txt_index_generations").get()
              .n,
            count
          );
          assert.equal(
            d
              .prepare(
                "SELECT count(*) AS n FROM txt_index_generations WHERE state='building'"
              )
              .get().n,
            0
          );
        }
      );
      await check(
        "concurrent rebuild uses generation comparison and cannot overwrite winner",
        async () => {
          const a = await service(request, 1),
            b = await service(request, 2);
          const winner = await commit(a);
          await assert.rejects(() => commit(b, fixture(), 2), /concurrently/);
          assert.equal(
            getConnection(storage)
              .prepare("SELECT active_generation FROM txt_index_documents")
              .get().active_generation,
            winner.generation
          );
        }
      );
      await check(
        "custom storage directories use different databases and cannot cross-use tickets",
        async () => {
          const other = path.join(temporary, "other");
          fs.mkdirSync(path.join(other, "book"), { recursive: true });
          fs.writeFileSync(path.join(other, "book", "book-1.txt"), source);
          const a = await service(request, 1),
            b = await service({ ...request, storagePath: other }, 1);
          assert.equal(b.cacheHit, false);
          await assert.rejects(
            () =>
              service(
                {
                  action: "commit",
                  dbName: "notes",
                  storagePath: other,
                  ticket: a.ticket,
                  index: fixture(),
                },
                1
              ),
            /foreign/
          );
          assert.notEqual(getConnection(storage), getConnection(other));
        }
      );
      await check(
        "actual Electron IPC preserves typed bytes and rejects a foreign renderer ticket",
        async () => {
          ipcMain.handle("database-command", (event, command) =>
            service(command, event.sender.id)
          );
          const window = new BrowserWindow({
            show: false,
            webPreferences: {
              nodeIntegration: true,
              contextIsolation: false,
              sandbox: false,
            },
          });
          try {
            await window.loadURL(
              "data:text/html,<title>Isolated TXT IPC test</title>"
            );
            const response = await window.webContents
              .executeJavaScript(`(async()=>{
          const result=await require("electron").ipcRenderer.invoke("database-command",${JSON.stringify(request)});
          return {typed:result.buffer instanceof Uint8Array,bytes:result.buffer.byteLength,cacheHit:result.cacheHit,ticket:result.ticket};
        })()`);
            assert.equal(response.typed, true);
            assert.equal(response.bytes, Buffer.byteLength(source));
            assert.equal(response.cacheHit, true);
            await assert.rejects(
              () => commit(response, fixture(), -1),
              /foreign/
            );
          } finally {
            window.destroy();
            ipcMain.removeHandler("database-command");
          }
        }
      );
      await check(
        "production connection registry keys by canonical database path and evicts closed connections",
        async () => {
          const {
            createDatabaseConnections,
          } = require("../src/utils/main/database-connections");
          const registry = createDatabaseConnections(Database);
          const sql = {
            createTableStatement: {
              notes: "CREATE TABLE IF NOT EXISTS notes(key TEXT PRIMARY KEY)",
            },
            migrateStatement: {},
          };
          const left = path.join(temporary, "registry-a"),
            right = path.join(temporary, "registry-b");
          const a = registry.getConnection("notes", left, sql),
            b = registry.getConnection("notes", right, sql);
          try {
            assert.notEqual(a, b);
            assert.equal(registry.getConnection("notes", left, sql), a);
            if (process.platform === "win32")
              assert.equal(
                registry.getConnection("notes", left.toUpperCase(), sql),
                a
              );
            assert.throws(
              () => registry.getConnection("../escape", left, sql),
              /Invalid/
            );
            registry.removeConnection("notes", left);
            a.close();
            const reopened = registry.getConnection("notes", left, sql);
            assert.notEqual(reopened, a);
            reopened.close();
          } finally {
            if (a.open) a.close();
            b.close();
          }
        }
      );
      await check(
        "corrupt cached JSON is a safe miss and can be replaced without touching notes",
        async () => {
          const d = getConnection(storage),
            active = d
              .prepare("SELECT active_generation FROM txt_index_documents")
              .get().active_generation;
          d.prepare(
            "UPDATE txt_index_generations SET index_json='invalid JSON' WHERE generation=?"
          ).run(active);
          const opened = await service(request, 1);
          assert.equal(opened.cacheHit, false);
          assert.equal(opened.index, null);
          await commit(opened);
          assert.equal((await service(request, 1)).cacheHit, true);
        }
      );
      await check(
        "ASCII remains indexed; other legacy encodings explicitly use the volatile path",
        async () => {
          assert.equal(
            (await service({ ...request, charset: "ASCII" }, 2))
              .persistentSupported,
            true
          );
          const legacy = await service({ ...request, charset: "shift_jis" }, 2);
          assert.equal(legacy.persistentSupported, false);
          assert.equal(legacy.index, null);
          assert.equal(legacy.ticket, null);
          assert.equal(Buffer.from(legacy.buffer).toString(), source);
        }
      );
      await check(
        "retention is bounded to active and previous ready generations; notes remain intact",
        async () => {
          for (let i = 0; i < 3; i++) {
            const opened = await service(request, 1);
            await commit(opened);
          }
          const d = getConnection(storage);
          assert.equal(
            d.prepare("SELECT count(*) AS n FROM txt_index_generations").get()
              .n,
            2
          );
          assert.equal(
            d.prepare("SELECT count(*) AS n FROM txt_index_chapters").get().n,
            4
          );
          assert.equal(
            d.prepare("SELECT notes FROM notes WHERE key='keep'").get().notes,
            "protected fixture"
          );
        }
      );
      fs.writeFileSync(
        reportPath,
        JSON.stringify({
          passed: true,
          cases: passed,
          electron: process.versions.electron,
          nativeSqlite: true,
          userDatabaseOpened: false,
        })
      );
    } finally {
      for (const connection of connections.values())
        if (connection.open) connection.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ passed: false, error: error.message })
    );
    console.error(error);
    app.exit(1);
  });
