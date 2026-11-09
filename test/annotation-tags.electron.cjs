const { app } = require("electron");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-ui1-tags-"));
app.setPath("userData", path.join(temporary, "profile"));
app.disableHardwareAcceleration();
const report = process.argv[2] || path.join(temporary, "result.json");
const checks = [], connections = new Map(), timings = {};
app.whenReady().then(async () => {
    const Database = require("better-sqlite3");
    const { createAnnotationService, ensureAnnotationSchema } = require("../src/utils/main/annotation-store");
    const { backupToPath, restoreFromPath } = require("../src/utils/main/backup-util");
    const storage = path.join(temporary, "library");
    const connection = root => {
        if (!connections.has(root)) {
            fs.mkdirSync(path.join(root, "config"), { recursive: true });
            const db = new Database(path.join(root, "config", "notes.db"));
            // The old drawing schema is not needed here; keep an empty table
            // so missing-entity lookup follows the existing drawing fallback.
            db.exec("CREATE TABLE IF NOT EXISTS drawing_notes(key TEXT PRIMARY KEY,notes TEXT)");
            connections.set(root, db);
        }
        return connections.get(root);
    };
    const service = createAnnotationService({ getConnection: connection, Database, describeTxt: () => { throw Error("No real source used"); } });
    const call = (action, data = {}, root = storage) => service({ operation: "annotations", dbName: "notes", storagePath: root, action, ...data }, 1);
    const db = connection(storage);
    const check = async (name, test) => { await test(); checks.push(name); console.log("PASS: " + name); };
    const local = (name, bookKey = "book-a") => call("tag-create", { name, scope: "book", bookKey });
    const global = name => call("tag-create", { name, scope: "global" });
    const tag = async value => (await call("tag-list", { bookKey: value.book_key || undefined, scope: value.scope, limit: 200 })).records.find(row => row.id === value.id);
    const save = (kind, tagIds = [], bookKey = "book-a") => call("save", { note: { bookKey, kind, notes: "Formal synthetic " + kind + " 😀", title: "retained legacy title", tagIds } });
    const note = value => call("get", { key: value.key });
    const rename = async (value, name, extra = {}) => call("tag-rename", { id: value.id, bookKey: value.book_key, version: value.version, name, ...extra });
    const remove = (value, confirmed = false) => call("tag-delete", { id: value.id, bookKey: value.book_key, version: value.version, confirmed });
    const raw = () => call("export");
    const v1 = async root => {
        const target = connection(root);
        await ensureAnnotationSchema(target);
        target.exec("DROP TRIGGER note_tags_book_insert; DROP TRIGGER note_tags_book_update; DROP TABLE note_tags; DROP TABLE annotation_tags; UPDATE annotation_schema SET version=1");
        // Reopen: the migration cache belongs to a connection, not a file path.
        target.close(); connections.delete(root);
        return connection(root);
    };
    await check("v1 formal migration preserves exact entities, versions, drawing/index/unrelated tables and makes a consistent pre-v2 backup", async () => {
        const root = path.join(temporary, "migration"), target = await v1(root);
        target.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep'); CREATE TABLE txt_index_documents(book_id TEXT); INSERT INTO txt_index_documents VALUES('cached'); INSERT INTO drawing_notes VALUES('drawing','keep drawing')");
        const insert = target.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)");
        for (const [index, kind] of ["small", "chapter", "range"].entries())
            insert.run("old-" + index, "book-a", kind, "legacy title", "legacy body 😀", JSON.stringify(["shared", "旧角色"]), '{"year":2026,"month":11,"day":9}', 1, 2, 7);
        const before = target.prepare("SELECT * FROM notes ORDER BY key").all();
        await ensureAnnotationSchema(target);
        assert.equal(target.prepare("SELECT version FROM annotation_schema").get().version, 2);
        assert.deepEqual(target.prepare("SELECT * FROM notes ORDER BY key").all(), before);
        assert.equal(target.prepare("SELECT count(*) n FROM note_tags").get().n, 6);
        assert.equal(target.prepare("SELECT count(*) n FROM annotation_tags").get().n, 2);
        assert.equal(target.prepare("SELECT value FROM unrelated").get().value, "keep");
        assert.equal(target.prepare("SELECT notes FROM drawing_notes").get().notes, "keep drawing");
        assert.equal(target.prepare("SELECT book_id FROM txt_index_documents").get().book_id, "cached");
        const backupName = fs.readdirSync(path.join(root, "config")).find(name => name.includes(".pre-annotations-v2-"));
        assert.ok(backupName);
        const backup = new Database(path.join(root, "config", backupName), { readonly: true });
        try { assert.equal(backup.prepare("SELECT version FROM annotation_schema").get().version, 1); assert.deepEqual(backup.prepare("SELECT * FROM notes ORDER BY key").all(), before); }
        finally { backup.close(); }
        target.close(); connections.delete(root);
        await ensureAnnotationSchema(connection(root));
        assert.equal(connection(root).prepare("SELECT count(*) n FROM note_tags").get().n, 6);
        assert.equal(fs.readdirSync(path.join(root, "config")).filter(name => name.includes(".pre-annotations-v2-")).length, 1);
    });
    await check("failed additive migration rolls back DDL and formal rows; fixing the fault permits an idempotent retry", async () => {
        const root = path.join(temporary, "migration-failure"), target = await v1(root);
        target.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)").run("keep", "book-a", "small", "", "kept", '["tag"]', '{}', 1, 1, 1);
        target.exec("CREATE TABLE annotation_tags(dummy TEXT)");
        await assert.rejects(() => ensureAnnotationSchema(target));
        assert.equal(target.prepare("SELECT version FROM annotation_schema").get().version, 1);
        assert.equal(target.prepare("SELECT notes FROM notes").get().notes, "kept");
        assert.equal(target.prepare("SELECT count(*) n FROM sqlite_master WHERE name='note_tags'").get().n, 0);
        target.exec("DROP TABLE annotation_tags"); await ensureAnnotationSchema(target);
        assert.equal(target.prepare("SELECT count(*) n FROM note_tags").get().n, 1);
    });
    await check("unused legacy configuration names seed globals once by stable identity without modifying formal notes", async () => {
        await call("tag-seed-legacy", { names: ["unused", "unused", " Name ", "Name", "😀"] });
        const before = await raw();
        await call("tag-seed-legacy", { names: ["unused", " Name ", "Name", "😀"] });
        assert.deepEqual(await raw(), before);
        assert.equal(before.tags.filter(row => row.name === "unused").length, 1);
        assert.equal(before.notes.length, 0);
    });
    let sameGlobal, sameLocal, otherLocal, shared;
    await check("equal names in global/two book scopes retain three distinct identities and book-isolated selection", async () => {
        sameGlobal = await global("same"); sameLocal = await local("same"); otherLocal = await local("same", "book-b");
        assert.equal(new Set([sameGlobal.id, sameLocal.id, otherLocal.id]).size, 3);
        const selected = await save("small", [sameGlobal.id, sameLocal.id]);
        assert.deepEqual(selected.tag, ["same"]); assert.equal(selected.tagRefs.length, 2);
        assert.deepEqual(selected.tagRefs.map(row => row.id), [sameGlobal.id, sameLocal.id]);
        const listed = await call("tag-list", { bookKey: "book-b" });
        assert.ok(listed.records.some(row => row.id === otherLocal.id));
        assert.ok(!listed.records.some(row => row.id === sameLocal.id));
    });
    await check("cross-book, missing IDs, invalid scope/page and empty new names fail without publishing notes or tag rows", async () => {
        const before = await raw();
        await assert.rejects(() => save("small", [otherLocal.id]));
        await assert.rejects(() => save("chapter", ["missing"]));
        await assert.rejects(() => call("tag-create", { name: "   ", scope: "book", bookKey: "book-a" }));
        await assert.rejects(() => call("tag-create", { name: "bad", scope: "global", bookKey: "book-a" }));
        await assert.rejects(() => call("tag-list", { scope: "book" }));
        await assert.rejects(() => call("tag-list", { limit: 201 }));
        await assert.rejects(() => call("tag-__proto__"));
        assert.deepEqual(await raw(), before);
    });
    await check("selected-text creation failure rolls back new global identities and references together with the entity", async () => {
        const before = await raw();
        db.exec("CREATE TRIGGER fail_tagged_create BEFORE INSERT ON note_bindings BEGIN SELECT RAISE(ABORT,'injected create failure'); END");
        try {
            await assert.rejects(() => call("create", { note: { bookKey: "book-a", kind: "small", notes: "must stay in editor", tag: ["never-published-global"] }, binding: { format: "EPUB", chapterIndex: 0, chapter: "Synthetic", range: '{}', cfi: '{}', quote: "source" } }), /injected/);
        } finally { db.exec("DROP TRIGGER fail_tagged_create"); }
        assert.deepEqual(await raw(), before);
    });
    await check("failed tag assignment rolls back body/version and the prior reference set atomically", async () => {
        const value = await save("small", [sameGlobal.id]), candidate = await local("assignment-fault"), before = await raw();
        db.exec("CREATE TRIGGER fail_tag_assignment BEFORE INSERT ON note_tags BEGIN SELECT RAISE(ABORT,'injected assignment failure'); END");
        try { await assert.rejects(() => call("save", { note: { ...value, notes: "unpublished edit", tagIds: [candidate.id] } }), /injected/); }
        finally { db.exec("DROP TRIGGER fail_tag_assignment"); }
        assert.deepEqual(await raw(), before);
    });
    let three;
    await check("all three kinds share optional tags; usage counts distinct entities rather than location bindings", async () => {
        shared = await local("shared-local");
        three = await Promise.all(["small", "chapter", "range"].map(kind => save(kind, [shared.id, sameGlobal.id])));
        await call("bind", { noteKey: three[0].key, binding: { format: "EPUB", chapterIndex: 0, chapter: "Synthetic chapter", range: '{}', cfi: '{}', quote: "synthetic" } });
        await call("bind", { noteKey: three[0].key, binding: { format: "EPUB", chapterIndex: 1, chapter: "Synthetic chapter 2", range: '{}', cfi: '{}', quote: "synthetic2" } });
        assert.equal((await tag(shared)).useCount, 3);
        assert.equal((await save("range")).tagRefs.length, 0);
        assert.equal((await call("list", { bookKey: "book-a", tagIds: [shared.id] })).records.length, 3);
        assert.equal((await call("list", { bookKey: "book-b", tagIds: [shared.id] })).records.length, 0);
    });
    await check("legacy body/name editors preserve local identity and same-name scopes; explicit IDs can remove a local reference", async () => {
        const original = await save("small", [sameGlobal.id, sameLocal.id]);
        const legacy = await call("save", { note: { ...original, notes: "legacy edit", tag: ["same", "new-global"] } });
        assert.ok(legacy.tagRefs.some(row => row.id === sameLocal.id));
        assert.ok(legacy.tagRefs.some(row => row.id === sameGlobal.id));
        const noNames = await call("save", { note: { ...legacy, tag: [] } });
        assert.deepEqual(noNames.tagRefs.map(row => row.id), [sameLocal.id]);
        const explicit = await call("save", { note: { ...noNames, tagIds: [] } });
        assert.equal(explicit.tagRefs.length, 0);
    });
    await check("local rename updates all three projections/versions and preserves body/title/bindings; stale editors cannot undo it", async () => {
        const before = await Promise.all(three.map(note)), source = await tag(shared);
        const result = await rename(source, "renamed-local"); shared = result.tag;
        assert.equal(shared.useCount, 3);
        for (let i = 0; i < before.length; i++) {
            const after = await note(before[i]);
            assert.ok(after.tag.includes("renamed-local")); assert.ok(!after.tag.includes("shared-local"));
            assert.equal(after.version, before[i].version + 1); assert.equal(after.notes, before[i].notes);
            assert.equal(after.title, before[i].title); assert.deepEqual(after.bindings, before[i].bindings);
        }
        await assert.rejects(() => call("save", { note: { ...before[0], notes: "stale", tag: ["shared-local"] } }), /changed/);
        await assert.rejects(() => rename(source, "stale"), /changed/);
        await assert.rejects(() => rename(sameGlobal, "not-a-global-manager"));
    });
    let mergeSource, mergeTarget, mergeNotes;
    await check("rename collision returns a no-write merge preview with deduplicated affected count", async () => {
        mergeSource = await local("merge-source"); mergeTarget = await local("merge-target");
        mergeNotes = [await save("small", [mergeSource.id, mergeTarget.id]), await save("chapter", [mergeSource.id]), await save("range", [mergeTarget.id])];
        mergeSource = await tag(mergeSource); mergeTarget = await tag(mergeTarget);
        const before = await raw(), preview = await rename(mergeSource, mergeTarget.name);
        assert.equal(preview.requiresMerge, true); assert.equal(preview.source.useCount, 2); assert.equal(preview.target.useCount, 2); assert.equal(preview.affectedCount, 3);
        assert.deepEqual(await raw(), before);
    });
    await check("concurrent target membership invalidates merge confirmation without partial changes", async () => {
        await save("small", [mergeTarget.id]); const before = await raw();
        await assert.rejects(() => rename(mergeSource, mergeTarget.name, { confirmMerge: true, targetId: mergeTarget.id, targetVersion: mergeTarget.version }), /changed/);
        assert.deepEqual(await raw(), before); mergeTarget = await tag(mergeTarget);
    });
    await check("merge failure after relation changes rolls the entire tag/note transaction back", async () => {
        const before = await raw();
        db.exec("CREATE TRIGGER fail_tag_merge BEFORE DELETE ON annotation_tags WHEN OLD.name='merge-source' BEGIN SELECT RAISE(ABORT,'injected merge failure'); END");
        try { await assert.rejects(() => rename(mergeSource, mergeTarget.name, { confirmMerge: true, targetId: mergeTarget.id, targetVersion: mergeTarget.version }), /injected/); }
        finally { db.exec("DROP TRIGGER fail_tag_merge"); }
        assert.deepEqual(await raw(), before);
    });
    await check("confirmed merge deduplicates shared references, removes only source identity and preserves each entity", async () => {
        const before = await Promise.all(mergeNotes.map(note));
        const result = await rename(mergeSource, mergeTarget.name, { confirmMerge: true, targetId: mergeTarget.id, targetVersion: mergeTarget.version });
        assert.equal(result.merged, true); assert.equal(result.tag.useCount, 4);
        assert.equal(await tag(mergeSource), undefined);
        for (const old of before) { const after = await note(old); assert.deepEqual(after.tagRefs.map(row => row.id), [mergeTarget.id]); assert.equal(after.notes, old.notes); assert.deepEqual(after.bindings, old.bindings); }
        await assert.rejects(() => save("small", [mergeSource.id]));
    });
    await check("delete preview and cancellation are no-write; stale usage confirmation is rejected", async () => {
        shared = await tag(shared); const before = await raw(), preview = await remove(shared);
        assert.equal(preview.requiresConfirmation, true); assert.equal(preview.affectedCount, 3); assert.deepEqual(await raw(), before);
        await save("small", [shared.id]); const current = await raw();
        await assert.rejects(() => remove(shared, true), /changed/); assert.deepEqual(await raw(), current);
    });
    await check("delete failure rolls back; confirmed delete affects only tag links across all kinds and protects stale note saves", async () => {
        shared = await tag(shared); const before = await raw(), old = await note(three[0]);
        db.exec("CREATE TRIGGER fail_tag_delete BEFORE UPDATE ON notes WHEN OLD.kind='chapter' BEGIN SELECT RAISE(ABORT,'injected delete failure'); END");
        try { await assert.rejects(() => remove(shared, true), /injected/); } finally { db.exec("DROP TRIGGER fail_tag_delete"); }
        assert.deepEqual(await raw(), before);
        assert.equal((await remove(shared, true)).affectedCount, 4);
        for (const entity of three) { const after = await note(entity); assert.ok(!after.tagRefs.some(row => row.id === shared.id)); assert.ok(after.tagRefs.some(row => row.id === sameGlobal.id)); assert.equal(after.notes, entity.notes); }
        assert.deepEqual((await note(old)).bindings, old.bindings);
        await assert.rejects(() => call("save", { note: old }), /changed/);
        assert.equal((await local("unused-delete")).useCount, 0);
        const unused = await local("unused-delete"); assert.equal((await remove(unused)).deleted, true);
    });
    await check("legacy global-name removal cannot remove a same-name local tag or its identity", async () => {
        const value = await save("small", [sameGlobal.id, sameLocal.id]);
        await call("remove-tag", { tag: "same" });
        const after = await note(value);
        assert.deepEqual(after.tagRefs.map(row => row.id), [sameLocal.id]); assert.deepEqual(after.tag, ["same"]);
        assert.ok(await tag(sameGlobal)); assert.ok(await tag(otherLocal));
    });
    await check("tag lists stay paged with an index-backed relation count and identity filters", async () => {
        for (let i = 0; i < 205; i++) await local("catalog-" + String(i).padStart(3, "0"), "catalog-book");
        const first = await call("tag-list", { scope: "book", bookKey: "catalog-book", limit: 100 });
        const last = await call("tag-list", { scope: "book", bookKey: "catalog-book", offset: 200, limit: 100 });
        assert.equal(first.records.length, 100); assert.equal(first.hasMore, true); assert.equal(last.records.length, 5); assert.equal(last.hasMore, false);
        const plan = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM note_tags WHERE tag_id=?").all(sameLocal.id);
        assert.ok(plan.some(row => /note_tags_tag/.test(row.detail)));
    });
    let dump;
    await check("v2 backup roundtrip preserves IDs/scopes, same-name identities, unused tags and relation positions and is repeatable", async () => {
        dump = await raw(); assert.equal(dump.version, 2);
        const root = path.join(temporary, "restored-v2");
        await call("import", { backup: dump }, root); const first = await call("export", {}, root);
        await call("import", { backup: dump }, root); assert.deepEqual(await call("export", {}, root), first);
        assert.deepEqual(first.tags, dump.tags); assert.deepEqual(first.tagRelations, dump.tagRelations);
        assert.deepEqual(first.notes, dump.notes);
        assert.ok(first.tags.some(row => row.name === "unused"));
    });
    await check("v2 restore merges compatible preseeded globals without changing local identity or breaking retries", async () => {
        const root = path.join(temporary, "preseeded");
        await call("tag-seed-legacy", { names: ["same", "extra-unused"] }, root);
        await call("import", { backup: dump }, root); const before = await call("export", {}, root);
        await call("import", { backup: dump }, root); assert.deepEqual(await call("export", {}, root), before);
        assert.ok(before.tags.some(row => row.name === "extra-unused"));
    });
    let oldDump;
    await check("v1 manifest and readonly database import keep formal content and convert names to stable global references", async () => {
        const root = path.join(temporary, "v1-source"), target = await v1(root);
        target.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)").run("v1-entity", "book-a", "chapter", "title", "kept v1", '["legacy-global"]', '{}', 1, 2, 3);
        const bytes = fs.readFileSync(path.join(root, "config", "notes.db"));
        oldDump = { format: "koodo-annotations", version: 1, notes: target.prepare("SELECT * FROM notes").all(), bindings: { small: [], chapter: [], range: [] }, drawings: [] };
        const manifestRoot = path.join(temporary, "v1-manifest");
        await call("import", { backup: oldDump }, manifestRoot); await call("import", { backup: oldDump }, manifestRoot);
        const imported = await call("get", { key: "v1-entity" }, manifestRoot);
        assert.equal(imported.notes, "kept v1"); assert.equal(imported.version, 3); assert.equal(imported.tagRefs[0].scope, "global");
        await call("import-database", { buffer: bytes }, path.join(temporary, "v1-database"));
        assert.deepEqual((await call("get", { key: "v1-entity" }, path.join(temporary, "v1-database"))).tagRefs, imported.tagRefs);
        assert.equal(target.prepare("SELECT version FROM annotation_schema").get().version, 1);
    });
    await check("v2 database-only restore carries scoped identities with the formal schema", async () => {
        const bytes = await call("export-database"), root = path.join(temporary, "v2-database");
        await call("import-database", { buffer: bytes }, root);
        assert.deepEqual((await call("export", {}, root)).tags, dump.tags);
        assert.deepEqual((await call("export", {}, root)).tagRelations, dump.tagRelations);
    });
    await check("invalid/cross-book/duplicate/projection-mismatched/future manifests never partially import", async () => {
        const cases = [];
        const cross = structuredClone(dump), localRelation = cross.tagRelations.find(row => cross.tags.find(t => t.id === row.tag_id).scope === "book");
        cross.tags.find(row => row.id === localRelation.tag_id).book_key = "wrong-book"; cases.push(cross);
        const missing = structuredClone(dump); missing.tagRelations[0].tag_id = "missing"; cases.push(missing);
        const duplicate = structuredClone(dump); duplicate.tagRelations.push(duplicate.tagRelations[0]); cases.push(duplicate);
        const projection = structuredClone(dump); projection.notes[0].tag = '["unrepresented"]'; cases.push(projection);
        const future = structuredClone(dump); future.version = 3; cases.push(future);
        for (const [i, backup] of cases.entries()) {
            const root = path.join(temporary, "invalid-" + i); const before = await call("export", {}, root);
            await assert.rejects(() => call("import", { backup }, root)); assert.deepEqual(await call("export", {}, root), before);
        }
    });
    await check("renamed tag or identical display names with different local IDs cause an atomic restore conflict", async () => {
        const root = path.join(temporary, "conflict"), before = await raw();
        await call("tag-create", { name: sameLocal.name, scope: "book", bookKey: sameLocal.book_key }, root);
        const snapshot = await call("export", {}, root);
        await assert.rejects(() => call("import", { backup: before }, root), /conflict/);
        assert.deepEqual(await call("export", {}, root), snapshot);
        const changed = structuredClone(dump); changed.tags.find(row => row.id === sameLocal.id).name = "obsolete name";
        for (const entity of changed.notes) {
            const refs = changed.tagRelations.filter(r => r.note_key === entity.key).map(r => changed.tags.find(t => t.id === r.tag_id).name);
            entity.tag = JSON.stringify([...new Set(refs)]);
        }
        const source = await raw(); await assert.rejects(() => call("import", { backup: changed }), /conflict/); assert.deepEqual(await raw(), source);
    });
    await check("restore injected after tag insertion rolls back entities, identities and relations together", async () => {
        const root = path.join(temporary, "restore-fault"); await call("export", {}, root); const target = connection(root), before = await call("export", {}, root);
        target.exec("CREATE TRIGGER fail_tag_import BEFORE INSERT ON note_tags BEGIN SELECT RAISE(ABORT,'injected import failure'); END");
        try { await assert.rejects(() => call("import", { backup: dump }, root), /injected/); } finally { target.exec("DROP TRIGGER fail_tag_import"); }
        assert.deepEqual(await call("export", {}, root), before);
    });
    await check("normal ZIP paths write/read both manifest generations and preserve v2 scoped tags", async () => {
        fs.writeFileSync(path.join(storage, "config", "config.json"), "{}");
        for (const backup of [oldDump, dump]) {
            const filename = "backup-v" + backup.version + ".zip";
            assert.equal((await backupToPath({ targetPath: temporary, fileName: filename, dataPath: storage, files: ["config/config.json"], dirs: [], annotations: backup }, () => {})).ok, true);
            const restored = await restoreFromPath({ filePath: path.join(temporary, filename), dataPath: path.join(temporary, "assets-" + backup.version) }, () => {});
            assert.equal(restored.ok, true);
            const manifest = restored.configFiles.find(entry => entry.name === `config/annotations.v${backup.version}.json`); assert.ok(manifest);
            const root = path.join(temporary, "zip-" + backup.version);
            await call("import", { backup: JSON.parse(Buffer.from(manifest.buffer).toString("utf8")) }, root);
            if (backup.version === 2) assert.deepEqual((await call("export", {}, root)).tagRelations, backup.tagRelations);
        }
    });
    await check("10000-entity migration pages only names and keeps tagged summary and usage queries bounded", async () => {
        const root = path.join(temporary, "scale"), target = await v1(root);
        target.pragma("journal_mode=WAL");
        const insert = target.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,1)"), body = "Long synthetic body ".repeat(128);
        target.transaction(() => {
            for (let i = 0; i < 10000; i++) insert.run("scale-" + String(i).padStart(5, "0"), "scale-book", ["small", "chapter", "range"][i % 3], "", body, JSON.stringify(["all", "group-" + i % 20, "parity-" + i % 2]), '{}', 1, i);
        })();
        const prepare = target.prepare.bind(target), queries = [];
        target.prepare = sql => { queries.push(sql); return prepare(sql); };
        const start = performance.now();
        try { await ensureAnnotationSchema(target); } finally { target.prepare = prepare; }
        timings.migration10000Ms = performance.now() - start;
        assert.ok(queries.some(sql => /SELECT key,tag FROM notes.*LIMIT 200/.test(sql)));
        assert.ok(!queries.some(sql => /SELECT \* FROM notes|SELECT .*\bnotes\b.*FROM notes/.test(sql)));
        assert.equal(target.prepare("SELECT count(*) n FROM note_tags").get().n, 30000);
        const selected = (await call("tag-list", { scope: "global", limit: 100 }, root)).records.find(t => t.name === "all");
        assert.equal(selected.useCount, 10000);
        const summaries = [], catalogs = [];
        for (let i = 0; i < 20; i++) {
            let begin = performance.now();
            const page = await call("list", { bookKey: "scale-book", kind: "small", tagIds: [selected.id], limit: 50, offset: i * 50 }, root);
            summaries.push(performance.now() - begin); assert.equal(page.records.length, 50); assert.ok(page.records.every(n => n.notes.length <= 160 && n.tagRefs.length === 3));
            begin = performance.now(); await call("tag-list", { scope: "global", limit: 50 }, root); catalogs.push(performance.now() - begin);
        }
        const summary = values => { values.sort((a, b) => a - b); return { p50: values[9], p95: values[18], max: values[19] }; };
        timings.taggedSummary10000Ms = summary(summaries); timings.usageCatalog10000Ms = summary(catalogs);
        assert.equal(target.pragma("integrity_check", { simple: true }), "ok"); assert.equal(target.pragma("foreign_key_check").length, 0);
    });
    await check("packaged ASAR loads scoped service and shared manifest names; JSON is explicitly included in release files", async () => {
        assert.ok(require("../package.json").build.files.includes("src/utils/main/annotation-backup-formats.json"));
        const source = path.resolve(__dirname, "../src/utils/main"), resources = path.join(temporary, "package-resources"), output = path.join(resources, "src/utils/main"), archive = path.join(temporary, "app.asar");
        fs.mkdirSync(output, { recursive: true });
        for (const file of ["annotation-store.js", "annotation-tags.js", "annotation-diagnostics.js", "annotation-backup-formats.json"]) fs.copyFileSync(path.join(source, file), path.join(output, file));
        await require("@electron/asar").createPackage(resources, archive);
        assert.equal(require(path.join(archive, "src/utils/main/annotation-backup-formats.json")).current, "annotations.v2.json");
        const packaged = require(path.join(archive, "src/utils/main/annotation-store.js")).createAnnotationService({ getConnection: connection, Database });
        const result = await packaged({ dbName: "notes", storagePath: storage, action: "tag-list", scope: "book", bookKey: "book-a", limit: 5 }, 9);
        assert.ok(result.records.length > 0);
    });
    const result = { passed: true, cases: checks.length, checks, timings, userDatabaseOpened: false, nativeSqlite: true, schemaVersion: 2 };
    fs.writeFileSync(report, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    close(); app.exit(0);
}).catch(error => { console.error(error); fs.writeFileSync(report, JSON.stringify({ passed: false, checks, error: error.message })); close(); app.exit(1); });
function close() { for (const db of connections.values()) if (db.open) db.close(); }
