const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { pathToFileURL } = require("node:url");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-annotation-reader-"));
app.setPath("userData", path.join(temporary, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => { });
const report = process.argv[2] || path.join(temporary, "result.json");
let server, window, db, booksDb;
app.whenReady().then(async () => {
    const { createServer } = await import("vite"), Database = require("better-sqlite3");
    const { SqlStatement } = await import(pathToFileURL(path.resolve(__dirname, "../src/assets/lib/kookit-extra.min.mjs")));
    const { createTxtIndexService } = require("../src/utils/main/txt-index-store"), { createAnnotationService } = require("../src/utils/main/annotation-store");
    const storage = path.join(temporary, "library");
    fs.mkdirSync(path.join(storage, "book"), { recursive: true });
    fs.mkdirSync(path.join(storage, "config"));
    fs.writeFileSync(path.join(storage, "book", "fixture.txt"), "\ufeffChapter 1\r\n正文一😀 & <tag>\r\nChapter 2\r正文二𠀀\rChapter 3\n正文三甲乙\n");
    db = new Database(path.join(storage, "config", "notes.db"));
    db.exec(SqlStatement.sqlStatement.createTableStatement.notes);
    booksDb=new Database(":memory:");booksDb.exec("CREATE TABLE books(key TEXT PRIMARY KEY,name TEXT);INSERT INTO books VALUES('fixture','Synthetic annotation fixture')");
    ipcMain.handle("custom-database-command",(_event,command)=>{if(command.dbName!=="books")throw Error("Fixture only supports book names");return booksDb.prepare(command.query).all(...command.data);});
    const annotationLogs=[],rendererLogs=[];
    const txt = createTxtIndexService({ getConnection: () => db }), annotations = createAnnotationService({ getConnection: () => db, describeTxt: (...args) => txt.describeChapter(...args), loadRegistry: async () => SqlStatement, Database,log:line=>annotationLogs.push(line) });
    ipcMain.handle("database-command", (event, command) => command.operation === "annotations" ? annotations(command, event.sender.id) : txt(command, event.sender.id));
    ipcMain.handle("annotation-test-fail-create",(_event,enabled)=>{db.exec(enabled?"CREATE TRIGGER fail_ui_create BEFORE INSERT ON note_bindings BEGIN SELECT RAISE(ABORT,'fixture failure'); END":"DROP TRIGGER fail_ui_create");return true;});
    ipcMain.handle("annotation-test-diagnostics",()=>({main:annotationLogs.map(line=>JSON.parse(line.slice(line.indexOf("{")))),renderer:rendererLogs.map(line=>JSON.parse(line.slice(line.indexOf("{"))))}));
    ipcMain.on("storage-location", event => { event.returnValue = storage; });
    server = await createServer({ root: path.resolve(__dirname, ".."), server: { port: 0, host: "127.0.0.1", warmup: { clientFiles: [] } }, plugins: [{ name: "annotation-test", configureServer(vite) { vite.middlewares.use("/__annotation_test__", async (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__annotation_test__", '<html><body><div id="page-area" style="width:600px;height:650px;overflow:auto"></div><div id="editor" style="position:absolute;top:0;right:0;width:520px;height:780px;overflow:auto;background:white"></div></body></html>')); }); } }] });
    await server.listen();
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on("console-message", event => { if(event.message?.startsWith("[DIAG][Database] read:complete"))rendererLogs.push(event.message); if (event.level === 3)
        errors.push(event.message); });
    await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__annotation_test__`);
    await window.webContents.executeJavaScript(`window.electronAPI={invoke:(...args)=>require("electron").ipcRenderer.invoke(...args),sendSync:(...args)=>require("electron").ipcRenderer.sendSync(...args),fs:require("fs"),path:require("path")};void 0;`);
    ipcMain.handle("annotation-test-preview", async (_event,kind) => { await window.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))"); const preview = path.join(temporary, kind==="native"?"annotation-native.png":"annotation-editor.png"); fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG()); return preview; });
    const result = await window.webContents.executeJavaScript(`import("/test/fixtures/annotation-reader.tsx").then(module=>module.run())`);
    const preview = path.join(temporary, "annotation-ui.png");
    fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(report, JSON.stringify({ ...result, preview, editorPreview: path.join(temporary, "annotation-editor.png"),nativePreview:path.join(temporary,"annotation-native.png"), rendererErrors: errors }, null, 2));
    console.log(JSON.stringify({ ...result, preview, editorPreview: path.join(temporary, "annotation-editor.png"),nativePreview:path.join(temporary,"annotation-native.png"), rendererErrors: errors }));
    await cleanup();
    app.exit(0);
}).catch(async (error) => { console.error(error); let preview; try {
    if (window && !window.isDestroyed()) {
        preview = path.join(temporary, "annotation-failed.png");
        fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG());
    }
}
catch { } fs.writeFileSync(report, JSON.stringify({ passed: false, error: error.message, preview })); await cleanup(); app.exit(1); });
async function cleanup() { if (window && !window.isDestroyed())
    window.destroy(); if (server)
    await server.close(); if (db?.open)
    db.close(); if(booksDb?.open)booksDb.close(); }
