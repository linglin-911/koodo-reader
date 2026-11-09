// Isolated real Reader smoke test; never opens the user's library or profile.
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'koodo-reader-toolbar-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = process.argv[2] || path.join(temporary, 'result.json');
let server, window, db;
const errors = [];
const deadline = setTimeout(() => { console.error('Reader toolbar test timed out'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const Database = require('better-sqlite3');
  const { SqlStatement } = await import(pathToFileURL(path.resolve(__dirname, '../src/assets/lib/kookit-extra.min.mjs')));
  const { createTxtIndexService } = require('../src/utils/main/txt-index-store');
  const { createAnnotationService } = require('../src/utils/main/annotation-store');
  const storage = path.join(temporary, 'library');
  fs.mkdirSync(path.join(storage, 'book'), { recursive: true });
  fs.mkdirSync(path.join(storage, 'config'));
  fs.writeFileSync(path.join(storage, 'book', 'fixture.txt'), Array.from({ length: 24 }, (_, i) => `Chapter ${i + 1}\r\n${('隔离测试正文😀，保留选文与章节位置。\r\n').repeat(35)}`).join(''));
  db = new Database(path.join(storage, 'config', 'notes.db'));
  db.exec(SqlStatement.sqlStatement.createTableStatement.notes);
  const txt = createTxtIndexService({ getConnection: () => db });
  const annotations = createAnnotationService({ getConnection: () => db, describeTxt: (...args) => txt.describeChapter(...args), loadRegistry: async () => SqlStatement, Database });
  const book = { key: 'fixture', name: 'Toolbar isolated TXT', author: 'Fixture', description: '', md5: '', cover: '', format: 'TXT', publisher: '', size: 50000, page: 24, path: '', charset: 'utf-8' };
  const bookmarks = [];
  ipcMain.handle('database-command', (event, command) => {
    if (command.operation === 'annotations') return annotations(command, event.sender.id);
    if (command.operation) return txt(command, event.sender.id);
    if (command.dbName === 'books') return command.executeType === 'get' ? book : [book];
    if (command.dbName === 'plugins') return [];
    if (command.dbName === 'bookmarks') {
      if (command.statement === 'saveStatement') { bookmarks.push(command.data); return { changes: 1 }; }
      return bookmarks;
    }
    throw Error(`Unexpected fixture database: ${command.dbName}`);
  });
  ipcMain.handle('custom-database-command', () => []);
  ipcMain.handle('reader-toolbar-book', () => book);
  ipcMain.handle('reader-toolbar-clipboard', () => clipboard.readText());
  ipcMain.handle('reader-toolbar-resize', (_event, width) => window.setContentSize(width, 850));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  ipcMain.handle('reader-toolbar-click', async (_event, { x, y, count }) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
      window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
      await pause(35);
    }
  });
  ipcMain.handle('reader-toolbar-drag', async (_event, { x, y, endX }) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step++) {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x + (endX - x) * step / 8), y, button: 'left' });
      await pause(25);
    }
    window.webContents.sendInputEvent({ type: 'mouseUp', x: endX, y, button: 'left', clickCount: 1 });
  });
  ipcMain.handle('reader-toolbar-wheel', async (_event, { x, y }) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaY: -350, deltaX: 0, canScroll: true, hasPreciseScrollingDeltas: false });
    await pause(250);
  });
  ipcMain.handle('reader-toolbar-preview', async (_event, kind) => {
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const preview = path.join(temporary, ({ navigation: 'reader-navigation.png', settings: 'reader-settings.png', note: 'small-annotation.png', selection: 'selection-menu.png' })[kind] || 'reader-settings.png');
    fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG());
    return preview;
  });
  ipcMain.on('storage-location', event => { event.returnValue = storage; });
  server = await createServer({ root: path.resolve(__dirname, '..'), server: { port: 0, host: '127.0.0.1', warmup: { clientFiles: [] } }, plugins: [{ name: 'reader-toolbar-test', configureServer(vite) {
    vite.middlewares.use('/__reader_toolbar__/', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml('/__reader_toolbar__/', '<html><body style="margin:0"><div id="root" style="height:100vh"></div></body></html>'));
    });
  } }] });
  await server.listen();
  window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: true } });
  window.webContents.on('console-message', event => { if (event.level === 3) errors.push(event.message); });
  await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__reader_toolbar__/fixture?test=1`);
  await window.webContents.executeJavaScript(`window.electronAPI={invoke:(...args)=>require('electron').ipcRenderer.invoke(...args),sendSync:(...args)=>require('electron').ipcRenderer.sendSync(...args),send:(...args)=>require('electron').ipcRenderer.send(...args),on:(...args)=>require('electron').ipcRenderer.on(...args),removeListener:(...args)=>require('electron').ipcRenderer.removeListener(...args),runtime:{platform:process.platform},fs:require('fs'),path:require('path')};void 0;`);
  const result = await window.webContents.executeJavaScript('import("/test/fixtures/reader-toolbar.tsx").then(module=>module.run())');
  const preview = path.join(temporary, 'reader-toolbar.png');
  fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG());
  if (errors.length) throw Error(`Renderer errors: ${errors.join('\n')}`);
  fs.writeFileSync(report, JSON.stringify({ ...result, preview, rendererErrors: errors }, null, 2));
  console.log(JSON.stringify({ ...result, preview, rendererErrors: errors }));
  await cleanup(); app.exit(0);
}).catch(async error => {
  let preview;
  if (window && !window.isDestroyed()) {
    preview = path.join(temporary, 'reader-toolbar-failed.png');
    fs.writeFileSync(preview, (await window.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(report, JSON.stringify({ passed: false, error: error.stack, preview, rendererErrors: errors }, null, 2));
  console.error(error); await cleanup(); app.exit(1);
});
async function cleanup() {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await server.close();
  if (db?.open) db.close();
}
