// Real React directory + normal compiled engine + IPC/SQLite. Synthetic data only.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-txt-directory-"));
app.setPath("userData", path.join(temporary, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const report = process.argv[2] || path.join(temporary, "result.json");
let server, window, db;
app.whenReady().then(async () => {
  const { createServer } = await import("vite"), Database = require("better-sqlite3");
  const { createTxtIndexService } = require("../src/utils/main/txt-index-store");
  const storage = path.join(temporary, "library");
  fs.mkdirSync(path.join(storage, "book"), { recursive: true });
  fs.mkdirSync(path.join(storage, "config"));
  fs.writeFileSync(path.join(storage, "book", "directory.txt"), Array.from({ length: 7700 }, (_, i) =>
    `Chapter ${i + 1}${i === 6799 ? " 中文长标题".repeat(40) : ""}\nSYNTHETIC_BODY_${i + 1}😀\n`).join(""));
  db = new Database(path.join(storage, "config", "notes.db"));
  db.exec("CREATE TABLE notes(key TEXT PRIMARY KEY)");
  const service = createTxtIndexService({ getConnection: () => db });
  const commands = [];
  const preview = path.join(temporary, "txt-directory.png");
  ipcMain.handle("directory-test-preview", async () => { await window.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"); fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG()); return preview; });
  ipcMain.handle("database-command", async (event, command) => {
    commands.push({ action: command.action, chapterIndex: command.chapterIndex });
    if (command.action !== "read-directory") return service(command, event.sender.id);
    const originalRead = fs.readSync;
    try {
      fs.readSync = () => { throw Error("Directory touched the original TXT"); };
      return await service(command, event.sender.id);
    } finally { fs.readSync = originalRead; }
  });
  ipcMain.handle("directory-test-commands", () => commands);
  ipcMain.on("storage-location", event => { event.returnValue = storage; });
  server = await createServer({ root: path.resolve(__dirname, ".."), server: { port: 0, host: "127.0.0.1", warmup: { clientFiles: [] } }, plugins: [{ name: "directory-fixture", configureServer(vite) {
    vite.middlewares.use("/__directory_test__", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await vite.transformIndexHtml("/__directory_test__", '<html><body><div id="page-area" style="position:absolute;left:320px;width:600px;height:650px"></div><div class="navigation-body" style="width:299px;height:600px"><div id="contents" style="height:100%"></div></div></body></html>'));
    });
  } }] });
  await server.listen();
  window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", event => { if (event.level === 3) errors.push(event.message); });
  await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__directory_test__`);
  await window.webContents.executeJavaScript(`window.electronAPI={invoke:(...args)=>require("electron").ipcRenderer.invoke(...args),sendSync:(...args)=>require("electron").ipcRenderer.sendSync(...args)};void 0;`);
  const result = await window.webContents.executeJavaScript('import("/test/fixtures/txt-directory.tsx").then(module=>module.run())');
  if (errors.length) throw Error(`Renderer errors: ${errors.join("; ")}`);
  fs.writeFileSync(report, JSON.stringify({ ...result, preview, rendererErrors: errors, userDatabaseOpened: false }, null, 2));
  console.log(JSON.stringify({ ...result, preview }));
  await cleanup(); app.exit(0);
}).catch(async error => {
  console.error(error);
  let preview;
  if (window && !window.isDestroyed()) { preview = path.join(temporary, "failed.png"); fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG()); }
  fs.writeFileSync(report, JSON.stringify({ passed: false, error: error.message, preview }));
  await cleanup(); app.exit(1);
});
async function cleanup() { if (window && !window.isDestroyed()) window.destroy(); if (server) await server.close(); if (db?.open) db.close(); }
