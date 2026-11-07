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
export const openPersistentTxt = async (
  bookId: string,
  bookPath: string,
  charset: string,
  parserRegex: string
) => {
  const storagePath = getStorageLocation();
  const invoke = (command: Record<string, unknown>) =>
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
    buffer: Uint8Array;
    index: TxtIndexSnapshot | null;
    encoding: string;
    persistentSupported: boolean;
    cacheHit: boolean;
  };
  console.info(
    `[DIAG][TXTIndex] open ${JSON.stringify({
      cacheHit: response.cacheHit,
      persistentSupported: response.persistentSupported,
      wholeFileReadBytes: response.buffer.byteLength,
      ipcRoundTripMs: Math.round((performance.now() - started) * 10) / 10,
    })}`
  );
  const ticket = response.ticket;
  let cached = response.index;
  return {
    // Electron structured clone returns a Uint8Array, not a Node Buffer.
    buffer: response.buffer.buffer.slice(
      response.buffer.byteOffset,
      response.buffer.byteOffset + response.buffer.byteLength
    ) as ArrayBuffer,
    encoding: response.encoding,
    store: response.persistentSupported
      ? {
          load: async (force: boolean) => (force ? null : cached),
          save: async (index: TxtIndexSnapshot) => {
            await invoke({ action: "commit", ticket, index });
            cached = index;
          },
        }
      : undefined,
  };
};
