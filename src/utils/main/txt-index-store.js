// Local, rebuildable cache in notes.db. No arbitrary SQL/legacy row converters.
const path = require("node:path");
const crypto = require("node:crypto");
const CONTRACT = Object.freeze({
  parserVersion: 1,
  indexVersion: 1,
  normalizationVersion: 1,
  featureVersion: 1,
});
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
      "prepare",
      "ensure-blocks",
      "build-status",
      "read-preview",
      "cancel-build",
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
const { inspect, inspectAsync, readVerifiedRangeAsync } = require("./txt-source");
const MAX_CHAPTER_READ_BYTES = 256 * 1024;
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
  // Optional additive sparse block metadata. Old valid v1 indexes remain usable.
  if (index.checkpoints !== undefined) {
    const points = index.checkpoints;
    if (!Array.isArray(points) || !points.length || points.length > Math.ceil(index.byteLength / 4096) + 2)
      throw Error("Invalid TXT block checkpoints");
    let byte = index.bomBytes, text = 0;
    points.forEach((point, i) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(integer) ||
        (i === 0 ? point[0] !== byte || point[1] !== 0 : point[0] <= byte || point[0] - byte > 8192 || point[1] < text || point[1] - text > 8192) ||
        point[0] > index.byteLength || point[1] > index.textLength)
        throw Error("Invalid TXT block checkpoint coordinates");
      [byte, text] = point;
    });
    if (byte !== index.byteLength || text !== index.textLength) throw Error("Incomplete TXT block checkpoints");
  }
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
const STAGED = Symbol("private worker generation");
const createTxtIndexService = ({ getConnection, now = Date.now, taskOptions = {} }) => {
  const tickets = new Map(), openingOwners = new Map();
  const { createTxtBuildTasks } = require("./txt-index-tasks");
  const tasks = createTxtBuildTasks({ getConnection, ensureSchema, validateIndex,
    publish: (ticket, t, index, generation, mode) => mode === "checkpoints"
      ? addCheckpoints(ticket, t, index)
      : run({ action: "commit", dbName: "notes", storagePath: t.request.storagePath, ticket, index, [STAGED]: generation }, t.owner),
    ...taskOptions });
  // Add rebuildable acceleration metadata only. Never publish the temporary
  // Worker's chapter IDs, advance a document revision, or mark bindings pending.
  const addCheckpoints = async (ticket, t, scanned) => {
    if (JSON.stringify((await inspectAsync(t.request)).metadata) !== JSON.stringify(t.metadata))
      throw Error("TXT source changed while preparing continuous scrolling");
    const db = await getConnection(t.request.storagePath);
    if (tickets.get(ticket) !== t) throw Error("TXT source closed before checkpoint publication");
    return db.transaction(() => {
      const active = loadActive(db, t.request.bookId);
      if (!active?.index || active.generation !== t.base || t.readGeneration !== t.base ||
          JSON.stringify(active.metadata) !== JSON.stringify(t.metadata))
        throw Error("TXT index changed while preparing continuous scrolling");
      validateIndex(active.index, t.metadata);
      if (active.index.checkpoints) return { generation: active.generation, index: active.index };
      const fields = ["contract", "encoding", "bomBytes", "textLength", "byteLength", "lineCount", "mode"];
      const chapterFields = ["index", "label", "byteStart", "byteEnd", "bodyByteStart", "start", "end", "bodyStart", "firstChars", "lastChars", "lineCount", "size", "recognition", "hasTitle", "fixedChunk"];
      if (!scanned.checkpoints || fields.some(key => JSON.stringify(active.index[key]) !== JSON.stringify(scanned[key])) ||
          active.index.chapters.length !== scanned.chapters.length || active.index.chapters.some((chapter, i) =>
            chapterFields.some(key => chapter[key] !== scanned.chapters[i][key])))
        throw Error("TXT checkpoint scan does not match the existing chapter coordinates");
      const row = db.prepare("SELECT index_json FROM txt_index_generations WHERE book_id=? AND generation=? AND state='ready'").get(t.request.bookId, active.generation);
      const header = { ...JSON.parse(row.index_json), checkpoints: scanned.checkpoints };
      const changed = db.prepare("UPDATE txt_index_generations SET index_json=? WHERE book_id=? AND generation=? AND state='ready' AND index_json=?")
        .run(JSON.stringify(header), t.request.bookId, active.generation, row.index_json);
      if (changed.changes !== 1) throw Error("TXT checkpoints changed concurrently");
      return { generation: active.generation, index: { ...active.index, checkpoints: scanned.checkpoints } };
    })();
  };
  const run = async (c, owner) => {
    validateRequest(c);
    if (c.action === "open") {
      const opening = openingOwners.get(owner) || { version: 0, count: 0 };
      const version = opening.version; opening.count++; openingOwners.set(owner, opening);
      try {
        // Read and validate the actual selected file BEFORE exposing any cached offsets.
        const started = performance.now();
        const snapshot = await inspectAsync(c);
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
            buffer: await readVerifiedRangeAsync(
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
        if (opening.version !== version) throw Error("TXT renderer closed while opening");
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
      } finally {
        if (--opening.count === 0) openingOwners.delete(owner);
      }
    }
    const t = tickets.get(c.ticket);
    if (c.action === "close" && !t) return { closed: true };
    if (!t || t.owner !== owner || t.request.storagePath !== c.storagePath)
      throw new Error("Expired or foreign TXT index ticket");
    if (c.action === "close") {
      tasks.release(c.ticket);
      tickets.delete(c.ticket);
      return { closed: true };
    }
    if (c.action === "prepare") return tasks.prepare(c.ticket, t);
    if (c.action === "ensure-blocks") {
      const db = await getConnection(c.storagePath), active = loadActive(db, t.request.bookId);
      if (!active?.index || active.generation !== t.readGeneration || t.base !== t.readGeneration)
        throw Error("TXT continuous scrolling requires the current ready index");
      validateIndex(active.index, t.metadata);
      if (active.index.checkpoints) return { index: active.index, diagnostics: { workerScans: 0, scannedBytes: 0 } };
      return tasks.prepare(c.ticket, t, "checkpoints");
    }
    if (c.action === "build-status") return tasks.status(c.ticket);
    if (c.action === "cancel-build") { tasks.release(c.ticket); return { cancelled: true }; }
    if (c.action === "read-preview") {
      const chapter = tasks.preview(c.ticket);
      if (!chapter) throw Error("TXT preview unavailable");
      const length = Math.min(MAX_CHAPTER_READ_BYTES, chapter.byteEnd - chapter.byteStart);
      return { buffer: await readVerifiedRangeAsync(t.request, t.metadata, chapter.byteStart, length), encoding: t.metadata.encoding };
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
        JSON.stringify((await inspectAsync(t.request)).metadata) !==
        JSON.stringify(t.metadata)
      )
        throw new Error("TXT source changed; reopen before rebuilding");
      const buffer = await readVerifiedRangeAsync(
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
        JSON.stringify((await inspectAsync(t.request)).metadata) !==
        JSON.stringify(t.metadata)
      )
        throw new Error("TXT source changed; reopen before reading");
      const started = performance.now();
      const buffer = await readVerifiedRangeAsync(
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
    const current = (await inspectAsync(t.request)).metadata;
    if (JSON.stringify(current) !== JSON.stringify(t.metadata))
      throw new Error("TXT source changed; reopen before rebuilding");
    const db = await getConnection(c.storagePath);
    await ensureSchema(db);
    // All scanning, decoding, input validation and filesystem matching happened outside SQL transactions.
    if (tickets.get(c.ticket) !== t) throw Error("TXT source closed before publication");
    const metadataJson = JSON.stringify(t.metadata);
    const generation = c[STAGED] || crypto.randomUUID(),
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
      ...(c.index.checkpoints ? { checkpoints: c.index.checkpoints.map(([byte, text]) => [byte, text]) } : {}),
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
    // or phase-10 reconciliation. Index rebuilding never deletes annotation data.
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
      if (!c[STAGED]) {
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
      } else {
        const staged = db.prepare("SELECT state FROM txt_index_generations WHERE book_id=? AND generation=?").get(t.request.bookId, generation);
        if (staged?.state !== "building") throw Error("TXT staged generation is unavailable");
        db.prepare("UPDATE txt_index_generations SET index_json=?,document_revision=? WHERE book_id=? AND generation=? AND state='building'")
          .run(JSON.stringify(header), revision, t.request.bookId, generation);
      }
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
    if(JSON.stringify((await inspectAsync(t.request)).metadata)!==JSON.stringify(t.metadata))throw new Error("TXT source changed; reopen before annotating");
    const db=await getConnection(t.request.storagePath);
    const row=db.prepare(`SELECT c.*,g.document_revision${typeof withText === "object" ? ",g.index_json" : ""} FROM txt_index_chapters c
      JOIN txt_index_generations g ON g.book_id=c.book_id AND g.generation=c.generation
      JOIN txt_index_documents d ON d.book_id=c.book_id AND d.active_generation=c.generation
      WHERE c.book_id=? AND c.generation=? AND c.chapter_index=? AND c.chapter_id=? AND g.state='ready'`)
      .get(t.request.bookId,t.readGeneration,chapterIndex,chapterId);
    if(!row)throw new Error("Chapter index changed; reopen before annotating");
    const chapter={chapterId:row.chapter_id,index:row.chapter_index,label:row.name,start:row.utf16_start,end:row.utf16_end,
      bodyStart:row.body_utf16_start,byteStart:row.byte_start,byteEnd:row.byte_end,bodyByteStart:row.body_byte_start,
      firstChars:row.first_chars,lastChars:row.last_chars};
    let text, textStart=chapter.start;
    if(withText){
      let byteStart=row.byte_start,byteEnd=row.byte_end,textEnd=chapter.end;
      if(typeof withText==="object"){
        const {start,end}=withText,bodyLength=chapter.end-chapter.bodyStart;
        if(![start,end].every(Number.isSafeInteger)||start<0||end<=start||end>bodyLength||end-start>2*1024*1024)throw Error("Invalid source text range");
        const checkpoints=JSON.parse(row.index_json).checkpoints;
        if(checkpoints){
          const points=checkpoints;
          const first=Math.max(chapter.bodyStart,chapter.bodyStart+start-64),last=Math.min(chapter.end,chapter.bodyStart+end+64);
          let low=0,high=points.length-1;
          while(low<high){const middle=(low+high+1)>>>1;if(points[middle][1]<=first)low=middle;else high=middle-1;}
          [byteStart,textStart]=points[low];if(byteStart<chapter.byteStart){byteStart=chapter.byteStart;textStart=chapter.start;}low=0;high=points.length-1;
          while(low<high){const middle=(low+high)>>>1;if(points[middle][1]<last)low=middle+1;else high=middle;}
          [byteEnd,textEnd]=points[low];if(byteEnd>chapter.byteEnd){byteEnd=chapter.byteEnd;textEnd=chapter.end;}
        }
      }
      const bytes=await readVerifiedRangeAsync(t.request,t.metadata,byteStart,byteEnd-byteStart);
      text=new TextDecoder(t.metadata.encoding,{fatal:true,ignoreBOM:true}).decode(bytes).replace(/\r\n?/g,"\n");
      if(text.length!==textEnd-textStart)throw new Error("Chapter source no longer matches index");
    }
    return {bookId:t.request.bookId,generation:t.readGeneration,documentRevision:row.document_revision,chapter,text,textStart};
  };
  run.releaseOwner = (owner) => {
    const opening = openingOwners.get(owner); if (opening) opening.version++;
    for (const [ticket, state] of tickets)
      if (state.owner === owner) { tasks.release(ticket); tickets.delete(ticket); }
  };
  run.shutdown = () => tasks.shutdown();
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
