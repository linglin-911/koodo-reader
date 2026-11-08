import { getStorageLocation } from "../common";

// The engine owns the detailed v1 wire types; the host transports structured
// values unchanged and never routes these rows through legacy Note converters.
interface TxtIndexSnapshot {
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
const CHAPTER_CHUNK_BYTES = 256 * 1024;
type Invoke = (command: Record<string, unknown>) => Promise<unknown>;
type Chapter = TxtIndexSnapshot["chapters"][number];
const createSource = (
  invoke: Invoke,
  ticket: string,
  initial: TxtIndexSnapshot | null,
  encoding: string
) => {
  let cached = initial;
  let closed = false;
  const command = (data: Record<string, unknown>) => {
    if (closed) throw new Error("TXT source is closed");
    return invoke({ ticket, ...data });
  };
  return {
    sourceTicket: ticket,
    load: async (force: boolean) => {
      if (closed) throw new Error("TXT source is closed");
      return force ? null : cached;
    },
    save: async (index: TxtIndexSnapshot) => {
      await command({ action: "commit", index });
      cached = index;
    },
    readSource: async () => {
      const result = (await command({ action: "read-source" })) as {
        buffer: Uint8Array;
      };
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
      cached = null;
      await invoke({ action: "close", ticket });
    },
  };
};
export const openPersistentTxt = async (
  bookId: string,
  bookPath: string,
  charset: string,
  parserRegex: string
) => {
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
  // empty; cold scan data lives exclusively inside prepareTxtIndex's call frame.
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
            response.encoding
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
