const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'koodo-ui1-tag-ui-'));
app.setPath('userData',path.join(temporary,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const report=process.argv[2]||path.join(temporary,'result.json'),dbs=new Map(),errors=[];
let server,window;
const inside=value=>{const relative=path.relative(temporary,path.resolve(value));if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Fixture refuses non-temporary data');return value;};
app.whenReady().then(async()=>{
 const Database=require('better-sqlite3'),{createAnnotationService}=require('../src/utils/main/annotation-store'),{backupToPath,restoreFromPath}=require('../src/utils/main/backup-util');
 const annotations=createAnnotationService({Database,getConnection:root=>{
  inside(root);if(!dbs.has(root)){fs.mkdirSync(path.join(root,'config'),{recursive:true});const db=new Database(path.join(root,'config','notes.db'));db.exec('CREATE TABLE IF NOT EXISTS drawing_notes(key TEXT PRIMARY KEY,notes TEXT)');dbs.set(root,db);}return dbs.get(root);
 }});
 ipcMain.on('storage-location',event=>event.returnValue=path.join(temporary,'default'));
 ipcMain.handle('tag-ui-root',(_event,name)=>{if(!/^[a-z0-9-]+$/.test(name))throw Error('Invalid fixture root');const root=path.join(temporary,name);fs.mkdirSync(root,{recursive:true});return root;});
 ipcMain.handle('database-command',(event,command)=>command.operation==='annotations'?annotations(command,event.sender.id):[]);
 ipcMain.handle('close-database',(_event,c)=>{inside(c.storagePath);if(c.dbName==='notes'){const db=dbs.get(c.storagePath);if(db?.open)db.close();dbs.delete(c.storagePath);}return true;});
 ipcMain.handle('backup-path',(_event,c)=>{inside(c.dataPath);inside(c.targetPath);return backupToPath(c,()=>{});});
 ipcMain.handle('restore-path',(_event,c)=>{inside(c.dataPath);inside(c.filePath);return restoreFromPath(c,()=>{});});
 const {createServer}=await import('vite');
 server=await createServer({root:path.resolve(__dirname,'..'),server:{port:0,host:'127.0.0.1',warmup:{clientFiles:[]}},plugins:[{name:'tag-ui-fixture',configureServer(v){v.middlewares.use('/__tag_ui__',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await v.transformIndexHtml('/__tag_ui__','<html><body></body></html>'));});}}]});
 await server.listen();window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
 window.webContents.on('console-message',event=>{if(event.level===3)errors.push(event.message);});
 await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__tag_ui__`);
 await window.webContents.executeJavaScript(`window.electronAPI={invoke:(...a)=>require('electron').ipcRenderer.invoke(...a),sendSync:(...a)=>require('electron').ipcRenderer.sendSync(...a),on:()=>{},removeListener:()=>{},fs:require('node:fs'),path:require('node:path')};void 0;`);
 const result=await window.webContents.executeJavaScript(`import('/test/fixtures/annotation-tags-ui.js').then(m=>m.run())`);
 assert.equal(result.passed,true);assert.ok(result.cases>=10);
 // Conflict rejections intentionally log through the existing restore UI.
 fs.writeFileSync(report,JSON.stringify({...result,userDatabaseOpened:false,rendererErrors:errors},null,2));console.log(JSON.stringify(result));await cleanup();app.exit(0);
}).catch(async error=>{console.error(error);fs.writeFileSync(report,JSON.stringify({passed:false,error:error.message,rendererErrors:errors}));await cleanup();app.exit(1);});
async function cleanup(){if(window&&!window.isDestroyed())window.destroy();if(server)await server.close();for(const db of dbs.values())if(db.open)db.close();}
