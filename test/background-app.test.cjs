'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const executablePath = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'test-app', 'Mini Browser.exe'));
assert.ok(executablePath.startsWith(root + path.sep));
const temp = path.join(root, '.cache', 'tmp'); fs.mkdirSync(temp, { recursive: true });
const profile = randomUUID();
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Page ${request.url}</title><p>${request.url}</p>`);
});
const wait = async (check, label) => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Timed out: ${label}`); };
const start = (extra = {}) => electron.launch({ executablePath, cwd: root, env: { ...process.env, MINI_BROWSER_TEST: '1', MINI_BROWSER_TEST_PROFILE: profile, TEMP: temp, TMP: temp, ...extra } });
const state = shell => shell.evaluate(() => window.miniBrowser.getState());

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // First run: open two pages, then quit; they are saved.
  let app = await start(), shell = await app.firstWindow();
  await shell.evaluate(url => window.miniBrowser.navigate(url), `${base}/one`);
  await shell.evaluate(() => window.miniBrowser.newTab());
  await shell.evaluate(url => window.miniBrowser.navigate(url), `${base}/two`);
  await wait(async () => (await state(shell)).tabs.filter(tab => tab.url?.startsWith(base)).length === 2, 'two pages open');
  await app.close();

  // Second run: a fresh start page with an offer; nothing loads until Restore.
  app = await start(); shell = await app.firstWindow();
  let current = await state(shell);
  assert.equal(current.restoreOffer, 2, 'previous tabs are offered');
  assert.equal(current.tabs.length, 1); assert.equal(current.mode, 'welcome');
  assert.ok(await shell.evaluate(() => !document.getElementById('restore-bar').hidden), 'restore bar is shown');
  assert.equal(await app.evaluate(({ webContents }, base) => webContents.getAllWebContents().filter(w => w.getURL().startsWith(base)).length, base), 0, 'saved pages are not loaded');
  await shell.evaluate(() => window.miniBrowser.restoreTabs());
  await wait(async () => { const s = await state(shell); return s.tabs.length === 2 && s.tabs.every(tab => tab.url?.startsWith(base)) && !s.restoreOffer; }, 'tabs restored, start page replaced');
  await app.close();

  // Dismissing keeps the saved session for next time.
  app = await start(); shell = await app.firstWindow();
  await shell.evaluate(() => window.miniBrowser.dismissRestore());
  await wait(async () => !(await state(shell)).restoreOffer, 'offer dismissed');
  await app.close();
  app = await start(); shell = await app.firstWindow();
  assert.equal((await state(shell)).restoreOffer, 2, 'a session of start pages only does not replace the saved one');
  await app.close();

  // Closing the last visible window hides it; its pages keep running without a reload.
  app = await start({ MINI_BROWSER_TEST_KEEP_ON_CLOSE: '1' }); shell = await app.firstWindow();
  await shell.evaluate(() => window.miniBrowser.restoreTabs());
  await wait(async () => (await state(shell)).tabs.length === 2, 'restored for background test');
  const mark = () => app.evaluate(({ webContents }, base) => Promise.all(webContents.getAllWebContents().filter(w => w.getURL().startsWith(base)).map(w => w.executeJavaScript('window.marker = window.marker || Math.random()'))), base);
  const before = await mark();
  await app.evaluate(({ BrowserWindow }, id) => { const win = BrowserWindow.fromId(id); win.show(); win.close(); }, shell.id);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }, id) => { const win = BrowserWindow.fromId(id); return win && !win.isDestroyed() ? [true, win.isVisible()] : [false]; }, shell.id), [true, false], 'window hidden, not closed');
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).show(), shell.id);
  assert.deepEqual(await mark(), before, 'pages were not reloaded');

  // With another window visible, closing one really closes it.
  await shell.evaluate(() => window.miniBrowser.createProfile('Work'));
  const other = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(win => win.id !== id && win.webContents.getURL() === 'mini://app/index.html').id, shell.id);
  await app.evaluate(({ BrowserWindow }, ids) => ids.forEach(id => BrowserWindow.fromId(id).show()), [shell.id, other]);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), other);
  await wait(() => app.evaluate(({ BrowserWindow }, id) => !BrowserWindow.fromId(id), other), 'second window really closed');
  assert.ok(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), shell.id), 'first window still open');
  await app.close();
  console.log('PASS: start page offers saved tabs; closing the last window keeps pages running in the background');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
