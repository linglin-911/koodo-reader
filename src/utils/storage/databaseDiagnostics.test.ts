import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeMeasuredDatabaseRead } from "./databaseDiagnostics";

const command = { statement: "getByBookKeyStatement", statementType: "string" as const,
  executeType: "all" as const, dbName: "notes", data: "private-book", storagePath: "private-path" };

afterEach(() => vi.restoreAllMocks());

describe("measured database reads", () => {
  it("unwraps records and uses a distinct request ID for concurrent reads", async () => {
    const log = vi.spyOn(console,"info").mockImplementation(() => {});
    const ids: string[] = [];
    const invoke = vi.fn(async (_channel: string, config: unknown) => {
      const { diagnostics } = config as { diagnostics: { requestId: string } };
      ids.push(diagnostics.requestId);
      return { records: [{ text: "private text" }], diagnostics: { requestId: diagnostics.requestId, mainDurationMs: 0 } };
    });
    const result = await Promise.all([invokeMeasuredDatabaseRead(invoke,command,{ traceId: "reader-1" }),invokeMeasuredDatabaseRead(invoke,command)]);
    expect(result[0]).toEqual([{ text: "private text" }]);
    expect(new Set(ids).size).toBe(2);
    expect(log.mock.calls.flat().join("")).not.toMatch(/private/);
    expect(log.mock.calls.flat().join("")).toContain("transportAndSchedulingDurationMs");
  });

  it("accepts the old raw-array IPC shape", async () => {
    vi.spyOn(console,"info").mockImplementation(() => {});
    const records = [{ key: "one" }];
    expect(await invokeMeasuredDatabaseRead(async () => records,command)).toBe(records);
  });

  it("propagates database errors even when the logging sink throws", async () => {
    vi.spyOn(console,"info").mockImplementation(() => { throw new Error("sink failure"); });
    const failure = new Error("database failure");
    await expect(invokeMeasuredDatabaseRead(async () => { throw failure; },command)).rejects.toBe(failure);
    expect(await invokeMeasuredDatabaseRead(async () => [],command)).toEqual([]);
  });
});
