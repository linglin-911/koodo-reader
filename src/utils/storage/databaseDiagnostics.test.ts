import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeMeasuredDatabaseRead, invokeMeasuredDatabaseCommand } from "./databaseDiagnostics";

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

describe("measured annotation commands",()=>{
 it("unwraps list and entity results without mistaking list.records for an IPC envelope",async()=>{
   const log=vi.spyOn(console,"info").mockImplementation(()=>{});
   const ids:string[]=[];
   const invoke=async(_channel:string,command:unknown)=>{const {diagnostics}=command as {diagnostics:{requestId:string}};ids.push(diagnostics.requestId);return {result:{records:[{notes:"private-body"}],hasMore:false},diagnostics:{...diagnostics,mainDurationMs:0}};};
   const rows=await Promise.all([invokeMeasuredDatabaseCommand(invoke,{bookKey:"private-book"},{traceId:"reader-test"}),invokeMeasuredDatabaseCommand(invoke,{})]);
   expect(rows[0]).toEqual({records:[{notes:"private-body"}],hasMore:false});expect(new Set(ids).size).toBe(2);
   expect(log.mock.calls.flat().join("")).not.toMatch(/private/);expect(log.mock.calls.flat().join("")).toContain("reader-test");
 });
 it("retains a raw result for old hosts and propagates failed writes even if logging fails",async()=>{
   vi.spyOn(console,"info").mockImplementation(()=>{throw Error("logger");});
   expect(await invokeMeasuredDatabaseCommand(async()=>({key:"one"}),{})).toEqual({key:"one"});
   const error=Error("failed transaction");await expect(invokeMeasuredDatabaseCommand(async()=>{throw error;},{})).rejects.toBe(error);
 });
});
