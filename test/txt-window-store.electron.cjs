const {app}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'koodo-txt-window-store-'));
app.setPath('userData',path.join(temporary,'profile'));app.disableHardwareAcceleration();
const report=process.argv[2]||path.join(temporary,'result.json');let db,txt;
app.whenReady().then(async()=>{
  const Database=require('better-sqlite3'),source=require('../src/utils/main/txt-source');
  const originalRead=source.readVerifiedRangeAsync;let bytes=0;
  source.readVerifiedRangeAsync=async(...args)=>{bytes+=args[3];return originalRead(...args);};
  const {createTxtIndexService}=require('../src/utils/main/txt-index-store'),{createAnnotationService}=require('../src/utils/main/annotation-store');
  const storage=path.join(temporary,'library');fs.mkdirSync(path.join(storage,'book'),{recursive:true});fs.mkdirSync(path.join(storage,'config'));
  const body='甲😀'.repeat(60000),file='Chapter 1\r\n'+body;
  fs.writeFileSync(path.join(storage,'book','fixture.txt'),file);
  db=new Database(path.join(storage,'config','notes.db'));db.exec('CREATE TABLE notes(key TEXT PRIMARY KEY,notes TEXT)');
  let indexHeaderReads=0;const prepare=db.prepare.bind(db);db.prepare=sql=>{if(sql.includes('SELECT c.*,g.document_revision,g.index_json'))indexHeaderReads++;return prepare(sql);};
  txt=createTxtIndexService({getConnection:()=>db});
  const annotations=createAnnotationService({getConnection:()=>db,describeTxt:(...args)=>txt.describeChapter(...args),loadRegistry:async()=>({}),Database});
  const base={dbName:'notes',storagePath:storage,bookId:'fixture',bookPath:'',charset:'utf-8',parserRegex:''};
  const opened=await txt({...base,action:'open'},1),index=(await txt({...base,ticket:opened.ticket,action:'prepare'},1)).index,chapter=index.chapters[0];
  const call=(action,data={},owner=1)=>annotations({dbName:'notes',storagePath:storage,action,...data},owner);
  const binding={format:'TXT',sourceTicket:opened.ticket,chapterIndex:0,chapterId:chapter.chapterId,start:90000,end:90003};
  let cases=0;const check=async(name,run)=>{await run();cases++;console.log('PASS: '+name);};let note;
  await check('giant selection reads bounded bytes and preserves exact 32-code-point context',async()=>{
    bytes=0;note=await call('create',{note:{bookKey:'fixture',kind:'small',notes:'PROTECTED_FORMAL_BODY',tag:[]},binding});
    assert.equal(note.bindings[0].quote,body.slice(90000,90003));assert(bytes<32768);
    assert.equal(note.bindings[0].prefix,Array.from(body.slice(0,90000)).slice(-32).join(''));
    assert.equal(note.bindings[0].suffix,Array.from(body.slice(90003)).slice(0,32).join(''));
  });
  const query={bookKey:'fixture',format:'TXT',sourceTicket:opened.ticket,blocks:[{chapterIndex:0,chapterId:chapter.chapterId,start:89990,end:90010}]};
  await check('window projection loads only overlapping bindings and no original quote or entity body',async()=>{
    await call('create',{note:{bookKey:'fixture',kind:'small',notes:'outside body',tag:[]},binding:{...binding,start:0,end:3}});
    indexHeaderReads=0;const result=await call('reading-window',query);assert.equal(indexHeaderReads,0);assert.equal(result.records.length,1);assert.equal(result.records[0].bindingId,note.bindings[0].id);
    assert(!JSON.stringify(result).includes('PROTECTED_FORMAL_BODY'));assert(!Object.hasOwn(result.records[0],'quote'));
  });
  await check('summary progress sorting orders offsets inside the same chapter in both directions',async()=>{
    for(const order of ['ASC','DESC']){
      const page=await call('list',{bookKey:'fixture',kind:'small',sort:'position',order});
      assert.deepEqual(page.records.map(row=>JSON.parse(row.cfi).annotationStart),order==='ASC'?[0,90000]:[90000,0]);
    }
  });
  await check('foreign owner, wrong chapter, invalid coordinates and oversized windows are rejected',async()=>{
    await assert.rejects(call('reading-window',query,2));
    for(const blocks of [[{...query.blocks[0],chapterId:'wrong'}],[{...query.blocks[0],end:body.length+1}],[{...query.blocks[0],end:query.blocks[0].start+8193}],Array(25).fill(query.blocks[0]),[{...query.blocks[0],start:-1}],Array(24).fill({...query.blocks[0],start:0,end:8192})])await assert.rejects(call('reading-window',{...query,blocks}));
  });
  await check('split surrogate and invalid range cannot create orphan formal entities',async()=>{
    for(const range of [{start:90002,end:90003},{start:body.length,end:body.length+2},{start:1,end:0}])await assert.rejects(call('create',{note:{bookKey:'fixture',kind:'small',notes:'must not survive',tag:[]},binding:{...binding,...range}}));
    assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n,2);
  });
  await check('chapter and range relations use the ready generation without loading their full bodies',async()=>{
    for(const kind of ['chapter','range']){
      const entity=await call('save',{note:{bookKey:'fixture',kind,notes:'PRIVATE_RELATED_BODY',tag:[]}});
      await call('bind',{noteKey:entity.key,binding:{...binding,...(kind==='range'?{endChapterIndex:0,endChapterId:chapter.chapterId}:{})}});
    }
    const result=await call('reading-window',query);assert.deepEqual(result.related.map(row=>row.kind).sort(),['chapter','range']);assert(!JSON.stringify(result).includes('PRIVATE_RELATED_BODY'));
  });
  await check('window query uses its composite index and pages dense overlapping bindings',async()=>{
    const bindingRow=db.prepare('SELECT * FROM note_bindings WHERE id=?').get(note.bindings[0].id),keys=Object.keys(bindingRow),insert=db.prepare('INSERT INTO note_bindings('+keys.join(',')+') VALUES('+keys.map(key=>'@'+key).join(',')+')');
    db.transaction(()=>{for(let i=0;i<250;i++)insert.run({...bindingRow,id:'dense-'+i});})();
    const page1=await call('reading-window',{...query,limit:200,offset:0}),page2=await call('reading-window',{...query,limit:200,offset:200});
    assert.equal(page1.records.length,200);assert(page1.hasMore);assert.equal(page2.records.length,51);assert(!page2.hasMore);
    assert.equal(new Set([...page1.records,...page2.records].map(row=>row.bindingId)).size,251);
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM note_bindings WHERE book_id=? AND generation=? AND status='active' AND start_index=? AND relative_end>? AND relative_start<?").all('fixture',note.bindings[0].generation,0,89990,90010);
    assert(plan.some(row=>row.detail.includes('note_bindings_window')));
  });
  await check('verified unchanged-source publication recovers exact bindings and rejects old chapter identifiers',async()=>{
    const before=db.prepare('SELECT notes FROM notes WHERE key=?').get(note.key).notes;
    const rebuilt=(await txt({...base,ticket:opened.ticket,action:'prepare'},1)).index;
    await assert.rejects(call('reading-window',query));
    const recovered=await call('reading-window',{...query,blocks:[{...query.blocks[0],chapterId:rebuilt.chapters[0].chapterId}]});assert.equal(recovered.records.length,200);assert(recovered.hasMore);
    assert.equal(db.prepare('SELECT quote FROM note_bindings WHERE id=?').get(note.bindings[0].id).quote,note.bindings[0].quote);
    assert.equal(db.prepare('SELECT notes FROM notes WHERE key=?').get(note.key).notes,before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM note_bindings WHERE status='pending'").get().n,0);
  });
  fs.writeFileSync(report,JSON.stringify({passed:true,cases,userDatabaseOpened:false,nativeSqlite:true},null,2));txt.shutdown();db.close();app.exit(0);
}).catch(error=>{console.error(error);fs.writeFileSync(report,JSON.stringify({passed:false,error:error.message}));txt?.shutdown();if(db?.open)db.close();app.exit(1);});
