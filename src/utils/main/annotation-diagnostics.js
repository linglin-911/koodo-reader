const { performance } = require("node:perf_hooks");
const validId = value => typeof value === "string" && /^[a-zA-Z0-9-]{1,96}$/.test(value);
const round = value => Math.round(value * 10) / 10;

// Per-request wrappers: never patch a shared SQLite connection or statement.
// execute includes SQLite row materialization, as in the original DB timings.
const runMeasuredAnnotationCommand = async (command, run, log = () => {}, now = () => performance.now()) => {
  const measured = validId(command?.diagnostics?.requestId);
  const started = now();
  let action;
  const timings = {registryDurationMs:0,connectionDurationMs:0,migrationDurationMs:0,
    prepareDurationMs:0,executeDurationMs:0,inputConversionDurationMs:0,outputConversionDurationMs:0,sourceValidationDurationMs:0,statementCount:0};
  const stage = (key, fn) => { const start=now();try{return fn();}finally{timings[key]+=now()-start;} };
  const asyncStage = async (key, fn) => {const start=now();try{return await fn();}finally{timings[key]+=now()-start;} };
  const sqlTotal = () => timings.prepareDurationMs + timings.executeDurationMs + timings.outputConversionDurationMs + timings.inputConversionDurationMs;
  const convert = (fn,key="outputConversionDurationMs") => {const start=now(),nested=sqlTotal();try{return fn();}finally{timings[key]+=Math.max(0,now()-start-(sqlTotal()-nested));}};
  const database = db => !measured ? db : new Proxy(db, {get(target,key){
    if(key === "prepare")return sql => {
      const statement=stage("prepareDurationMs",()=>target.prepare(sql));
      return new Proxy(statement,{get(row,method){
        if(["all","get","run"].includes(method))return (...args)=>{timings.statementCount++;return stage("executeDurationMs",()=>row[method](...args));};
        const value=Reflect.get(row,method,row);return typeof value === "function"?value.bind(row):value;
      }});
    };
    if(key === "exec")return sql => stage("executeDurationMs",()=>target.exec(sql));
    const value=Reflect.get(target,key,target);return typeof value === "function"?value.bind(target):value;
  }});
  const metrics = measured ? {setAction:value=>{action=value;},stage,asyncStage,convert,input:fn=>convert(fn,"inputConversionDurationMs"),database} : {
    setAction:()=>{},stage:(_key,fn)=>fn(),asyncStage:(_key,fn)=>fn(),convert:fn=>fn(),input:fn=>fn(),database:db=>db};
  const finish = (failed,result) => {
    const mainDurationMs = now()-started;
    const diagnostics = {action,requestId:command.diagnostics.requestId,
      traceId:validId(command.diagnostics.traceId)?command.diagnostics.traceId:undefined,
      ...Object.fromEntries(Object.entries(timings).map(([key,value])=>[key,round(value)])),
      mainDurationMs:round(mainDurationMs),resultRowCount:Array.isArray(result)?result.length:Array.isArray(result?.records)?result.records.length:result?.key?1:undefined,failed};
    // Only fixed operation names and numeric metrics; no SQL, paths, quotes or errors.
    try{log(`[DIAG][Annotations] command:${failed?"failed":"complete"} ${JSON.stringify(diagnostics)}`);}catch{}
    return diagnostics;
  };
  try {
    const result=await run(metrics);
    return measured?{result,diagnostics:finish(false,result)}:result;
  } catch(error){if(measured)finish(true);throw error;}
};
module.exports={runMeasuredAnnotationCommand};
