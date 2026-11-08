const test=require('node:test'),assert=require('node:assert/strict');
const {planRecovery}=require('../src/utils/main/txt-reconcile');
const chapter=(index,label,firstChars='始甲',lastChars='末乙')=>({index,chapterId:'new-'+index,label,recognition:'heading',start:0,bodyStart:0,end:0,firstChars,lastChars});
const binding=(id,kind,old,quote='',prefix='',suffix='')=>({id,kind,version:1,quote,prefix,suffix,relative_start:0,anchor_json:JSON.stringify(kind==='range'?{start:old[0],end:old[1]}:{chapter:old})});
async function plan(rows,chapters,bodies,chunk=3){const reads=[];const result=await planRecovery({snapshot:{rows,epoch:'epoch'},chapters,readBody:async function*(c){reads.push(c.index);const text=bodies[c.index]||'';c.end=text.length;for(let i=0;i<text.length;i+=chunk)yield text.slice(i,i+chunk);}});return {...result,reads};}
test('unique titles restore chapter/range without reading any body, including inserted and reordered chapters',async()=>{
 const old=[chapter(0,'第一章'),chapter(1,'第二章')],next=[chapter(0,'插入'),chapter(1,'第二章'),chapter(2,'第一章')];
 const result=await plan([binding('c','chapter',old[0]),binding('r','range',old)],next,{});
 assert.equal(result.plans[0].start.index,2);assert.equal(result.plans[1].reason,'reversed-range');assert.deepEqual(result.reads,[]);
});
test('renames need both strong features and a unique identity; weak/duplicate features remain pending',async()=>{
 const old=chapter(0,'旧标题'),next=[chapter(0,'新标题')];
 assert.equal((await plan([binding('c','chapter',old)],next,{})).plans[0].status,'active');
 assert.equal((await plan([binding('c','chapter',old)],[...next,chapter(1,'另章')],{})).plans[0].status,'pending');
 assert.equal((await plan([binding('c','chapter',chapter(0,'旧','甲','乙'))],[chapter(0,'新','甲','乙')],{})).plans[0].status,'pending');
});
test('only referenced candidate bodies are read once; quotes and 32-code-point contexts cross tiny chunks',async()=>{
 const body='前'.repeat(40)+'😀跨块原文𠀀'+'后'.repeat(40),quote='😀跨块原文𠀀';
 const rows=[binding('a','small',chapter(0,'标题'),quote,'前'.repeat(32),'后'.repeat(32)),binding('b','small',chapter(0,'标题'),'跨块')];
 const result=await plan(rows,[chapter(0,'无关','其他','另一'),chapter(1,'标题')],{1:body},1);
 assert.deepEqual(result.reads,[1]);assert(result.plans.every(p=>p.status==='active'));assert.equal(result.plans[0].match.start,40);assert.equal(result.plans[0].match.prefix.length,32);
});
test('duplicated titles/quotes are disambiguated by exact context, never by old chapter order alone',async()=>{
 const old=chapter(0,'番外'),next=[chapter(0,'番外'),chapter(1,'番外')];
 let result=await plan([binding('a','small',old,'摘录','左甲','右乙')],next,{0:'左甲摘录右乙',1:'其他摘录不同'});
 assert.equal(result.plans[0].start.index,0);
 result=await plan([binding('a','small',old,'摘录','左甲','右乙')],next,{0:'左甲摘录右乙',1:'左甲摘录右乙'});
 assert.equal(result.plans[0].status,'pending');assert.equal(result.plans[0].reason,'ambiguous-quote');
 assert.equal((await plan([binding('c','chapter',old)],next,{})).plans[0].reason,'ambiguous-chapter');
});
test('deleted excerpt is invalid, missing/ambiguous range endpoint stays pending without partial recovery',async()=>{
 const old=chapter(0,'标题'),next=[chapter(0,'标题')];
 assert.equal((await plan([binding('a','small',old,'已删除')],next,{0:'新正文'})).plans[0].status,'invalid');
 const range=await plan([binding('r','range',[old,chapter(1,'不存在','弱','弱')])],next,{});
 assert.equal(range.plans[0].status,'pending');assert.equal(range.plans[0].start,undefined);
});
test('title match with deleted excerpt cannot fall through into an unrelated feature collision',async()=>{
 const result=await plan([binding('a','small',chapter(0,'原章'),'摘录')],[chapter(0,'原章'),chapter(1,'别章')],{0:'摘录删除',1:'摘录'});
 // Use a truly deleted quote in the named chapter; presence in another title is not identity.
 const deleted=await plan([binding('a','small',chapter(0,'原章'),'只在别章')],[chapter(0,'原章'),chapter(1,'别章')],{0:'正文',1:'只在别章'});
 assert.equal(deleted.plans[0].status,'invalid');assert.deepEqual(deleted.reads,[0]);assert.equal(result.plans[0].start.index,0);
});
test('cancellation is checked while streaming a giant candidate and publishes no plan',async()=>{
 let cancelled=false;const c=chapter(0,'标题');c.end=10;
 await assert.rejects(planRecovery({snapshot:{rows:[binding('a','small',c,'正文')],epoch:'x'},chapters:[c],
   alive:()=>{if(cancelled)throw Error('cancelled');},readBody:async function*(){yield '正文';cancelled=true;yield '剩余';}}),/cancelled/);
});

test('generated fallback labels never identify a chapter by its previous ordinal',async()=>{
 const old={...chapter(0,'Chapter 1'),recognition:'fixed'},next={...chapter(0,'Chapter 1','新开','新末'),recognition:'fixed'};
 const result=await plan([binding('c','chapter',old)],[next],{});assert.equal(result.plans[0].status,'pending');
});
test('duplicate real headings may resolve only through both uniquely matching body features',async()=>{
 const old=chapter(0,'番外'),next=[chapter(0,'番外','其他','另一'),chapter(1,'番外')];
 const result=await plan([binding('c','chapter',old)],next,{});assert.equal(result.plans[0].status,'active');assert.equal(result.plans[0].start.index,1);
});

test('repeated single-code-point features are weak even if the new directory has one candidate',async()=>{
 const old=chapter(0,'旧名','哈哈','哈哈'),next=chapter(0,'新名','哈哈','哈哈');
 assert.equal((await plan([binding('c','chapter',old)],[next],{})).plans[0].status,'pending');
});

test('millions of repeated one-character quotes retain only two uniqueness/context witnesses',async()=>{
 const {locateQuotes}=require('../src/utils/main/txt-reconcile'),body='x'.repeat(2*1024*1024),c=chapter(0,'标题');c.end=body.length;
 const row=binding('a','small',c,'x','x'.repeat(32),'x'.repeat(32));
 const result=await locateQuotes(c,[row],(async function*(){for(let i=0;i<body.length;i+=8192)yield body.slice(i,i+8192);})(),()=>{});
 assert.equal(result[0].count,2);assert.equal(result[0].contextCount,2);
});
