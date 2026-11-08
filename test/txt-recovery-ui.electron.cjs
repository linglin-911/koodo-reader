const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { pathToFileURL } = require("node:url");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koodo-annotation-reader-"));
app.setPath("userData", path.join(temporary, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => { });
const report = process.argv[2] || path.join(temporary, "result.json");
let server, window, db, booksDb, bookmarksDb;
const deadline=setTimeout(()=>{console.error("Stage 10 recovery UI test timed out");app.exit(1);},180000);
app.whenReady().then(async () => {
    const { createServer } = await import("vite"), Database = require("better-sqlite3");
    const { SqlStatement } = await import(pathToFileURL(path.resolve(__dirname, "../src/assets/lib/kookit-extra.min.mjs")));
    const rangeReads=[];const source=require("../src/utils/main/txt-source"),readRange=source.readVerifiedRangeAsync;
    source.readVerifiedRangeAsync=async(...args)=>{rangeReads.push(args[3]);return readRange(...args);};
    const { createTxtIndexService } = require("../src/utils/main/txt-index-store"), { createAnnotationService } = require("../src/utils/main/annotation-store");
    const storage = path.join(temporary, "library");
    fs.mkdirSync(path.join(storage, "book"), { recursive: true });
    fs.mkdirSync(path.join(storage, "config"));
    const first="Chapter 1\r\n正文一😀 & <tag>\r\n"+Array.from({length:80},(_,i)=>"短段落 "+i+"\r\n").join("")+"Chapter 2\r正文二𠀀及相邻章节选区测试原文ABCDEFGHIJKLMNOP\rChapter 3\nfirst legacy line\nsecond legacy line\nlegacy target line\nlast legacy line\nChapter 4\r\n";
    const padding="x".repeat(8192-Buffer.byteLength(first)-8);
    fs.writeFileSync(path.join(storage,"book","fixture.txt"),first+padding+"CROSS_BLOCK_NEEDLE"+"巨章😀甲乙<>&".repeat(200000));
    const originalFile=path.join(storage,"book","fixture.txt"),relocatedFile=path.join(temporary,"relocated-original.txt");
    fs.writeFileSync(originalFile,"Chapter 1\r\n左边😀唯一摘录𠀀右边 正文保留\r\nChapter 2\r\n第二章原文保留\r\n");
    let selected=relocatedFile,hold=false,release,held=false;
    const file=()=>fs.existsSync(originalFile)?originalFile:relocatedFile;
    ipcMain.handle("select-file",()=>selected);
    ipcMain.handle("phase10-change",(_event,mode)=>{
      if(mode==='insert')fs.writeFileSync(file(),"Chapter 0\r\n新增前章\r\n"+fs.readFileSync(file(),'utf8'));
      if(mode==='delete-quote')fs.writeFileSync(file(),fs.readFileSync(file(),'utf8').replace('唯一摘录𠀀','摘录已删除'));
      if(mode==='missing')fs.renameSync(originalFile,relocatedFile);
      if(mode==='hold'){hold=true;held=false;}
      if(mode==='release'){hold=false;release?.();}
      return true;
    });
    db = new Database(path.join(storage, "config", "notes.db"));
    db.exec(SqlStatement.sqlStatement.createTableStatement.notes);
    bookmarksDb=new Database(path.join(storage,"config","bookmarks.db"));bookmarksDb.exec("CREATE TABLE bookmarks(key TEXT PRIMARY KEY,bookKey TEXT,cfi TEXT,label TEXT,percentage TEXT,chapter TEXT)");
    booksDb=new Database(":memory:");booksDb.exec(SqlStatement.sqlStatement.createTableStatement.books);
    ipcMain.handle("custom-database-command",(_event,command)=>{if(command.dbName!=="books")throw Error("Fixture only supports book names");return booksDb.prepare(command.query).all(...command.data);});
    const annotationLogs=[],rendererLogs=[];
    const txt = createTxtIndexService({ getConnection: () => db,taskOptions:{beforeBatch:async()=>{if(hold){held=true;await new Promise(resolve=>release=resolve);}}} }), annotations = createAnnotationService({ getConnection: () => db, describeTxt: (...args) => txt.describeChapter(...args), loadRegistry: async () => SqlStatement, Database,log:line=>annotationLogs.push(line) });
    const requests=[];let windowHasBody=false,detailReads=0,maxCreateRangeBytes=0;
    ipcMain.handle("database-command",async(event,command)=>{
      requests.push({operation:command.operation,action:command.action,offset:command.offset,limit:command.limit});
      if(command.operation==="annotations"){
        if(command.action==="get")detailReads++;
        const start=rangeReads.length,result=await annotations(command,event.sender.id);
        const raw=result?.result??result;
        if(command.action==="reading-window")windowHasBody ||= JSON.stringify(raw).includes("SYNTHETIC_FULL_BODY_");
        if(command.action==="create")maxCreateRangeBytes=Math.max(maxCreateRangeBytes,rangeReads.slice(start).reduce((a,b)=>a+b,0));
        return result;
      }
      if(command.operation==="txt-index")return txt(command,event.sender.id);
      if(command.dbName==="bookmarks"){
        if(command.statement==="saveStatement"){const b=command.data;return bookmarksDb.prepare("INSERT INTO bookmarks VALUES(?,?,?,?,?,?)").run(b.key,b.bookKey,b.cfi,b.label,b.percentage,b.chapter);}
        if(command.statement==="getByBookKeyStatement")return bookmarksDb.prepare("SELECT * FROM bookmarks WHERE bookKey=?").all(command.data);
        if(command.statement==="getStatement")return bookmarksDb.prepare("SELECT * FROM bookmarks WHERE key=?").get(command.data);
        return bookmarksDb.prepare("SELECT * FROM bookmarks").all();
      }
      if(command.dbName==='books')return require('../src/utils/main/database-diagnostics').runDatabaseCommand(command,{loadRegistry:async()=>SqlStatement,getConnection:()=>booksDb});
      return [];
    });
    ipcMain.handle('phase10-ui-stats',()=>{
      const row=db.prepare("SELECT g.generation,g.index_json FROM txt_index_documents d JOIN txt_index_generations g ON g.book_id=d.book_id AND g.generation=d.active_generation WHERE d.book_id='fixture'").get();
      const digest=require('node:crypto').createHash('sha256').update(fs.readFileSync(file())).digest('hex');
      const saved=booksDb.prepare("SELECT * FROM books WHERE key='fixture'").get();
      return {generation:row?.generation,completeHash:JSON.parse(row?.index_json||'{}').fullHash?.digest===digest,
        wholeSourceReads:requests.filter(r=>r.action==='read-source').length,held,building:!!db.prepare("SELECT 1 FROM txt_index_generations WHERE state='building'").get(),relocatedPathPersisted:saved?.path===relocatedFile};
    });
    ipcMain.handle("phase8-legacy-cache",()=>{
      const current=db.prepare("SELECT active_generation FROM txt_index_documents WHERE book_id='fixture'").get().active_generation;
      db.prepare("UPDATE txt_index_generations SET index_json=json_remove(index_json,'$.checkpoints') WHERE book_id='fixture' AND generation=?").run(current);
      return {generation:current,bindings:JSON.stringify(db.prepare("SELECT * FROM note_bindings ORDER BY id").all())};
    });
    ipcMain.handle("phase8-legacy-check",()=>({generation:db.prepare("SELECT active_generation FROM txt_index_documents WHERE book_id='fixture'").get().active_generation,bindings:JSON.stringify(db.prepare("SELECT * FROM note_bindings ORDER BY id").all())}));
    ipcMain.handle("phase8-native-wheel",(_event,{direction,x,y})=>{
      window.focus();
      window.webContents.sendInputEvent({type:"mouseMove",x,y});
      window.webContents.sendInputEvent({type:"mouseWheel",x,y,deltaY:-direction*600,deltaX:0,canScroll:true,hasPreciseScrollingDeltas:false});
    });
    ipcMain.handle("phase8-stats",()=>({windowPages:requests.filter(r=>r.action==="reading-window"&&r.offset>0).length,windowHasBody,detailReads,maxCreateRangeBytes,requests,bookmarks:bookmarksDb.prepare("SELECT * FROM bookmarks").all()}));
    ipcMain.handle("phase8-copy",async()=>{
      const old={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage()};
      try{await window.webContents.executeJavaScript('document.getElementById("page-area").querySelector("iframe").focus();document.getElementById("page-area").querySelector("iframe").contentDocument.execCommand("copy")',true);await new Promise(resolve=>setTimeout(resolve,50));return clipboard.readText().replace(/\r\n?/g,"\n");}
      finally{clipboard.write(old);}
    });
    ipcMain.handle("phase8-seed",(_event,{chapterId,generation})=>{
      const row=db.prepare("SELECT * FROM txt_index_chapters WHERE book_id='fixture' AND generation=? AND chapter_id=?").get(generation,chapterId);
      if(!row)throw Error("Synthetic seed generation missing");
      const insert=db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,1)"),bind=db.prepare("INSERT INTO note_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)");
      db.transaction(()=>{for(let i=0;i<270;i++){
        const key="phase8-synthetic-"+String(i).padStart(4,"0");
        insert.run(key,"fixture","small","Summary "+i,"SYNTHETIC_FULL_BODY_".repeat(512),"[]",JSON.stringify({year:2026,month:11,day:8}),Date.now(),Date.now()+i);
        bind.run("binding-"+key,key,"fixture","TXT",generation,chapterId,0,0,"active",JSON.stringify({chapter:{chapterId,index:0,label:"Chapter 1",start:row.utf16_start,end:row.utf16_end,bodyStart:row.body_utf16_start,firstChars:row.first_chars,lastChars:row.last_chars}}),"正文","","",0,2,"background-#FEF3CD");
      }})();return true;
    });
    ipcMain.handle("annotation-test-fail-create",(_event,enabled)=>{db.exec(enabled?"CREATE TRIGGER fail_ui_create BEFORE INSERT ON note_bindings BEGIN SELECT RAISE(ABORT,'fixture failure'); END":"DROP TRIGGER fail_ui_create");return true;});
    ipcMain.handle("annotation-test-diagnostics",()=>({main:annotationLogs.map(line=>JSON.parse(line.slice(line.indexOf("{")))),renderer:rendererLogs.map(line=>JSON.parse(line.slice(line.indexOf("{"))))}));
    ipcMain.handle("decrypt-data",()=>"");
    ipcMain.on("storage-location", event => { event.returnValue = storage; });
    server = await createServer({ root: path.resolve(__dirname, ".."), server: { port: 0, host: "127.0.0.1", warmup: { clientFiles: [] } }, plugins: [{ name: "annotation-test", configureServer(vite) { vite.middlewares.use("/__annotation_test__", async (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__annotation_test__", '<html><body><div id="page-area" style="width:600px;height:650px;overflow:auto"></div><div id="editor" style="position:absolute;top:0;right:0;width:520px;height:780px;overflow:auto;background:white"></div></body></html>')); }); } }] });
    await server.listen();
    window = new BrowserWindow({ show: true, x: -20000, y: 0, width: 1200, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on("console-message", event => { if(event.message?.startsWith("[DIAG][Database] read:complete"))rendererLogs.push(event.message); if (event.level === 3)
        {errors.push(event.message);console.error("RENDERER:",event.message);} });
    await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__annotation_test__`);
    await window.webContents.executeJavaScript(`window.electronAPI={invoke:(...args)=>require("electron").ipcRenderer.invoke(...args),sendSync:(...args)=>require("electron").ipcRenderer.sendSync(...args),fs:require("fs"),path:require("path")};void 0;`);
    ipcMain.handle("annotation-test-preview", async (_event,kind) => { await window.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))"); const preview = path.join(temporary, kind==="native"?"annotation-native.png":kind==="panel"?"txt-recovery-panel.png":"annotation-editor.png"); fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG()); return preview; });
    const result = await window.webContents.executeJavaScript(`import("/test/fixtures/txt-recovery-ui.tsx").then(module=>module.run())`);
    const preview = path.join(temporary, "annotation-ui.png");
    fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(report, JSON.stringify({ ...result, preview, panelPreview:path.join(temporary,"txt-recovery-panel.png"), editorPreview: path.join(temporary, "annotation-editor.png"),nativePreview:path.join(temporary,"annotation-native.png"), rendererErrors: errors }, null, 2));
    console.log(JSON.stringify({ ...result, preview, panelPreview:path.join(temporary,"txt-recovery-panel.png"), editorPreview: path.join(temporary, "annotation-editor.png"),nativePreview:path.join(temporary,"annotation-native.png"), rendererErrors: errors }));
    await cleanup();
    app.exit(0);
}).catch(async (error) => { console.error(error); let preview; try {
    if (window && !window.isDestroyed()) {
        preview = path.join(temporary, "annotation-failed.png");
        fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG());
    }
}
catch { } fs.writeFileSync(report, JSON.stringify({ passed: false, error: error.message, preview })); await cleanup(); app.exit(1); });
async function cleanup() { clearTimeout(deadline); if (window && !window.isDestroyed())
    window.destroy(); if (server)
    await server.close(); if (db?.open)
    db.close(); if(booksDb?.open)booksDb.close();if(bookmarksDb?.open)bookmarksDb.close(); }
