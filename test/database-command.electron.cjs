// Run with: node_modules/electron/dist/electron.exe test/database-command.electron.cjs
// No window, real book, or user database is opened.
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(),"koodo-db-test-"));
app.setPath("userData",temporaryProfile);
const reportPath = process.argv[2] || path.join(temporaryProfile,"result.json");

app.whenReady().then(async () => {
  const Database = require("better-sqlite3");
  const { runDatabaseCommand } = require("../src/utils/main/database-diagnostics.js");
  const { SqlStatement } = await import(pathToFileURL(path.resolve(__dirname,"../src/assets/lib/kookit-extra.min.mjs")));
  const db = new Database(":memory:");
  try {
    db.exec(SqlStatement.sqlStatement.createTableStatement.notes);
    const logs = [];
    const dependencies = { loadRegistry: async () => SqlStatement,
      getConnection: () => db,log: message => logs.push(message) };
    const command = { dbName: "notes",storagePath: temporaryProfile,statementType: "string" };
    const note = { key: "test-note",bookKey: "test-book",date: { year: 2026,month: 10,day: 8 },
      chapter: "test chapter",chapterIndex: 0,text: "private fixture quote",cfi: "{}",range: "{}",
      notes: "private fixture content",percentage: "0",color: "background-#FEF3CD",tag: ["test"] };
    await runDatabaseCommand({ ...command,statement: "saveStatement",executeType: "run",data: note },dependencies);
    const loaded = await runDatabaseCommand({ ...command,statement: "getStatement",executeType: "get",data: note.key },dependencies);
    assert.equal(loaded.notes,note.notes);
    const response = await runDatabaseCommand({ ...command,statement: "getByBookKeyStatement",executeType: "all",data: note.bookKey,
      diagnostics: { requestId: "db-electron-smoke",traceId: "reader-smoke" } },dependencies);
    assert.equal(response.records.length,1);
    assert.equal(response.records[0].key,note.key);
    assert.ok(response.diagnostics.executeDurationMs >= 0);
    assert.doesNotMatch(logs.join(""),/private fixture|koodo-db-test-/);
    fs.writeFileSync(reportPath,JSON.stringify({ passed: true,electron: process.versions.electron,
      nativeSqlite: true,measuredRowCount: response.records.length,userDatabaseOpened: false }));
    console.log("PASS: Electron native SQLite + actual SqlStatement save/get/measured read; no user DB opened");
  } finally {
    db.close();
  }
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(reportPath,JSON.stringify({ passed: false,error: error.message }));
  console.error(error);
  app.exit(1);
});
