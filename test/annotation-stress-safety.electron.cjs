// Large formal-data safety checks; temporary synthetic databases only.
const{app}=require('electron');const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const{writeSource,seedAnnotations}=require('./helpers/phase11-fixtures.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'koodo-phase11-safety-'));app.setPath('userData',path.join(temporary,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const reportPath=process.argv[2]||path.join(temporary,'result.json'),checks=[],timings={},dbs=[];let txt,workers=0;
const timer=setTimeout(()=>{console.error('Safety timeout');app.exit(1);},30*60000);
app.whenReady().then(async()=>{
 const Database=require('better-sqlite3'),{createTxtIndexService}=require('../src/utils/main/txt-index-store'),{createAnnotationService,ensureAnnotationSchema}=require('../src/utils/main/annotation-store');
 const storage=path.join(temporary,'library');fs.mkdirSync(path.join(storage,'book'),{recursive:true});fs.mkdirSync(path.join(storage,'config'));
 const source=path.join(storage,'book','matrix.txt');writeSource(source,4*1024*1024);
 const db=new Database(path.join(storage,'config','notes.db'));dbs.push(db);db.pragma('journal_mode=WAL');db.exec('CREATE TABLE notes(key TEXT PRIMARY KEY,notes TEXT)');await ensureAnnotationSchema(db);
 txt=createTxtIndexService({getConnection:()=>db,taskOptions:{onWorker:w=>{workers++;w.once('exit',()=>workers--);}}});
 const notes=createAnnotationService({getConnection:()=>db,describeTxt:(...a)=>txt.describeChapter(...a),Database});
 const request={dbName:'notes',operation:'txt-index',storagePath:storage,bookId:'matrix',bookPath:'',charset:'utf-8',parserRegex:'^Chapter '};
 const annotation=(action,data={})=>notes({dbName:'notes',operation:'annotations',storagePath:storage,action,...data},1);
 const check=async(name,fn)=>{const t=performance.now();await fn();timings[name]=performance.now()-t;checks.push(name);console.log('PASS: '+name);};
 const digest=(database,sql)=>{const hash=crypto.createHash('sha256');for(const row of database.prepare(sql).iterate())hash.update(JSON.stringify(row)+'\n');return hash.digest('hex');};
 const entities=database=>digest(database,'SELECT * FROM notes ORDER BY key');
 const bindings=database=>Object.fromEntries(['note_bindings','chapter_bindings','range_bindings'].map(table=>[table,digest(database,`SELECT id,note_key,book_id,format,quote,prefix,suffix,style FROM ${table} ORDER BY id`)]));
 let opened=await txt({...request,action:'open'},1),built=await txt({...request,action:'prepare',ticket:opened.ticket},1),seed=seedAnnotations(db,built.index,built.generation||db.prepare("SELECT active_generation g FROM txt_index_documents WHERE book_id='matrix'").get().g,10000,10);
 const baseline={notes:entities(db),bindings:bindings(db)};
 await check('cursor pagination equals SQL oracle without duplicates, preserves offset callers and rejects invalid cursors',async()=>{
  const chapter=built.index.chapters[0],blocks=[{chapterIndex:0,chapterId:chapter.chapterId,start:0,end:Math.min(8192,chapter.end-chapter.bodyStart)}];
  const query={bookKey:'matrix',format:'TXT',sourceTicket:opened.ticket,blocks,limit:73};
  const expected=db.prepare("SELECT id FROM note_bindings WHERE start_index=0 AND status='active' ORDER BY id").all().map(row=>row.id);
  const ids=[];let afterId,offset=0;
  for(;;){const page=await annotation('reading-window',{...query,offset,afterId});ids.push(...page.records.map(row=>row.bindingId));
   if(offset===73){const legacy=await annotation('reading-window',{...query,offset});assert.deepEqual(page.records,legacy.records);assert.equal(page.related.length,0);}
   if(!page.hasMore)break;assert(page.nextCursor);afterId=page.nextCursor;offset+=73;
  }
  assert.deepEqual(ids,expected);assert.equal(new Set(ids).size,ids.length);
  await assert.rejects(()=>annotation('reading-window',{...query,afterId:''}),/Invalid/);
 });

 let unbound;
 await check('10000 entities / 99982 bindings: API unlink preserves formal body and all sibling locations',async()=>{const detail=await annotation('get',{key:'n000000'});const result=await annotation('unbind',{noteKey:detail.key,kind:'small',bindingId:detail.bindings[0].id,version:detail.bindings[0].version});unbound=result.bindings[0];assert.equal(result.notes,detail.notes);assert.equal(result.bindings.length,10);assert.equal(entities(db),baseline.notes);});
 let fullSnapshotReadsInTransaction=0,transactionPrepareCalls=0;const prepare=db.prepare.bind(db);
 db.prepare=sql=>{if(db.inTransaction){transactionPrepareCalls++;if(/SELECT \* FROM (?:note_bindings|chapter_bindings|range_bindings)/.test(sql))fullSnapshotReadsInTransaction++;}return prepare(sql);};
 const oldPositions=new Map(db.prepare('SELECT id,start_index,end_index,relative_start,relative_end FROM note_bindings UNION ALL SELECT id,start_index,end_index,relative_start,relative_end FROM chapter_bindings UNION ALL SELECT id,start_index,end_index,relative_start,relative_end FROM range_bindings').all().map(r=>[r.id,r]));
 await check('large source-change recovery has zero wrong bindings and zero lost bodies/quotes/styles',async()=>{
  fs.writeFileSync(source,Buffer.concat([Buffer.from('Chapter 0\r\nZZ_INSERTED_UNIQUE_YY\r\n'),fs.readFileSync(source)]));
  const fresh=await txt({...request,action:'open'},1);const result=await txt({...request,action:'prepare',ticket:fresh.ticket},1);
  assert.equal(entities(db),baseline.notes);assert.deepEqual(bindings(db),baseline.bindings);
  for(const table of ['note_bindings','chapter_bindings','range_bindings'])for(const row of db.prepare(`SELECT * FROM ${table}`).iterate()){
   if(row.id===unbound.id){assert.equal(row.status,'unbound');assert.equal(row.generation,unbound.generation);assert.deepEqual(JSON.parse(row.anchor_json),unbound.anchor);assert.equal(row.version,unbound.version);assert.equal(row.relative_start,unbound.relative_start);assert.equal(row.relative_end,unbound.relative_end);continue;}
   const old=oldPositions.get(row.id);assert.equal(row.status,'active',row.id);assert.equal(row.start_index,old.start_index+1,row.id);assert.equal(row.end_index,old.end_index+1,row.id);
   assert.equal(row.relative_start,old.relative_start);assert.equal(row.relative_end,old.relative_end);
   const first=result.index.chapters[row.start_index],last=result.index.chapters[row.end_index],anchor=JSON.parse(row.anchor_json);
   assert.equal(row.chapter_id,first.chapterId);assert.equal((anchor.chapter||anchor.start).chapterId,first.chapterId);
   assert.equal((anchor.chapter||anchor.start).bodyStart,first.bodyStart);assert.equal((anchor.chapter||anchor.start).start,first.start);
   if(table==='range_bindings'){assert.equal(anchor.end.chapterId,last.chapterId);assert.equal(anchor.end.end,last.end);}
  }
  assert.equal(fullSnapshotReadsInTransaction,0);assert(transactionPrepareCalls<100,'Publication prepared per-binding SQL');timings.publishFullSnapshotReads=fullSnapshotReadsInTransaction;timings.transactionPrepareCalls=transactionPrepareCalls;timings.recoveryDiagnostics=result.diagnostics;await txt({...request,action:'close',ticket:opened.ticket},1);opened=fresh;
 });
 let backup,restored,restore,restoreCommand;
 await check('large versioned backup round-trips complete formal bodies, all three binding kinds and unbound snapshots',async()=>{
  backup=await annotation('export');assert.equal(backup.notes.length,10000);assert.equal(Object.values(backup.bindings).reduce((n,b)=>n+b.length,0),seed.bindings);
  const dir=path.join(temporary,'restore');fs.mkdirSync(path.join(dir,'config'),{recursive:true});restored=new Database(path.join(dir,'config','notes.db'));dbs.push(restored);await ensureAnnotationSchema(restored);
  restore=createAnnotationService({getConnection:()=>restored,describeTxt:()=>{throw Error('No source needed for restore');},Database});restoreCommand=(action,data={})=>restore({dbName:'notes',operation:'annotations',storagePath:dir,action,...data},2);
  const result=await restoreCommand('import',{backup});assert.equal(result.notes,10000);assert.equal(result.bindings,seed.bindings);assert.equal(entities(restored),baseline.notes);assert.deepEqual(bindings(restored),baseline.bindings);
  for(const table of ['note_bindings','chapter_bindings','range_bindings'])assert.equal(restored.prepare(`SELECT count(*) n FROM ${table} WHERE status NOT IN ('pending','unbound')`).get().n,0);
 });
 await check('repeated 100k-binding import is idempotent; conflicting/newer formal body never overwrites',async()=>{
  const before={notes:entities(restored),bindings:bindings(restored)};await restoreCommand('import',{backup});assert.equal(entities(restored),before.notes);assert.deepEqual(bindings(restored),before.bindings);
  const original=backup.notes[0].notes;backup.notes[0].notes='CONFLICT';await assert.rejects(()=>restoreCommand('import',{backup}),/conflict/);backup.notes[0].notes=original;assert.equal(entities(restored),before.notes);
 });
 await check('failed large import after entity writes rolls back every new entity and binding',async()=>{
  const failed=new Database(':memory:');dbs.push(failed);await ensureAnnotationSchema(failed);failed.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON note_bindings WHEN NEW.id='b99_0' BEGIN SELECT RAISE(ABORT,'injected large restore failure');END");
  const svc=createAnnotationService({getConnection:()=>failed,describeTxt:()=>{},Database});await assert.rejects(()=>svc({dbName:'notes',operation:'annotations',storagePath:temporary,action:'import',backup},3),/injected large restore failure/);
  assert.equal(failed.prepare('SELECT count(*) n FROM notes').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM note_bindings').get().n,0);
 });
 await check('additive query-index failure preserves formal rows, and a new connection retries safely',async()=>{
  const connection=new Database(restored.name);dbs.push(connection);
  connection.exec('DROP INDEX notes_updated;DROP INDEX notes_book_updated;DROP INDEX note_bindings_position;DROP INDEX note_bindings_window_cursor;');
  const execute=connection.exec.bind(connection),marker='CREATE INDEX IF NOT EXISTS notes_book_updated';
  connection.exec=sql=>{const at=sql.indexOf(marker);if(at>=0){execute(sql.slice(0,at));throw Error('injected additive index failure');}return execute(sql);};
  await assert.rejects(()=>ensureAnnotationSchema(connection),/injected additive index failure/);assert.equal(entities(connection),baseline.notes);
  connection.exec=execute;await ensureAnnotationSchema(connection);assert.equal(entities(connection),baseline.notes);
  assert.equal(connection.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name IN ('notes_updated','notes_book_updated','note_bindings_position','note_bindings_window_cursor')").get().n,4);
 });
 await check('formal schema reopens idempotently without changing entity contents and passes integrity checks',async()=>{
  await ensureAnnotationSchema(db);await ensureAnnotationSchema(restored);assert.equal(entities(db),baseline.notes);assert.equal(entities(restored),baseline.notes);
  for(const database of [db,restored]){assert.equal(database.pragma('integrity_check',{simple:true}),'ok');assert.equal(database.pragma('foreign_key_check').length,0);}
 });
 await txt({...request,action:'close',ticket:opened.ticket},1);txt.shutdown();
 fs.writeFileSync(reportPath,JSON.stringify({passed:true,synthetic:true,userDatabaseOpened:false,sourceBytes:fs.statSync(source).size,...seed,checks,timings,dataLossCount:0,wrongAutoBindings:0,runtime:{electron:process.versions.electron,node:process.versions.node,cpu:os.cpus()[0]?.model}},null,2));await cleanup();app.exit(0);
}).catch(async e=>{console.error(e);fs.writeFileSync(reportPath,JSON.stringify({passed:false,error:e.message,checks,timings},null,2));await cleanup();app.exit(1);});
async function cleanup(){clearTimeout(timer);txt?.shutdown();for(const db of dbs)if(db.open)db.close();}
