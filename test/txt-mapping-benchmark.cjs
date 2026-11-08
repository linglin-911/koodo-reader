// Same-process Node microbench of existing stage-1 algorithms, not Electron/UI.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const sourceRoot=process.argv[2],report=process.argv[3];if(!sourceRoot||!report)throw Error('Usage: node txt-mapping-benchmark.cjs <kookit-source> <report.json>');
const quiet={beginDiagnostic:()=>()=>{}},load=require(path.join(sourceRoot,'test/helpers/load-typescript.cjs'))({'./diagnostics':quiet,'../utils/diagnostics':quiet});
const GeneralParser=load(path.join(sourceRoot,'src/utils/generalParser.ts')).default;
const{cumulativeSumWithPrevious}=load(path.join(sourceRoot,'src/utils/common.ts'));
const summarize=values=>{const a=[...values].sort((x,y)=>x-y);return{p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],values};};
(async()=>{const rows=[];
for(const count of [2000,4000,7700,15400]){
 const sections=Array.from({length:count},()=>({size:100})),parser=new GeneralParser({sections});parser.flattenChapters=sections.map((_s,index)=>({index,label:String(index),href:String(index)}));
 const weights=sections.map(s=>s.size),mapping=[],prefix=[];
 for(let run=0;run<35;run++){
  let t=performance.now();const docs=await parser.getChapterDoc();const mapped=performance.now()-t;assert.equal(docs.length,count);assert.equal(docs.at(-1).text,sections.at(-1));
  t=performance.now();const sums=cumulativeSumWithPrevious(weights),accumulated=performance.now()-t;assert.equal(sums.at(-1),100*(count-1));
  if(run>=5){mapping.push(mapped);prefix.push(accumulated);}
 }
 rows.push({sections:count,mappingMs:summarize(mapping),prefixMs:summarize(prefix)});
}
fs.writeFileSync(report,JSON.stringify({passed:true,synthetic:true,userDatabaseOpened:false,scope:'Node algorithm microbenchmark; arrays prepared outside timers; 5 warmups + 30 samples per size; no real-book/UI/P95 inference',runtime:{node:process.versions.node,cpu:os.cpus()[0]?.model},rows},null,2));console.log(JSON.stringify(rows.map(r=>({sections:r.sections,mappingP50:r.mappingMs.p50,mappingP95:r.mappingMs.p95,prefixP50:r.prefixMs.p50,prefixP95:r.prefixMs.p95}))));
})().catch(error=>{console.error(error);process.exitCode=1;});
