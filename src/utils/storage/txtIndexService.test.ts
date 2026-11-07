import { afterEach, expect, it, vi } from "vitest";
vi.mock("../common", () => ({ getStorageLocation: () => "fixture-storage" }));
import { openPersistentTxt } from "./txtIndexService";
afterEach(() => vi.unstubAllGlobals());
it("unwraps structured clone bytes, scopes commits, and reuses successful saves", async () => {
  const bytes = new Uint8Array([0, 65, 66, 0]).subarray(1, 3);
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
      buffer: bytes,
      index,
      encoding: "utf-8",
      persistentSupported: true,
    })
    .mockResolvedValue({ generation: "ready" });
  vi.stubGlobal("window", { electronAPI: { invoke } });
  const opened = await openPersistentTxt("book-1", "", "utf8", "");
  expect(Array.from(new Uint8Array(opened.buffer))).toEqual([65, 66]);
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
