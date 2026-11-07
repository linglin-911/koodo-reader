// Hidden renderer smoke test of the normal compiled Kookit + host adapter.
// Runs against an isolated profile and synthetic original TXT only.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-txt-reader-"));
app.setPath("userData", path.join(temporary, "profile"));
app.disableHardwareAcceleration();
const reportPath = process.argv[2] || path.join(temporary, "result.json");
let server, window, db;
app
  .whenReady()
  .then(async () => {
    const { createServer } = await import("vite");
    const Database = require("better-sqlite3");
    const {
      createTxtIndexService,
    } = require("../src/utils/main/txt-index-store");
    const storage = path.join(temporary, "library");
    fs.mkdirSync(path.join(storage, "book"), { recursive: true });
    fs.mkdirSync(path.join(storage, "config"));
    fs.writeFileSync(
      path.join(storage, "book", "reader-fixture.txt"),
      "\ufeffChapter 1\r\n正文一😀\r\nChapter 2\r正文二𠀀\rChapter 3\n正文三甲乙\n"
    );
    db = new Database(path.join(storage, "config", "notes.db"));
    db.exec("CREATE TABLE notes(key TEXT PRIMARY KEY)");
    const service = createTxtIndexService({ getConnection: () => db });
    ipcMain.handle("database-command", (event, command) =>
      service(command, event.sender.id)
    );
    ipcMain.on("storage-location", (event) => {
      event.returnValue = storage;
    });
    server = await createServer({
      root: path.resolve(__dirname, ".."),
      server: { port: 0, host: "127.0.0.1", warmup: { clientFiles: [] } },
      plugins: [
        {
          name: "isolated-txt-test",
          configureServer(vite) {
            vite.middlewares.use("/__txt_test__", (_req, res) => {
              res.setHeader("Content-Type", "text/html");
              res.end(
                '<html><body><div id="page-area" style="width:800px;height:600px;overflow:auto"></div></body></html>'
              );
            });
          },
        },
      ],
    });
    await server.listen();
    const port = server.httpServer.address().port;
    window = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    });
    await window.loadURL(`http://127.0.0.1:${port}/__txt_test__`);
    const result = await window.webContents.executeJavaScript(`(async()=>{
    window.electronAPI={invoke:(...args)=>require("electron").ipcRenderer.invoke(...args),sendSync:(...args)=>require("electron").ipcRenderer.sendSync(...args)};
    const [{openPersistentTxt},Kookit]=await Promise.all([import("/src/utils/storage/txtIndexService.ts"),import("/src/assets/lib/kookit.min.js")]);
    const area=document.getElementById("page-area");
    const results=[];let savedLocation;
    for(const phase of ["cold","hot"]){
      const prepared=await openPersistentTxt("reader-fixture","","utf-8","^Chapter ");
      const cacheHit=Boolean(await prepared.store.load(false));
      const rendition=Kookit.BookHelper.getRendition(prepared.buffer,{format:"TXT",charset:prepared.encoding,
        parserRegex:"^Chapter ",txtIndexStore:prepared.store,readerMode:"scroll",animation:"none",isMobile:"no",platform:"electron"},Kookit);
      await rendition.renderTo(area);
      if(phase==="cold")await rendition.goToChapterDocIndex(2);else await rendition.goToPosition(savedLocation);
      const doc=rendition.getDocument();
      if(!doc.body.textContent.includes("正文三甲乙"))throw new Error("Deep chapter/position restore did not render expected text");
      const paragraph=Array.from(doc.querySelectorAll("p")).find(p=>p.textContent.includes("正文三甲乙"));
      const range=doc.createRange();range.selectNodeContents(paragraph);
      const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);
      if(selection.toString()!=="正文三甲乙")throw new Error("Normalized TXT lost selectable body text");
      await rendition.record();savedLocation=JSON.stringify(rendition.tempLocation);
      results.push({phase,cacheHit,chapterCount:rendition.getChapterDoc().length,chapterDocIndex:rendition.tempLocation.chapterDocIndex,selectionPreserved:true});
      rendition.removeContent();area.innerHTML="";
    }
    return results;
  })()`);
    assert.equal(result[0].cacheHit, false);
    assert.equal(result[1].cacheHit, true);
    assert.ok(
      result.every(
        (row) =>
          row.chapterCount === 3 &&
          Number(row.chapterDocIndex) === 2 &&
          row.selectionPreserved
      )
    );
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          passed: true,
          normalCompiledEngine: true,
          actualRendererAndIPC: true,
          userDatabaseOpened: false,
          results: result,
        },
        null,
        2
      )
    );
    console.log(
      "PASS: normal compiled engine + host IPC adapter; cold/hot render, chapter jump, selectable text, reading-position restore"
    );
    await cleanup();
    app.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ passed: false, error: error.message })
    );
    await cleanup();
    app.exit(1);
  });
async function cleanup() {
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await server.close();
  if (db?.open) db.close();
}
