import { afterEach, expect, it, vi } from "vitest";
vi.mock("../common", () => ({ getStorageLocation: () => "fixture-storage" }));
import { openPersistentTxt } from "./txtIndexService";
afterEach(() => vi.unstubAllGlobals());
it("opens without whole-book bytes, scopes commits, and reuses successful saves", async () => {
  const index = {
    contract: {
      parserVersion: 1,
      indexVersion: 1,
      normalizationVersion: 1,
      featureVersion: 1,
    },
    encoding: "utf-8",
    bomBytes: 0,
    textLength: 2,
    byteLength: 2,
    lineCount: 1,
    mode: "fixed-500-lines" as const,
    chapters: [],
  };
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({
      ticket: "ticket-1",

      index,
      encoding: "utf-8",
      persistentSupported: true,
    })
    .mockResolvedValue({ generation: "ready" });
  vi.stubGlobal("window", { electronAPI: { invoke } });
  const opened = await openPersistentTxt("book-1", "", "utf8", "");
  expect(opened.buffer.byteLength).toBe(0);
  expect(await opened.store!.load(false)).toBe(index);
  expect(await opened.store!.load(true)).toBeNull();
  const rebuilt = { ...index, textLength: 1 };
  await opened.store!.save(rebuilt);
  expect(await opened.store!.load(false)).toBe(rebuilt);
  expect(invoke.mock.calls[1]).toEqual([
    "database-command",
    {
      operation: "txt-index",
      dbName: "notes",
      storagePath: "fixture-storage",
      action: "commit",
      ticket: "ticket-1",
      index: rebuilt,
    },
  ]);
});
it("retains the old cached index when a commit fails and leaves unsupported encodings volatile", async () => {
  const old = { fixture: true };
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({
      ticket: "ticket-1",
      buffer: new Uint8Array(),
      index: old,
      encoding: "utf-8",
      persistentSupported: true,
    })
    .mockRejectedValueOnce(new Error("source changed"))
    .mockResolvedValueOnce({
      ticket: null,
      buffer: new Uint8Array([65]),
      index: null,
      encoding: "shift_jis",
      persistentSupported: false,
    });
  vi.stubGlobal("window", { electronAPI: { invoke } });
  const opened = await openPersistentTxt("book-1", "", "utf8", "");
  await expect(
    opened.store!.save(
      {} as Parameters<NonNullable<typeof opened.store>["save"]>[0]
    )
  ).rejects.toThrow("source changed");
  expect(await opened.store!.load(false)).toBe(old);
  expect(
    (await openPersistentTxt("book-2", "", "shift_jis", "")).store
  ).toBeUndefined();
});

it("decodes UTF-8/UTF-16/GBK across IPC boundaries and normalizes split CRLF", async () => {
  const prefix = "x".repeat(256 * 1024 - 1);
  const utf8 = new TextEncoder().encode(prefix + "😀\r\n甲\r乙");
  const wideText = prefix + "😀\r\n甲\r乙";
  const wide = new Uint8Array(wideText.length * 2);
  for (let i = 0; i < wideText.length; i++) {
    wide[2 * i] = wideText.charCodeAt(i) & 255;
    wide[2 * i + 1] = wideText.charCodeAt(i) >> 8;
  }
  const wideBe = wide.slice();
  for (let i = 0; i < wideBe.length; i += 2) {
    const low = wideBe[i];
    wideBe[i] = wideBe[i + 1];
    wideBe[i + 1] = low;
  }
  const gb18030 = new Uint8Array(256 * 1024 + 5).fill(0x78);
  gb18030.set([0x90, 0x30, 0x81, 0x30, 13, 10], 256 * 1024 - 1);
  const gbk = new Uint8Array(256 * 1024 + 5).fill(0x78);
  gbk.set([0xd5, 0xfd, 13, 10, 0xce, 0xc4], 256 * 1024 - 1);
  for (const [encoding, bytes] of [
    ["utf-8", utf8],
    ["utf-8", new TextEncoder().encode(prefix + "\r\n尾")],
    ["utf-16le", wide],
    ["utf-16be", wideBe],
    ["gbk", gbk],
    ["gb18030", gb18030],
  ] as const) {
    const expected = new TextDecoder(encoding)
      .decode(bytes)
      .replace(/\r\n?/g, "\n");
    const invoke = vi.fn(
      async (
        _channel: string,
        config: { action: string; offset: number; length: number }
      ) =>
        config.action === "open"
          ? {
              ticket: "reader",
              encoding,
              persistentSupported: true,
              index: null,
            }
          : {
              buffer: bytes.subarray(
                config.offset,
                config.offset + config.length
              ),
            }
    );
    vi.stubGlobal("window", { electronAPI: { invoke } });
    const source = await openPersistentTxt("book", "", encoding, "");
    const chapter = {
      index: 0,
      chapterId: "chapter",
      byteStart: 0,
      byteEnd: bytes.length,
      start: 0,
      end: expected.length,
    } as Parameters<NonNullable<typeof source.store>["readChapter"]>[0];
    expect(await source.store!.readChapter(chapter)).toBe(expected);
    const reads = invoke.mock.calls
      .map((call) => call[1])
      .filter((c) => c.action === "read-chapter");
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((c) => c.length <= 256 * 1024)).toBe(true);
    await source.store!.close();
    await expect(source.store!.readChapter(chapter)).rejects.toThrow("closed");
  }
});
it("rejects truncated or malformed chapter bytes without returning partial text", async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0xf0, 0x9f])]) {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ticket: "reader",
        encoding: "utf-8",
        persistentSupported: true,
        index: null,
      })
      .mockResolvedValue({ buffer: bytes });
    vi.stubGlobal("window", { electronAPI: { invoke } });
    const source = await openPersistentTxt("book", "", "utf-8", "");
    await expect(
      source.store!.readChapter({
        index: 0,
        chapterId: "chapter",
        byteStart: 0,
        byteEnd: 2,
        start: 0,
        end: 1,
      } as Parameters<NonNullable<typeof source.store>["readChapter"]>[0])
    ).rejects.toThrow();
  }
});
