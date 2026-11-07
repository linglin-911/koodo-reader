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
