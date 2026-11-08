// Recovery uses formal snapshots, never old chapter numbers as identity.
// This module runs in the main process, outside the publication transaction.
const crypto = require('node:crypto');
const TABLES = {small:'note_bindings',chapter:'chapter_bindings',range:'range_bindings'};
const migrations = new WeakMap();
const hasAnnotations = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='annotation_schema'").get();
const bindingEpoch = rows => crypto.createHash('sha256').update(JSON.stringify(rows.map(row=>[row.kind,row.id,row.version,row.status]))).digest('hex');
// Publication CAS needs versions/cardinality, not quotes, identities or source
// proofs. All controlled binding mutations advance version/status or add an ID.
const captureBindingVersions = (db,book) => {
  const rows=hasAnnotations(db)?Object.entries(TABLES).flatMap(([kind,table])=>
    db.prepare(`SELECT id,note_key,generation,status,version FROM ${table} WHERE book_id=? AND format='TXT' AND status!='unbound' ORDER BY id`).all(book).map(row=>({...row,kind}))):[];
  return {rows,epoch:bindingEpoch(rows)};
};
const captureBindings = (db,book) => {
  const rows = hasAnnotations(db) ? Object.entries(TABLES).flatMap(([kind,table]) =>
    db.prepare(`SELECT * FROM ${table} WHERE book_id=? AND format='TXT' AND status!='unbound' ORDER BY id`).all(book).map(row=>({...row,kind}))) : [];
  const indexed=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='txt_index_chapters'").get();
  const identities=new Map(),proofs=new Map();
  for(const row of rows){
    if(!proofs.has(row.generation))proofs.set(row.generation,indexed&&row.generation?db.prepare(`SELECT
      CASE WHEN json_valid(index_json) THEN json_extract(index_json,'$.fullHash.digest') END digest,
      CASE WHEN json_valid(index_json) THEN json_extract(index_json,'$.contract') END contract,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.configDigest') END configDigest
      FROM txt_index_generations WHERE book_id=? AND generation=?`).get(book,row.generation):null);
    row.sourceProof=proofs.get(row.generation);
  }
  for(const row of rows){
    let anchor;try{anchor=JSON.parse(row.anchor_json);}catch{continue;}
    const identity=part=>{
      if(!part)return part;
      const key=JSON.stringify([row.generation,part.chapterId]);
      if(!identities.has(key))identities.set(key,indexed&&row.generation&&part.chapterId?db.prepare('SELECT recognition FROM txt_index_chapters WHERE book_id=? AND generation=? AND chapter_id=?').get(book,row.generation,part.chapterId)?.recognition:null);
      // Old v1 snapshots did not identify generated fallback labels. Recover
      // provenance from only their referenced immutable rows; imported unknown
      // labels are not proof of a real source heading.
      return {...part,recognition:identities.get(key)||part.recognition||'unknown'};
    };
    row.identity={...anchor,...(anchor.chapter?{chapter:identity(anchor.chapter)}:{}),...(anchor.start?{start:identity(anchor.start),end:identity(anchor.end)}:{})};
  }
  const epoch = bindingEpoch(rows);
  return {rows,epoch};
};
const ensureRecoverySchema = db => {
  if(migrations.has(db))return migrations.get(db);
  const pending=(async()=>{
    const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE name='txt_recovery_schema'").get();
    if(exists){if(db.prepare('SELECT version FROM txt_recovery_schema WHERE id=1').get()?.version!==1)throw Error('Unsupported TXT recovery schema');return;}
    if(db.name!==':memory:')await db.backup(db.name+'.pre-txt-recovery-v1-'+crypto.randomUUID()+'.bak');
    db.transaction(()=>db.exec(`
      CREATE TABLE txt_recovery_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT INTO txt_recovery_schema VALUES(1,1);
      CREATE TABLE txt_recovery_results(book_id TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL,
        binding_id TEXT NOT NULL,note_key TEXT NOT NULL,binding_version INTEGER NOT NULL,status TEXT NOT NULL,
        reason TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(book_id,generation,kind,binding_id));
      CREATE INDEX txt_recovery_results_book ON txt_recovery_results(book_id,generation,status);
    `))();
  })();
  migrations.set(db,pending);pending.catch(()=>migrations.delete(db));return pending;
};
const strong = snapshot => snapshot && [snapshot.firstChars,snapshot.lastChars].every(value=>typeof value==='string'&&Array.from(value.replace(/\s/gu,'')).length>=2&&new Set(Array.from(value.replace(/\s/gu,''))).size>=2);
const featureKey = chapter => strong(chapter) ? JSON.stringify([chapter.firstChars,chapter.lastChars]) : null;
const makeCandidates = chapters => {
  const names=new Map(),features=new Map(),coordinates=new Map();
  const coordinateKey=chapter=>JSON.stringify([chapter?.start,chapter?.end,chapter?.bodyStart,chapter?.label]);
  const add=(map,key,chapter)=>{if(key){if(!map.has(key))map.set(key,[]);map.get(key).push(chapter);}};
  for(const chapter of chapters){if(chapter.recognition==='heading')add(names,chapter.label?.trim(),chapter);add(features,featureKey(chapter),chapter);add(coordinates,coordinateKey(chapter),chapter);}
  return (snapshot,kind='small',stable=false) => {
    if(stable)return coordinates.get(coordinateKey(snapshot))||[];
    const named=snapshot?.recognition==='heading'?(names.get(snapshot.label?.trim())||[]):[];
    if(kind!=='small'&&named.length>1&&featureKey(snapshot)){
      const exact=named.filter(chapter=>featureKey(chapter)===featureKey(snapshot));
      if(exact.length===1)return exact;
    }
    // An existing chapter name is stronger than the two-code-point feature pair.
    // Do not search unrelated feature collisions after its quote was deleted.
    return named.length ? named : features.get(featureKey(snapshot))||[];
  };
};
const boundary=(text,index)=>index===0||index===text.length||!(text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff&&text.charCodeAt(index-1)>=0xd800&&text.charCodeAt(index-1)<=0xdbff);
const contextAt=(text,start,end)=>({prefix:Array.from(text.slice(Math.max(0,start-64),start)).slice(-32).join(''),suffix:Array.from(text.slice(end,end+64)).slice(0,32).join('')});
/** Stream a candidate once for all quotes that reference it. Retain one shared
 * overlap buffer (largest quote + context), not a whole giant chapter or every
 * occurrence. A second indistinguishable occurrence makes the result pending. */
async function locateQuotes(chapter,rows,chunks,alive) {
  const states=rows.map(row=>({row,next:0,contextNext:0,count:0,contextCount:0,positionCount:0,first:null,context:null,position:null}));
  const keep=rows.reduce((maximum,row)=>Math.max(maximum,row.quote.length),0)+256;
  let tail='',base=0,length=0;
  const consume=(incoming,final)=>{
    const text=tail+incoming,origin=base;
    for(const state of states){
      const row=state.row;
      const materialize=(start,end)=>({chapter,start:origin+start,end:origin+end,...contextAt(text,start,end)});
      // Two occurrences already disprove uniqueness. Do not enumerate millions
      // of common one-character hits or allocate a context array for each hit.
      let cursor=Math.max(0,state.next-origin);
      while(state.count<2&&cursor<=text.length-row.quote.length){
        const start=text.indexOf(row.quote,cursor);if(start<0){state.next=Math.max(state.next,origin+text.length-row.quote.length+1);break;}
        const end=start+row.quote.length;
        if(!final&&end+64>text.length){state.next=origin+start;break;}
        cursor=start+1;state.next=origin+cursor;
        if(!boundary(text,start)||!boundary(text,end))continue;
        state.count++;if(state.count===1)state.first=materialize(start,end);
      }
      if((row.prefix||row.suffix)&&state.contextCount<2){
        const pattern=row.prefix+row.quote+row.suffix;
        let cursor=Math.max(0,state.contextNext-origin);
        while(state.contextCount<2&&cursor<=text.length-pattern.length){
          const found=text.indexOf(pattern,cursor);if(found<0){state.contextNext=Math.max(state.contextNext,origin+text.length-pattern.length+1);break;}
          const start=found+row.prefix.length,end=start+row.quote.length;
          if(!final&&end+64>text.length){state.contextNext=origin+found;break;}
          cursor=found+1;state.contextNext=origin+cursor;
          if(!boundary(text,start)||!boundary(text,end))continue;
          state.contextCount++;if(state.contextCount===1)state.context=materialize(start,end);
        }
      }
      const old=row.identity?.chapter,local=row.relative_start-origin,end=local+row.quote.length;
      // Relative position is evidence only when a full-file digest and parsing
      // contract proved the source unchanged, not a proximity heuristic.
      if(row.stable&&!state.positionCount&&old&&chapter.start===old.start&&chapter.end===old.end&&chapter.bodyStart===old.bodyStart&&local>=0&&end<=text.length&&(final||end+64<=text.length)&&text.startsWith(row.quote,local)&&boundary(text,local)&&boundary(text,end)){
        state.positionCount=1;state.position=materialize(local,end);
      }
    }
    const dropped=Math.max(0,text.length-keep);base=origin+dropped;tail=text.slice(dropped);length+=incoming.length;
  };
  for await(const text of chunks){alive();consume(text,false);}
  alive();consume('',true);
  if(length!==chapter.end-chapter.bodyStart)throw Error('TXT recovery body coordinates changed');
  return states;
}

async function planRecovery({snapshot,chapters,readBody,fullHash,configDigest,contract,alive=()=>{}}) {
  const candidates=makeCandidates(chapters),plans=[],groups=new Map(),small=new Map();
  for(const row of snapshot.rows){
    alive();let anchor;try{anchor=row.identity||JSON.parse(row.anchor_json);}catch{}
    const plan={row,status:'pending',reason:'chapter-missing',anchor};plans.push(plan);
    if(!anchor){plan.reason='invalid-snapshot';continue;}
    const stable=!!(fullHash&&row.sourceProof?.digest===fullHash&&row.sourceProof.configDigest===configDigest&&row.sourceProof.contract===JSON.stringify(contract));
    if(row.kind==='small'){
      if(!row.quote||row.quote.length>2*1024*1024){plan.reason='invalid-snapshot';continue;}
      const options=candidates(anchor.chapter,'small',stable);if(!options.length)continue;
      const state={plan,count:0,contextCount:0,positionCount:0,first:null,context:null,position:null};
      small.set(row.id,state);
      for(const chapter of options){if(!groups.has(chapter.index))groups.set(chapter.index,{chapter,rows:[]});groups.get(chapter.index).rows.push({...row,stable});}
    }else{
      const first=candidates(row.kind==='range'?anchor.start:anchor.chapter,row.kind,stable),last=row.kind==='range'?candidates(anchor.end,row.kind,stable):first;
      if(first.length!==1||last.length!==1){plan.reason=first.length>1||last.length>1?'ambiguous-chapter':'chapter-missing';continue;}
      if(first[0].index>last[0].index){plan.reason='reversed-range';continue;}
      plan.status='active';plan.reason='recovered';plan.start=first[0];plan.end=last[0];
    }
  }
  let candidateReads=0;
  for(const {chapter,rows} of groups.values()){
    alive();candidateReads++;
    for(const match of await locateQuotes(chapter,rows,readBody(chapter),alive)){
      const state=small.get(match.row.id);
      if(!state.first&&match.first)state.first=match.first;
      if(!state.context&&match.context)state.context=match.context;
      if(!state.position&&match.position)state.position=match.position;
      state.count+=match.count;state.contextCount+=match.contextCount;state.positionCount+=match.positionCount;
    }
  }
  for(const state of small.values()){
    const {plan}=state;
    const match=state.count===1?state.first:state.positionCount===1?state.position:state.contextCount===1?state.context:null;
    if(!match){plan.status=state.count?'pending':'invalid';plan.reason=state.count?'ambiguous-quote':'quote-missing';continue;}
    plan.status='active';plan.reason='recovered';plan.start=plan.end=match.chapter;plan.match=match;
  }
  return {plans,epoch:snapshot.epoch,candidateReads};
}
// Called inside the SAME short transaction that publishes the ready index.
function applyRecovery(db,book,generation,revision,plan) {
  const current=captureBindingVersions(db,book),unchanged=plan&&current.epoch===plan.epoch;
  const lookup=new Map((unchanged?plan.plans:[]).map(item=>[item.row.kind+':'+item.row.id,item]));
  const counts={active:0,pending:0,invalid:0,conflicts:unchanged?0:current.rows.length};
  const statements=Object.fromEntries(Object.entries(TABLES).map(([kind,table])=>[kind,{
    active:db.prepare(`UPDATE ${table} SET generation=?,chapter_id=?,start_index=?,end_index=?,status='active',anchor_json=?,prefix=?,suffix=?,relative_start=?,relative_end=?,version=version+1 WHERE id=? AND version=? AND status!='unbound'`),
    pending:db.prepare(`UPDATE ${table} SET status=?,version=version+1 WHERE id=? AND version=? AND status!='unbound'`),
  }]));
  const insertResult=db.prepare('INSERT INTO txt_recovery_results VALUES(?,?,?,?,?,?,?,?,?)'),anchors=new Map();
  for(const currentRow of current.rows){
    const item=lookup.get(currentRow.kind+':'+currentRow.id);
    // Reuse a full snapshot only after the complete logical epoch matched in
    // this same transaction. On a conflict only lightweight current rows apply.
    const row=item?item.row:currentRow;
    let status=row.status,reason=item?.reason||'concurrent-change',version=row.version;
    if(item?.status==='active'){
      const anchorKey=JSON.stringify([row.kind,item.start.chapterId,item.end.chapterId]);
      if(!anchors.has(anchorKey))anchors.set(anchorKey,JSON.stringify(row.kind==='range'?{start:item.start,end:item.end,documentRevision:revision}:{chapter:item.start,documentRevision:revision}));
      const match=item.match;
      const changed=statements[row.kind].active
        .run(generation,item.start.chapterId,item.start.index,item.end.index,anchors.get(anchorKey),match?.prefix??row.prefix,match?.suffix??row.suffix,match?.start??row.relative_start,match?.end??row.relative_end,row.id,row.version);
      if(changed.changes!==1)throw Error('TXT binding changed during recovery');status='active';version++;
    }else if(row.generation!==generation||item){
      status=item?.status||'pending';
      const changed=statements[row.kind].pending.run(status,row.id,row.version);
      if(changed.changes!==1)throw Error('TXT binding changed during recovery');version++;
    }
    counts[status]++;
    const old=item?.anchor;const label=item?.start?.label||old?.chapter?.label||old?.start?.label||'';
    insertResult.run(book,generation,row.kind,row.id,row.note_key,version,status,reason,label);
  }
  // Results are rebuildable diagnostics; formal snapshots/quotes remain in bindings.
  db.prepare('DELETE FROM txt_recovery_results WHERE book_id=? AND generation!=?').run(book,generation);
  return counts;
}
function recoveryResults(db,book,offset=0,limit=50) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid recovery result page');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='txt_recovery_results'").get())return {records:[],counts:{},hasMore:false};
  const generation=db.prepare('SELECT active_generation FROM txt_index_documents WHERE book_id=?').get(book)?.active_generation;
  const union=Object.entries(TABLES).map(([kind,table])=>`SELECT '${kind}' kind,id,version,status FROM ${table}`).join(' UNION ALL ');
  const from=`FROM txt_recovery_results r JOIN notes n ON n.key=r.note_key JOIN (${union}) b ON b.kind=r.kind AND b.id=r.binding_id AND b.version=r.binding_version WHERE r.book_id=? AND r.generation=?`;
  const records=db.prepare(`SELECT r.*,substr(n.title,1,160) title ${from} ORDER BY r.status DESC,r.kind,r.binding_id LIMIT ? OFFSET ?`).all(book,generation,limit+1,offset);
  const counts=Object.fromEntries(db.prepare(`SELECT r.status,count(*) total ${from} GROUP BY r.status`).all(book,generation).map(row=>[row.status,row.total]));
  return {generation,records:records.slice(0,limit),counts,hasMore:records.length>limit};
}
module.exports={captureBindings,ensureRecoverySchema,planRecovery,applyRecovery,recoveryResults,makeCandidates,locateQuotes};
