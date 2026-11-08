// Browser half of the reproducible phase-11 synthetic matrix.
import * as Kookit from '/src/assets/lib/kookit.min.js';
import {openPersistentTxt} from '/src/utils/storage/txtIndexService.ts';
import {AnnotationService} from '/src/utils/storage/annotationService.ts';
import {restoreAnnotations} from '/src/utils/reader/annotationUtil.ts';
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const pause=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return{count:values.length,p50:sorted[Math.max(0,Math.ceil(sorted.length*.5)-1)]??0,p95:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]??0,max:sorted.at(-1)??0,values};};
const ipc=(action,data)=>window.electronAPI.invoke(action,data);
async function memory(){globalThis.gc?.();await pause();return{heap:require('node:v8').getHeapStatistics().used_heap_size,browserHeap:performance.memory.usedJSHeapSize,privateKB:(await globalThis.process.getProcessMemoryInfo()).private};}
function summarizeIPC(metrics){
 const groups={};for(const r of metrics.requests){const g=groups[r.action]??={durations:[],readBytes:0,readCalls:0,ipcRequestBytes:0,ipcResponseBytes:0,workerStarts:0};g.durations.push(r.durationMs);for(const k of ['readBytes','readCalls','ipcRequestBytes','ipcResponseBytes','workerStarts'])g[k]+=r[k];}
 for(const g of Object.values(groups)){g.durationMs=summary(g.durations);delete g.durations;}
 const stages={};for(const t of metrics.traces){const g=stages[t.action]??={};for(const [k,v]of Object.entries(t))if(typeof v==='number')(g[k]??=[]).push(v);}
 for(const g of Object.values(stages))for(const k of Object.keys(g))g[k]=summary(g[k]);
 return{actions:groups,stages,mainMemory:metrics.mainMemory};
}
export async function run(){
 const area=document.getElementById('page-area'),book={key:'matrix',format:'TXT'},config=prepared=>({format:'TXT',charset:prepared.encoding,parserRegex:'^Chapter ',txtIndexStore:prepared.store,txtContinuousScroll:true,readerMode:'scroll',animation:'none',isMobile:'no',platform:'electron'});
 const longTasks=[],frameGaps=[];let previous=performance.now(),frame;
 const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())longTasks.push({start:e.startTime,duration:e.duration});});observer.observe({type:'longtask',buffered:true});
 const tick=now=>{frameGaps.push(now-previous);previous=now;frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
 const liveURLs=new Set(),create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=(...args)=>{const u=create(...args);liveURLs.add(u);return u;};URL.revokeObjectURL=u=>{liveURLs.delete(u);return revoke(u);};
 let reader,prepared;
 try{
  const coldStart=performance.now();prepared=await openPersistentTxt('matrix','','utf-8','^Chapter ');reader=Kookit.BookHelper.getRendition(prepared.buffer,config(prepared),Kookit);await reader.renderTo(area);await reader.goToChapterDocIndex(0);
  const cold={firstReadableMs:performance.now()-coldStart,metrics:summarizeIPC(await ipc('stress-metrics')),sections:reader.book.sections.length};assert(cold.sections===7700,'Synthetic source must have 7700 sections');assert(reader.txtWindow,'Normal continuous window was not used');
  await reader.removeContent();await prepared.store.close();
  const warm=[];
  for(const target of [0,1599,6799])for(let n=0;n<20;n++){
   await ipc('stress-metrics');const start=performance.now();prepared=await openPersistentTxt('matrix','','utf-8','^Chapter ');reader=Kookit.BookHelper.getRendition(prepared.buffer,config(prepared),Kookit);await reader.renderTo(area);await reader.goToChapterDocIndex(target);
   const elapsed=performance.now()-start,metrics=await ipc('stress-metrics');assert(metrics.requests.every(r=>!['prepare','rebuild','read-source'].includes(r.action)&&r.workerStarts===0),'Hot open rescanned source');assert(prepared.buffer.byteLength===0,'Hot open retained whole book');
   warm.push({chapter:target+1,firstReadableMs:elapsed,metrics:summarizeIPC(metrics)});await reader.removeContent();await prepared.store.close();
  }
  prepared=await openPersistentTxt('matrix','','utf-8','^Chapter ');reader=Kookit.BookHelper.getRendition(prepared.buffer,config(prepared),Kookit);await reader.renderTo(area);
  await ipc('stress-metrics');let random=0x11c0ffee;const jumps=[];
  for(let i=0;i<100;i++){random=(Math.imul(random,1664525)+1013904223)>>>0;const index=random%7700,start=performance.now();await reader.goToChapterDocIndex(index);const mounted=reader.getDocument().querySelectorAll('*').length;assert(mounted<=20000,'DOM budget exceeded');jumps.push({chapter:index+1,durationMs:performance.now()-start,nodes:mounted});}
  const deepJumps={durationMs:summary(jumps.map(r=>r.durationMs)),targets:jumps,metrics:summarizeIPC(await ipc('stress-metrics'))};
  const datasets=[];
  const scenarios=[6,1000,10000].flatMap(entities=>[1,3,10].map(multiplier=>({entities,multiplier})));
  scenarios.push({entities:10000,multiplier:10,hot:true});
  for(const {entities,multiplier,hot=false} of scenarios){
   await reader.goToChapterDocIndex(0);const seed=await ipc('stress-seed',{entities,multiplier,hot,ticket:prepared.store.sourceTicket});await ipc('stress-metrics');
   const start=performance.now(),frameStart=frameGaps.length,taskStart=longTasks.length,statsBefore=reader.txtWindow.stats;const restoreSpans=[],timerDelays=[];const durations={list:[],filter:[],position:[],detail:[],restore:[],edit:[],unlink:[]};
   let detail;
   for(let n=0;n<20;n++){
    for(const [action,filter]of [['list',{bookKey:'matrix',limit:50,offset:n%2?0:Math.max(0,entities-50)}],['filter',{bookKey:'matrix',tags:[n%2?'odd':'even'],keyword:'Synthetic',limit:50}],['position',{bookKey:'matrix',sort:'position',order:'ASC',limit:50}]]){
     const t=performance.now(),page=await AnnotationService.list(filter);durations[action].push(performance.now()-t);assert(page.records.length<=50,'List ignored limit');assert(page.records.every(r=>r.notes.length<=160&&r.bindings.length===0),'List transferred full body or bindings');
    }
    const t=performance.now();detail=await AnnotationService.get('n000000');durations.detail.push(performance.now()-t);assert(detail.notes.length===seed.longBodyCharacters&&detail.bindings.length===multiplier,'Detail lost body or anchors');
   }
   const doc=reader.getDocument(),originalText=doc.body.textContent,nodeCount=doc.querySelectorAll('*').length;
   for(let n=0;n<5;n++){
    const t=performance.now();let previous=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();timerDelays.push(Math.max(0,now-previous-10));previous=now;},10);
    await restoreAnnotations(book,reader,0);durations.restore.push(performance.now()-t);restoreSpans.push({start:t,end:performance.now()});await pause(0);clearInterval(heartbeat);await pause();
   }
   const highlights=reader.windowHighlights.ranges,nativeCount=doc.defaultView.CSS.highlights.size;
   assert(highlights.length>=(hot?entities-2:Math.ceil((entities-2)/10))*multiplier&&nativeCount>0&&nativeCount<=2,'Hot bindings were silently truncated');assert(doc.body.textContent===originalText&&doc.querySelectorAll('*').length===nodeCount,'Native highlights changed source DOM');
   assert(highlights.every(row=>row.ranges.every(range=>Array.from(doc.defaultView.CSS.highlights.values()).some(group=>group.has(range)))),'Binding range lost from native paint group');
   assert(highlights.every(r=>r.ranges.length&&r.ranges.every(range=>range.toString().length>0)),'Empty native range '+JSON.stringify(highlights.filter(r=>r.ranges.some(range=>!range.toString().length)).slice(0,3).map(r=>({id:r.bindingId,ranges:r.ranges.map(range=>({start:range.startContainer.nodeName,end:range.endContainer.nodeName,startOffset:range.startOffset,endOffset:range.endOffset,connected:range.startContainer.isConnected,text:range.toString()}))}))));
   let t=performance.now();detail=await AnnotationService.save({...detail,title:'Edited synthetic title'});durations.edit.push(performance.now()-t);const binding=detail.bindings[0];t=performance.now();const unlinked=await AnnotationService.unlink(detail.key,binding);durations.unlink.push(performance.now()-t);assert(unlinked.notes===detail.notes&&unlinked.bindings.length===multiplier&&unlinked.bindings[0].status==='unbound','Unbind removed content or another location');const shared=highlights.find(row=>row.bindingId!==binding.id&&row.ranges[0]===highlights.find(item=>item.bindingId===binding.id)?.ranges[0]);
   await restoreAnnotations(book,reader,0);assert(reader.getTxtHighlightRanges().length===highlights.length-1,'Unlink lost a sibling highlight');
   if(shared)assert(Array.from(doc.defaultView.CSS.highlights.values()).some(group=>group.has(shared.ranges[0])),'Unlink revoked a shared native range still owned by another binding');
   await AnnotationService.undo(detail.key,unlinked.bindings[0],prepared.store.sourceTicket);await restoreAnnotations(book,reader,0);assert(reader.getTxtHighlightRanges().length===highlights.length,'Undo lost a shared binding');
   const integrity=await ipc('stress-integrity');assert(integrity.entities===entities&&integrity.bindings===seed.bindings&&integrity.foreignKeyErrors===0&&integrity.integrity==='ok','Data loss or integrity failure');
   const metrics=await ipc('stress-metrics'),reading=metrics.requests.filter(r=>r.action==='reading-window');assert(reading.every(r=>r.ipcResponseBytes<150000),'Reading page grew beyond lightweight headers');
   const item={...seed,elapsedMs:performance.now()-start,timings:Object.fromEntries(Object.entries(durations).map(([k,v])=>[k,summary(v)])),nativeHighlights:highlights.length,nativePaintObjects:nativeCount,domNodes:nodeCount,windowStats:statsBefore,activeURLs:liveURLs.size,frameGapsMs:summary(frameGaps.slice(frameStart)),restoreTimerDelayMs:summary(timerDelays),longTasks:longTasks.slice(taskStart).map(task=>({...task,phase:restoreSpans.some(span=>task.start>=span.start&&task.start<span.end)?'restore':'test-validation-or-other-work'})),metrics:summarizeIPC(metrics),integrity,rendererMemory:await memory()};
   if(entities===6)item.sixNoteTraces=metrics.traces.filter(r=>r.action==='reading-window').slice(0,8);
   datasets.push(item);await ipc('stress-checkpoint',{cold,warmOpens:{firstReadableMs:summary(warm.map(r=>r.firstReadableMs)),runs:warm},deepJumps,datasets});console.log('STRESS '+JSON.stringify({entities,bindings:seed.bindings,restoreP95:item.timings.restore.p95,listP95:item.timings.list.p95,readingP95:item.metrics.actions['reading-window'].durationMs.p95}));
  }
  const finalStats=reader.txtWindow.stats;
  const paintDocument=reader.getDocument(),registry=paintDocument.defaultView.CSS.highlights;
  const replacement=reader.windowNotes.map(note=>({...note,color:'wavy-#4466AA'}));
  const cancelled=[];
  for(let batch=0;batch<6;batch++){
    cancelled.push(reader.renderHighlighters(replacement.map(note=>({...note,key:'cancel-'+batch+'-'+note.key,bindingId:'cancel-'+batch+'-'+note.bindingId})),()=>{}));
    assert(reader.windowHighlights.entries.size<=replacement.length,'Superseded paints accumulated multiple binding datasets');
    assert(Array.from(reader.windowHighlights.groups.values()).every(group=>group.references>0),'Superseded paints retained empty native groups');
  }
  await Promise.all(cancelled);

  const stale=reader.renderHighlighters(replacement,()=>{});await reader.renderHighlighters(replacement,()=>{});await stale;
  const rules=paintDocument.querySelector('style[data-txt-highlights]').textContent;
  assert(Array.from(registry.keys()).every(name=>rules.includes(name)),'Superseding paint lost CSS for an existing group');
  const midPaint=reader.renderHighlighters(replacement.map(note=>({...note,color:'underline-#00AA00'})),()=>{});
  await reader.removeContent();await midPaint;assert(registry.size===0,'Close during dense paint resurrected native ranges');await prepared.store.close();await pause();assert(liveURLs.size===0&&area.querySelectorAll('iframe').length===0,'Reader close leaked resources');
  return{seed:'phase11-0x11c0ffee-v1',source:{bytes:76083283,chapters:7700,cacheState:'first index build then OS-warm repeated opens; cold disk not asserted'},cold,warmOpens:{firstReadableMs:summary(warm.map(r=>r.firstReadableMs)),runs:warm},deepJumps,datasets,finalStats,gcExposed:typeof globalThis.gc==='function',closedMemory:await memory(),closedURLs:liveURLs.size,closedDuringDensePaint:true,supersededDensePaint:true,cancelledDatasetBudget:true,limitations:['Synthetic source only; no real-book/manual acceptance inferred','IPC bytes use UTF-8 JSON size as a reproducible proxy, not exact structured-clone wire bytes','Latency runs overlap resource soak and serial gate/safety work; not an isolated machine baseline','Hidden-window requestAnimationFrame gaps are scheduler diagnostics, not visible FPS or native input latency; restore timer delays and long tasks are reported separately','Full 7.1 matrix remains tracked in PROJECT_REQUIREMENTS.md']};
 }finally{observer.disconnect();cancelAnimationFrame(frame);URL.createObjectURL=create;URL.revokeObjectURL=revoke;await reader?.removeContent();await prepared?.store.close();}
}
