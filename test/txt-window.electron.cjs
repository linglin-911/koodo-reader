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
const deadline=setTimeout(()=>{console.error("TXT window test timed out");app.exit(1);},180000);
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
    const service = createTxtIndexService({ getConnection: () => db });
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
    const requested=[];window.electronAPI={invoke:(...args)=>{requested.push(args[1]);return require('electron').ipcRenderer.invoke(...args);},sendSync:(...args)=>require('electron').ipcRenderer.sendSync(...args)};
    const [{openPersistentTxt}, Kookit] = await Promise.all([import('/src/utils/storage/txtIndexService.ts'), import('/src/assets/lib/kookit.min.js')]);
    const area=document.getElementById('page-area'), checks=[];
    const check=(condition, message)=>{if(!condition)throw Error(message);checks.push(message);};
    const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
    async function settle(r){for(let i=0;i<3;i++){await r.txtWindow.fill();await tick();}}
    let saved, firstGeneration;
    for(const phase of ['cold','hot']) {
      const prepared=await openPersistentTxt('reader-fixture','','utf-8','');
      let failRead=false;const readRange=prepared.store.readChapterRange;prepared.store.readChapterRange=(...args)=>failRead?Promise.reject(Error('injected block failure')):readRange(...args);
      const r=Kookit.BookHelper.getRendition(prepared.buffer,{format:'TXT',charset:prepared.encoding,parserRegex:'',txtIndexStore:prepared.store,txtContinuousScroll:true,readerMode:'scroll',animation:'none',isMobile:'no',platform:'electron'},Kookit);
      await r.renderTo(area);check(r.isTxtWindowActive(), phase+' uses opt-in window');
      const frame=r.getIframe(),doc=r.getDocument(),body=doc.body;
      let blobs=0;const original=URL.createObjectURL;URL.createObjectURL=(...args)=>{blobs++;return original(...args);};
      try {
        if(phase==='cold') {
          await r.goToChapterDocIndex(0);await settle(r);
          for(const direction of [1,-1]) {
            for(let i=direction>0?1:99;direction>0?i<=100:i>=0;i+=direction) {
              await settle(r);
              const node=doc.querySelector('[data-chapter-index="'+i+'"] [data-txt-block]');
              if(!node)throw Error('continuous chapter not prefetched: '+i+' direction '+direction+' '+JSON.stringify(r.txtWindow.stats));
              area.scrollTop=node.getBoundingClientRect().top+1;
              await settle(r);
              if(r.getIframe()!==frame||r.getDocument()!==doc||doc.body!==body)throw Error('iframe/document replaced at chapter boundary');
              const s=r.txtWindow.stats;
              if(s.mountedBlocks>s.blocks||s.mountedCharacters>s.characters||s.mountedChapters>s.chapters||s.nodes>20000)throw Error('window budget exceeded');
            }
          }
          check(true,'bidirectional 100 chapter scroll keeps one iframe and bounded DOM');
          await r.goToChapterDocIndex(10);await settle(r);
          const a=doc.querySelector('[data-chapter-index="10"] [data-txt-block]'),b=doc.querySelector('[data-chapter-index="11"] [data-txt-block]');
          const selection=doc.getSelection(),range=doc.createRange();range.setStart(a.firstChild,0);range.setEnd(b.firstChild,b.firstChild.length);selection.removeAllRanges();selection.addRange(range);
          check(selection.toString()===a.textContent+'\n'+b.textContent,'native cross-chapter selection preserves normalized separator');
          await settle(r);check(doc.contains(a)&&doc.contains(b),'selection pins required blocks');selection.removeAllRanges();
          // Concurrent directory jumps must never let an older read replace the destination.
          await Promise.all([r.goToChapterDocIndex(20),r.goToChapterDocIndex(80),r.goToChapterDocIndex(120)]);await settle(r);
          check(Number(r.tempLocation.chapterDocIndex)===120,'rapid deep jumps reject stale mounts');
          const index=await prepared.store.load(false),giant=index.chapters[120];
          const checkpoint=index.checkpoints.find(p=>p[0]>giant.byteStart+(giant.byteEnd-giant.byteStart)*0.8);
          const offset=checkpoint[1]-giant.start,readStart=requested.length;
          await r.txtWindow.jump(120,offset);await settle(r);
          const bytes=requested.slice(readStart).filter(c=>c.action==='read-chapter').reduce((n,c)=>n+c.length,0);
          check(bytes<256*1024,'deep giant chapter jump reads bounded local blocks');
          check(Math.abs(r.tempLocation.txtWindow.offset-offset)<100,'exact checkpoint boundary locates the target source offset');
          check(r.txtWindow.stats.mountedCharacters<=128*1024,'giant single paragraph stays within character budget');
          const visible=doc.querySelector('[data-txt-block]'),position=visible.getBoundingClientRect().top-area.scrollTop;
          doc.body.style.fontSize='23px';area.style.width='620px';await doc.fonts.ready;await settle(r);
          check(Number.isFinite(area.scrollTop)&&r.getIframe()===frame,'font and viewport changes retain iframe and finite anchor');
          const stable=r.tempLocation.txtWindow;
          const block=Array.from(doc.querySelectorAll('[data-txt-block]')).find(n=>Number(n.dataset.txtStart)<=r.book.sections[120].chapter.start+stable.offset && Number(n.dataset.txtEnd)>r.book.sections[120].chapter.start+stable.offset);
          const anchor=doc.createRange(),local=r.book.sections[120].chapter.start+stable.offset-Number(block.dataset.txtStart);anchor.setStart(block.firstChild,local);anchor.setEnd(block.firstChild,local+1);
          const anchorTop=anchor.getBoundingClientRect().top-area.scrollTop;
          doc.body.style.fontSize='19px';await settle(r);
          check(Math.abs(anchor.getBoundingClientRect().top-area.scrollTop-anchorTop)<3,'font relayout compensates the original text anchor: '+(anchor.getBoundingClientRect().top-area.scrollTop-anchorTop));
          failRead=true;let failed=false;try{await r.txtWindow.jump(120,Math.floor((giant.end-giant.start)/2));}catch{failed=true;}failRead=false;
          check(failed&&doc.contains(block),'failed destination read retains the current readable DOM');
          saved=JSON.stringify(r.tempLocation);firstGeneration=r.tempLocation.txtWindow.generation;
          check(r.tempLocation.txtWindow.chapterId===giant.chapterId,'position stores immutable chapter ID and generation');
          await r.goToChapterDocIndex(0);await settle(r);
          const first=doc.querySelector('[data-txt-block]'),selected=doc.createRange();selected.selectNodeContents(first);selection.addRange(selected);
          // Pin a long range then scroll: growth stops at the same budget.
          const last=Array.from(doc.querySelectorAll('[data-txt-block]')).at(-1);selected.setEnd(last.firstChild,last.firstChild.length);selection.removeAllRanges();selection.addRange(selected);
          area.scrollTop=last.getBoundingClientRect().top;await settle(r);
          check(r.txtWindow.stats.mountedBlocks<=24,'selected blocks cannot grow beyond hard window budget');
          selection.removeAllRanges();
        } else {
          const readStart=requested.length;await r.goToPosition(saved);await settle(r);
          check(r.tempLocation.txtWindow.generation===firstGeneration&&Number(r.tempLocation.chapterDocIndex)===120,'hot position restores same generation and chapter');
          check(requested.slice(readStart).filter(c=>c.action==='read-chapter').reduce((n,c)=>n+c.length,0)<256*1024,'hot giant position restore has bounded reads');
          await r.goToPosition(JSON.stringify({chapterDocIndex:'60',count:'0'}));await settle(r);
          check(Number(r.tempLocation.chapterDocIndex)===60,'legacy chapter/count position adapter remains readable');
          let rejected=false;try{await r.goToPosition(JSON.stringify({chapterDocIndex:'60',txtWindow:{chapterId:'wrong',generation:firstGeneration,offset:0}}));}catch{rejected=true;}check(rejected,'mismatched generation/chapter snapshot rejected');
        }
        check(blobs===0,phase+' window creates zero chapter Blob URLs');
      } finally {URL.createObjectURL=original;}
      const manager=r.txtWindow;r.removeContent();await prepared.store.close();await tick();
      check(manager.stats.mountedBlocks===0&&area.querySelectorAll('iframe').length===0,phase+' close releases window DOM');
    }
    check(!requested.some(c=>c.action==='read-source'),'cold/hot window uses zero whole-source reads');
    return checks;
  })()`);
    assert.ok(
      commands
        .filter((c) => c.action === "read-chapter")
        .every((c) => c.length <= 256 * 1024)
    );
    assert.ok(result.length >= 22);
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
          checks: result,
        },
        null,
        2
      )
    );
    console.log(
      "PASS: phase-7 bounded TXT window with compiled engine + real IPC"
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
  if (db?.open) db.close();
}
