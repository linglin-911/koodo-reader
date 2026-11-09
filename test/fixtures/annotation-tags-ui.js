import JSZip from 'jszip';
import {AnnotationService,AnnotationTagService} from '/src/utils/storage/annotationService.ts';
import {ConfigService} from '/src/assets/lib/kookit-extra-browser.min.js';
import {generateSnapshot,backupFromPath,getSnapshots} from '/src/utils/file/backup.ts';
import {restoreFromfilePath,restoreFromSnapshot,restoreFromBrowser} from '/src/utils/file/restore.ts';
export async function run(){
 const fs=window.electronAPI.fs,path=window.electronAPI.path,checks=[];
 const assert=(value,message)=>{if(!value)throw Error(message);};
 const check=async(name,run)=>{await run();checks.push(name);};
 const root=async name=>{const directory=await window.electronAPI.invoke('tag-ui-root',name);ConfigService.setItem('storageLocation',directory);return directory;};
 const writeZip=async(zip,directory,name)=>{const filename=path.join(directory,name);fs.writeFileSync(filename,await zip.generateAsync({type:'uint8array'}));return filename;};
 const browserRestore=async bytes=>{
  const create=document.createElement.bind(document);
  document.createElement=function(name,...args){const element=create(name,...args);if(name==='input')element.click=()=>{
   const file=new File([bytes],'synthetic.zip',{type:'application/zip'});Object.defineProperty(element,'files',{value:[file]});
   queueMicrotask(()=>element.onchange({target:element}));
  };return element;};
  try{return await restoreFromBrowser();}finally{document.createElement=create;}
 };
 ConfigService.setListConfig('unused-legacy','noteTags');
 let source,dump,entity,archive,snapshot,zip;
 await check('renderer service seeds unused configuration and preserves same-name global/local references',async()=>{
  source=await root('source');const global=await AnnotationTagService.create({name:'same',scope:'global'}),local=await AnnotationTagService.create({name:'same',scope:'book',bookKey:'book-a'});
  entity=await AnnotationService.save({bookKey:'book-a',kind:'small',notes:'synthetic formal body',tagIds:[global.id,local.id]});
  assert(entity.tagRefs.length===2,'Same-name scope collapsed');
  assert((await AnnotationTagService.list({scope:'global'})).records.some(t=>t.name==='unused-legacy'),'Unused legacy catalog lost');dump=await AnnotationService.export();
 });
 await check('snapshot writer emits the v2 manifest including unused/scoped tags',async()=>{
  await generateSnapshot();snapshot=getSnapshots()[0]?.file;assert(snapshot,'No snapshot');zip=await JSZip.loadAsync(new Uint8Array(fs.readFileSync(path.join(source,'snapshot',snapshot))));
  assert(zip.file('config/annotations.v2.json')&&!zip.file('config/annotations.v1.json'),'Wrong snapshot version');
  const data=JSON.parse(await zip.file('config/annotations.v2.json').async('string'));assert(data.tagRelations.length===2&&data.tags.some(t=>t.name==='unused-legacy'),'Incomplete v2 snapshot');
 });
 await check('normal backup writer uses v2 and path restoration preserves scoped identities',async()=>{
  const directory=await window.electronAPI.invoke('tag-ui-root','archives');assert(await backupFromPath(directory,'normal.zip'),'Backup failed');archive=path.join(directory,'normal.zip');
  const target=await root('stream-target');assert(await restoreFromfilePath(archive),'Stream restore failed');
  assert(ConfigService.getItem('storageLocation')===target,'Backup changed target library');
  const value=await AnnotationService.get(entity.key);assert(value.tagRefs.length===2&&value.tagRefs.some(t=>t.scope==='book'),'Stream restore lost local tag');
 });
 await check('snapshot restoration merges v2 through the formal service instead of replacing notes.db',async()=>{
  const target=await root('snapshot-target');fs.mkdirSync(path.join(target,'snapshot'),{recursive:true});fs.copyFileSync(path.join(source,'snapshot',snapshot),path.join(target,'snapshot',snapshot));
  assert(await restoreFromSnapshot(snapshot),'Snapshot restore failed');assert(ConfigService.getItem('storageLocation')===target,'Snapshot changed library path');
  assert((await AnnotationService.get(entity.key)).tagRefs.length===2,'Snapshot lost scope identity');
 });
 await check('snapshot cannot overwrite a newer formal body or silently discard its tag references',async()=>{
  const current=await AnnotationService.get(entity.key);await AnnotationService.save({...current,notes:'newer protected body'});
  assert(!(await restoreFromSnapshot(snapshot)),'Conflicting snapshot unexpectedly succeeded');
  const after=await AnnotationService.get(entity.key);assert(after.notes==='newer protected body'&&after.tagRefs.length===2,'Snapshot overwrote formal data');
 });
 await check('browser ZIP restoration prefers v2 and retains the destination library',async()=>{
  const target=await root('browser-target');const result=await browserRestore(fs.readFileSync(archive));assert(result==='success','Browser restore failed');
  assert(ConfigService.getItem('storageLocation')===target,'Browser restore redirected library');assert((await AnnotationService.get(entity.key)).tagRefs.length===2,'Browser lost identities');
 });
 const v1={format:'koodo-annotations',version:1,notes:[{key:'old-entity',bookKey:'book-a',kind:'chapter',title:'',notes:'v1 formal',tag:'["old-tag"]',date:'{}',created_at:1,updated_at:1,version:1}],bindings:{small:[],chapter:[],range:[]},drawings:[]};
 await check('v1 archive fallback imports formal notes and unused configuration tags',async()=>{
  const target=await root('v1-target'),legacy=new JSZip();legacy.file('config/config.json',JSON.stringify({noteTags:JSON.stringify(['legacy-unused-from-backup'])}));legacy.file('config/annotations.v1.json',JSON.stringify(v1));
  assert(await restoreFromfilePath(await writeZip(legacy,target,'v1.zip')),'V1 restore failed');assert((await AnnotationService.get('old-entity')).tagRefs[0].scope==='global','V1 name not mapped globally');
  assert((await AnnotationTagService.list({scope:'global'})).records.some(t=>t.name==='legacy-unused-from-backup'),'Unused restored legacy tag missing');
 });
 await check('when both manifests exist v2 is authoritative',async()=>{
  const target=await root('dual-target'),dual=new JSZip();dual.file('config/config.json','{}');dual.file('config/annotations.v1.json',JSON.stringify(v1));dual.file('config/annotations.v2.json',JSON.stringify(dump));
  assert(await restoreFromfilePath(await writeZip(dual,target,'both.zip')),'Dual restore failed');
  const notes=(await AnnotationService.list()).records;assert(notes.length===1&&notes[0].key===entity.key,'Wrong manifest chosen');
 });
 await check('corrupt v2 never falls back to v1 or notes.db in streamed or browser restoration',async()=>{
  const target=await root('corrupt-target'),bad=new JSZip();bad.file('config/config.json','{}');bad.file('config/annotations.v1.json',JSON.stringify(v1));bad.file('config/annotations.v2.json','{broken');bad.file('config/notes.db',await zip.file('config/notes.db').async('uint8array'));
  const bytes=await bad.generateAsync({type:'uint8array'});assert(!(await restoreFromfilePath(await writeZip(bad,target,'bad.zip'))),'Stream fell back');assert((await browserRestore(bytes))==='failed','Browser fell back');
  assert((await AnnotationService.list()).records.length===0,'Corrupt archive published annotations');
 });
 await check('future and mislabeled manifest versions fail without publishing formal data',async()=>{
  for(const future of [true,false]){
   const target=await root(future?'future-target':'mislabeled-target'),bad=new JSZip();bad.file('config/config.json','{}');bad.file('config/annotations.v1.json',JSON.stringify(v1));bad.file(`config/annotations.v${future?3:2}.json`,JSON.stringify(future?{...dump,version:3}:v1));
   assert(!(await restoreFromfilePath(await writeZip(bad,target,'unsupported.zip'))),'Unsupported/mislabeled manifest accepted');assert((await AnnotationService.list()).records.length===0,'Unsupported archive wrote notes');
  }
 });
 await check('database-only snapshot fallback preserves scoped references and leaves source library unchanged',async()=>{
  const target=await root('database-snapshot-target'),legacy=await JSZip.loadAsync(new Uint8Array(fs.readFileSync(path.join(source,'snapshot',snapshot))));legacy.remove('config/annotations.v2.json');fs.mkdirSync(path.join(target,'snapshot'),{recursive:true});await writeZip(legacy,path.join(target,'snapshot'),'database-only.zip');
  assert(await restoreFromSnapshot('database-only.zip'),'Database-only snapshot failed');assert((await AnnotationService.get(entity.key)).tagRefs.length===2,'Native snapshot lost tag identities');
  await root('source');const final=await AnnotationService.get(entity.key);assert(final.notes==='synthetic formal body'&&final.tagRefs.length===2,'Source library was modified by restores');
 });
 return{passed:true,cases:checks.length,checks};
}
