// Serial Electron gate runner. Reports and all fixtures remain in a temporary root.
// Avoid parallel UI scripts sharing Vite's default optimizer cache.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const output=process.argv[2]||fs.mkdtempSync(path.join(os.tmpdir(),'koodo-final-acceptance-'));
fs.mkdirSync(output,{recursive:true});
const electron=require('electron'),root=path.resolve(__dirname,'..');
const scripts=['annotation-store','txt-index-store','txt-index-worker','txt-reader','txt-worker-reader','txt-directory','txt-window','txt-window-store','txt-checkpoint-upgrade','txt-window-interactions','annotation-reader','txt-recovery','txt-recovery-ui'];
const stress=process.argv.includes('--stress'),soakArg=process.argv.find(arg=>arg.startsWith('--soak-minutes='));
const soakMinutes=soakArg?Number(soakArg.split('=')[1]):0;
if(!Number.isFinite(soakMinutes)||soakMinutes<0||soakMinutes>120)throw Error('Invalid soak minutes');
if(stress)scripts.push('annotation-stress','annotation-stress-safety');
if(soakMinutes)scripts.push('txt-lifecycle');
(async()=>{
 const results=[];
 for(const name of scripts){
  const report=path.join(output,name+'.json'),log=path.join(output,name+'.log'),fd=fs.openSync(log,'w'),start=performance.now();
  let exitCode;
  try{exitCode=await new Promise((resolve,reject)=>{const child=spawn(electron,[path.join(__dirname,name+'.electron.cjs'),report,...(name==='txt-lifecycle'?[String(soakMinutes)]:[])],{cwd:root,windowsHide:true,stdio:['ignore',fd,fd],timeout:name==='txt-lifecycle'?(soakMinutes+10)*60000:30*60000});child.once('error',reject);child.once('exit',resolve);});}finally{fs.closeSync(fd);}
  let result;try{result=JSON.parse(fs.readFileSync(report,'utf8'));}catch{result={passed:false,error:'Missing/invalid report'};}
  const entry={name,exitCode,durationMs:performance.now()-start,passed:exitCode===0&&result.passed===true,cases:result.cases??result.checks?.length,rendererErrors:result.rendererErrors?.length??0,error:result.error};results.push(entry);
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({passed:results.every(r=>r.passed),complete:results.length===scripts.length,synthetic:true,userDatabaseOpened:false,scope:'configured automated synthetic gates; not the full manual/real-book matrix',stress,soakMinutes,results},null,2));
  console.log(JSON.stringify(entry));
 }
 process.exitCode=results.every(r=>r.passed)?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
