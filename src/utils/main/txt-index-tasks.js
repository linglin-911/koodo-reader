const crypto = require("node:crypto"), path = require("node:path");
const { Worker } = require("node:worker_threads");
const abortError = () => new Error("TXT indexing cancelled");
const rowValues = (book, generation, c) => [book, generation, c.chapterId, c.index, c.label, c.byteStart, c.byteEnd,
  c.bodyByteStart, c.start, c.end, c.bodyStart, c.firstChars, c.lastChars, c.lineCount, c.size, c.recognition, +c.hasTitle, +c.fixedChunk];
const readRows = (db, book, generation) => db.prepare(`SELECT chapter_id AS chapterId,chapter_index AS 'index',name AS label,
  byte_start AS byteStart,byte_end AS byteEnd,body_byte_start AS bodyByteStart,utf16_start AS start,utf16_end AS end,
  body_utf16_start AS bodyStart,first_chars AS firstChars,last_chars AS lastChars,line_count AS lineCount,size,recognition,
  has_title AS hasTitle,fixed_chunk AS fixedChunk FROM txt_index_chapters WHERE book_id=? AND generation=? ORDER BY chapter_index`)
  .all(book, generation).map(c => ({ ...c, hasTitle: !!c.hasTitle, fixedChunk: !!c.fixedChunk }));
module.exports.createTxtBuildTasks = ({ getConnection, ensureSchema, validateIndex, publish,
  workerPath = path.join(__dirname, "txt-index-worker.js"), stallTimeoutMs = 15000, beforeBatch = async () => {},
  onWorker = () => {} }) => {
  const tasks = new Map(), byTicket = new Map(), queue = [];
  let running = false, stopped = false;
  const alive = task => { if (!task.consumers.size || stopped) throw abortError(); };
  async function execute(task) {
    const t = task.source, book = t.request.bookId, db = await getConnection(t.request.storagePath);
    await ensureSchema(db); alive(task);
    // building rows have no reader or binding references. Recover only this
    // book's interrupted cache work; ready/old referenced generations survive.
    db.transaction(() => {
      db.prepare("DELETE FROM txt_index_chapters WHERE book_id=? AND generation IN (SELECT generation FROM txt_index_generations WHERE book_id=? AND state='building')").run(book, book);
      db.prepare("DELETE FROM txt_index_generations WHERE book_id=? AND state='building'").run(book);
      db.prepare("INSERT INTO txt_index_generations VALUES(?,?,'building',?,'{}',?,?)").run(book, task.generation, JSON.stringify(t.metadata), crypto.randomUUID(), Date.now());
    })();
    let worker, watchdog, settled = false;
    try {
      const result = await new Promise((resolve, reject) => {
        const fail = error => { if (!settled) { settled = true; reject(error); } };
        task.cancel = () => fail(abortError());
        worker = new Worker(workerPath, { workerData: { request: t.request, metadata: t.metadata } });
        onWorker(worker);
        let lastActivity = Date.now(), waiting = false;
        watchdog = setInterval(() => { if (!waiting && Date.now() - lastActivity > stallTimeoutMs) fail(Error("TXT indexing Worker timed out")); }, Math.min(stallTimeoutMs, 1000));
        worker.on("error", fail);
        worker.on("exit", code => { if (!settled) fail(Error(`TXT indexing Worker exited before completion (${code})`)); });
        worker.on("message", async message => {
          if (settled) return;
          lastActivity = Date.now();
          try {
            alive(task);
            if (message.type === "progress") { task.bytes = message.bytes; return; }
            if (message.type === "error") throw Error(message.message);
            if (message.type === "done") {
              settled = true;
              resolve({ header: message.header, readBytes: message.readBytes }); return;
            }
            waiting = true;
            if (message.type === "batch") {
              if (!Array.isArray(message.rows) || !message.rows.length || message.rows.length > 128 || JSON.stringify(message.rows).length > 512 * 1024) throw Error("Invalid TXT Worker batch");
              await beforeBatch(message.rows); if (settled) return; alive(task);
              db.transaction(() => {
                const insert = db.prepare("INSERT INTO txt_index_chapters VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
                for (const row of message.rows) {
                  if (row.index !== task.chapters++) throw Error("Unordered TXT Worker batch");
                  insert.run(...rowValues(book, task.generation, row));
                }
              })();
              if (!task.preview) task.preview = message.rows[0];
            } else if (message.type === "reset") {
              db.prepare("DELETE FROM txt_index_chapters WHERE book_id=? AND generation=?").run(book, task.generation); task.chapters = 0;
            } else throw Error("Invalid TXT Worker message");
            alive(task); worker.postMessage("ack"); waiting = false; lastActivity = Date.now();
          } catch (error) { fail(error); }
        });
      });
      alive(task);
      const index = { ...result.header, chapters: readRows(db, book, task.generation) };
      validateIndex(index, t.metadata);
      let publication;
      while (true) {
        alive(task);
        const [ticket, consumer] = task.consumers.entries().next().value;
        try { publication = await publish(ticket, consumer.source, index, task.generation, task.mode); break; }
        catch (error) {
          if (task.consumers.has(ticket) || !task.consumers.size) throw error;
        }
      }
      // A shared task updates every surviving source, so each reader can use its
      // own ticket. No cancelled/closed consumer can revive a released ticket.
      for (const consumer of task.consumers.values()) { consumer.source.base = publication?.generation || task.generation; consumer.source.readGeneration = publication?.generation || task.generation; }
      task.bytes = t.metadata.identity.size;
      return { index: publication?.index || index, diagnostics: { workerScans: 1, scannedBytes: result.readBytes, maximumBatchRows: 128 } };
    } finally {
      clearInterval(watchdog);
      if (worker) await worker.terminate();
      db.transaction(() => {
        // Never erase a generation that was successfully published ready.
        db.prepare("DELETE FROM txt_index_chapters WHERE book_id=? AND generation=? AND EXISTS(SELECT 1 FROM txt_index_generations WHERE book_id=? AND generation=? AND state='building')").run(book, task.generation, book, task.generation);
        db.prepare("DELETE FROM txt_index_generations WHERE book_id=? AND generation=? AND state='building'").run(book, task.generation);
      })();
    }
  }
  async function pump() {
    if (running || stopped) return;
    const task = queue.shift(); if (!task) return;
    running = true;
    try {
      task.state = "building";
      const result = await execute(task);
      for (const consumer of task.consumers.values()) consumer.resolve(result);
    } catch (error) { for (const consumer of task.consumers.values()) consumer.reject(error); }
    finally {
      for (const ticket of task.consumers.keys()) byTicket.delete(ticket);
      task.consumers.clear();
      if (tasks.get(task.key) === task) tasks.delete(task.key); running = false; void pump();
    }
  }
  return {
    prepare(ticket, source, mode = "rebuild") {
      if (stopped) return Promise.reject(abortError());
      if (byTicket.has(ticket)) {
        const pending = byTicket.get(ticket);
        return pending.mode === mode ? pending.consumers.get(ticket).promise : Promise.reject(Error("TXT source already has another build task"));
      }
      const key = JSON.stringify([source.databasePath, source.request.bookId, source.metadata, source.base, mode]);
      let task = tasks.get(key);
      if (!task) {
        if (tasks.size >= 16) return Promise.reject(Error("TXT indexing queue is full"));
        task = { key, source, mode, generation: crypto.randomUUID(), consumers: new Map(), bytes: 0, chapters: 0, state: "queued" };
        tasks.set(key, task); queue.push(task);
      }
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      task.consumers.set(ticket, { source, resolve, reject, promise }); byTicket.set(ticket, task);
      void pump(); return promise;
    },
    status(ticket) { const t = byTicket.get(ticket); return t ? { state: t.state, bytes: t.bytes, total: t.source.metadata.identity.size, chapters: t.chapters, canPreview: !!t.preview } : { state: "idle" }; },
    preview(ticket) { return byTicket.get(ticket)?.preview; },
    release(ticket) {
      const task = byTicket.get(ticket); if (!task) return;
      task.consumers.get(ticket).reject(abortError()); task.consumers.delete(ticket); byTicket.delete(ticket);
      if (!task.consumers.size) {
        if (tasks.get(task.key) === task) tasks.delete(task.key);
        const queued = queue.indexOf(task); if (queued >= 0) queue.splice(queued, 1);
        task.cancel?.();
      }
    },
    shutdown() { stopped = true; for (const ticket of byTicket.keys()) this.release(ticket); queue.length = 0; tasks.clear(); },
  };
};
