const { app } = require("electron");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { pathToFileURL } = require("node:url");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-annotation-test-"));
app.setPath("userData", path.join(temp, "profile"));
app.disableHardwareAcceleration();
const report = process.argv[2] || path.join(temp, "result.json");
app
  .whenReady()
  .then(async () => {
    const Database = require("better-sqlite3"),
      { SqlStatement } = await import(
        pathToFileURL(
          path.resolve(__dirname, "../src/assets/lib/kookit-extra.min.mjs")
        )
      );
    const {
        createAnnotationService,
        ensureAnnotationSchema,
      } = require("../src/utils/main/annotation-store"),
      {
        createTxtIndexService,
        CONTRACT,
      } = require("../src/utils/main/txt-index-store");
    const dbs = new Map();
    const connection = (storage) => {
      if (!dbs.has(storage)) {
        fs.mkdirSync(path.join(storage, "config"), { recursive: true });
        const db = new Database(path.join(storage, "config", "notes.db"));
        db.pragma("journal_mode=WAL");
        db.exec(SqlStatement.sqlStatement.createTableStatement.notes);
        dbs.set(storage, db);
      }
      return dbs.get(storage);
    };
    const storage = path.join(temp, "library");
    fs.mkdirSync(path.join(storage, "book"), { recursive: true });
    const text =
      "第一章\nAlpha 😀 甲 & <tag>\n第二章\nBeta 乙\n第三章\nGamma 丙\n";
    fs.writeFileSync(path.join(storage, "book", "fixture.txt"), text);
    const titles = ["第一章", "第二章", "第三章"],
      chapters = titles.map((label, i) => {
        const start = text.indexOf(label),
          end =
            i + 1 < titles.length
              ? text.indexOf(titles[i + 1]) - 1
              : text.length,
          bodyStart = text.indexOf("\n", start) + 1;
        return {
          index: i,
          label,
          start,
          end,
          bodyStart,
          byteStart: Buffer.byteLength(text.slice(0, start)),
          byteEnd: Buffer.byteLength(text.slice(0, end)),
          bodyByteStart: Buffer.byteLength(text.slice(0, bodyStart)),
          chapterId: "chapter-" + i,
          firstChars: ["Al", "Be", "Ga"][i],
          lastChars: [">", "乙", "丙"][i],
          hasTitle: true,
          fixedChunk: false,
          lineCount: i === 2 ? 3 : 2,
          size: 100,
          recognition: "heading",
        };
      });
    const index = {
      contract: { ...CONTRACT },
      encoding: "utf-8",
      bomBytes: 0,
      textLength: text.length,
      byteLength: Buffer.byteLength(text),
      lineCount: 7,
      mode: "chapter-headings",
      chapters,
    };
    const txt = createTxtIndexService({ getConnection: connection });
    const notes = createAnnotationService({
      getConnection: connection,
      describeTxt: (...args) => txt.describeChapter(...args),
      loadRegistry: async () => SqlStatement,
      Database,
    });
    const request = {
      operation: "txt-index",
      dbName: "notes",
      storagePath: storage,
      action: "open",
      bookId: "fixture",
      bookPath: "",
      charset: "utf-8",
      parserRegex: "",
    };
    let opened = await txt(request, 1);
    await txt(
      { ...request, action: "commit", ticket: opened.ticket, index },
      1
    );
    const call = (action, data = {}, where = storage) =>
      notes({ dbName: "notes", storagePath: where, action, ...data }, 1);
    const save = (kind, body = "body", tag = []) =>
      call("save", { note: { bookKey: "fixture", kind, notes: body, tag } });
    const anchor = (chapter = 0, start = 0, end = 5) => ({
      format: "TXT",
      sourceTicket: opened.ticket,
      chapterIndex: chapter,
      chapterId: chapters[chapter].chapterId,
      start,
      end,
      style: "background-#FEF3CD",
    });
    const db = connection(storage),
      old = {
        key: "discard",
        bookKey: "fixture",
        date: { year: 2026, month: 11, day: 8 },
        chapter: "old",
        chapterIndex: 0,
        text: "old fixture",
        cfi: "{}",
        range: "{}",
        notes: "old fixture body",
        percentage: "0",
        color: "background-#FEF3CD",
        tag: [],
      };
    db.prepare(SqlStatement.sqlStatement.saveStatement.notes).run(
      SqlStatement.jsonToSqlite.notes(old)
    );
    db.prepare(SqlStatement.sqlStatement.saveStatement.notes).run(
      SqlStatement.jsonToSqlite.notes({
        ...old,
        key: "drawing",
        notes: "annotation",
      })
    );
    db.exec(
      "CREATE TABLE unrelated(value TEXT);INSERT INTO unrelated VALUES('keep')"
    );
    let passed = 0;
    const check = async (name, task) => {
      await task();
      passed++;
      console.log("PASS: " + name);
    };
    let small, chapter, range;
    try {
      await check(
        "authorized fixture reset is scoped; drawings/index/unrelated data and WAL backup survive",
        async () => {
          await ensureAnnotationSchema(db);
          assert.equal(db.prepare("SELECT count(*) n FROM notes").get().n, 0);
          assert.equal(
            db.prepare("SELECT count(*) n FROM drawing_notes").get().n,
            1
          );
          assert.equal(
            db.prepare("SELECT value FROM unrelated").get().value,
            "keep"
          );
          assert.equal(
            db.prepare("SELECT count(*) n FROM txt_index_chapters").get().n,
            3
          );
          const file = fs
            .readdirSync(path.join(storage, "config"))
            .find((n) => n.includes("pre-annotations"));
          assert.ok(file);
          const backup = new Database(path.join(storage, "config", file), {
            readonly: true,
          });
          try {
            assert.equal(
              backup
                .prepare("SELECT notes FROM notes WHERE key='discard'")
                .get().notes,
              old.notes
            );
          } finally {
            backup.close();
          }
        }
      );
      await check("reopening a formal database skips legacy Note migrations", async () => {
        const {createDatabaseConnections} = require("../src/utils/main/database-connections");
        const registry = createDatabaseConnections(Database);
        const reopened = registry.getConnection("notes",storage,SqlStatement.sqlStatement);
        try {
          const columns=reopened.pragma("table_info(notes)").map(row=>row.name);
          assert.ok(columns.includes("kind") && columns.includes("version"));
          assert.ok(!columns.includes("cfi") && !columns.includes("range") && !columns.includes("text"));
          assert.equal(reopened.prepare("SELECT count(*) n FROM drawing_notes").get().n,1);
          assert.equal(reopened.prepare("SELECT count(*) n FROM txt_index_chapters").get().n,3);
        } finally {reopened.close();}
      });
      await check("legacy database restore preserves drawings and ignores disposable text fixtures", async () => {
        const oldBackup=fs.readdirSync(path.join(storage,"config")).find(name=>name.includes("pre-annotations"));
        const target=path.join(temp,"legacy-restored");
        await call("import-database",{buffer:new Uint8Array(fs.readFileSync(path.join(storage,"config",oldBackup)))},target);
        const result=await call("export",{},target);
        assert.equal(result.notes.length,0);
        assert.equal(result.drawings.length,1);
        assert.equal(result.drawings[0].key,"drawing");
      });
      await check(
        "migration failure rolls back old notes and all new DDL",
        async () => {
          const broken = new Database(":memory:");
          try {
            broken.exec(
              "CREATE TABLE notes(key TEXT,notes TEXT);INSERT INTO notes VALUES('keep','body');CREATE TABLE range_bindings(dummy)"
            );
            await assert.rejects(() => ensureAnnotationSchema(broken));
            assert.equal(
              broken.prepare("SELECT notes FROM notes").get().notes,
              "body"
            );
            assert.equal(
              broken
                .prepare(
                  "SELECT count(*) n FROM sqlite_master WHERE name='annotation_schema'"
                )
                .get().n,
              0
            );
          } finally {
            broken.close();
          }
        }
      );
      await check("selected-text creation validates before publishing and rolls back both rows on binding write failure", async () => {
        const count=()=>db.prepare("SELECT count(*) n FROM notes").get().n;
        const original=count();
        const draft={bookKey:"fixture",kind:"small",notes:"must remain in editor on failure",tag:["atomic"]};
        await assert.rejects(()=>call("create",{note:draft,binding:anchor(0,0,99999)}));
        assert.equal(count(),original);
        db.exec("CREATE TRIGGER fail_atomic BEFORE INSERT ON note_bindings BEGIN SELECT RAISE(ABORT,'injected atomic failure'); END");
        try {await assert.rejects(()=>call("create",{note:draft,binding:anchor()}),/injected atomic failure/);}
        finally{db.exec("DROP TRIGGER fail_atomic");}
        assert.equal(count(),original);
        const active=db.prepare("SELECT active_generation FROM txt_index_documents WHERE book_id='fixture'").get().active_generation;
        const racing=createAnnotationService({getConnection:connection,loadRegistry:async()=>SqlStatement,Database,describeTxt:async(...args)=>{
          const snapshot=await txt.describeChapter(...args);db.prepare("UPDATE txt_index_documents SET active_generation=NULL WHERE book_id='fixture'").run();return snapshot;
        }});
        try{await assert.rejects(()=>racing({dbName:"notes",storagePath:storage,action:"create",note:draft,binding:anchor()},1),/Index changed/);}
        finally{db.prepare("UPDATE txt_index_documents SET active_generation=? WHERE book_id='fixture'").run(active);}
        assert.equal(count(),original);
        const result=await call("create",{note:draft,binding:anchor()});
        assert.equal(result.bindings.length,1);assert.equal(result.notes,draft.notes);
        await call("delete",{key:result.key,version:result.version});
        assert.equal(count(),original);
      });
      await check("new annotation reads carry private-free request/trace and real SQL stage timings", async () => {
        const logs=[];
        const measured=createAnnotationService({getConnection:connection,describeTxt:(...args)=>txt.describeChapter(...args),loadRegistry:async()=>SqlStatement,Database,log:line=>logs.push(line)});
        const result=await measured({dbName:"notes",storagePath:storage,action:"list",diagnostics:{requestId:"atomic-diag-1",traceId:"reader-test"}},1);
        assert.ok(Array.isArray(result.result.records));
        assert.equal(result.diagnostics.requestId,"atomic-diag-1");assert.equal(result.diagnostics.traceId,"reader-test");
        assert.ok(result.diagnostics.statementCount>0);
        for(const stage of ["registryDurationMs","connectionDurationMs","migrationDurationMs","prepareDurationMs","executeDurationMs","outputConversionDurationMs"])assert.ok(result.diagnostics[stage]>=0,stage);
        assert.ok(!logs.join("").includes(storage));assert.ok(!logs.join("").includes("must remain"));
      });
      await check(
        "three independent entities support unbound creation and isolated tags/body",
        async () => {
          small = await save("small", "small body", ["small-tag"]);
          chapter = await save("chapter", "chapter body", ["chapter-tag"]);
          range = await save("range", "range body", ["range-tag"]);
          assert.equal(new Set([small.key, chapter.key, range.key]).size, 3);
          assert.ok(
            [small, chapter, range].every((n) => n.bindings.length === 0)
          );
          assert.equal(
            (await call("list", { kind: "chapter" })).records.length,
            1
          );
        }
      );
      await check(
        "small note supports independent overlapping and cross-chapter anchors with exact Unicode quotes",
        async () => {
          small = await call("bind", { noteKey: small.key, binding: anchor() });
          small = await call("bind", {
            noteKey: small.key,
            binding: anchor(0, 3, 8),
          });
          small = await call("bind", {
            noteKey: small.key,
            binding: anchor(1, 0, 4),
          });
          assert.equal(small.bindings.length, 3);
          assert.equal(small.bindings[0].quote, "Alpha");
          assert.equal(small.bindings[1].quote, "ha 😀");
          assert.equal(small.bindings[2].quote, "Beta");
          assert.equal(small.notes, "small body");
          await assert.rejects(
            () =>
              call("bind", { noteKey: small.key, binding: anchor(0, 7, 8) }),
            /range/
          );
        }
      );
      await check(
        "per-location style mutation does not overwrite sibling locations or entity content",
        async () => {
          const first = small.bindings[0],
            second = small.bindings[1];
          small = await call("style", {
            noteKey: small.key,
            bindingId: first.id,
            version: first.version,
            style: "underline-#FF0000",
          });
          assert.equal(
            small.bindings.find((b) => b.id === first.id).style,
            "underline-#FF0000"
          );
          assert.equal(
            small.bindings.find((b) => b.id === second.id).style,
            second.style
          );
          assert.equal(small.notes, "small body");
        }
      );
      await check(
        "single/all unbind preserve bodies, snapshots and support versioned undo",
        async () => {
          let first = small.bindings[0];
          small = await call("unbind", {
            noteKey: small.key,
            kind: "small",
            bindingId: first.id,
            version: first.version,
          });
          first = small.bindings.find((b) => b.id === first.id);
          assert.equal(first.status, "unbound");
          assert.equal(first.quote, "Alpha");
          small = await call("undo", {
            noteKey: small.key,
            kind: "small",
            bindingId: first.id,
            version: first.version,
            sourceTicket: opened.ticket,
          });
          assert.equal(
            small.bindings.find((b) => b.id === first.id).status,
            "active"
          );
          await assert.rejects(
            () =>
              call("undo", {
                noteKey: small.key,
                kind: "small",
                bindingId: first.id,
                version: first.version,
              }),
            /changed/
          );
          await assert.rejects(
            () => call("unbind-all", { noteKey: small.key, versions: {} }),
            /changed/
          );
          small = await call("unbind-all", {
            noteKey: small.key,
            versions: Object.fromEntries(
              small.bindings.map((b) => [b.id, b.version])
            ),
          });
          assert.ok(small.bindings.every((b) => b.status === "unbound"));
          assert.equal(small.notes, "small body");
        }
      );
      await check(
        "chapter binding is optional/singular; manual replacement unlinks prior snapshot atomically",
        async () => {
          chapter = await call("bind", {
            noteKey: chapter.key,
            binding: anchor(),
          });
          await assert.rejects(() =>
            call("bind", { noteKey: chapter.key, binding: anchor(1) })
          );
          const first = chapter.bindings[0];
          chapter = await call("bind", {
            noteKey: chapter.key,
            binding: anchor(1),
            replaceId: first.id,
            replaceVersion: first.version,
          });
          assert.equal(
            chapter.bindings.filter((b) => b.status === "active").length,
            1
          );
          assert.equal(
            chapter.bindings.find((b) => b.id === first.id).status,
            "unbound"
          );
          assert.equal(chapter.notes, "chapter body");
        }
      );
      await check(
        "continuous range validates both endpoints and rejects reversal/cross-book binding",
        async () => {
          range = await call("bind", {
            noteKey: range.key,
            binding: {
              ...anchor(),
              endChapterIndex: 2,
              endChapterId: chapters[2].chapterId,
            },
          });
          assert.equal(range.bindings[0].end_index, 2);
          await assert.rejects(
            () =>
              call("bind", {
                noteKey: range.key,
                binding: {
                  ...anchor(2),
                  endChapterIndex: 0,
                  endChapterId: chapters[0].chapterId,
                },
              }),
            /range/
          );
          const other = await call("save", {
            note: {
              bookKey: "other",
              kind: "small",
              notes: "other body",
              tag: [],
            },
          });
          await assert.rejects(
            () => call("bind", { noteKey: other.key, binding: anchor() }),
            /Cross-book/
          );
          await call("delete", { key: other.key, version: other.version });
        }
      );
      await check(
        "native non-TXT adapter stores format locator and never fabricates UTF-16 coordinates",
        async () => {
          const note = await save("small", "EPUB body");
          const bound = await call("bind", {
            noteKey: note.key,
            binding: {
              format: "EPUB",
              chapterIndex: 2,
              chapter: "epub chapter",
              range: '{"characterRange":{"start":1,"end":3}}',
              cfi: '{"chapterDocIndex":"2"}',
              quote: "ab",
              style: "underline-#FF0000",
            },
          });
          assert.equal(bound.bindings[0].relative_start, null);
          assert.equal(bound.bindings[0].format, "EPUB");
          await call("delete", { key: bound.key, version: bound.version });
        }
      );
      await check(
        "entity updates use CAS and leave bindings unchanged",
        async () => {
          const oldVersion = small.version;
          small = await call("save", {
            note: { ...small, notes: "edited body" },
          });
          await assert.rejects(
            () =>
              call("save", {
                note: { ...small, version: oldVersion, notes: "stale" },
              }),
            /changed/
          );
          assert.equal(small.bindings.length, 3);
        }
      );
      await check(
        "index rebuild retains referenced snapshots and marks old relationships pending",
        async () => {
          const current = await txt(request, 1);
          await txt(
            {
              ...request,
              action: "commit",
              ticket: current.ticket,
              index: {
                ...index,
                chapters: chapters.map((c) => ({
                  ...c,
                  chapterId: c.chapterId + "-new",
                })),
              },
            },
            1
          );
          opened = await txt(request, 1);
          assert.equal(
            db.prepare("SELECT count(*) n FROM txt_index_generations").get().n,
            2
          );
          chapter = await call("get", { key: chapter.key });
          assert.equal(
            chapter.bindings.find((b) => b.status !== "unbound").status,
            "pending"
          );
          assert.equal(
            (
              await call("reading", {
                bookKey: "fixture",
                format: "TXT",
                sourceTicket: opened.ticket,
                chapterIndex: 0,
                chapterId: "chapter-0-new",
              })
            ).length,
            0
          );
        }
      );
      let dump;
      await check(
        "formal backup includes all entities, unbound bindings, quotes/styles and drawings but no local index",
        async () => {
          dump = await call("export");
          assert.equal(dump.format, "koodo-annotations");
          assert.equal(dump.bindings.small.length, 3);
          assert.equal(dump.drawings.length, 1);
          assert.ok(!JSON.stringify(dump).includes("sampleFingerprint"));
        }
      );
      const restored = path.join(temp, "restored");
      await check(
        "restore is atomic, lossless and repeatable; TXT snapshots await reconciliation",
        async () => {
          await call("import", { backup: dump }, restored);
          await call("import", { backup: dump }, restored);
          const note = await call("get", { key: small.key }, restored);
          assert.equal(note.notes, "edited body");
          assert.deepEqual(
            note.bindings.map((b) => [b.id, b.quote]).sort(),
            small.bindings.map((b) => [b.id, b.quote]).sort()
          );
          assert.ok(note.bindings.every((b) => b.status === "unbound"));
          assert.equal(
            (await call("get", { key: chapter.key }, restored)).bindings.find(
              (b) => b.status !== "unbound"
            ).status,
            "pending"
          );
        }
      );
      await check(
        "conflicting/corrupt imports never partially replace formal data",
        async () => {
          const bad = structuredClone(dump);
          bad.notes[0].notes = "overwrite";
          bad.notes.push({ ...bad.notes[0], key: "new-but-rollback" });
          // Keep the v2 tag graph valid so this still tests a conflicting body,
          // rather than failing earlier on the newly copied entity's graph.
          bad.tagRelations.push(...bad.tagRelations.filter(r => r.note_key === bad.notes[0].key)
            .map(r => ({...r,note_key:"new-but-rollback"})));
          await assert.rejects(
            () => call("import", { backup: bad }, restored),
            /conflict/
          );
          assert.equal(
            await call("get", { key: "new-but-rollback" }, restored),
            null
          );
          const broken = structuredClone(dump);
          broken.bindings.small[0].note_key = "missing";
          await assert.rejects(() =>
            call("import", { backup: broken }, restored)
          );
        }
      );
      await check(
        "normal ZIP backup/restore carries the versioned manifest and imports all relationships",
        async () => {
          const {
            backupToPath,
            restoreFromPath,
          } = require("../src/utils/main/backup-util");
          fs.writeFileSync(path.join(storage, "config", "config.json"), "{}");
          const backed = await backupToPath(
            {
              targetPath: temp,
              fileName: "roundtrip.zip",
              dataPath: storage,
              dirs: [],
              files: ["config/config.json"],
              annotations: dump,
            },
            () => {}
          );
          assert.equal(backed.ok, true);
          const result = await restoreFromPath(
            {
              filePath: path.join(temp, "roundtrip.zip"),
              dataPath: path.join(temp, "assets-restore"),
            },
            () => {}
          );
          assert.equal(result.ok, true);
          const manifest = result.configFiles.find(
            (f) => f.name === `config/annotations.v${dump.version}.json`
          );
          assert.ok(manifest);
          await call(
            "import",
            { backup: JSON.parse(Buffer.from(manifest.buffer).toString()) },
            path.join(temp, "zip-restored")
          );
        }
      );
      await check(
        "database-only restore uses native formal schema, not legacy single-position converters",
        async () => {
          const bytes = await call("export-database");
          const result = await call(
            "import-database",
            { buffer: bytes },
            path.join(temp, "db-restored")
          );
          assert.equal(result.notes, dump.notes.length);
        }
      );
      await check(
        "deleting one entity never deletes other kinds or their bodies",
        async () => {
          await call("delete", { key: small.key, version: small.version });
          assert.equal(await call("get", { key: small.key }), null);
          assert.equal(
            (await call("get", { key: chapter.key })).notes,
            "chapter body"
          );
          assert.equal(
            (await call("get", { key: range.key })).notes,
            "range body"
          );
          assert.equal(
            db.prepare("SELECT value FROM unrelated").get().value,
            "keep"
          );
        }
      );
      fs.writeFileSync(
        report,
        JSON.stringify({
          passed: true,
          cases: passed,
          userDatabaseOpened: false,
          nativeSqlite: true,
        })
      );
    } finally {
      for (const db of dbs.values()) if (db.open) db.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.writeFileSync(
      report,
      JSON.stringify({ passed: false, error: error.message })
    );
    app.exit(1);
  });
