const test = require("node:test");
const assert = require("node:assert/strict");
const { runDatabaseCommand } = require("../src/utils/main/database-diagnostics.js");

function fixture() {
  let clock = 0;
  const events = [];
  const registry = {
    sqlStatement: { read: { notes: "SELECT test" }, save: { notes: "INSERT test" },
      dynamic: { notes: (data) => `SELECT ${data.length}` } },
    jsonToSqlite: { notes: (data) => ({ encoded: data.value }) },
    sqliteToJson: { notes: (row) => row ? ({ value: row.raw }) : null },
  };
  const dependencies = {
    loadRegistry: async () => registry,
    getConnection: () => ({ prepare: (sql) => ({
      all: (data) => { events.push({ sql, data }); return [{ raw: "private text" }]; },
      get: () => undefined,
      run: (data) => { events.push({ sql, data }); return { changes: 1 }; },
    }) }),
    now: () => ++clock,
    log: (message) => events.push(message),
  };
  const command = { statement: "read", statementType: "string", executeType: "all", dbName: "notes", data: "private-book-key", storagePath: "private-path" };
  return { dependencies, events, command };
}

test("legacy callers keep raw records and conversions, without diagnostic logs", async () => {
  const f = fixture();
  assert.deepEqual(await runDatabaseCommand(f.command,f.dependencies),[{ value: "private text" }]);
  assert.equal(f.events.filter(x => typeof x === "string").length,0);
  assert.equal(await runDatabaseCommand({ ...f.command, executeType: "get" },f.dependencies),null);
});

test("measured calls include local stage durations and correlate without logging content or paths", async () => {
  const f = fixture();
  const result = await runDatabaseCommand({ ...f.command, diagnostics: { requestId: "db-test-1", traceId: "reader-1" } },f.dependencies);
  assert.deepEqual(result.records,[{ value: "private text" }]);
  for (const name of ["registryDurationMs","connectionDurationMs","prepareDurationMs","executeDurationMs","inputConversionDurationMs","outputConversionDurationMs","mainDurationMs"]) {
    assert.equal(typeof result.diagnostics[name],"number");
    assert.ok(result.diagnostics[name] >= 0);
  }
  const log = f.events.find(x => typeof x === "string");
  assert.match(log,/db-test-1/);
  assert.doesNotMatch(log,/private|SELECT test/);
  assert.equal(result.diagnostics.resultRowCount,1);
});

test("function statements and save conversion preserve existing parameter binding", async () => {
  const f = fixture();
  await runDatabaseCommand({ ...f.command, statement: "save", executeType: "run", data: { value: 42 } },f.dependencies);
  assert.deepEqual(f.events[0].data,{ encoded: 42 });
  await runDatabaseCommand({ ...f.command, statement: "dynamic", statementType: "function", data: ["one","two"] },f.dependencies);
  assert.equal(f.events[1].sql,"SELECT 2");
});

test("database failures propagate and a broken logger cannot break successful reads", async () => {
  const f = fixture();
  const error = new Error("private-path SQL failure");
  f.dependencies.getConnection = () => { throw error; };
  await assert.rejects(runDatabaseCommand({ ...f.command, diagnostics: { requestId: "db-fail" } },f.dependencies),e => e === error);
  assert.doesNotMatch(f.events[0],/private-path/);
  const good = fixture();
  good.dependencies.log = () => { throw new Error("sink failed"); };
  assert.equal((await runDatabaseCommand({ ...good.command, diagnostics: { requestId: "db-good" } },good.dependencies)).records.length,1);
});

test("invalid methods and prototype properties never reach the database connection", async () => {
  const f = fixture();
  f.dependencies.getConnection = () => { throw new Error("should not open"); };
  await assert.rejects(runDatabaseCommand({ ...f.command, executeType: "exec" },f.dependencies),/Invalid database command/);
  await assert.rejects(runDatabaseCommand({ ...f.command, statement: "constructor" },f.dependencies),/Invalid database command/);
});
