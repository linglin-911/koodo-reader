// Chromium + normal compiled engine + host adapter + IPC + native SQLite.
// Owns only a mkdtemp synthetic library. Never opens a user profile or book.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {writeSource,seedAnnotations}=require('./helpers/phase11-fixtures.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'koodo-phase11-'));
app.setPath('userData',path.join(temporary,'profile'));app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags','--expose-gc');app.on('window-all-closed',()=>{});
const reportPath=process.argv[2]||path.join(temporary,'report.json');
let db,service,server,window;const requests=[],traces=[],errors=[],workers=new Set();let workerStarts=0;
const codeHashes=Object.fromEntries(['src/assets/lib/kookit.min.js','src/utils/main/annotation-store.js','src/utils/main/txt-reconcile.js','src/utils/reader/annotationUtil.ts','src/utils/storage/annotationService.ts','test/fixtures/annotation-stress.js','test/helpers/phase11-fixtures.cjs'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',file))).digest('hex')]));
const startedAt=new Date().toISOString(),timer=setTimeout(()=>{console.error('Stress timeout');app.exit(1);},30*60000);
const originalOpen=fs.promises.open;let readBytes=0,readCalls=0;
fs.promises.open=async(...args)=>{const h=await originalOpen(...args),read=h.read.bind(h);h.read=async(...a)=>{const r=await read(...a);readBytes+=r.bytesRead;readCalls++;return r;};return h;};
app.whenReady().then(async()=>{
 const Database=require('better-sqlite3'),{createTxtIndexService}=require('../src/utils/main/txt-index-store'),{createAnnotationService,ensureAnnotationSchema}=require('../src/utils/main/annotation-store');
 const storage=path.join(temporary,'library');fs.mkdirSync(path.join(storage,'book'),{recursive:true});fs.mkdirSync(path.join(storage,'config'));
 writeSource(path.join(storage,'book','matrix.txt'),76083283);
 db=new Database(path.join(storage,'config','notes.db'));db.pragma('journal_mode=WAL');db.exec('CREATE TABLE notes(key TEXT PRIMARY KEY,notes TEXT)');await ensureAnnotationSchema(db);
 service=createTxtIndexService({getConnection:()=>db,taskOptions:{onWorker:w=>{workerStarts++;workers.add(w);w.once('exit',()=>workers.delete(w));}}});
 const annotations=createAnnotationService({getConnection:()=>db,describeTxt:(...a)=>service.describeChapter(...a),Database,log:line=>traces.push(JSON.parse(line.slice(line.indexOf('{'))))});
 ipcMain.on('storage-location',e=>e.returnValue=storage);
 ipcMain.handle('database-command',async(e,c)=>{
  const start=performance.now(),bytes=readBytes,calls=readCalls,starts=workerStarts;
  const result=await(c.operation==='annotations'?annotations(c,e.sender.id):service(c,e.sender.id));
  requests.push({action:c.action,requestId:c.diagnostics?.requestId,durationMs:performance.now()-start,readBytes:readBytes-bytes,readCalls:readCalls-calls,workerStarts:workerStarts-starts,ipcRequestBytes:Buffer.byteLength(JSON.stringify(c)),ipcResponseBytes:Buffer.byteLength(JSON.stringify(result)),chapterIndex:c.chapterIndex});return result;
 });
 ipcMain.handle('stress-checkpoint',(_event,result)=>{fs.writeFileSync(reportPath+'.partial',JSON.stringify({passed:false,inProgress:true,startedAt,...result},null,2));return true;});
 ipcMain.handle('stress-metrics',()=>({requests:requests.splice(0),traces:traces.splice(0),mainMemory:process.memoryUsage(),workerStarts}));
 ipcMain.handle('stress-seed',async(e,{entities,multiplier,hot=false,ticket})=>{
  const active=db.prepare("SELECT generation,index_json FROM txt_index_generations WHERE book_id='matrix' AND state='ready' ORDER BY rowid DESC LIMIT 1").get(),index=JSON.parse(active.index_json);
  index.chapters=db.prepare("SELECT chapter_index AS 'index',name AS label,chapter_id AS chapterId,utf16_start AS start,utf16_end AS end,body_utf16_start AS bodyStart,first_chars AS firstChars,last_chars AS lastChars FROM txt_index_chapters WHERE book_id='matrix' AND generation=? ORDER BY chapter_index").all(active.generation);
  const seeded=seedAnnotations(db,index,active.generation,entities,multiplier,hot);await service.describeChapter(e.sender.id,ticket,0,index.chapters[0].chapterId,false);
  const plans={};for(const t of ['note_bindings','chapter_bindings','range_bindings'])plans[t]=db.prepare(`EXPLAIN QUERY PLAN SELECT b.id FROM ${t} b JOIN notes n ON n.key=b.note_key WHERE b.book_id=? AND b.generation=? AND b.status='active' AND b.start_index=? AND b.end_index>=? ORDER BY b.id LIMIT 201`).all('matrix',active.generation,0,0).map(r=>r.detail);
  return{...seeded,queryPlans:plans};
 });
 ipcMain.handle('stress-integrity',()=>({entities:db.prepare('SELECT count(*) n FROM notes').get().n,bindings:['note_bindings','chapter_bindings','range_bindings'].reduce((n,t)=>n+db.prepare(`SELECT count(*) n FROM ${t}`).get().n,0),foreignKeyErrors:db.pragma('foreign_key_check').length,integrity:db.pragma('integrity_check',{simple:true})}));
 const {createServer}=await import('vite');
 server=await createServer({root:path.resolve(__dirname,'..'),cacheDir:path.resolve(__dirname,'../node_modules/.vite-tests',path.basename(temporary)),server:{port:0,host:'127.0.0.1',warmup:{clientFiles:[]}},plugins:[{name:'phase11',configureServer(v){v.middlewares.use('/__stress__',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><body><div id="page-area" style="width:800px;height:650px;overflow:auto"></div></body></html>');});}}]});
 await server.listen();window=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});
 window.webContents.on('console-message',e=>{if(e.level===3)errors.push(e.message);if(e.message?.startsWith('STRESS '))console.log(e.message);});
 await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__stress__`);
 await window.webContents.executeJavaScript(`window.electronAPI={invoke:(...a)=>require('electron').ipcRenderer.invoke(...a),sendSync:(...a)=>require('electron').ipcRenderer.sendSync(...a)};void 0;`);
 const result=await window.webContents.executeJavaScript(`import('/test/fixtures/annotation-stress.js').then(m=>m.run())`);
 assert.equal(errors.length,0,errors.join('; '));assert.equal(workers.size,0);
 fs.writeFileSync(reportPath,JSON.stringify({passed:true,synthetic:true,userDatabaseOpened:false,codeHashes,startedAt,completedAt:new Date().toISOString(),runtime:{electron:process.versions.electron,node:process.versions.node,platform:process.platform,arch:process.arch,osRelease:os.release(),cpu:os.cpus()[0]?.model,totalMemoryBytes:os.totalmem()},rendererErrors:errors,...result},null,2));
 console.log('PASS: phase11 annotation stress');await cleanup();app.exit(0);
}).catch(async error=>{console.error(error);fs.writeFileSync(reportPath,JSON.stringify({passed:false,error:error.message,startedAt,rendererErrors:errors},null,2));await cleanup();app.exit(1);});
async function cleanup(){clearTimeout(timer);if(window&&!window.isDestroyed())window.destroy();if(server)await server.close();service?.shutdown();if(db?.open)db.close();fs.promises.open=originalOpen;}
