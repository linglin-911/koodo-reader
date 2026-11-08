// Native SQLite + actual Worker + controlled annotation service. Synthetic data only.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'koodo-txt-recovery-'));
app.setPath('userData',path.join(temporary,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const report=process.argv[2]||path.join(temporary,'result.json');
let db,service;const checks=[],liveWorkers=new Set();
const deadline=setTimeout(()=>{console.error('Recovery test timed out');app.exit(1);},180000);
app.whenReady().then(async()=>{
 const Database=require('better-sqlite3'),{createTxtIndexService}=require('../src/utils/main/txt-index-store'),{createAnnotationService,ensureAnnotationSchema}=require('../src/utils/main/annotation-store');
 const storage=path.join(temporary,'library');fs.mkdirSync(path.join(storage,'book'),{recursive:true});fs.mkdirSync(path.join(storage,'config'));
 db=new Database(path.join(storage,'config','notes.db'));db.pragma('journal_mode=WAL');db.exec('CREATE TABLE notes(key TEXT PRIMARY KEY,notes TEXT)');await ensureAnnotationSchema(db);
 let batchHook=async()=>{};
 service=createTxtIndexService({getConnection:()=>db,taskOptions:{beforeBatch:rows=>batchHook(rows),onWorker:worker=>{liveWorkers.add(worker);worker.once('exit',()=>liveWorkers.delete(worker));}}});
 const annotations=createAnnotationService({getConnection:()=>db,describeTxt:(...args)=>service.describeChapter(...args)});
 const annotation=(action,data={})=>annotations({dbName:'notes',operation:'annotations',storagePath:storage,action,...data},1);
 const request=book=>({dbName:'notes',operation:'txt-index',storagePath:storage,bookId:book,bookPath:'',charset:book.startsWith('utf16le')?'utf-16le':book.startsWith('utf16be')?'utf-16be':book==='gbk'?'gbk':'utf-8',parserRegex:['giant','fixed-proof'].includes(book)?'':'^(?:Chapter|Renamed|Extra) '});
 const call=(s,action,extra={})=>service({...request(s.book),ticket:s.ticket,action,...extra},1);
 const sources=[];
 const open=async book=>{const s={...await service({...request(book),action:'open'},1),book};sources.push(s);return s;};
 const scan=async book=>{const s=await open(book);s.index=(await call(s,'rebuild')).index;return s;};
 const write=(book,sections)=>{const text=sections.map(([name,body])=>name+'\r\n'+body+'\r\n').join('');fs.writeFileSync(path.join(storage,'book',book+'.txt'),text);return text.replace(/\r\n/g,'\n');};
 const defaults=()=>[['Chapter 1','开甲 LEFT😀唯一摘录𠀀 RIGHT 终乙'],['Chapter 2','乙开 SECOND 乙末'],['Chapter 3','丙开 THIRD 丙末']];
 const create=async(s,kind,index=0,quote='唯一摘录𠀀',end=2)=>{
  const chapter=s.index.chapters[index],source=fs.readFileSync(path.join(storage,'book',s.book+'.txt'),'utf8').replace(/\r\n/g,'\n');
  const start=source.slice(chapter.bodyStart,chapter.end).indexOf(quote);
  const binding={format:'TXT',sourceTicket:s.ticket,chapterIndex:index,chapterId:chapter.chapterId,start,end:start+quote.length};
  if(kind==='range'){binding.endChapterIndex=end;binding.endChapterId=s.index.chapters[end].chapterId;}
  return annotation('create',{note:{bookKey:s.book,kind,notes:'FORMAL BODY '+kind+' 😀',tag:['keep']},binding});
 };
 const get=note=>annotation('get',{key:note.key});
 const active=book=>db.prepare('SELECT active_generation g FROM txt_index_documents WHERE book_id=?').get(book)?.g;
 const noBuilding=()=>db.prepare("SELECT count(*) n FROM txt_index_generations WHERE state='building'").get().n===0;
 const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
 const wait=async(predicate)=>{const until=Date.now()+15000;while(Date.now()<until){if(await predicate())return;await pause();}throw Error('Condition timed out');};
 const check=async(name,run)=>{await run();assert(noBuilding());checks.push(name);console.log('PASS: '+name);};
 await check('unannotated source rebuild performs one Worker scan, complete SHA-256 and metadata-only hot open',async()=>{
  write('none',defaults());const s=await scan('none'),file=fs.readFileSync(path.join(storage,'book','none.txt'));
  assert.deepEqual(s.index.fullHash,{algorithm:'sha256',digest:crypto.createHash('sha256').update(file).digest('hex'),bytes:file.length});
  const hot=await open('none');assert(hot.cacheHit);assert.equal(hot.buffer,undefined);
 });
 await check('small, chapter and complete range recover atomically after insertion and preserve entity bodies/styles',async()=>{
  write('insert',defaults());const old=await scan('insert'),notes=[];for(const kind of ['small','chapter','range'])notes.push(await create(old,kind));
  write('insert',[['Extra 0','新开 INTRO 新末'],...defaults()]);const fresh=await scan('insert');
  for(const note of notes){const restored=await get(note),binding=restored.bindings[0];assert.equal(restored.notes,note.notes);assert.deepEqual(restored.tag,note.tag);assert.equal(binding.status,'active');assert.equal(binding.generation,active('insert'));assert.equal(binding.start_index,1);assert.equal(binding.style,note.bindings[0].style);assert.equal(binding.id,note.bindings[0].id);}
  assert.equal((await get(notes[2])).bindings[0].end_index,3);
  const results=await annotation('recovery-results',{bookKey:'insert'});assert.equal(results.counts.active,3);assert.equal(results.records.length,3);
  assert(db.prepare("SELECT 1 FROM txt_index_generations WHERE book_id='insert' AND generation=?").get(notes[0].bindings[0].generation));
 });
 await check('renamed chapters recover only via both unique strong features plus an existing excerpt',async()=>{
  write('rename',defaults());const s=await scan('rename'),small=await create(s,'small'),chapter=await create(s,'chapter');
  const next=defaults();next[0][0]='Renamed 1';write('rename',next);await scan('rename');
  for(const note of [small,chapter]){const b=(await get(note)).bindings[0];assert.equal(b.status,'active');assert.equal(b.anchor.chapter.label,'Renamed 1');}
 });
 await check('deleted quote becomes invalid without overwriting original snapshot, quote or body',async()=>{
  write('deleted',defaults());const s=await scan('deleted'),note=await create(s,'small'),saved=note.bindings[0];
  const next=defaults();next[0][1]=next[0][1].replace('唯一摘录𠀀','已删除');write('deleted',next);await scan('deleted');
  const result=await get(note),b=result.bindings[0];assert.equal(b.status,'invalid');assert.equal(b.quote,saved.quote);assert.deepEqual(b.anchor,saved.anchor);assert.equal(b.generation,saved.generation);assert.equal(result.notes,note.notes);
 });
 await check('duplicate title and indistinguishable quotes stay pending, with no arbitrary chapter-index recovery',async()=>{
  write('duplicate',defaults());const s=await scan('duplicate'),small=await create(s,'small'),chapter=await create(s,'chapter');
  const next=defaults();next.push([...next[0]]);write('duplicate',next);await scan('duplicate');
  for(const note of [small,chapter]){const b=(await get(note)).bindings[0];assert.equal(b.status,'pending');assert.deepEqual(b.anchor,note.bindings[0].anchor);}
 });
 await check('duplicate excerpts with unique exact context recover the correct new offset',async()=>{
  const parts=defaults();parts[0][1]='开甲 左边唯一摘录𠀀右边 终乙';write('context',parts);const s=await scan('context'),note=await create(s,'small');
  parts[0][1]='开甲 另一处唯一摘录𠀀不同 '+parts[0][1];write('context',parts);await scan('context');
  const b=(await get(note)).bindings[0];assert.equal(b.status,'active');assert(b.relative_start>note.bindings[0].relative_start);assert.equal(b.quote,note.bindings[0].quote);
 });
 await check('reordered range endpoints and a missing endpoint never partially activate a range',async()=>{
  for(const [book,modify] of [['reverse',p=>p.reverse()],['missing',p=>p.slice(0,2)]]){
   write(book,defaults());const s=await scan(book),note=await create(s,'range'),parts=defaults();write(book,modify(parts));await scan(book);
   const b=(await get(note)).bindings[0];assert.equal(b.status,'pending');assert.deepEqual(b.anchor,note.bindings[0].anchor);assert.equal(b.generation,note.bindings[0].generation);
  }
 });
 await check('unbound bindings are excluded; old referenced generations survive repeated cache GC',async()=>{
  write('unbound',defaults());const s=await scan('unbound'),note=await create(s,'small');
  await annotation('unbind',{kind:'small',noteKey:note.key,bindingId:note.bindings[0].id,version:note.bindings[0].version});const before=(await get(note)).bindings[0];
  write('unbound',[['Extra 0','新增'],...defaults()]);await scan('unbound');await scan('unbound');
  assert.deepEqual((await get(note)).bindings[0],before);
  const protectedBinding=(await annotation('recovery-results',{bookKey:'deleted'})).records[0];assert(protectedBinding);
  const deletedNote=(await annotation('list',{bookKey:'deleted'})).records[0];
  const preservedGeneration=(await get(deletedNote)).bindings[0].generation;
  await scan('deleted');await scan('deleted');
  assert(db.prepare('SELECT 1 FROM txt_index_generations WHERE book_id=? AND generation=?').get('deleted',preservedGeneration));
 });
 await check('manual replacement while scanning wins binding epoch comparison and is never overwritten',async()=>{
  write('concurrent',defaults());const s=await scan('concurrent'),note=await create(s,'small');let release,entered=false;const held=new Promise(resolve=>release=resolve);
  batchHook=async()=>{entered=true;await held;};const job=call(s,'rebuild');await wait(()=>entered);
  const c=s.index.chapters[1],replacement=await annotation('bind',{noteKey:note.key,replaceId:note.bindings[0].id,replaceVersion:1,binding:{format:'TXT',sourceTicket:s.ticket,chapterIndex:1,chapterId:c.chapterId,start:3,end:9}});
  const manual=replacement.bindings.find(b=>b.status==='active');release();await job;batchHook=async()=>{};
  const current=await get(note),b=current.bindings.find(b=>b.id===manual.id);assert.equal(b.status,'pending');assert.deepEqual(b.anchor,manual.anchor);assert.equal(b.quote,manual.quote);assert.equal(current.bindings[0].status,'unbound');
 });
 await check('entity edits during scanning are preserved while unchanged binding versions may recover',async()=>{
  write('body-edit',defaults());const s=await scan('body-edit'),note=await create(s,'small');let release,entered=false;const held=new Promise(resolve=>release=resolve);
  batchHook=async()=>{entered=true;await held;};const job=call(s,'rebuild');await wait(()=>entered);
  await annotation('save',{note:{...note,notes:'EDITED DURING SCAN'}});release();await job;batchHook=async()=>{};
  const result=await get(note);assert.equal(result.notes,'EDITED DURING SCAN');assert.equal(result.bindings[0].status,'active');
 });
 await check('recovery SQL failure rolls back the index pointer, all binding updates and result rows',async()=>{
  write('sql-failure',defaults());const s=await scan('sql-failure'),note=await create(s,'small'),previous=active('sql-failure');
  db.exec("CREATE TEMP TRIGGER recovery_fail BEFORE INSERT ON txt_recovery_results WHEN NEW.book_id='sql-failure' BEGIN SELECT RAISE(ABORT,'injected recovery failure'); END");
  await assert.rejects(()=>call(s,'rebuild'),/injected recovery failure/);db.exec('DROP TRIGGER recovery_fail');assert.equal(active('sql-failure'),previous);assert.deepEqual(await get(note),note);
 });
 await check('last-consumer close during candidate streaming cancels before publication and preserves old snapshots',async()=>{
  write('cancel',defaults());const s=await scan('cancel'),note=await create(s,'small'),previous=active('cancel');
  const source=require('../src/utils/main/txt-source'),original=source.readBodyChunks;let release,entered=false;const held=new Promise(resolve=>release=resolve);
  source.readBodyChunks=async function*(...args){entered=true;await held;yield* original(...args);};
  try{const job=call(s,'rebuild'),rejected=assert.rejects(job,/cancelled/);await wait(()=>entered);await call(s,'close');release();await rejected;await wait(noBuilding);assert.equal(active('cancel'),previous);assert.deepEqual(await get(note),note);}
  finally{source.readBodyChunks=original;release?.();}
 });
 await check('source changes and active-generation CAS loss during recovery fail without binding writes',async()=>{
  for(const mode of ['source','cas']){
   const book='change-'+mode;write(book,defaults());const s=await scan(book),note=await create(s,'small'),source=require('../src/utils/main/txt-source'),original=source.readBodyChunks;
   let release,entered=false;const held=new Promise(resolve=>release=resolve);source.readBodyChunks=async function*(...args){entered=true;await held;yield* original(...args);};
   try{const job=call(s,'rebuild'),rejected=assert.rejects(job,/changed/);await wait(()=>entered);if(mode==='source')fs.appendFileSync(path.join(storage,'book',book+'.txt'),'CHANGED');else await call(s,'invalidate');release();await rejected;assert.deepEqual(await get(note),note);}
   finally{source.readBodyChunks=original;release?.();}
  }
 });
 await check('result pagination is bounded, stale versions disappear, backup retains recovered and pending snapshots',async()=>{
  await assert.rejects(()=>annotation('recovery-results',{bookKey:'insert',limit:101}),/Invalid/);
  const result=await annotation('recovery-results',{bookKey:'insert',limit:1});assert.equal(result.records.length,1);assert(result.hasMore);
  const before=await annotation('export');assert(before.notes.every(n=>n.notes));assert(before.bindings.small.some(b=>b.status==='invalid'));assert(before.bindings.range.some(b=>b.status==='pending'));
  const b=before.bindings.small.find(b=>b.book_id==='insert');await annotation('unbind',{kind:'small',noteKey:b.note_key,bindingId:b.id,version:b.version});
  assert(!(await annotation('recovery-results',{bookKey:'insert'})).records.some(r=>r.binding_id===b.id));
 });

 await check('UTF-8/UTF-16LE/UTF-16BE BOM and GBK source changes preserve exact normalized quote offsets',async()=>{
  for(const book of ['utf8-bom','utf16le-bom','utf16be-bom','gbk']){
   const encode=text=>{
    if(book==='utf8-bom')return Buffer.concat([Buffer.from([239,187,191]),Buffer.from(text)]);
    const bytes=Buffer.from(text,'utf16le');if(book.startsWith('utf16be'))bytes.swap16();
    return Buffer.concat([Buffer.from(book.startsWith('utf16be')?[254,255]:[255,254]),bytes]);
   };
   const writeEncoded=prefix=>{const text=prefix+'Chapter 1\r\nAB正文CD\r\n';
    const data=book==='gbk'?Buffer.concat([Buffer.from(prefix+'Chapter 1\r\nAB'),Buffer.from([0xd5,0xfd,0xce,0xc4]),Buffer.from('CD\r\n')]):encode(text);
    fs.writeFileSync(path.join(storage,'book',book+'.txt'),data);
   };
   writeEncoded('');const old=await scan(book),c=old.index.chapters[0];
   const note=await annotation('create',{note:{bookKey:book,kind:'small',notes:'ENCODING FORMAL BODY',tag:[]},binding:{format:'TXT',sourceTicket:old.ticket,chapterIndex:0,chapterId:c.chapterId,start:2,end:4}});
   assert.equal(note.bindings[0].quote,'正文');writeEncoded('Chapter 0\r\nINTRO\r\n');await scan(book);
   const b=(await get(note)).bindings[0];assert.equal(b.status,'active');assert.equal(b.start_index,1);assert.equal(b.relative_start,2);assert.equal(b.quote,'正文');
  }
 });
 await check('100MiB giant candidate is streamed once in bounded decoded chunks and restores a deep emoji quote',async()=>{
  const book='giant',file=path.join(storage,'book',book+'.txt'),fd=fs.openSync(file,'w'),chunk=Buffer.alloc(1024*1024,120),quote='GIANT😀NEEDLE',offset=80*1024*1024;
  try{fs.writeSync(fd,'Chapter 1\r\n');for(let i=0;i<80;i++)fs.writeSync(fd,chunk);fs.writeSync(fd,quote);for(let i=0;i<20;i++)fs.writeSync(fd,chunk);fs.writeSync(fd,'\r\n');}finally{fs.closeSync(fd);}
  const old=await scan(book),c=old.index.chapters[0];
  const note=await annotation('create',{note:{bookKey:book,kind:'small',notes:'GIANT FORMAL BODY',tag:[]},binding:{format:'TXT',sourceTicket:old.ticket,chapterIndex:0,chapterId:c.chapterId,start:offset,end:offset+quote.length}});
  const source=require('../src/utils/main/txt-source'),original=source.readBodyChunks;let reads=0,maximum=0;
  source.readBodyChunks=async function*(...args){reads++;for await(const text of original(...args)){maximum=Math.max(maximum,text.length);yield text;}};
  try{await call(old,'rebuild');}finally{source.readBodyChunks=original;}
  const result=await get(note),b=result.bindings[0];assert.equal(reads,1);assert(maximum<=256*1024);assert.equal(b.status,'active');assert.equal(b.relative_start,offset);assert.equal(b.quote,quote);assert.equal(result.notes,note.notes);
 });
 await check('additive recovery migration failure preserves existing formal rows and supports safe retry',async()=>{
  const {ensureRecoverySchema}=require('../src/utils/main/txt-reconcile'),other=new Database(path.join(temporary,'migration.db'));
  other.exec("CREATE TABLE notes(key TEXT PRIMARY KEY,notes TEXT);INSERT INTO notes VALUES('protected','FORMAL CONTENT')");
  const backup=other.backup;other.backup=async()=>{throw Error('injected backup failure');};
  await assert.rejects(()=>ensureRecoverySchema(other),/injected backup failure/);
  assert.equal(other.prepare("SELECT notes FROM notes WHERE key='protected'").get().notes,'FORMAL CONTENT');
  assert(!other.prepare("SELECT 1 FROM sqlite_master WHERE name='txt_recovery_results'").get());
  other.backup=backup;await ensureRecoverySchema(other);assert.equal(other.prepare('SELECT version FROM txt_recovery_schema').get().version,1);other.close();
 });
 await check('relocation cannot silently override an available library original with a different selected file',async()=>{
  const other=path.join(temporary,'different.txt');fs.writeFileSync(other,'Chapter 1\nDifferent source');
  await assert.rejects(()=>service({...request('none'),action:'open',bookPath:other,requireSelectedSource:true},1),/TXT_LIBRARY_SOURCE_AVAILABLE/);
 });

 await check('relative offsets disambiguate duplicate context only under complete unchanged-source SHA-256 proof',async()=>{
  const repeated='a'.repeat(40)+'TARGET'+'b'.repeat(40),parts=[['Chapter 1','AB'+repeated+' MIDDLE '+repeated+'CD']];
  write('position-proof',parts);const old=await scan('position-proof'),note=await create(old,'small',0,'TARGET');
  await call(old,'rebuild');let result=await get(note);assert.equal(result.bindings[0].status,'active');assert.equal(result.bindings[0].relative_start,note.bindings[0].relative_start);
  parts.push(['Chapter 2','UNRELATED CHANGE']);write('position-proof',parts);await scan('position-proof');
  result=await get(note);assert.equal(result.bindings[0].status,'pending');assert.equal(result.notes,note.notes);
 });

 await check('unchanged-source proof preserves untitled fixed-chunk bindings without trusting generated chapter labels',async()=>{
  fs.writeFileSync(path.join(storage,'book','fixed-proof.txt'),'x'.repeat(40)+'TARGET'+'x'.repeat(40));
  const source=await scan('fixed-proof'),small=await create(source,'small',0,'TARGET'),chapter=await create(source,'chapter');
  await call(source,'rebuild');
  for(const note of [small,chapter])assert.equal((await get(note)).bindings[0].status,'active');
  fs.appendFileSync(path.join(storage,'book','fixed-proof.txt'),'x');await scan('fixed-proof');
  for(const note of [small,chapter])assert.equal((await get(note)).bindings[0].status,'pending');
 });

 await check('TXT rebuilding never changes an existing non-TXT binding or its formal body',async()=>{
  write('other-format',defaults());const source=await scan('other-format');
  const note=await annotation('create',{note:{bookKey:'other-format',kind:'small',notes:'NON TXT FORMAL BODY',tag:[]},binding:{format:'EPUB',chapterIndex:0,chapter:'Original EPUB location',quote:'kept',range:'{}',cfi:'{}',percentage:'0'}});
  await call(source,'rebuild');assert.deepEqual(await get(note),note);
 });
 for(const s of sources)await call(s,'close');await wait(()=>liveWorkers.size===0);assert(noBuilding());
 fs.writeFileSync(report,JSON.stringify({passed:true,cases:checks.length,checks,userDatabaseOpened:false,nativeSqlite:true,liveWorkers:liveWorkers.size,annotationSchema:db.prepare('SELECT version FROM annotation_schema').get().version,indexSchema:db.prepare('SELECT version FROM txt_index_schema').get().version,recoverySchema:db.prepare('SELECT version FROM txt_recovery_schema').get().version},null,2));
 clearTimeout(deadline);service.shutdown();db.close();app.exit(0);
}).catch(error=>{console.error(error);fs.writeFileSync(report,JSON.stringify({passed:false,error:error.message}));clearTimeout(deadline);service?.shutdown();if(db?.open)db.close();app.exit(1);});
