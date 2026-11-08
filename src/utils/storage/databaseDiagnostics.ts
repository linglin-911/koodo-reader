export interface DatabaseReadContext {
  traceId?: string;
}

interface DatabaseReadCommand {
  statement: string;
  statementType: "string";
  executeType: "all";
  dbName: string;
  data: string;
  storagePath: string;
}

interface DatabaseReadResponse<T> {
  records: T[];
  diagnostics: { requestId: string; mainDurationMs: number };
}

let sequence = 0;
const clientId = Math.random().toString(36).slice(2, 10);
const safeLog = (details: Record<string, unknown>) => {
  try {
    console.info(`[DIAG][Database] read:complete ${JSON.stringify(details)}`);
  } catch (_) {
    // Diagnostics must not interrupt reading.
  }
};

export const invokeMeasuredDatabaseRead = async <T>(
  invoke: (channel: string, config: unknown) => Promise<T[] | DatabaseReadResponse<T>>,
  command: DatabaseReadCommand,
  context: DatabaseReadContext = {}
): Promise<T[]> => {
  const requestId = `db-${clientId}-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  const startedAt = performance.now();
  try {
    const response = await invoke("database-command", {
      ...command,
      diagnostics: { requestId, traceId: context.traceId },
    });
    const receivedAt = performance.now();
    const records = Array.isArray(response) ? response : response.records;
    const main = Array.isArray(response) ? undefined : response.diagnostics;
    const round = (value: number) => Math.round(value * 10) / 10;
    safeLog({
      requestId,
      traceId: /^[a-zA-Z0-9-]{1,96}$/.test(context.traceId || "") ? context.traceId : undefined,
      resultRowCount: records.length,
      ipcRoundTripDurationMs: round(receivedAt - startedAt),
      mainDurationMs: main?.mainDurationMs,
      // Includes dispatch queues, structured clone, scheduling and logging; NOT SQL time.
      transportAndSchedulingDurationMs: main
        ? round(Math.max(0, receivedAt - startedAt - main.mainDurationMs)) : undefined,
      rendererResultDurationMs: round(performance.now() - receivedAt),
    });
    return records;
  } catch (error) {
    safeLog({ requestId, failed: true, ipcRoundTripDurationMs: Math.round((performance.now() - startedAt) * 10) / 10 });
    throw error;
  }
};

// Object/list/write commands use an explicit result envelope; list.records is
// user data and must not be confused with the original raw-array protocol.
export const invokeMeasuredDatabaseCommand = async <T>(
  invoke:(channel:string,command:unknown)=>Promise<T | {result:T;diagnostics:{requestId:string;mainDurationMs:number}}>,
  command:Record<string,unknown>, context:DatabaseReadContext={}
):Promise<T> => {
  const requestId=`db-${clientId}-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  const start=performance.now();
  const traceId=/^[a-zA-Z0-9-]{1,96}$/.test(context.traceId || "")?context.traceId:undefined;
  try {
    const response=await invoke("database-command",{...command,diagnostics:{requestId,traceId}});
    const received=performance.now();
    const wrapped=response as {result:T;diagnostics?:{requestId:string;mainDurationMs:number}};
    const main=wrapped?.diagnostics?.requestId===requestId?wrapped.diagnostics:undefined;
    const result=main?wrapped.result:response as T;
    safeLog({requestId,traceId,operation:"annotations",ipcRoundTripDurationMs:Math.round((received-start)*10)/10,
      mainDurationMs:main?.mainDurationMs,transportAndSchedulingDurationMs:main?Math.round(Math.max(0,received-start-main.mainDurationMs)*10)/10:undefined,
      rendererResultDurationMs:Math.round((performance.now()-received)*10)/10});
    return result;
  } catch(error){safeLog({requestId,traceId,failed:true,ipcRoundTripDurationMs:Math.round((performance.now()-start)*10)/10});throw error;}
};
