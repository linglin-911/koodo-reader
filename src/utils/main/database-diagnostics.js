const { performance } = require("node:perf_hooks");

const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9-]{1,96}$/.test(value);

// Keep the existing database-command result shape unless a caller opts into timings.
const runDatabaseCommand = async (config, dependencies) => {
  const { loadRegistry, getConnection, log, now = () => performance.now() } = dependencies;
  const startedAt = now();
  const context = config?.diagnostics;
  const measured = validId(context?.requestId);
  const timings = { requestId: measured ? context.requestId : undefined };
  const round = (value) => Math.round(value * 10) / 10;
  const emit = (failed) => {
    if (!measured) return;
    timings.mainDurationMs = round(now() - startedAt);
    try {
      // No SQL, parameters, book identity, paths, note content, or error text.
      log(`[DIAG][Database] command:${failed ? "failed" : "complete"} ${JSON.stringify({
        ...timings,
        traceId: validId(context.traceId) ? context.traceId : undefined,
        failed,
      })}`);
    } catch (_) {
      // A diagnostic sink must not change database behavior.
    }
  };
  try {
    let stage = now();
    const SqlStatement = await loadRegistry();
    timings.registryDurationMs = round(now() - stage);
    const { statement, statementType, executeType, dbName, storagePath } = config;
    let { data } = config;
    if (!["all", "get", "run"].includes(executeType) ||
        !["string", "function"].includes(statementType) ||
        typeof statement !== "string" || typeof dbName !== "string" ||
        !Object.hasOwn(SqlStatement.sqlStatement, statement) ||
        !Object.hasOwn(SqlStatement.sqlStatement[statement], dbName)) {
      throw new TypeError("Invalid database command");
    }
    stage = now();
    const db = getConnection(dbName, storagePath, SqlStatement.sqlStatement);
    timings.connectionDurationMs = round(now() - stage);
    stage = now();
    const registered = SqlStatement.sqlStatement[statement][dbName];
    const sql = statementType === "function" ? registered(data) : registered;
    const row = db.prepare(sql);
    timings.prepareDurationMs = round(now() - stage);
    stage = now();
    if (data && (statement.startsWith("save") || statement.startsWith("update"))) {
      data = SqlStatement.jsonToSqlite[dbName](data);
    }
    timings.inputConversionDurationMs = round(now() - stage);
    stage = now();
    const result = data ? row[executeType](data) : row[executeType]();
    timings.executeDurationMs = round(now() - stage);
    timings.resultRowCount = executeType === "all" ? result.length : executeType === "get" ? Number(!!result) : 0;
    stage = now();
    const records = executeType === "all"
      ? result.map((item) => SqlStatement.sqliteToJson[dbName](item))
      : executeType === "get" ? SqlStatement.sqliteToJson[dbName](result) : result;
    timings.outputConversionDurationMs = round(now() - stage);
    emit(false);
    return measured ? { records, diagnostics: timings } : records;
  } catch (error) {
    emit(true);
    throw error;
  }
};

module.exports = { runDatabaseCommand };
