// Local, rebuildable cache in notes.db. No arbitrary SQL/legacy row converters.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const CONTRACT = Object.freeze({
  parserVersion: 1,
  indexVersion: 1,
  normalizationVersion: 1,
  featureVersion: 1,
});
const SAMPLE_ALGORITHM = "sha256-3x4096-v1";
const migrated = new WeakMap();
const ensureSchema = (db) => {
  if (migrated.has(db)) return migrated.get(db);
  const pending = (async () => {
    const exists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='txt_index_schema'"
      )
      .get();
    const version = exists
      ? db.prepare("SELECT version FROM txt_index_schema WHERE id=1").get()
          ?.version || 0
      : 0;
    if (version > 1) throw new Error("Unsupported TXT index schema version");
    if (version === 0 && db.name !== ":memory:") {
      // SQLite's online backup includes committed WAL contents. A filesystem
      // copy of notes.db alone would not be a consistent pre-migration backup.
      await db.backup(
        db.name + ".pre-txt-index-v1-" + crypto.randomUUID() + ".bak"
      );
    }
    db.transaction(() => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS txt_index_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)"
      );
      const version =
        db.prepare("SELECT version FROM txt_index_schema WHERE id=1").get()
          ?.version || 0;
      if (version > 1) throw new Error("Unsupported TXT index schema version");
      if (version === 0) {
        db.exec(`
          CREATE TABLE txt_index_documents (
            book_id TEXT PRIMARY KEY, active_generation TEXT, document_revision TEXT);
          CREATE TABLE txt_index_generations (
            book_id TEXT NOT NULL, generation TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('building','ready')),
            metadata_json TEXT NOT NULL, index_json TEXT NOT NULL,
            document_revision TEXT NOT NULL, indexed_at INTEGER NOT NULL,
            PRIMARY KEY(book_id,generation));
          CREATE TABLE txt_index_chapters (
            book_id TEXT NOT NULL, generation TEXT NOT NULL, chapter_id TEXT NOT NULL,
            chapter_index INTEGER NOT NULL, name TEXT NOT NULL,
            byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, body_byte_start INTEGER NOT NULL,
            utf16_start INTEGER NOT NULL, utf16_end INTEGER NOT NULL, body_utf16_start INTEGER NOT NULL,
            first_chars TEXT NOT NULL, last_chars TEXT NOT NULL,
            line_count INTEGER NOT NULL, size INTEGER NOT NULL, recognition TEXT NOT NULL,
            has_title INTEGER NOT NULL, fixed_chunk INTEGER NOT NULL,
            PRIMARY KEY(book_id,generation,chapter_index), UNIQUE(book_id,generation,chapter_id));
          INSERT INTO txt_index_schema(id,version) VALUES(1,1);
        `);
      }
    })();
  })();
  migrated.set(db, pending);
  pending.catch(() => migrated.delete(db));
  return pending;
};
const validString = (value, max = 32768) =>
  typeof value === "string" && value.length <= max && !value.includes("\0");
const validateRequest = (c) => {
  if (
    !c ||
    c.dbName !== "notes" ||
    ![
      "open",
      "commit",
      "read-source",
      "read-chapter",
      "read-directory",
      "close",
      "invalidate",
    ].includes(c.action) ||
    !validString(c.storagePath) ||
    !path.isAbsolute(c.storagePath)
  )
    throw new Error("Invalid TXT index command");
  if (
    c.action === "open" &&
    (!validString(c.bookId, 256) ||
      !c.bookId ||
      /[\\/:*?"<>|]/.test(c.bookId) ||
      !validString(c.bookPath || "") ||
      (c.bookPath && !path.isAbsolute(c.bookPath)) ||
      !validString(c.charset || "", 128) ||
      !validString(c.parserRegex || "", 16384))
  )
    throw new Error("Invalid TXT source request");
  if (c.action !== "open" && (!validString(c.ticket, 64) || !c.ticket))
    throw new Error("Invalid TXT index ticket");
};
const resolveSource = (c) => {
  const library = path.join(c.storagePath, "book", c.bookId + ".txt");
  const selected = fs.existsSync(library) ? library : c.bookPath;
  if (!selected) throw new Error("TXT source is unavailable");
  return fs.realpathSync.native(selected);
};
const statIdentity = (file, stat) => {
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid TXT source file");
  return {
    realpath: file,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
};
const sample = (size, read) => {
  const hash = crypto.createHash("sha256");
  const offsets = [
    ...new Set([
      0,
      Math.max(0, Math.floor(size / 2) - 2048),
      Math.max(0, size - 4096),
    ]),
  ];
  for (const start of offsets) {
    const length = Math.min(4096, size - start);
    hash.update(`${start}:${length}:`);
    hash.update(read(start, length));
  }
  return hash.digest("hex");
};
const encodingOf = (bytes, charset) => {
  let encoding = new TextDecoder(charset || "utf-8").encoding;
  let bomBytes = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    bomBytes = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    bomBytes = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    bomBytes = 2;
  }
  return { encoding, bomBytes };
};
// Sampling is a lightweight change detector, never a complete content proof.
const inspect = (c) => {
  const file = resolveSource(c);
  const fd = fs.openSync(file, "r");
  try {
    const identity = statIdentity(file, fs.fstatSync(fd, { bigint: true }));
    const read = (start, length) => {
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const count = fs.readSync(
          fd,
          buffer,
          total,
          length - total,
          start + total
        );
        if (!count) throw new Error("TXT file changed during read");
        total += count;
      }
      return buffer;
    };
    const sampleFingerprint = sample(identity.size, read);
    const encoding = encodingOf(read(0, Math.min(4, identity.size)), c.charset);
    // Inspection remains bounded. Cold source data is read only through the
    // explicit read-source operation, after the SQLite cache has been checked.
    const after = statIdentity(file, fs.fstatSync(fd, { bigint: true }));
    const currentFile = resolveSource(c);
    // Electron's patched statSync can report dev=0 on Windows; use fstat for
    // both descriptors so volume/inode comparisons use the same native API.
    const currentFd = fs.openSync(currentFile, "r");
    let current;
    try {
      current = statIdentity(
        currentFile,
        fs.fstatSync(currentFd, { bigint: true })
      );
    } finally {
      fs.closeSync(currentFd);
    }
    if (
      JSON.stringify(identity) !== JSON.stringify(after) ||
      JSON.stringify(identity) !== JSON.stringify(current)
    )
      throw new Error(
        "TXT changed during inspection: " +
          Object.keys(identity)
            .filter(
              (key) =>
                identity[key] !== after[key] || identity[key] !== current[key]
            )
            .join(",")
      );
    const metadata = {
      identity,
      ...encoding,
      sampleFingerprint,
      sampleAlgorithm: SAMPLE_ALGORITHM,
      contract: CONTRACT,
      configDigest: crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            parserRegex: c.parserRegex || "",
            charset: c.charset || "",
          })
        )
        .digest("hex"),
    };
    return { metadata };
  } finally {
    fs.closeSync(fd);
  }
};
const MAX_CHAPTER_READ_BYTES = 256 * 1024;
const readVerifiedRange = (request, metadata, start, length) => {
  const fd = fs.openSync(metadata.identity.realpath, "r");
  try {
    const sameIdentity = (stat) =>
      JSON.stringify(statIdentity(metadata.identity.realpath, stat)) ===
      JSON.stringify(metadata.identity);
    if (!sameIdentity(fs.fstatSync(fd, { bigint: true })))
      throw new Error("TXT source changed; reopen before reading");
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const count = fs.readSync(
        fd,
        buffer,
        total,
        length - total,
        start + total
      );
      if (!count) throw new Error("TXT source changed during range read");
      total += count;
    }
    if (
      !sameIdentity(fs.fstatSync(fd, { bigint: true })) ||
      JSON.stringify(inspect(request).metadata) !== JSON.stringify(metadata)
    ) {
      throw new Error("TXT source changed during range read");
    }
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
};
const loadActive = (db, bookId) => {
  const row = db
    .prepare(
      `SELECT g.* FROM txt_index_documents d JOIN txt_index_generations g
    ON d.book_id=g.book_id AND d.active_generation=g.generation
    WHERE d.book_id=? AND g.state='ready'`
    )
    .get(bookId);
  if (!row) return null;
  const chapters = db
    .prepare(
      `SELECT chapter_id AS chapterId,chapter_index AS 'index',name AS label,
    byte_start AS byteStart,byte_end AS byteEnd,body_byte_start AS bodyByteStart,
    utf16_start AS start,utf16_end AS end,body_utf16_start AS bodyStart,
    first_chars AS firstChars,last_chars AS lastChars,line_count AS lineCount,size,recognition,
    has_title AS hasTitle,fixed_chunk AS fixedChunk FROM txt_index_chapters
    WHERE book_id=? AND generation=? ORDER BY chapter_index`
    )
    .all(bookId, row.generation)
    .map((c) => ({ ...c, hasTitle: !!c.hasTitle, fixedChunk: !!c.fixedChunk }));
  try {
    return {
      generation: row.generation,
      metadata: JSON.parse(row.metadata_json),
      index: { ...JSON.parse(row.index_json), chapters },
    };
  } catch {
    // Cache corruption is a miss, while retaining the generation for compare-and-swap.
    return { generation: row.generation, metadata: null, index: null };
  }
};
const validateIndex = (index, metadata) => {
  const integer = (n) => Number.isSafeInteger(n) && n >= 0;
  if (
    !index ||
    JSON.stringify(index.contract) !== JSON.stringify(CONTRACT) ||
    index.encoding !== metadata.encoding ||
    index.bomBytes !== metadata.bomBytes ||
    index.byteLength !== metadata.identity.size ||
    !integer(index.textLength) ||
    index.textLength > index.byteLength * 2 ||
    !integer(index.lineCount) ||
    !["chapter-headings", "fixed-500-lines"].includes(index.mode) ||
    !Array.isArray(index.chapters) ||
    !index.chapters.length ||
    index.chapters.length > 1000000
  )
    throw new Error("Invalid TXT index header");
  let previousByte = index.bomBytes,
    previousText = 0;
  const ids = new Set();
  index.chapters.forEach((c, i) => {
    if (
      c.index !== i ||
      !validString(c.chapterId, 64) ||
      !c.chapterId ||
      ids.has(c.chapterId) ||
      !validString(c.label, 65536) ||
      !validString(c.firstChars, 4) ||
      !validString(c.lastChars, 4) ||
      ![
        c.byteStart,
        c.byteEnd,
        c.bodyByteStart,
        c.start,
        c.end,
        c.bodyStart,
        c.lineCount,
        c.size,
      ].every(integer) ||
      c.byteStart < previousByte ||
      c.byteStart > c.bodyByteStart ||
      c.bodyByteStart > c.byteEnd ||
      c.byteEnd > index.byteLength ||
      c.start < previousText ||
      c.start > c.bodyStart ||
      c.bodyStart > c.end ||
      c.end > index.textLength ||
      typeof c.hasTitle !== "boolean" ||
      typeof c.fixedChunk !== "boolean" ||
      c.recognition !==
        (c.fixedChunk ? "fixed" : c.hasTitle ? "heading" : "preamble")
    )
      throw new Error("Invalid TXT chapter coordinates");
    ids.add(c.chapterId);
    previousByte = c.byteEnd;
    previousText = c.end;
  });
};
const createTxtIndexService = ({ getConnection, now = Date.now }) => {
  const tickets = new Map();
  const run = async (c, owner) => {
    validateRequest(c);
    if (c.action === "open") {
      // Read and validate the actual selected file BEFORE exposing any cached offsets.
      const started = performance.now();
      const snapshot = inspect(c);
      const sourceReadAndValidationMs = performance.now() - started;
      const persistentSupported = [
        "utf-8",
        "gbk",
        "gb18030",
        "utf-16le",
        "utf-16be",
        "windows-1252",
      ].includes(snapshot.metadata.encoding);
      if (!persistentSupported)
        return {
          ticket: null,
          index: null,
          buffer: readVerifiedRange(
            c,
            snapshot.metadata,
            0,
            snapshot.metadata.identity.size
          ),
          encoding: snapshot.metadata.encoding,
          cacheHit: false,
          persistentSupported,
          transitionWholeFileRead: true,
        };
      const schemaStarted = performance.now();
      const db = await getConnection(c.storagePath);
      await ensureSchema(db);
      const connectionAndSchemaMs = performance.now() - schemaStarted;
      const sqlStarted = performance.now();
      const active = loadActive(db, c.bookId);
      let index =
        active &&
        JSON.stringify(active.metadata) === JSON.stringify(snapshot.metadata)
          ? active.index
          : null;
      if (index) {
        try {
          validateIndex(index, snapshot.metadata);
        } catch {
          index = null;
        }
      }
      const sqlLoadAndValidationMs = performance.now() - sqlStarted;
      const ticket = crypto.randomUUID();
      // Reading and pre-caching the same book can coexist in one renderer.
      // Do not expire a live reader merely because it stayed on a page for a while.
      if (tickets.size >= 128) throw new Error("Too many open TXT sources");
      tickets.set(ticket, {
        owner,
        databasePath: db.name,
        request: {
          bookId: c.bookId,
          bookPath: c.bookPath || "",
          storagePath: c.storagePath,
          charset: c.charset || "",
          parserRegex: c.parserRegex || "",
        },
        metadata: snapshot.metadata,
        base: active?.generation || null,
        readGeneration: index ? active.generation : null,
        createdAt: now(),
      });
      return {
        ticket,
        index,
        byteLength: snapshot.metadata.identity.size,
        bomBytes: snapshot.metadata.bomBytes,
        encoding: snapshot.metadata.encoding,
        cacheHit: !!index,
        persistentSupported,
        transitionWholeFileRead: false,
        diagnostics: {
          sourceReadAndValidationMs,
          connectionAndSchemaMs,
          sqlLoadAndValidationMs,
          wholeFileReadBytes: 0,
        },
      };
    }
    const t = tickets.get(c.ticket);
    if (c.action === "close" && !t) return { closed: true };
    if (!t || t.owner !== owner || t.request.storagePath !== c.storagePath)
      throw new Error("Expired or foreign TXT index ticket");
    if (c.action === "close") {
      tickets.delete(c.ticket);
      return { closed: true };
    }
    if (c.action === "read-directory") {
      // Use the immutable generation pinned by this reader, not the active
      // pointer (which another reader may have invalidated/rebuilt). No source-file I/O.
      const db = await getConnection(c.storagePath);
      const generation = db.prepare(`SELECT generation FROM txt_index_generations
        WHERE book_id=? AND generation=? AND state='ready'`)
        .get(t.request.bookId, t.readGeneration);
      if (!generation) throw new Error("TXT directory unavailable; prepare the index first");
      const chapters = db.prepare(`SELECT chapter_id AS chapterId,chapter_index AS "index",name AS label
        FROM txt_index_chapters WHERE book_id=? AND generation=? ORDER BY chapter_index`)
        .all(t.request.bookId, t.readGeneration);
      return { generation: t.readGeneration, chapters };
    }
    if (c.action === "read-source") {
      const started = performance.now();
      if (
        JSON.stringify(inspect(t.request).metadata) !==
        JSON.stringify(t.metadata)
      )
        throw new Error("TXT source changed; reopen before rebuilding");
      const buffer = readVerifiedRange(
        t.request,
        t.metadata,
        0,
        t.metadata.identity.size
      );
      return {
        buffer,
        diagnostics: {
          sourceBytes: buffer.byteLength,
          sourceReadMs: performance.now() - started,
        },
      };
    }
    if (c.action === "read-chapter") {
      if (
        ![c.chapterIndex, c.offset, c.length].every(
          (n) => Number.isSafeInteger(n) && n >= 0
        ) ||
        !validString(c.chapterId, 64) ||
        c.length > MAX_CHAPTER_READ_BYTES
      )
        throw new Error("Invalid TXT chapter read");
      const db = await getConnection(c.storagePath);
      const chapter = db
        .prepare(
          `SELECT c.* FROM txt_index_chapters c JOIN txt_index_generations g
        ON c.book_id=g.book_id AND c.generation=g.generation
        WHERE c.book_id=? AND c.generation=? AND c.chapter_index=? AND c.chapter_id=? AND g.state='ready'`
        )
        .get(t.request.bookId, t.readGeneration, c.chapterIndex, c.chapterId);
      if (
        !chapter ||
        c.offset > chapter.byte_end - chapter.byte_start ||
        c.length > chapter.byte_end - chapter.byte_start - c.offset
      )
        throw new Error("TXT chapter range is unavailable");
      if (
        JSON.stringify(inspect(t.request).metadata) !==
        JSON.stringify(t.metadata)
      )
        throw new Error("TXT source changed; reopen before reading");
      const started = performance.now();
      const buffer = readVerifiedRange(
        t.request,
        t.metadata,
        chapter.byte_start + c.offset,
        c.length
      );
      return {
        buffer,
        diagnostics: {
          chapterIndex: c.chapterIndex,
          chapterBytes: buffer.byteLength,
          rangeReadMs: performance.now() - started,
        },
      };
    }
    if (c.action === "invalidate") {
      const db = await getConnection(c.storagePath);
      db.prepare(
        "UPDATE txt_index_documents SET active_generation=NULL,document_revision=NULL WHERE book_id=? AND active_generation IS ?"
      ).run(t.request.bookId, t.base);
      // Leave immutable rows available to already-open readers. The next rebuild
      // prunes unpinned rows back to active/previous generations.
      return { invalidated: true };
    }
    validateIndex(c.index, t.metadata);
    const current = inspect(t.request).metadata;
    if (JSON.stringify(current) !== JSON.stringify(t.metadata))
      throw new Error("TXT source changed; reopen before rebuilding");
    const db = await getConnection(c.storagePath);
    await ensureSchema(db);
    // All scanning, decoding, input validation and filesystem matching happened outside SQL transactions.
    const metadataJson = JSON.stringify(t.metadata);
    const generation = crypto.randomUUID(),
      revision = crypto.randomUUID();
    const { chapters } = c.index;
    // Whitelist every persisted field: an extra renderer payload must never
    // turn this local index into a storage location for full book text/HTML.
    const header = {
      contract: CONTRACT,
      encoding: c.index.encoding,
      bomBytes: c.index.bomBytes,
      textLength: c.index.textLength,
      byteLength: c.index.byteLength,
      lineCount: c.index.lineCount,
      mode: c.index.mode,
    };
    const previousGeneration =
      t.base ||
      db
        .prepare(
          "SELECT generation FROM txt_index_generations WHERE book_id=? AND state='ready' ORDER BY indexed_at DESC,rowid DESC LIMIT 1"
        )
        .get(t.request.bookId)?.generation;
    const retained = new Set([generation, previousGeneration].filter(Boolean));
    // Already-open readers pin their immutable generation. Repeated cache clearing
    // must not delete rows still needed for the next chapter read in another tab.
    for (const state of tickets.values()) {
      if (
        state.databasePath === db.name &&
        state.request.bookId === t.request.bookId &&
        state.readGeneration
      )
        retained.add(state.readGeneration);
    }
    // Formal bindings keep their old snapshots available until explicit unlink
    // or phase-5 reconciliation. Index rebuilding never deletes annotation data.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='annotation_schema'").get()) {
      for (const table of ["note_bindings", "chapter_bindings", "range_bindings"]) {
        for (const row of db.prepare(`SELECT DISTINCT generation FROM ${table} WHERE book_id=? AND status!='unbound' AND generation IS NOT NULL`).all(t.request.bookId))
          retained.add(row.generation);
      }
    }
    const retainedValues = [...retained];
    const retainedSql = retainedValues.map(() => "?").join(",");
    const commitStarted = performance.now();
    db.transaction(() => {
      const active = db
        .prepare(
          "SELECT active_generation FROM txt_index_documents WHERE book_id=?"
        )
        .get(t.request.bookId);
      if ((active?.active_generation || null) !== t.base)
        throw new Error(
          "TXT index changed concurrently; reopen before rebuilding"
        );
      db.prepare(
        `INSERT INTO txt_index_generations VALUES(?,?,'building',?,?,?,?)`
      ).run(
        t.request.bookId,
        generation,
        metadataJson,
        JSON.stringify(header),
        revision,
        now()
      );
      const insert = db.prepare(
        "INSERT INTO txt_index_chapters VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const ch of chapters)
        insert.run(
          t.request.bookId,
          generation,
          ch.chapterId,
          ch.index,
          ch.label,
          ch.byteStart,
          ch.byteEnd,
          ch.bodyByteStart,
          ch.start,
          ch.end,
          ch.bodyStart,
          ch.firstChars,
          ch.lastChars,
          ch.lineCount,
          ch.size,
          ch.recognition,
          +ch.hasTitle,
          +ch.fixedChunk
        );
      db.prepare(
        "UPDATE txt_index_generations SET state='ready' WHERE book_id=? AND generation=?"
      ).run(t.request.bookId, generation);
      db.prepare(
        `INSERT INTO txt_index_documents VALUES(?,?,?) ON CONFLICT(book_id) DO UPDATE
        SET active_generation=excluded.active_generation,document_revision=excluded.document_revision`
      ).run(t.request.bookId, generation, revision);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='annotation_schema'").get()) {
        for (const table of ["note_bindings", "chapter_bindings", "range_bindings"]) {
          db.prepare(`UPDATE ${table} SET status='pending',version=version+1 WHERE book_id=? AND generation IS NOT ? AND status='active'`)
            .run(t.request.bookId,generation);
        }
      }
      // Index generations are rebuildable cache; retain generations referenced
      // by formal bindings and open readers before collecting old entries.
      for (const table of ["txt_index_chapters", "txt_index_generations"]) {
        db.prepare(
          `DELETE FROM ${table} WHERE book_id=? AND generation NOT IN (${retainedSql})`
        ).run(t.request.bookId, ...retainedValues);
      }
    })();
    t.base = generation;
    t.readGeneration = generation;
    return {
      generation,
      documentRevision: revision,
      chapterCount: chapters.length,
      diagnostics: { batchCommitMs: performance.now() - commitStarted },
    };
  };
  run.describeChapter = async (owner,ticket,chapterIndex,chapterId,withText=false) => {
    if (!validString(ticket,64) || !Number.isSafeInteger(chapterIndex) || chapterIndex<0 || !validString(chapterId,64)) throw new Error("Invalid chapter snapshot request");
    const t=tickets.get(ticket);
    if(!t||t.owner!==owner||!t.readGeneration)throw new Error("TXT source unavailable; reopen before annotating");
    if(JSON.stringify(inspect(t.request).metadata)!==JSON.stringify(t.metadata))throw new Error("TXT source changed; reopen before annotating");
    const db=await getConnection(t.request.storagePath);
    const row=db.prepare(`SELECT c.*,g.document_revision FROM txt_index_chapters c
      JOIN txt_index_generations g ON g.book_id=c.book_id AND g.generation=c.generation
      JOIN txt_index_documents d ON d.book_id=c.book_id AND d.active_generation=c.generation
      WHERE c.book_id=? AND c.generation=? AND c.chapter_index=? AND c.chapter_id=? AND g.state='ready'`)
      .get(t.request.bookId,t.readGeneration,chapterIndex,chapterId);
    if(!row)throw new Error("Chapter index changed; reopen before annotating");
    const chapter={chapterId:row.chapter_id,index:row.chapter_index,label:row.name,start:row.utf16_start,end:row.utf16_end,
      bodyStart:row.body_utf16_start,byteStart:row.byte_start,byteEnd:row.byte_end,bodyByteStart:row.body_byte_start,
      firstChars:row.first_chars,lastChars:row.last_chars};
    let text;
    if(withText){const bytes=readVerifiedRange(t.request,t.metadata,row.byte_start,row.byte_end-row.byte_start);
      text=new TextDecoder(t.metadata.encoding,{fatal:true,ignoreBOM:true}).decode(bytes).replace(/\r\n?/g,"\n");
      if(text.length!==chapter.end-chapter.start)throw new Error("Chapter source no longer matches index");}
    return {bookId:t.request.bookId,generation:t.readGeneration,documentRevision:row.document_revision,chapter,text};
  };
  run.releaseOwner = (owner) => {
    for (const [ticket, state] of tickets)
      if (state.owner === owner) tickets.delete(ticket);
  };
  return run;
};
module.exports = {
  createTxtIndexService,
  ensureSchema,
  inspect,
  validateIndex,
  MAX_CHAPTER_READ_BYTES,
  CONTRACT,
};
