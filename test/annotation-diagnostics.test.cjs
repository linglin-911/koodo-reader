const test=require("node:test"),assert=require("node:assert/strict");
const {runMeasuredAnnotationCommand}=require("../src/utils/main/annotation-diagnostics");
const config={diagnostics:{requestId:"req-1",traceId:"reader-1"},notes:"secret-body",storagePath:"secret-path"};
test("concurrent metrics never patch the shared database and separate SQL from conversion",async()=>{
 let tick=0;const logs=[];const db={prepare(){return {all(){return [{notes:"secret-body"}];}};}};
 const original=db.prepare;
 const run=metrics=>metrics.convert(()=>metrics.database(db).prepare("secret-sql").all());
 const [a,b]=await Promise.all([runMeasuredAnnotationCommand(config,run,line=>logs.push(line),()=>++tick),runMeasuredAnnotationCommand({...config,diagnostics:{requestId:"req-2"}},run,line=>logs.push(line),()=>++tick)]);
 assert.equal(db.prepare,original);assert.equal(a.result[0].notes,"secret-body");assert.equal(a.diagnostics.statementCount,1);assert.equal(b.diagnostics.statementCount,1);
 assert.ok(a.diagnostics.prepareDurationMs>0);assert.ok(a.diagnostics.executeDurationMs>0);assert.ok(a.diagnostics.outputConversionDurationMs>=0);
 assert.doesNotMatch(logs.join(""),/secret/);
});
test("unmeasured callers keep raw values and logging failures cannot change a transaction result",async()=>{
 const value={key:"one"};assert.equal(await runMeasuredAnnotationCommand({},()=>value),value);
 assert.equal((await runMeasuredAnnotationCommand(config,()=>value,()=>{throw Error("sink");})).result,value);
 const failure=Error("private database failure");const logs=[];
 await assert.rejects(()=>runMeasuredAnnotationCommand(config,()=>{throw failure;},line=>logs.push(line)),error=>error===failure);
 assert.match(logs[0],/failed/);assert.doesNotMatch(logs[0],/private/);
});
