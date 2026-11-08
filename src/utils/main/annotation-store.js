const requireChange = result => { if (result.changes !== 1)
    throw new Error("Binding changed; reload before editing"); return result; };
// Formal annotation data. All mutations use this controlled notes.db interface.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const migrations = new WeakMap();
const TABLES = Object.freeze(Object.assign(Object.create(null), {
    small: "note_bindings",
    chapter: "chapter_bindings",
    range: "range_bindings",
}));
const ACTIONS = new Set([
    "export",
    "import",
    "import-database",
    "export-database",
    "drawing-save",
    "get",
    "list",
    "save",
    "delete",
    "remove-tag",
    "style",
    "unbind-all",
    "unbind",
    "undo",
    "bind",
    "reading",
]);
const validString = (value, max = 1024) => typeof value === "string" && value.length <= max && !value.includes("\0");
const requireString = (value, max = 1024) => {
    if (!validString(value, max))
        throw new Error("Invalid annotation text");
    return value;
};
const identifier = (value) => {
    if (!validString(value, 256) || !value)
        throw new Error("Invalid annotation identifier");
    return value;
};
const tags = (value) => {
    if (!Array.isArray(value) ||
        value.length > 128 ||
        value.some((t) => !validString(t, 256)))
        throw new Error("Invalid annotation tags");
    return [...new Set(value)];
};
const pendingStatus = (row) => row.status === "unbound"
    ? "unbound"
    : row.format === "TXT"
        ? "pending"
        : row.status;
const ensureAnnotationSchema = (db) => {
    if (migrations.has(db))
        return migrations.get(db);
    const pending = (async () => {
        db.pragma("foreign_keys=ON");
        const exists = db
            .prepare("SELECT 1 FROM sqlite_master WHERE name='annotation_schema' AND type='table'")
            .get();
        if (exists) {
            if (db.prepare("SELECT version FROM annotation_schema").get()?.version !== 1)
                throw new Error("Unsupported annotation schema");
            return;
        }
        if (db.name !== ":memory:")
            await db.backup(db.name + ".pre-annotations-v1-" + crypto.randomUUID() + ".bak");
        db.transaction(() => {
            // Existing selected-text notes/highlights are authorized disposable fixtures.
            // Drawing rows remain in their own legacy-format table, never text bindings.
            const old = db
                .prepare("SELECT 1 FROM sqlite_master WHERE name='notes' AND type='table'")
                .get();
            if (old) {
                db.exec("CREATE TABLE drawing_notes AS SELECT * FROM notes WHERE notes='annotation'; CREATE UNIQUE INDEX drawing_notes_key ON drawing_notes(key); DROP TABLE notes;");
            }
            db.exec(`CREATE TABLE notes(key TEXT PRIMARY KEY,bookKey TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('small','chapter','range')),
        title TEXT NOT NULL,notes TEXT NOT NULL,tag TEXT NOT NULL,date TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,version INTEGER NOT NULL);
        CREATE INDEX notes_book_kind ON notes(bookKey,kind,updated_at);
        CREATE TABLE annotation_schema(version INTEGER NOT NULL); INSERT INTO annotation_schema VALUES(1);`);
            for (const [kind, table] of Object.entries(TABLES)) {
                db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,note_key TEXT NOT NULL,book_id TEXT NOT NULL,format TEXT NOT NULL,
          generation TEXT,chapter_id TEXT,start_index INTEGER NOT NULL,end_index INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','pending','invalid','unbound')),anchor_json TEXT NOT NULL,
          quote TEXT NOT NULL,prefix TEXT NOT NULL,suffix TEXT NOT NULL,relative_start INTEGER,relative_end INTEGER,
          style TEXT NOT NULL,version INTEGER NOT NULL,unbound_from TEXT,
          FOREIGN KEY(note_key) REFERENCES notes(key) ON DELETE CASCADE);
          CREATE INDEX ${table}_chapter ON ${table}(book_id,generation,start_index,end_index,status);
          CREATE INDEX ${table}_entity ON ${table}(note_key,status);`);
                if (kind !== "small")
                    db.exec(`CREATE UNIQUE INDEX ${table}_one ON ${table}(note_key) WHERE status!='unbound'`);
            }
        })();
    })();
    migrations.set(db, pending);
    pending.catch(() => migrations.delete(db));
    return pending;
};
const bindingDto = (row) => ({
    ...row,
    anchor: JSON.parse(row.anchor_json),
    anchor_json: undefined,
});
const bindings = (db, key) => Object.entries(TABLES).flatMap(([kind, table]) => db
    .prepare(`SELECT * FROM ${table} WHERE note_key=? ORDER BY rowid`)
    .all(key)
    .map((r) => ({ ...bindingDto(r), kind })));
const dto = (db, row, details = true) => {
    if (!row)
        return null;
    const all = details ? bindings(db, row.key) : [];
    const first = details
        ? all.find((b) => b.status !== "unbound")
        : (() => {
            const table = TABLES[row.kind];
            const value = db
                .prepare(`SELECT id,generation,chapter_id,format,status,anchor_json,start_index,style,substr(quote,1,160) AS quote FROM ${table} WHERE note_key=? AND status!='unbound' ORDER BY rowid LIMIT 1`)
                .get(row.key);
            return value
                ? { ...value, anchor: JSON.parse(value.anchor_json) }
                : undefined;
        })();
    const snapshot = first?.anchor.start || first?.anchor.chapter;
    const locator = first?.anchor.locator;
    const location = first
        ? {
            ...(locator?.cfi
                ? JSON.parse(locator.cfi)
                : {
                    chapterDocIndex: String(first.start_index),
                    chapterTitle: snapshot?.label || "",
                    chapterHref: "title" + first.start_index,
                }),
            annotationBindingId: first.id,
            annotationChapterId: first.chapter_id,
            annotationFormat: first.format,
            annotationStatus: first.status,
        }
        : { annotationUnbound: true };
    return {
        ...row,
        tag: JSON.parse(row.tag),
        date: JSON.parse(row.date),
        bindings: all,
        chapter: snapshot?.label || "",
        chapterIndex: first?.start_index ?? -1,
        text: first?.quote || row.text || "",
        cfi: JSON.stringify(location),
        range: locator?.range || "{}",
        percentage: locator?.percentage || "0",
        color: first?.style || "background-#FEF3CD",
    };
};
const exportData = (db) => db.transaction(() => ({
    format: "koodo-annotations",
    version: 1,
    notes: db.prepare("SELECT * FROM notes ORDER BY key").all(),
    bindings: Object.fromEntries(Object.entries(TABLES).map(([kind, table]) => [
        kind,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ])),
    drawings: db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='drawing_notes'")
        .get()
        ? db.prepare("SELECT * FROM drawing_notes").all()
        : [],
}))();
const parseJson = (value) => {
    if (!validString(value, 2 * 1024 * 1024))
        throw new Error("Invalid annotation locator");
    const obj = JSON.parse(value);
    if (!obj || typeof obj !== "object")
        throw new Error("Invalid annotation locator");
    return obj;
};
const boundary = (text, index) => index === 0 ||
    index === text.length ||
    !(text.charCodeAt(index) >= 0xdc00 &&
        text.charCodeAt(index) <= 0xdfff &&
        text.charCodeAt(index - 1) >= 0xd800 &&
        text.charCodeAt(index - 1) <= 0xdbff);
const createAnnotationService = ({ getConnection, describeTxt, Database, loadRegistry = async () => null, }) => {
    const get = async (storage) => {
        if (!validString(storage, 32768) || !path.isAbsolute(storage))
            throw new Error("Invalid annotation storage");
        const db = await getConnection(storage);
        await ensureAnnotationSchema(db);
        return db;
    };
    const drawingDto = async (raw) => raw
        ? { ...(await loadRegistry()).sqliteToJson.notes(raw), kind: "drawing" }
        : null;
    const importData = (db, data) => {
        if (!data ||
            data.format !== "koodo-annotations" ||
            data.version !== 1 ||
            !Array.isArray(data.notes) ||
            data.notes.length > 1000000 ||
            !data.bindings)
            throw new Error("Unsupported annotation backup");
        const noteKeys = new Set(), noteMap = new Map();
        for (const n of data.notes) {
            identifier(n.key);
            identifier(n.bookKey);
            if (!TABLES[n.kind] || noteKeys.has(n.key))
                throw new Error("Invalid backup entity");
            noteKeys.add(n.key);
            noteMap.set(n.key, n);
            requireString(n.notes, 16 * 1024 * 1024);
            requireString(n.title, 4096);
            tags(JSON.parse(n.tag));
            parseJson(n.date);
            if (!Number.isSafeInteger(n.version) ||
                n.version < 1 ||
                ![n.created_at, n.updated_at].every(Number.isSafeInteger))
                throw new Error("Invalid backup version");
        }
        const ids = new Set();
        for (const [kind, table] of Object.entries(TABLES)) {
            const list = data.bindings[kind];
            if (!Array.isArray(list) || list.length > 1000000)
                throw new Error("Invalid binding backup");
            const cardinality = new Set();
            for (const b of list) {
                identifier(b.id);
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(b.id))
                    throw new Error("Invalid backup binding identifier");
                if (ids.has(b.id) ||
                    !noteKeys.has(b.note_key) ||
                    noteMap.get(b.note_key)?.kind !== kind)
                    throw new Error("Invalid backup relationship");
                ids.add(b.id);
                identifier(b.book_id);
                if (noteMap.get(b.note_key).bookKey !== b.book_id)
                    throw new Error("Cross-book backup relationship");
                if (!["active", "pending", "invalid", "unbound"].includes(b.status) ||
                    !validString(b.format, 32) ||
                    ![b.start_index, b.end_index, b.version].every(Number.isSafeInteger) ||
                    b.start_index < 0 ||
                    b.end_index < b.start_index ||
                    b.version < 1)
                    throw new Error("Invalid backup binding");
                if (kind !== "small" && b.status !== "unbound") {
                    if (cardinality.has(b.note_key))
                        throw new Error("Multiple chapter/range bindings");
                    cardinality.add(b.note_key);
                }
                const anchor = parseJson(b.anchor_json);
                requireString(b.quote, 2 * 1024 * 1024);
                requireString(b.prefix, 1024);
                requireString(b.suffix, 1024);
                requireString(b.style, 256);
                if (b.format === "TXT" &&
                    kind === "small" &&
                    (!Number.isSafeInteger(b.relative_start) ||
                        !Number.isSafeInteger(b.relative_end) ||
                        b.relative_start < 0 ||
                        b.relative_end <= b.relative_start ||
                        b.quote.length !== b.relative_end - b.relative_start))
                    throw new Error("Invalid backup text range");
                if (b.format === "TXT" && !anchor.chapter && !anchor.start)
                    throw new Error("Missing chapter snapshot");
            }
        }
        return db.transaction(() => {
            // Preflight every conflict before any mutation. A restore must not silently
            // overwrite newer formal bodies, bindings or unbind operations.
            for (const n of data.notes) {
                const current = db
                    .prepare("SELECT * FROM notes WHERE key=?")
                    .get(n.key);
                if (current && JSON.stringify(current) !== JSON.stringify(n))
                    throw new Error("Annotation restore conflict");
            }
            for (const [kind, table] of Object.entries(TABLES))
                for (const b of data.bindings[kind]) {
                    const current = db
                        .prepare(`SELECT * FROM ${table} WHERE id=?`)
                        .get(b.id);
                    if (current &&
                        JSON.stringify(current) !== JSON.stringify(b) &&
                        JSON.stringify(current) !==
                            JSON.stringify({ ...b, status: pendingStatus(b) }))
                        throw new Error("Binding restore conflict");
                }
            const insertNote = db.prepare("INSERT OR IGNORE INTO notes VALUES(@key,@bookKey,@kind,@title,@notes,@tag,@date,@created_at,@updated_at,@version)");
            for (const n of data.notes)
                insertNote.run(n);
            for (const [kind, table] of Object.entries(TABLES))
                for (const b of data.bindings[kind]) {
                    // Retain original snapshots/quotes. Imported TXT anchors await explicit
                    // rebinding/reconciliation; no cache generation is synchronized/restored.
                    const keys = Object.keys(b);
                    const row = { ...b, status: pendingStatus(b) };
                    const columns = db.pragma(`table_info(${table})`).map((c) => c.name);
                    if (keys.some((k) => !columns.includes(k)))
                        throw new Error("Unexpected backup binding field");
                    db.prepare(`INSERT OR IGNORE INTO ${table}(${columns.join(",")}) VALUES(${columns.map((k) => "@" + k).join(",")})`).run(row);
                }
            if (data.drawings?.length) {
                if (!db
                    .prepare("SELECT 1 FROM sqlite_master WHERE name='drawing_notes'")
                    .get())
                    throw new Error("Drawing schema unavailable");
                const columns = db
                    .pragma("table_info(drawing_notes)")
                    .map((c) => c.name);
                for (const row of data.drawings) {
                    if (Object.keys(row).some((k) => !columns.includes(k)))
                        throw new Error("Invalid drawing backup");
                    db.prepare(`INSERT OR IGNORE INTO drawing_notes(${columns.join(",")}) VALUES(${columns.map((k) => "@" + k).join(",")})`).run(row);
                }
            }
            return { notes: data.notes.length, bindings: ids.size };
        })();
    };
    return async (c, owner) => {
        if (!c || c.dbName !== "notes" || !ACTIONS.has(c.action))
            throw new Error("Invalid annotation command");
        const db = await get(c.storagePath);
        if (c.action === "export")
            return exportData(db);
        if (c.action === "import")
            return importData(db, c.backup);
        if (c.action === "export-database") {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-annotations-export-")), file = path.join(dir, "notes.db");
            try {
                await db.backup(file);
                return fs.readFileSync(file);
            }
            finally {
                if (fs.existsSync(file))
                    fs.unlinkSync(file);
                try {
                    fs.rmdirSync(dir);
                }
                catch { }
            }
        }
        if (c.action === "import-database") {
            if (!Database ||
                !(c.buffer instanceof Uint8Array) ||
                c.buffer.byteLength > 512 * 1024 * 1024)
                throw new Error("Invalid annotation database backup");
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-annotations-restore-")), file = path.join(dir, "notes.db");
            let source;
            try {
                fs.writeFileSync(file, c.buffer);
                source = new Database(file, { readonly: true });
                if (source
                    .prepare("SELECT 1 FROM sqlite_master WHERE name='annotation_schema'")
                    .get())
                    return importData(db, exportData(source));
                // Only old selected-text fixtures are disposable. Preserve drawings
                // through the legacy format adapter without creating text entities.
                const registry = await loadRegistry();
                const hasNotes = source.prepare("SELECT 1 FROM sqlite_master WHERE name='notes' AND type='table'").get();
                const drawings = hasNotes ? source.prepare("SELECT * FROM notes WHERE notes='annotation'").all()
                    .map(row => registry.jsonToSqlite.notes(registry.sqliteToJson.notes(row))) : [];
                return {...importData(db,{format:"koodo-annotations",version:1,notes:[],bindings:{small:[],chapter:[],range:[]},drawings}),legacy:true};
            }
            finally {
                source?.close();
                if (fs.existsSync(file))
                    fs.unlinkSync(file);
                try {
                    fs.rmdirSync(dir);
                }
                catch { }
            }
        }
        if (c.action === "drawing-save") {
            if (c.note?.notes !== "annotation")
                throw new Error("Invalid drawing record");
            const registry = await loadRegistry(), row = registry.jsonToSqlite.notes(c.note), columns = db.pragma("table_info(drawing_notes)").map((x) => x.name);
            if (!columns.length || Object.keys(row).some((k) => !columns.includes(k)))
                throw new Error("Invalid drawing columns");
            db.transaction(() => {
                db.prepare("DELETE FROM drawing_notes WHERE key=?").run(identifier(c.note.key));
                db.prepare(`INSERT INTO drawing_notes(${Object.keys(row).join(",")}) VALUES(${Object.keys(row)
                    .map((k) => "@" + k)
                    .join(",")})`).run(row);
            })();
            return c.note;
        }
        if (c.action === "get") {
            const row = db
                .prepare("SELECT * FROM notes WHERE key=?")
                .get(identifier(c.key));
            return row
                ? dto(db, row)
                : await drawingDto(db.prepare("SELECT * FROM drawing_notes WHERE key=?").get(c.key));
        }
        if (c.action === "list") {
            const limit = c.limit ?? 100, offset = c.offset ?? 0;
            if (!Number.isInteger(limit) ||
                limit < 1 ||
                limit > 200 ||
                !Number.isInteger(offset) ||
                offset < 0 ||
                offset > 10000000)
                throw new Error("Invalid annotation page");
            const where = [], args = [];
            if (c.bookKey) {
                where.push("n.bookKey=?");
                args.push(identifier(c.bookKey));
            }
            if (c.kind) {
                if (!TABLES[c.kind])
                    throw new Error("Invalid annotation kind");
                where.push("n.kind=?");
                args.push(c.kind);
            }
            if (c.tab === "highlight")
                where.push("n.kind='small' AND n.notes=''");
            if (c.tab === "note")
                where.push("(n.kind!='small' OR n.notes!='')");
            if (c.chapterIndex !== undefined) {
                if (!c.bookKey)
                    throw new Error("Related annotations require a book");
                const current = await describeTxt(owner, c.sourceTicket, c.chapterIndex, c.chapterId, false);
                if (current.bookId !== c.bookKey)
                    throw new Error("Cross-book related query");
                where.push("(" +
                    Object.values(TABLES)
                        .map((table) => `EXISTS(SELECT 1 FROM ${table} b WHERE b.note_key=n.key AND b.status='active' AND b.generation=? AND b.start_index<=? AND b.end_index>=?)`)
                        .join(" OR ") +
                    ")");
                for (const table of Object.values(TABLES))
                    args.push(current.generation, c.chapterIndex, c.chapterIndex);
            }
            if (c.keyword) {
                requireString(c.keyword, 2048);
                where.push("(instr(lower(n.notes),lower(?))>0 OR instr(lower(n.title),lower(?))>0 OR EXISTS(SELECT 1 FROM note_bindings b WHERE b.note_key=n.key AND instr(lower(b.quote),lower(?))>0))");
                args.push(c.keyword, c.keyword, c.keyword);
            }
            for (const tag of c.tags ? tags(c.tags) : []) {
                where.push("EXISTS(SELECT 1 FROM json_each(n.tag) WHERE value=?)");
                args.push(tag);
            }
            const rows = db
                .prepare(`SELECT n.key,n.bookKey,n.kind,n.title,substr(n.notes,1,160) AS notes,n.tag,n.date,n.version,n.updated_at,
        (SELECT substr(quote,1,160) FROM note_bindings WHERE note_key=n.key AND status!='unbound' LIMIT 1) AS text
        FROM notes n ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY n.updated_at ${c.order === "ASC" ? "ASC" : "DESC"},n.key LIMIT ? OFFSET ?`)
                .all(...args, limit, offset);
            const result = rows.map((row) => dto(db, row, false));
            if (c.tab === "annotation")
                return {
                    records: await Promise.all(db
                        .prepare("SELECT * FROM drawing_notes" +
                        (c.bookKey ? " WHERE bookKey=?" : ""))
                        .all(...(c.bookKey ? [c.bookKey] : []))
                        .map(drawingDto)),
                    hasMore: false,
                };
            return { records: result, hasMore: result.length === limit };
        }
        if (c.action === "save") {
            const n = c.note;
            if (!n || !TABLES[n.kind])
                throw new Error("Invalid annotation entity");
            const key = n.key ? identifier(n.key) : crypto.randomUUID(), book = identifier(n.bookKey), body = requireString(n.notes || "", 16 * 1024 * 1024), title = requireString(n.title || "", 4096), tag = JSON.stringify(tags(n.tag || [])), now = Date.now();
            const old = db.prepare("SELECT * FROM notes WHERE key=?").get(key);
            if (old &&
                (n.version !== old.version ||
                    old.bookKey !== book ||
                    old.kind !== n.kind))
                throw new Error("Annotation changed; reload before saving");
            if (old) {
                const result = db
                    .prepare("UPDATE notes SET notes=?,title=?,tag=?,updated_at=?,version=version+1 WHERE key=? AND version=?")
                    .run(body, title, tag, now, key, n.version);
                if (result.changes !== 1)
                    throw new Error("Annotation changed; reload before saving");
            }
            else
                db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,1)").run(key, book, n.kind, title, body, tag, JSON.stringify({
                    year: new Date().getFullYear(),
                    month: new Date().getMonth() + 1,
                    day: new Date().getDate(),
                }), now, now);
            return dto(db, db.prepare("SELECT * FROM notes WHERE key=?").get(key));
        }
        if (c.action === "delete") {
            const key = identifier(c.key), row = db.prepare("SELECT * FROM notes WHERE key=?").get(key);
            if (row) {
                if (c.version !== row.version)
                    throw new Error("Annotation changed; reload before deleting");
                db.transaction(() => {
                    if (db.prepare("SELECT version FROM notes WHERE key=?").get(key)
                        ?.version !== c.version)
                        throw new Error("Annotation changed; reload before deleting");
                    for (const table of Object.values(TABLES))
                        db.prepare(`DELETE FROM ${table} WHERE note_key=?`).run(key);
                    db.prepare("DELETE FROM notes WHERE key=?").run(key);
                })();
            }
            else
                db.prepare("DELETE FROM drawing_notes WHERE key=?").run(key);
            return { deleted: true };
        }
        if (c.action === "remove-tag") {
            const tag = requireString(c.tag, 256), kind = c.kind || "small";
            if (!TABLES[kind])
                throw new Error("Invalid tag kind");
            db.transaction(() => {
                for (const row of db
                    .prepare("SELECT key,tag FROM notes WHERE kind=?")
                    .all(kind)) {
                    const current = JSON.parse(row.tag);
                    if (current.includes(tag))
                        db.prepare("UPDATE notes SET tag=?,version=version+1,updated_at=? WHERE key=?").run(JSON.stringify(current.filter((value) => value !== tag)), Date.now(), row.key);
                }
            })();
            return { updated: true };
        }
        if (c.action === "style") {
            const row = db
                .prepare("SELECT * FROM note_bindings WHERE id=? AND note_key=?")
                .get(identifier(c.bindingId), identifier(c.noteKey));
            if (!row || row.version !== c.version)
                throw new Error("Binding changed; reload before styling");
            requireChange(db.prepare("UPDATE note_bindings SET style=?,version=version+1 WHERE id=? AND version=?").run(requireString(c.style, 256), row.id, row.version));
            return dto(db, db.prepare("SELECT * FROM notes WHERE key=?").get(row.note_key));
        }
        if (c.action === "unbind-all") {
            const note = db
                .prepare("SELECT * FROM notes WHERE key=?")
                .get(identifier(c.noteKey));
            if (!note)
                throw new Error("Annotation unavailable");
            const table = TABLES[note.kind];
            db.transaction(() => {
                const rows = db.prepare(`SELECT * FROM ${table} WHERE note_key=? AND status!='unbound'`).all(note.key);
                if (!c.versions || Object.keys(c.versions).length !== rows.length || rows.some(row => c.versions[row.id] !== row.version))
                    throw new Error("Bindings changed; reload before unlinking");
                for (const row of rows)
                    requireChange(db.prepare(`UPDATE ${table} SET unbound_from=status,status='unbound',version=version+1 WHERE id=? AND version=?`).run(row.id, row.version));
            })();
            return dto(db, db.prepare("SELECT * FROM notes WHERE key=?").get(note.key));
        }
        if (["unbind", "undo"].includes(c.action)) {
            if (!TABLES[c.kind])
                throw new Error("Invalid binding kind");
            const table = TABLES[c.kind];
            const row = db
                .prepare(`SELECT * FROM ${table} WHERE id=?`)
                .get(identifier(c.bindingId));
            if (!row ||
                row.note_key !== identifier(c.noteKey) ||
                row.version !== c.version)
                throw new Error("Binding changed; reload before editing");
            if (c.action === "unbind") {
                if (row.status === "unbound")
                    throw new Error("Binding already unbound");
                requireChange(db.prepare(`UPDATE ${table} SET unbound_from=status,status='unbound',version=version+1 WHERE id=? AND version=?`).run(row.id, row.version));
            }
            else {
                if (row.status !== "unbound")
                    throw new Error("Binding is not unbound");
                let status = row.unbound_from || "pending";
                if (row.format === "TXT") {
                    status = "pending";
                    if (c.sourceTicket) {
                        try {
                            const snap = await describeTxt(owner, c.sourceTicket, row.start_index, row.chapter_id, false);
                            if (snap.generation === row.generation)
                                status = row.unbound_from || "active";
                        }
                        catch { }
                    }
                }
                requireChange(db.prepare(`UPDATE ${table} SET status=?,unbound_from=NULL,version=version+1 WHERE id=? AND version=?`).run(status, row.id, row.version));
            }
            return dto(db, db.prepare("SELECT * FROM notes WHERE key=?").get(row.note_key));
        }
        if (c.action === "bind") {
            const note = db
                .prepare("SELECT * FROM notes WHERE key=?")
                .get(identifier(c.noteKey));
            if (!note)
                throw new Error("Annotation is unavailable");
            const input = c.binding;
            if (!input || !validString(input.format, 32))
                throw new Error("Invalid binding format");
            let anchor, generation = null, chapterId = null, startIndex, endIndex, quote = "", prefix = "", suffix = "", relativeStart = null, relativeEnd = null;
            if (input.format === "TXT") {
                const first = await describeTxt(owner, input.sourceTicket, input.chapterIndex, input.chapterId, note.kind === "small");
                if (first.bookId !== note.bookKey)
                    throw new Error("Cross-book annotation binding");
                generation = first.generation;
                chapterId = first.chapter.chapterId;
                startIndex = first.chapter.index;
                endIndex = startIndex;
                if (note.kind === "range") {
                    const last = await describeTxt(owner, input.sourceTicket, input.endChapterIndex, input.endChapterId, false);
                    if (last.bookId !== note.bookKey ||
                        last.generation !== generation ||
                        last.chapter.index < startIndex)
                        throw new Error("Invalid continuous chapter range");
                    endIndex = last.chapter.index;
                    const count = db
                        .prepare("SELECT count(*) AS n FROM txt_index_chapters WHERE book_id=? AND generation=? AND chapter_index BETWEEN ? AND ?")
                        .get(note.bookKey, generation, startIndex, endIndex).n;
                    if (count !== endIndex - startIndex + 1)
                        throw new Error("Non-contiguous chapter range");
                    anchor = {
                        start: first.chapter,
                        end: last.chapter,
                        documentRevision: first.documentRevision,
                    };
                }
                else
                    anchor = {
                        chapter: first.chapter,
                        documentRevision: first.documentRevision,
                    };
                if (note.kind === "small") {
                    const body = first.text.slice(first.chapter.bodyStart - first.chapter.start);
                    relativeStart = input.start;
                    relativeEnd = input.end;
                    if (![relativeStart, relativeEnd].every(Number.isSafeInteger) ||
                        relativeStart < 0 ||
                        relativeEnd <= relativeStart ||
                        relativeEnd > body.length ||
                        !boundary(body, relativeStart) ||
                        !boundary(body, relativeEnd))
                        throw new Error("Invalid source text range");
                    quote = body.slice(relativeStart, relativeEnd);
                    prefix = Array.from(body.slice(0, relativeStart)).slice(-32).join("");
                    suffix = Array.from(body.slice(relativeEnd)).slice(0, 32).join("");
                    if (quote.length > 2 * 1024 * 1024)
                        throw new Error("Selection is too long");
                }
            }
            else {
                if (note.kind !== "small" ||
                    input.format === "TXT" ||
                    !Number.isSafeInteger(input.chapterIndex) ||
                    input.chapterIndex < 0)
                    throw new Error("Unsupported format binding");
                parseJson(input.range);
                parseJson(input.cfi);
                startIndex = endIndex = input.chapterIndex;
                quote = requireString(input.quote || "", 2 * 1024 * 1024);
                anchor = {
                    chapter: {
                        index: startIndex,
                        label: requireString(input.chapter || "", 65536),
                    },
                    locator: {
                        range: input.range,
                        cfi: input.cfi,
                        percentage: requireString(input.percentage || "0", 64),
                    },
                };
            }
            const table = TABLES[note.kind], id = crypto.randomUUID();
            db.transaction(() => {
                if (generation &&
                    db
                        .prepare("SELECT active_generation FROM txt_index_documents WHERE book_id=?")
                        .get(note.bookKey)?.active_generation !== generation)
                    throw new Error("Index changed; reopen before binding");
                if (c.replaceId) {
                    const old = db
                        .prepare(`SELECT * FROM ${table} WHERE id=? AND note_key=?`)
                        .get(identifier(c.replaceId), note.key);
                    if (!old ||
                        old.status === "unbound" ||
                        old.version !== c.replaceVersion)
                        throw new Error("Binding changed; reload before replacing");
                    db.prepare(`UPDATE ${table} SET unbound_from=status,status='unbound',version=version+1 WHERE id=?`).run(old.id);
                }
                db.prepare(`INSERT INTO ${table} VALUES(${Array(16).fill("?").join(",")},1,NULL)`).run(id, note.key, note.bookKey, input.format, generation, chapterId, startIndex, endIndex, "active", JSON.stringify(anchor), quote, prefix, suffix, relativeStart, relativeEnd, requireString(input.style || "background-#FEF3CD", 256));
            })();
            return dto(db, db.prepare("SELECT * FROM notes WHERE key=?").get(note.key));
        }
        if (c.action === "reading") {
            const book = identifier(c.bookKey), index = c.chapterIndex;
            if (!Number.isSafeInteger(index) || index < 0)
                throw new Error("Invalid chapter");
            let generation = null;
            if (c.format === "TXT") {
                const current = await describeTxt(owner, c.sourceTicket, index, c.chapterId, false);
                if (current.bookId !== book)
                    throw new Error("Cross-book reading");
                generation = current.generation;
            }
            const rows = db
                .prepare(`SELECT b.*,n.notes!='' AS hasNote FROM note_bindings b JOIN notes n ON n.key=b.note_key
        WHERE b.book_id=? AND b.format=? AND b.start_index=? AND b.status='active' ${generation ? "AND b.generation=?" : ""}`)
                .all(book, c.format, index, ...(generation ? [generation] : []));
            return rows.map((b) => {
                const anchor = JSON.parse(b.anchor_json);
                return {
                    key: b.id,
                    entityKey: b.note_key,
                    bindingId: b.id,
                    hasNote: !!b.hasNote,
                    notes: "",
                    color: b.style,
                    chapterIndex: index,
                    cfi: anchor.locator?.cfi || "{}",
                    range: anchor.locator?.range || "{}",
                    txtAnchor: c.format === "TXT"
                        ? { start: b.relative_start, end: b.relative_end }
                        : undefined,
                };
            });
        }
        throw new Error("Unknown annotation operation");
    };
};
module.exports = {
    createAnnotationService,
    ensureAnnotationSchema,
    exportData,
    TABLES,
};
