// Scoped annotation tags. The relation table is authoritative; notes.tag is a
// legacy name projection only. All callers run inside the controlled notes IPC.
const crypto = require("node:crypto");
const text = (value, empty = false) => {
    if (typeof value !== "string" || value.length > 256 || value.includes("\0") || (!empty && !value.trim()))
        throw new Error("Invalid annotation tag");
    return value;
};
const id = value => { text(value); if (!value) throw new Error("Invalid tag identifier"); return value; };
const names = value => {
    if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid annotation tags");
    return [...new Set(value.map(name => text(name, true)))];
};
const globalId = name => "global-" + crypto.createHash("sha256").update(name, "utf8").digest("hex");
const globalTag = name => ({ id: globalId(name), name, scope: "global", book_key: "", version: 1 });
const INSERT_TAG = "INSERT OR IGNORE INTO annotation_tags(id,name,scope,book_key,version) VALUES(@id,@name,@scope,@book_key,@version)";
const insertTag = (db, tag) => db.prepare(INSERT_TAG).run(tag);
const tagRefs = (db, key) => db.prepare(`SELECT t.* FROM note_tags r JOIN annotation_tags t ON t.id=r.tag_id
    WHERE r.note_key=? ORDER BY r.position,t.id`).all(key);
const projection = refs => [...new Set(refs.map(tag => tag.name))];
const refreshProjection = (db, key, increment = false) => db.prepare(`UPDATE notes SET tag=?${increment ? ",version=version+1,updated_at=?" : ""} WHERE key=?`)
    .run(JSON.stringify(projection(tagRefs(db, key))), ...(increment ? [Date.now()] : []), key);
const touchTags = (db, ids) => {
    const update = db.prepare("UPDATE annotation_tags SET version=version+1 WHERE id=?");
    for (const key of new Set(ids)) update.run(key);
};
const migrateTags = db => db.transaction(() => {
    db.exec(`CREATE TABLE annotation_tags(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('global','book')),
      book_key TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),
      CHECK((scope='global' AND book_key='') OR (scope='book' AND book_key!='')),
      UNIQUE(scope,book_key,name));
      CREATE TABLE note_tags(note_key TEXT NOT NULL,tag_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),
      PRIMARY KEY(note_key,tag_id),FOREIGN KEY(note_key) REFERENCES notes(key) ON DELETE CASCADE,
      FOREIGN KEY(tag_id) REFERENCES annotation_tags(id) ON DELETE CASCADE);
      CREATE INDEX note_tags_tag ON note_tags(tag_id,note_key);
      CREATE TRIGGER note_tags_book_insert BEFORE INSERT ON note_tags
      WHEN NOT EXISTS(SELECT 1 FROM notes n JOIN annotation_tags t ON t.id=NEW.tag_id
        WHERE n.key=NEW.note_key AND (t.scope='global' OR t.book_key=n.bookKey))
      BEGIN SELECT RAISE(ABORT,'Cross-book annotation tag'); END;
      CREATE TRIGGER note_tags_book_update BEFORE UPDATE ON note_tags
      WHEN NOT EXISTS(SELECT 1 FROM notes n JOIN annotation_tags t ON t.id=NEW.tag_id
        WHERE n.key=NEW.note_key AND (t.scope='global' OR t.book_key=n.bookKey))
      BEGIN SELECT RAISE(ABORT,'Cross-book annotation tag'); END;`);
    const attach = db.prepare("INSERT INTO note_tags(note_key,tag_id,position) VALUES(?,?,?)"), insert = db.prepare(INSERT_TAG);
    // Materialize bounded name-only pages before writing. better-sqlite3 cannot
    // mutate this connection while an iterator statement is still executing.
    let after;
    for (;;) {
        const page = after === undefined
            ? db.prepare("SELECT key,tag FROM notes ORDER BY key LIMIT 200").all()
            : db.prepare("SELECT key,tag FROM notes WHERE key>? ORDER BY key LIMIT 200").all(after);
        if (!page.length) break;
        for (const row of page) names(JSON.parse(row.tag)).forEach((name, position) => {
            const tag = globalTag(name); insert.run(tag); attach.run(row.key, tag.id, position);
        });
        after = page[page.length - 1].key;
    }
    // Existing formal entity fields, timestamps, versions and bindings stay intact.
    db.prepare("UPDATE annotation_schema SET version=2 WHERE version=1").run();
})();

const resolveTagIds = (db, note, previous) => {
    if (note.tagIds !== undefined) {
        if (!Array.isArray(note.tagIds) || note.tagIds.length > 128) throw new Error("Invalid tag references");
        return [...new Set(note.tagIds.map(id))].map(key => {
            const tag = db.prepare("SELECT * FROM annotation_tags WHERE id=?").get(key);
            if (!tag || (tag.scope === "book" && tag.book_key !== note.bookKey)) throw new Error("Unavailable or cross-book annotation tag");
            return tag.id;
        });
    }
    // Old editors can edit global name tags, but cannot remove/reinterpret local
    // identities they only understand as strings (including same-name scopes).
    const before = previous ? tagRefs(db, previous.key) : [];
    const local = before.filter(tag => tag.scope === "book");
    const selected = local.map(tag => tag.id);
    for (const name of names(note.tag || [])) {
        if (local.some(tag => tag.name === name) && !before.some(tag => tag.scope === "global" && tag.name === name)) continue;
        const tag = globalTag(name); insertTag(db, tag); selected.push(tag.id);
    }
    if (selected.length > 128) throw new Error("Too many annotation tags");
    return [...new Set(selected)];
};
const replaceTagIds = (db, key, selected) => {
    const before = tagRefs(db, key).map(tag => tag.id), old = new Set(before), next = new Set(selected);
    const changed = [...before.filter(key => !next.has(key)), ...selected.filter(key => !old.has(key))];
    db.prepare("DELETE FROM note_tags WHERE note_key=?").run(key);
    const insert = db.prepare("INSERT INTO note_tags(note_key,tag_id,position) VALUES(?,?,?)");
    selected.forEach((tag, position) => insert.run(key, tag, position));
    touchTags(db, changed); refreshProjection(db, key);
};
const count = (db, key) => db.prepare("SELECT count(*) n FROM note_tags WHERE tag_id=?").get(key).n;
const tagDto = (db, tag) => tag ? { ...tag, useCount: count(db, tag.id) } : null;
const localForChange = (db, command) => {
    const tag = db.prepare("SELECT * FROM annotation_tags WHERE id=?").get(id(command.id));
    if (!tag || tag.scope !== "book" || tag.book_key !== id(command.bookKey)) throw new Error("Local tag unavailable");
    if (!Number.isSafeInteger(command.version) || command.version !== tag.version) throw new Error("Tag changed; reload before editing");
    return tag;
};
const runTagCommand = (db, c) => {
    if (c.action === "tag-seed-legacy") {
        if (!Array.isArray(c.names) || c.names.length > 10000) throw new Error("Invalid legacy tag catalog");
        const catalog = [...new Set(c.names.map(name => text(name, true)))];
        return db.transaction(() => {
            const insert = db.prepare(INSERT_TAG);
            for (const name of catalog) insert.run(globalTag(name));
            return { imported: catalog.length };
        })();
    }
    if (c.action === "tag-list") {
        const limit = c.limit ?? 100, offset = c.offset ?? 0;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000)
            throw new Error("Invalid tag page");
        const book = c.bookKey === undefined ? undefined : id(c.bookKey);
        if (c.scope !== undefined && !["global", "book"].includes(c.scope)) throw new Error("Invalid tag scope");
        if (c.scope === "book" && !book) throw new Error("Local tags require a book");
        const where = c.scope === "global" || !book ? "t.scope='global'" : c.scope === "book" ? "t.scope='book' AND t.book_key=?" : "(t.scope='global' OR (t.scope='book' AND t.book_key=?))";
        const rows = db.prepare(`SELECT t.*,(SELECT count(*) FROM note_tags r WHERE r.tag_id=t.id) AS useCount
            FROM annotation_tags t WHERE ${where} ORDER BY t.name,t.scope,t.id LIMIT ? OFFSET ?`)
            .all(...(book && c.scope !== "global" ? [book] : []), limit + 1, offset);
        return { records: rows.slice(0, limit), hasMore: rows.length > limit };
    }
    if (c.action === "tag-create") {
        const name = text(c.name), scope = c.scope;
        if (!["global", "book"].includes(scope)) throw new Error("Invalid tag scope");
        const book = scope === "book" ? id(c.bookKey) : "";
        if (scope === "global" && c.bookKey) throw new Error("Global tags cannot belong to a book");
        return db.transaction(() => {
            const existing = db.prepare("SELECT * FROM annotation_tags WHERE scope=? AND book_key=? AND name=?").get(scope, book, name);
            if (existing) return tagDto(db, existing);
            const tag = scope === "global" ? globalTag(name) : { id: crypto.randomUUID(), name, scope, book_key: book, version: 1 };
            insertTag(db, tag); return tagDto(db, tag);
        })();
    }
    if (c.action === "tag-rename") return db.transaction(() => {
        const source = localForChange(db, c), name = text(c.name);
        if (source.name === name) return { tag: tagDto(db, source), merged: false };
        const target = db.prepare("SELECT * FROM annotation_tags WHERE scope='book' AND book_key=? AND name=?").get(source.book_key, name);
        const affected = db.prepare("SELECT note_key FROM note_tags WHERE tag_id=?").all(source.id).map(row => row.note_key);
        if (target) {
            const affectedCount = db.prepare("SELECT count(DISTINCT note_key) n FROM note_tags WHERE tag_id IN (?,?)").get(source.id, target.id).n;
            if (c.confirmMerge !== true) return { requiresMerge: true, source: tagDto(db, source), target: tagDto(db, target), affectedCount };
            if (c.targetId !== target.id || c.targetVersion !== target.version) throw new Error("Tag changed; reload before merging");
            db.prepare(`INSERT OR IGNORE INTO note_tags(note_key,tag_id,position)
                SELECT note_key,?,position FROM note_tags WHERE tag_id=?`).run(target.id, source.id);
            db.prepare("DELETE FROM annotation_tags WHERE id=?").run(source.id);
            touchTags(db, [target.id]);
            for (const key of affected) refreshProjection(db, key, true);
            return { tag: tagDto(db, db.prepare("SELECT * FROM annotation_tags WHERE id=?").get(target.id)), merged: true, affectedCount };
        }
        if (c.confirmMerge) throw new Error("Merge target changed; reload before editing");
        db.prepare("UPDATE annotation_tags SET name=?,version=version+1 WHERE id=?").run(name, source.id);
        for (const key of affected) refreshProjection(db, key, true);
        return { tag: tagDto(db, db.prepare("SELECT * FROM annotation_tags WHERE id=?").get(source.id)), merged: false };
    })();
    if (c.action === "tag-delete") return db.transaction(() => {
        const source = localForChange(db, c), affectedCount = count(db, source.id);
        if (affectedCount && c.confirmed !== true) return { requiresConfirmation: true, tag: tagDto(db, source), affectedCount };
        const keys = db.prepare("SELECT note_key FROM note_tags WHERE tag_id=?").all(source.id);
        db.prepare("DELETE FROM annotation_tags WHERE id=?").run(source.id);
        for (const { note_key } of keys) refreshProjection(db, note_key, true);
        return { deleted: true, affectedCount };
    })();
    throw new Error("Invalid tag command");
};
const removeLegacyTag = (db, name, kind) => db.transaction(() => {
    // Kept for the old global-name control. It never matches book-local tags.
    const key = globalId(text(name, true));
    const rows = db.prepare("SELECT n.key FROM notes n JOIN note_tags r ON r.note_key=n.key WHERE r.tag_id=? AND n.kind=?").all(key, kind);
    for (const row of rows) {
        db.prepare("DELETE FROM note_tags WHERE note_key=? AND tag_id=?").run(row.key, key);
        refreshProjection(db, row.key, true);
    }
    if (rows.length) touchTags(db, [key]);
    return { updated: true };
})();

// Validate everything before importing a single formal row. V1 names retain
// their original global meaning; V2 identities never collapse by display name.
const backupTags = data => {
    if (data.version === 1) {
        const catalog = new Map(), relations = [];
        for (const note of data.notes) names(JSON.parse(note.tag)).forEach((name, position) => {
            const tag = globalTag(name); catalog.set(tag.id, tag); relations.push({ note_key: note.key, tag_id: tag.id, position });
        });
        return { tags: [...catalog.values()], relations };
    }
    if (!Array.isArray(data.tags) || data.tags.length > 1000000 || !Array.isArray(data.tagRelations) || data.tagRelations.length > 10000000)
        throw new Error("Invalid tag backup");
    const catalog = new Map(), identities = new Set(), notes = new Map(data.notes.map(note => [note.key, note]));
    for (const tag of data.tags) {
        id(tag.id); text(tag.name, true);
        if (!["global", "book"].includes(tag.scope) || (tag.scope === "global" ? tag.book_key !== "" || tag.id !== globalId(tag.name) : !tag.book_key) || !Number.isSafeInteger(tag.version) || tag.version < 1)
            throw new Error("Invalid backup tag identity");
        if (tag.scope === "book") id(tag.book_key);
        const identity = JSON.stringify([tag.scope, tag.book_key, tag.name]);
        if (catalog.has(tag.id) || identities.has(identity) || Object.keys(tag).some(key => !["id", "name", "scope", "book_key", "version"].includes(key)))
            throw new Error("Duplicate or invalid backup tag");
        identities.add(identity); catalog.set(tag.id, tag);
    }
    const unique = new Set(), grouped = new Map();
    for (const row of data.tagRelations) {
        const note = notes.get(row.note_key), tag = catalog.get(row.tag_id), pair = JSON.stringify([row.note_key, row.tag_id]);
        if (!note || !tag || (tag.scope === "book" && tag.book_key !== note.bookKey) || unique.has(pair) || !Number.isSafeInteger(row.position) || row.position < 0 || Object.keys(row).some(key => !["note_key", "tag_id", "position"].includes(key)))
            throw new Error("Invalid backup tag relationship");
        unique.add(pair);
        const refs = grouped.get(note.key) || []; refs.push(tag); grouped.set(note.key, refs);
        if (refs.length > 128) throw new Error("Too many backup tag references");
    }
    for (const note of data.notes) {
        if (JSON.stringify(names(JSON.parse(note.tag)).sort()) !== JSON.stringify(projection(grouped.get(note.key) || []).sort()))
            throw new Error("Backup tag projection mismatch");
    }
    return { tags: data.tags, relations: data.tagRelations };
};
const preflightTagImport = (db, backup, existingNotes) => {
    for (const tag of backup.tags) {
        const current = db.prepare("SELECT * FROM annotation_tags WHERE id=? OR (scope=? AND book_key=? AND name=?)").all(tag.id, tag.scope, tag.book_key, tag.name);
        if (current.some(row => row.id !== tag.id || row.name !== tag.name || row.scope !== tag.scope || row.book_key !== tag.book_key))
            throw new Error("Tag restore conflict");
    }
    const byNote = new Map();
    for (const row of backup.relations) { const refs = byNote.get(row.note_key) || []; refs.push(row); byNote.set(row.note_key, refs); }
    for (const key of existingNotes) {
        const current = db.prepare("SELECT tag_id,position FROM note_tags WHERE note_key=? ORDER BY tag_id").all(key);
        const incoming = new Map((byNote.get(key) || []).map(({ tag_id, position }) => [tag_id, position]));
        if (current.length !== incoming.size || current.some(row => incoming.get(row.tag_id) !== row.position))
            throw new Error("Tag relationship restore conflict");
    }
};
const importTagRows = (db, backup) => {
    const existing = new Set();
    for (const tag of backup.tags) {
        if (db.prepare("SELECT 1 FROM annotation_tags WHERE id=?").get(tag.id)) existing.add(tag.id);
        insertTag(db, tag);
        db.prepare("UPDATE annotation_tags SET version=MAX(version,?) WHERE id=?").run(tag.version, tag.id);
    }
    const changed = new Set(), insert = db.prepare("INSERT OR IGNORE INTO note_tags(note_key,tag_id,position) VALUES(@note_key,@tag_id,@position)");
    for (const row of backup.relations) if (insert.run(row).changes && existing.has(row.tag_id)) changed.add(row.tag_id);
    touchTags(db, changed);
};
module.exports = { migrateTags, tagRefs, resolveTagIds, replaceTagIds, touchTags, removeLegacyTag, runTagCommand, backupTags, preflightTagImport, importTagRows };
