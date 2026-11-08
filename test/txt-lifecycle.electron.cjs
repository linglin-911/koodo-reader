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
let server, window, db, service;
const liveWorkers=new Set(), liveHandles=new Set();
const originalOpen=fs.promises.open;
fs.promises.open=async(...args)=>{
  const handle=await originalOpen.apply(fs.promises,args);liveHandles.add(handle);
  const originalClose=handle.close.bind(handle);
  handle.close=async()=>{try{return await originalClose();}finally{liveHandles.delete(handle);}};
  return handle;
};
app.commandLine.appendSwitch("js-flags","--expose-gc");
const minutes=Number(process.argv[3]||0);
if(!Number.isFinite(minutes)||minutes<0||minutes>120)throw Error("Invalid soak minutes");
const deadline=setTimeout(()=>{console.error("TXT window test timed out");app.exit(1);},Math.max(600000,(minutes+10)*60000));
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
      Array.from({length:120},(_,i)=>`Chapter ${i+1}\r\n${('正文'+i+'😀').repeat(50)}\r\n`).join('')+'Chapter 121\r\n'+'巨章😀甲乙'.repeat(1000000)
    );
    db = new Database(path.join(storage, "config", "notes.db"));
    db.exec("CREATE TABLE notes(key TEXT PRIMARY KEY)");
    service = createTxtIndexService({ getConnection: () => db, taskOptions: {onWorker:worker=>{
      liveWorkers.add(worker);worker.once("exit",()=>liveWorkers.delete(worker));
    }} });
    const commands = [];
    let rangeReads = 0, maximumRangeReads = 0;
    ipcMain.handle("database-command", async (event, command) => {
      commands.push({
        action: command.action,
        chapterIndex: command.chapterIndex,
        length: command.length,
      });
      if (command.action !== 'read-chapter') return service(command, event.sender.id);
      maximumRangeReads = Math.max(maximumRangeReads, ++rangeReads);
      try { return await service(command, event.sender.id); } finally { rangeReads--; }
    });
    ipcMain.on("storage-location", (event) => {
      event.returnValue = storage;
    });
    server = await createServer({
      root: path.resolve(__dirname, ".."),
      cacheDir: path.resolve(__dirname, "../node_modules/.vite-tests", path.basename(temporary)),
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
        backgroundThrottling: false,
        sandbox: false,
      },
    });
    window.webContents.on('console-message', (_event, _level, message) => console.log('RENDERER:', message));
    await window.loadURL(`http://127.0.0.1:${port}/__txt_test__`);
    const result = await window.webContents.executeJavaScript(String.raw`(async()=>{
    const requested=[];window.electronAPI={invoke:(...args)=>{requested.push(args[1].action);return require('electron').ipcRenderer.invoke(...args);},sendSync:(...args)=>require('electron').ipcRenderer.sendSync(...args)};
    const [{openPersistentTxt},Kookit]=await Promise.all([import('/src/utils/storage/txtIndexService.ts'),import('/src/assets/lib/kookit.min.js')]);
    const checks=[],samples=[],area=document.getElementById('page-area');
    const check=(condition,message)=>{if(!condition)throw Error(message);checks.push(message);};
    const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
    const liveURLs=new Set(),liveObservers=new Set(),frames=new Set();
    const create=URL.createObjectURL,revoke=URL.revokeObjectURL,NativeObserver=ResizeObserver,raf=requestAnimationFrame,caf=cancelAnimationFrame;
    URL.createObjectURL=(...args)=>{const url=create(...args);liveURLs.add(url);return url;};
    URL.revokeObjectURL=url=>{liveURLs.delete(url);return revoke(url);};
    window.ResizeObserver=class extends NativeObserver{constructor(cb){super(cb);liveObservers.add(this);}disconnect(){liveObservers.delete(this);super.disconnect();}};
    window.requestAnimationFrame=callback=>{const id=raf(t=>{frames.delete(id);callback(t);});frames.add(id);return id;};
    window.cancelAnimationFrame=id=>{frames.delete(id);return caf(id);};
    const config=prepared=>({format:'TXT',charset:prepared.encoding,txtIndexStore:prepared.store,txtContinuousScroll:true,readerMode:'scroll',animation:'none',isMobile:'no',platform:'electron'});
    let jumps=0,maxCache=0,maxNodes=0;
    async function sample(label){await tick();globalThis.gc?.();await tick();const memory=await process.getProcessMemoryInfo();samples.push({label,elapsedMs:performance.now(),heap:require('node:v8').getHeapStatistics().used_heap_size,browserHeap:performance.memory.usedJSHeapSize,privateKB:memory.private});if(label.startsWith('soak-'))console.log('SOAK_SAMPLE '+JSON.stringify(samples[samples.length-1]));}
    async function open(){const prepared=await openPersistentTxt('reader-fixture','','utf-8','');const reader=Kookit.BookHelper.getRendition(prepared.buffer,config(prepared),Kookit);await reader.renderTo(area);return {prepared,reader};}
    try{
      for(let cycle=0;cycle<10;cycle++){
        const {prepared,reader}=await open();const manager=reader.txtWindow;
        for(let i=0;i<100;i++){
          if(i%10===0){const giant=reader.book.sections[120].chapter;await reader.txtWindow.jump(120,Math.floor((giant.end-giant.start)*((i*13+cycle*7)%97)/100));}else await reader.goToChapterDocIndex((i*37+cycle*11)%121);jumps++;
          const stats=manager.stats;maxCache=Math.max(maxCache,stats.cacheBytes);maxNodes=Math.max(maxNodes,stats.nodes);
          if(stats.cacheBytes>stats.cacheBudget||stats.nodes>20000||stats.mountedBlocks>stats.blocks||stats.mountedCharacters>stats.characters)throw Error('resource budget exceeded');
        }
        check(liveURLs.size===0,'cycle '+cycle+' internal window creates no Blob URL');
        const section=reader.book.sections[0];
        const [a,b]=await Promise.all([section.load(),section.load()]);
        check(a===b&&liveURLs.size===1,'cycle '+cycle+' legacy URL shares consumers');
        section.unload();check((await (await fetch(b)).text()).includes('正文0'),'cycle '+cycle+' first release keeps remaining consumer readable');
        section.unload();check(liveURLs.size===0,'cycle '+cycle+' last release revokes URL');
        const commandStart=requested.length;await reader.goToChapterDocIndex(40);await reader.goToChapterDocIndex(40);
        check(reader.book.resourceStats().activeURLs===0,'cycle '+cycle+' navigation keeps Blob ownership empty');
        await reader.removeContent();await prepared.store.close();await tick();
        const stats=manager.stats;
        check(stats.cacheBytes===0&&stats.activeReads===0&&stats.observers===0&&stats.listeners===0&&stats.animationFrames===0&&area.querySelectorAll('iframe').length===0&&liveURLs.size===0&&liveObservers.size===0&&frames.size===0,'cycle '+cycle+' close releases cache, DOM, URL, observer and animation frame');
        await sample('close-'+cycle);
      }
      check(jumps===1000,'1000 explicit chapter jumps and 10 open/close cycles completed');
      {
        const {prepared,reader}=await open();await reader.goToChapterDocIndex(0);const manager=reader.txtWindow,book=reader.book;
        let release,entered=false;const hold=new Promise(resolve=>release=resolve),original=prepared.store.readChapterRange;
        prepared.store.readChapterRange=async(...args)=>{entered=true;await hold;return original(...args);};
        // Manager captured the original callback during construction; gate it via its options.
        manager.options.read=prepared.store.readChapterRange;
        const stale=reader.goToChapterDocIndex(110);while(!entered)await tick();
        await reader.removeContent();release();await stale;await tick();
        check(manager.stats.activeReads===0&&manager.stats.cacheBytes===0&&book.resourceStats().activeURLs===0&&area.children.length===0&&liveObservers.size===0,'close during range read cannot resurrect DOM, cache or URL');
      }
      {
        const {prepared,reader}=await open();await reader.goToChapterDocIndex(0);const manager=reader.txtWindow;
        let failed=false;manager.options.read=async()=>{throw Error('injected range failure');};
        try{await reader.goToChapterDocIndex(110);}catch{failed=true;}
        check(failed&&manager.stats.activeReads===0&&reader.getDocument().querySelector('[data-txt-block]'),'read failure drains I/O while retaining current DOM');
        await reader.removeContent();await prepared.store.close();
      }
      // Optional real-time soak uses one continuous window; it is not simulated time.
      const soakMinutes=SOAK_MINUTES,soakStart=performance.now();let soakMoves=0;
      if(soakMinutes>0){
        const {prepared,reader}=await open();await reader.goToChapterDocIndex(0);
        await sample('soak-baseline');
        while(performance.now()-soakStart<soakMinutes*60000){
          const direction=Math.floor(soakMoves/200)%2===0?1:-1;await reader.txtWindow.move(direction);soakMoves++;
          const stats=reader.txtWindow.stats;
          if(stats.cacheBytes>stats.cacheBudget||stats.nodes>20000||stats.mountedCharacters>stats.characters)throw Error('soak resource budget exceeded');
          if(soakMoves%50===0)await sample('soak-'+soakMoves);
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        await reader.removeContent();await prepared.store.close();await sample('soak-closed');
        check(liveURLs.size===0&&liveObservers.size===0&&frames.size===0,'real-time soak closes all renderer resources');
      }
      return {checks,jumps,openCloseCycles:10,maxCache,maxNodes,gcExposed:typeof globalThis.gc==='function',samples,soakMinutes,soakElapsedMs:performance.now()-soakStart,soakMoves};
    }finally{URL.createObjectURL=create;URL.revokeObjectURL=revoke;window.ResizeObserver=NativeObserver;window.requestAnimationFrame=raf;window.cancelAnimationFrame=caf;}
  })()`.replace('SOAK_MINUTES',String(minutes)));
    assert.ok(
      commands
        .filter((c) => c.action === "read-chapter")
        .every((c) => c.length <= 256 * 1024)
    );
    assert.ok(result.checks.length >= 63);
    assert.equal(liveWorkers.size,0);
    assert.equal(liveHandles.size,0);
    assert.equal(rangeReads,0);
    assert.equal(maximumRangeReads, 1);
    assert.ok(commands.filter(c=>c.action==='read-chapter').every(c=>c.length<=8192));
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          passed: true,
          normalCompiledEngine: true,
          actualRendererAndIPC: true,
          userDatabaseOpened: false,
          maximumConcurrentRangeReads: maximumRangeReads,
          runtime: {electron:process.versions.electron,node:process.versions.node,platform:process.platform,arch:process.arch,osRelease:os.release(),cpu:os.cpus()[0]?.model},
          liveWorkers: liveWorkers.size, liveMainFileHandles: liveHandles.size,
          ...result,
        },
        null,
        2
      )
    );
    console.log(
      "PASS: phase-9 TXT resource lifecycle with compiled engine + real IPC"
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
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await server.close();
  service?.shutdown();
  if (db?.open) db.close();
  fs.promises.open=originalOpen;
}
