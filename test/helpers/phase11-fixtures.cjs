// Deterministic fixtures, used only by the runner-owned temporary database.
const fs=require('node:fs');
const prefix=i=>`AB_${String(i).padStart(5,'0')}_unique_source_0123456789_abcdefghijklmnopqrstuvwxyz_CD`;
function writeSource(file,bytes,count=7700){
 const fd=fs.openSync(file,'w');
 try{for(let i=0;i<count;i++){
  const size=Math.floor((i+1)*bytes/count)-Math.floor(i*bytes/count),head=`Chapter ${i+1}\r\n${prefix(i)}\r\n`,line='合成😀<&>甲乙 '.repeat(8)+'\r\n';
  const rest=size-Buffer.byteLength(head)-2,n=Math.floor(rest/Buffer.byteLength(line));
  fs.writeSync(fd,head+line.repeat(n)+'x'.repeat(rest-n*Buffer.byteLength(line))+'\r\n');
 }}finally{fs.closeSync(fd);}
 if(fs.statSync(file).size!==bytes)throw Error('Fixture size drift');
}
function seedAnnotations(db,index,generation,entities,multiplier,hot=false){
 // The fixture still seeds in one transaction, but must now seed the canonical
 // tag graph too; JSON names alone are a compatibility projection in schema v2.
 const {runTagCommand,touchTags}=require('../../src/utils/main/annotation-tags');
 const tagIds=Object.fromEntries(['odd','even'].map(name=>[name,runTagCommand(db,{action:'tag-create',scope:'global',name}).id]));
 const insertTag=db.prepare('INSERT INTO note_tags(note_key,tag_id,position) VALUES(?,?,0)');
 const insertNote=db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,1)'),inserts={};
 for(const [kind,table] of Object.entries({small:'note_bindings',chapter:'chapter_bindings',range:'range_bindings'}))inserts[kind]=db.prepare(`INSERT INTO ${table} VALUES(@id,@note_key,@book_id,@format,@generation,@chapter_id,@start_index,@end_index,@status,@anchor_json,@quote,@prefix,@suffix,@relative_start,@relative_end,@style,@version,@unbound_from)`);
 const now=1700000000000,body='SYNTHETIC_NOTE_BODY_'.repeat(128);let bindings=0;
 db.transaction(()=>{
  db.exec('DELETE FROM note_bindings;DELETE FROM chapter_bindings;DELETE FROM range_bindings;DELETE FROM notes;');
  for(let i=0;i<entities;i++){
   const kind=i===entities-2?'chapter':i===entities-1?'range':'small',key=`n${String(i).padStart(6,'0')}`;
   insertNote.run(key,'matrix',kind,'Synthetic '+i,i===0?'SYNTHETIC_LONG_BODY_'.repeat(65536):body,JSON.stringify([i%2?'odd':'even']),JSON.stringify({year:2023,month:11,day:14}),now+i,now+i);
   insertTag.run(key,tagIds[i%2?'odd':'even']);
   for(let j=0;j<(kind==='small'?multiplier:1);j++){
    const ch=kind!=='small'||hot||i%10===0?0:(i*37+j*719)%7700,c=index.chapters[ch],last=kind==='range'?index.chapters[7699]:c,start=j,end=start+12,text=prefix(ch),snapshot={...c,recognition:'heading'};
    const anchor=kind==='range'?{start:snapshot,end:{...last,recognition:'heading'}}:{chapter:snapshot};
    inserts[kind].run({id:`b${i}_${j}`,note_key:key,book_id:'matrix',format:'TXT',generation,chapter_id:c.chapterId,start_index:ch,end_index:last.index,status:'active',anchor_json:JSON.stringify(anchor),quote:kind==='small'?text.slice(start,end):'',prefix:kind==='small'?text.slice(0,start):'',suffix:kind==='small'?text.slice(end,end+32):'',relative_start:kind==='small'?start:null,relative_end:kind==='small'?end:null,style:j%2?'underline-#FF0000':'background-#FEF3CD',version:1,unbound_from:null});bindings++;
   }
  }
  touchTags(db,Object.values(tagIds));
 })();
 return{entities,smallEntities:entities-2,chapterEntities:1,rangeEntities:1,smallBindings:(entities-2)*multiplier,bindings,multiplier,distribution:hot?'all-hot':'10-percent-hot-and-scattered',longBodyCharacters:'SYNTHETIC_LONG_BODY_'.length*65536};
}
module.exports={writeSource,seedAnnotations};
