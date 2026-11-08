import { getStorageLocation } from "../common";

// The engine owns the detailed v1 wire types; the host transports structured
// values unchanged and never routes these rows through legacy Note converters.
interface TxtIndexSnapshot {
  checkpoints?: [number, number][];
  contract: {
    parserVersion: number;
    indexVersion: number;
    normalizationVersion: number;
    featureVersion: number;
  };
  encoding: string;
  bomBytes: number;
  textLength: number;
  byteLength: number;
  lineCount: number;
  mode: "chapter-headings" | "fixed-500-lines";
  chapters: {
    index: number;
    label: string;
    start: number;
    end: number;
    bodyStart: number;
    byteStart: number;
    byteEnd: number;
    bodyByteStart: number;
    chapterId: string;
    firstChars: string;
    lastChars: string;
    recognition: "heading" | "preamble" | "fixed";
    lineCount: number;
    size: number;
    hasTitle: boolean;
    fixedChunk: boolean;
  }[];
}
export interface TxtDirectory {
  generation: string | null;
  chapters: { chapterId: string; index: number; label: string }[];
}
export interface TxtBuildProgress {
  state: "queued" | "building" | "idle" | "failed" | "cancelled";
  reason?: "line-limit" | "timeout";
  bytes?: number; total?: number; chapters?: number; canPreview?: boolean; preview?: string;
}
interface SourceOptions { signal?: AbortSignal; onProgress?: (progress: TxtBuildProgress | null) => void; }
const CHAPTER_CHUNK_BYTES = 256 * 1024;
type Invoke = (command: Record<string, unknown>) => Promise<unknown>;
type Chapter = TxtIndexSnapshot["chapters"][number];
const createSource = (
  invoke: Invoke,
  ticket: string,
  initial: TxtIndexSnapshot | null,
  encoding: string,
  options: SourceOptions
) => {
  let cached = initial;
  let closed = false;
  const command = (data: Record<string, unknown>) => {
    if (closed) throw new Error("TXT source is closed");
    return invoke({ ticket, ...data });
  };
  let preparing: Promise<TxtIndexSnapshot> | undefined;
  const abort = () => { void source.close().catch(() => {}); };
  const source = {
    sourceTicket: ticket,
    load: async (force: boolean) => {
      if (closed) throw new Error("TXT source is closed");
      return force ? null : cached;
    },
    prepare: (): Promise<TxtIndexSnapshot> => {
      if (preparing) return preparing;
      preparing = (async () => {
        let active = true, timer: ReturnType<typeof setTimeout> | undefined, preview: string | undefined;
        const poll = async () => {
          try {
            const progress = (await command({ action: "build-status" })) as TxtBuildProgress;
            if (progress.canPreview && preview === undefined) {
              try {
                const response = (await command({ action: "read-preview" })) as { buffer: Uint8Array; encoding: string };
                preview = new TextDecoder(response.encoding, { fatal: true, ignoreBOM: true }).decode(response.buffer, { stream: true }).replace(/\r\n?/g, "\n");
              } catch { /* Publication may finish between status and preview. */ }
            }
            if (active && !closed) options.onProgress?.({ ...progress, preview });
          } catch { /* The prepare request owns errors; polling cannot hide them. */ }
          if (active && !closed) timer = setTimeout(poll, 100);
        };
        try {
          const job = command({ action: "prepare" });
          if (options.onProgress) void poll();
          const result = (await job) as { index: TxtIndexSnapshot };
          if (closed) throw new Error("TXT source is closed");
          cached = result.index;
          return result.index;
        } finally { active = false; clearTimeout(timer); if (!closed) options.onProgress?.(null); preparing = undefined; }
      })();
      return preparing;
    },
    save: async (index: TxtIndexSnapshot) => {
      await command({ action: "commit", index });
      cached = index;
    },
    readDirectory: async (): Promise<TxtDirectory> =>
      (await command({ action: "read-directory" })) as TxtDirectory,
    readSource: async () => {
      const result = (await command({ action: "read-source" })) as {
        buffer: Uint8Array;
      };
      return result.buffer;
    },
    readChapterRange: async (chapter: Chapter, offset: number, length: number) => {
      const result = (await command({ action: "read-chapter", chapterIndex: chapter.index, chapterId: chapter.chapterId, offset, length })) as { buffer: Uint8Array };
      if (result.buffer.byteLength !== length) throw new Error("Incomplete TXT block range");
      return result.buffer;
    },
    readChapter: async (chapter: Chapter) => {
      const decoder = new TextDecoder(encoding, {
        fatal: true,
        ignoreBOM: true,
      });
      const parts: string[] = [];
      const total = chapter.byteEnd - chapter.byteStart;
      let offset = 0;
      do {
        const length = Math.min(CHAPTER_CHUNK_BYTES, total - offset);
        const result = (await command({
          action: "read-chapter",
          chapterIndex: chapter.index,
          chapterId: chapter.chapterId,
          offset,
          length,
        })) as { buffer: Uint8Array };
        if (result.buffer.byteLength !== length)
          throw new Error("Incomplete TXT chapter range");
        parts.push(decoder.decode(result.buffer, { stream: true }));
        offset += length;
      } while (offset < total);
      parts.push(decoder.decode());
      // Normalize after joining so a CRLF split across reads remains one LF.
      const text = parts.join("").replace(/\r\n?/g, "\n");
      if (text.length !== chapter.end - chapter.start)
        throw new Error("TXT chapter length changed");
      return text;
    },
    invalidate: async () => {
      await command({ action: "invalidate" });
      cached = null;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener("abort", abort);
      cached = null;
      await invoke({ action: "close", ticket });
    },
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return source;
};
export const openPersistentTxt = async (
  bookId: string,
  bookPath: string,
  charset: string,
  parserRegex: string,
  options: SourceOptions = {}
) => {
  if (options.signal?.aborted) throw new Error("TXT indexing cancelled");
  const storagePath = getStorageLocation();
  const invoke: Invoke = (command) =>
    window.electronAPI.invoke("database-command", {
      operation: "txt-index",
      dbName: "notes",
      storagePath,
      ...command,
    });
  const started = performance.now();
  const response = (await invoke({
    action: "open",
    bookId,
    bookPath,
    charset,
    parserRegex,
  })) as {
    ticket: string | null;
    buffer?: Uint8Array;
    index: TxtIndexSnapshot | null;
    encoding: string;
    persistentSupported: boolean;
    cacheHit: boolean;
  };
  console.info(
    `[DIAG][TXTIndex] open ${JSON.stringify({
      cacheHit: response.cacheHit,
      persistentSupported: response.persistentSupported,
      wholeFileReadBytes: response.buffer?.byteLength || 0,
      ipcRoundTripMs: Math.round((performance.now() - started) * 10) / 10,
    })}`
  );
  // Only the legacy adapter receives a whole buffer. The supported path starts
  // empty; supported cold scans stream through a main-process-owned Worker.
  const legacy = response.buffer;
  return {
    buffer: legacy
      ? (legacy.buffer.slice(
          legacy.byteOffset,
          legacy.byteOffset + legacy.byteLength
        ) as ArrayBuffer)
      : new ArrayBuffer(0),
    encoding: response.encoding,
    cacheHit: response.cacheHit,
    store:
      response.persistentSupported && response.ticket
        ? createSource(
            invoke,
            response.ticket,
            response.index,
            response.encoding,
            options
          )
        : undefined,
  };
};
export const precachePersistentTxt = async (
  bookId: string,
  bookPath: string,
  charset: string,
  parserRegex: string
) => {
  const source = await openPersistentTxt(
    bookId,
    bookPath,
    charset,
    parserRegex
  );
  if (!source.store) return false;
  try {
    const { prepareTxtIndex } = await import("../../assets/lib/kookit.min");
    await prepareTxtIndex(source.store, source.encoding, parserRegex);
    return true;
  } finally {
    await source.store.close();
  }
};
export const clearPersistentTxtCache = async (
  bookId: string,
  bookPath: string,
  charset: string,
  parserRegex: string
) => {
  const source = await openPersistentTxt(
    bookId,
    bookPath,
    charset,
    parserRegex
  );
  if (!source.store) return;
  try {
    await source.store.invalidate();
  } finally {
    await source.store.close();
  }
};

// Imported work retains metadata only and runs serially.
let importQueue: Promise<unknown> = Promise.resolve();
export const queueImportedTxtIndex = (book: { key: string; path: string; charset: string }, parserRegex: string, signal: AbortSignal) => {
  const metadata = { key: book.key, path: book.path, charset: book.charset };
  const job = importQueue.then(async () => {
    const opened = await openPersistentTxt(metadata.key, metadata.path, metadata.charset, parserRegex, { signal });
    try {
      if (opened.store && !opened.cacheHit) await opened.store.prepare();
    } finally { await opened.store?.close(); }
  });
  importQueue = job.catch(() => {});
  return job;
};
