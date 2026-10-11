'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'test-app', 'Mini Browser.exe'));
assert.ok(source.startsWith(root + path.sep));
const fixture = path.join(root, '.cache', `basics-${randomUUID().slice(0, 8)}`);
const temp = path.join(root, '.cache', 'tmp');
fs.mkdirSync(temp, { recursive: true });
fs.cpSync(path.dirname(source), fixture, { recursive: true, filter: file => {
  const relative = path.relative(path.dirname(source), file);
  return relative.split(path.sep)[0] !== '.mini-browser' && relative !== path.join('resources', 'installed.flag');
} });
const data = path.join(fixture, '.mini-browser');
const downloads = path.join(fixture, 'downloads');
fs.mkdirSync(downloads, { recursive: true });
let application, shell;
const server = http.createServer((request, response) => {
  if (request.url === '/download' || request.url === '/slow-download') {
    response.setHeader('Content-Disposition', 'attachment; filename="sample.txt"');
    response.setHeader('Content-Type', 'application/octet-stream');
    if (request.url === '/download') return response.end('completed download fixture');
    response.setHeader('Content-Length', '1000000'); response.write('started'.repeat(1024));
    const timer = setInterval(() => response.write('more'), 100);
    response.on('close', () => clearInterval(timer)); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Browser basics</title><h1>Browser basics</h1><p>needle one</p><p>needle two</p><p>needle three</p><a id="link" href="/linked">A link</a><input id="edit" value="Edit me">');
});
async function poll(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('Timed out: ' + label);
}
const state = () => shell.evaluate(() => window.miniBrowser.getState());
const call = (method, ...args) => shell.evaluate(({ method, args }) => window.miniBrowser[method](...args), { method, args });
async function page(code) {
  const current = await state(), index = current.tabs.findIndex(tab => tab.id === current.activeTabId);
  return application.evaluate(({ BrowserWindow }, { id, index, code }) => BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[index].webContents.executeJavaScript(code, true), { id: shell.id, index, code });
}
async function key(keyCode, modifiers = [], inShell = false) {
  const current = await state(), index = current.tabs.findIndex(tab => tab.id === current.activeTabId);
  await application.evaluate(({ BrowserWindow }, { id, index, keyCode, modifiers, inShell }) => {
    const win = BrowserWindow.fromId(id), content = inShell ? win.contentView.children.find(view => view.browserChrome).webContents : win.contentView.children.filter(view => !view.browserChrome)[index].webContents;
    content.focus(); content.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); content.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { id: shell.id, index, keyCode, modifiers, inShell });
}
async function navigate(url) {
  assert.equal((await call('navigate', url)).ok, true);
  await poll(async () => { const s = await state(); return s.url === url && !s.loading && s.mode === 'page'; }, 'page loads');
}
async function launch(test = false, uuid) {
  const env = { ...process.env, MINI_BROWSER_TEST: test ? '1' : '0', TEMP: temp, TMP: temp };
  if (uuid) env.MINI_BROWSER_TEST_PROFILE = uuid;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: path.join(fixture, 'Mini Browser.exe'), cwd: root, env });
  shell = await application.firstWindow(); await shell.waitForURL('mini://app/index.html');
  await poll(async () => !!(await state()).activeProfile, 'shell ready');
  await application.evaluate(({ app }, directory) => app.setPath('downloads', directory), downloads);
}
async function profileWindow(id) {
  let result;
  await poll(async () => {
    result = await application.evaluate(async ({ BrowserWindow }, id) => {
      for (const win of BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')) {
        const state = await win.webContents.executeJavaScript('window.miniBrowser?.getState()');
        if (state?.activeProfile.id === id) return win.id;
      }
    }, id); return !!result;
  }, 'profile window');
  return application.window(result);
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await launch(); await navigate(base + '/first');
    const unownedBlocked = await application.evaluate(({ BrowserWindow }, { id, url }) => new Promise(resolve => {
      const session = BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[0].webContents.session;
      session.once('will-download', event => resolve(event.defaultPrevented));
      session.downloadURL(url);
    }), { id: shell.id, url: base + '/download' });
    assert.equal(unownedBlocked, true, 'a session download without an owning page is rejected');
    assert.deepEqual((await state()).downloads, []);
    await key('f', ['control']); await poll(async () => (await state()).find.open, 'Ctrl+F');
    await application.evaluate(({ BrowserWindow }, id) => { global.findTrace = []; BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[0].webContents.on('found-in-page', (_event, result) => global.findTrace.push(result)); }, shell.id);
    await shell.overlay().locator('#find-text').fill('needle');
    try { await poll(async () => (await state()).find.matches === 3, 'find three matches'); }
    catch (error) { console.error('Find diagnostics:', (await state()).find, await application.evaluate(() => global.findTrace)); throw error; }
    const first = (await state()).find.ordinal; assert.equal(first, 1);
    await shell.screenshot({ path: path.join(fixture, 'find.png') });
    await key('Enter', [], true);
    try { await poll(async () => (await state()).find.ordinal === 2, 'Enter next match'); }
    catch (error) { console.error('Next diagnostics:', (await state()).find, await application.evaluate(() => global.findTrace), await shell.evaluate(() => ({ focused: document.activeElement.id, text: document.getElementById('find-text').value }))); throw error; }
    await key('Enter', ['shift'], true); await poll(async () => (await state()).find.ordinal === 1, 'Shift+Enter previous match');
    await key('Escape', [], true); await poll(async () => !(await state()).find.open, 'Escape closes find');
    assert.equal((await state()).find.requestId, null); assert.equal(await page('getSelection().toString()'), '');
    console.log('PASS: Ctrl+F, live matches, Enter/Shift+Enter next/previous, and Escape clearing highlights');

    const firstTab = (await state()).activeTabId;
    await call('newTab'); await navigate(base + '/same-origin'); const secondTab = (await state()).activeTabId;
    await key('+', ['control']); await poll(async () => (await state()).zoomPercent === 110, 'Ctrl+Plus');
    const factors = await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome).map(view => view.webContents.getZoomFactor()), shell.id);
    assert.deepEqual(factors, [1, 1.1], 'same-origin tabs have independent zoom');
    for (let index = 0; index < 20; index++) await call('zoom', 'in');
    await poll(async () => (await state()).zoomPercent === 300, 'zoom limit publishes');
    for (let index = 0; index < 25; index++) await call('zoom', 'out');
    await poll(async () => (await state()).zoomPercent === 50, 'zoom limit publishes');
    await key('0', ['control']); await poll(async () => (await state()).zoomPercent === 100, 'Ctrl+0');
    await key('-', ['control']); await poll(async () => (await state()).zoomPercent === 90, 'Ctrl+Minus');
    await call('selectTab', firstTab); await poll(async () => (await state()).activeTabId === firstTab && (await state()).zoomPercent === 100, 'first tab zoom');
    await call('selectTab', secondTab); await poll(async () => (await state()).activeTabId === secondTab && (await state()).zoomPercent === 90, 'second tab zoom');
    console.log('PASS: tab-only same-origin zoom, Ctrl+Plus/Minus/0, and 50–300% limits');
    await call('zoom', 'reset');

    // Intercept only the native menu display; build it from a real right-click event.
    await application.evaluate(({ Menu }) => { Menu.prototype.popup = function () { global.basicsMenu = this; }; });
    const point = await page('(() => { const r = document.getElementById("link").getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()');
    await application.evaluate(({ BrowserWindow }, { id, point }) => {
      const content = BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[1].webContents;
      content.sendInputEvent({ type: 'mouseDown', button: 'right', ...point }); content.sendInputEvent({ type: 'mouseUp', button: 'right', ...point });
    }, { id: shell.id, point });
    await poll(() => application.evaluate(() => !!global.basicsMenu), 'native page menu');
    const labels = await application.evaluate(() => global.basicsMenu.items.map(item => item.label));
    for (const label of ['Reload', 'Copy link', 'Open in new tab', 'Download link']) assert.ok(labels.includes(label), `Missing ${label}: ${labels}`);
    await application.evaluate(() => global.basicsMenu.items.find(item => item.label === 'Open in new tab').click());
    await poll(async () => (await state()).tabs.length === 3 && (await state()).url === base + '/linked' && !(await state()).loading, 'context menu opens link tab');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length), 1);
    console.log('PASS: context-menu params produce link actions; Open in new tab keeps the same profile/window');

    fs.writeFileSync(path.join(downloads, 'sample.txt'), 'keep existing');
    await key('Shift');
    await page("location.href='/download';");
    await poll(async () => (await state()).downloads.some(item => item.state === 'completed'), 'download completes');
    const completed = (await state()).downloads[0];
    assert.equal(completed.path, path.join(downloads, 'sample (1).txt'));
    assert.equal(fs.readFileSync(completed.path, 'utf8'), 'completed download fixture');
    assert.equal(fs.readFileSync(path.join(downloads, 'sample.txt'), 'utf8'), 'keep existing');
    assert.equal((await state()).downloadsPanelOpen, true);
    await poll(() => shell.evaluate(() => document.querySelector('#downloads-list').textContent.includes('Open file')), 'completed download actions');
    await shell.screenshot({ path: path.join(fixture, 'downloads.png') });
    // Check shell calls without executing a downloaded file or opening Explorer.
    await application.evaluate(({ shell }) => { shell.openPath = async path => { global.openedDownload = path; return ''; }; shell.showItemInFolder = path => { global.shownDownload = path; }; });
    assert.equal((await call('download', 'open', completed.id)).ok, true);
    assert.equal((await call('download', 'show', completed.id)).ok, true);
    assert.deepEqual(await application.evaluate(() => [global.openedDownload, global.shownDownload]), [completed.path, completed.path]);
    await page("location.href='/slow-download';");
    await poll(async () => (await state()).downloads.some(item => item.state === 'progressing'), 'download progress');
    const pending = (await state()).downloads.find(item => item.state === 'progressing');
    assert.equal((await call('download', 'cancel', pending.id)).ok, true);
    await poll(async () => (await state()).downloads.find(item => item.id === pending.id).state === 'cancelled', 'download cancels');
    const invalidDirectory = path.join(fixture, 'not-a-directory'); fs.mkdirSync(invalidDirectory);
    await application.evaluate(({ app }, directory) => app.setPath('downloads', directory), invalidDirectory);
    fs.rmdirSync(invalidDirectory); fs.writeFileSync(invalidDirectory, 'fixture');
    await page("location.href='/download';");
    await poll(async () => (await state()).downloads.some(item => item.state === 'interrupted' && item.error), 'failed download shows filesystem error');
    await application.evaluate(({ app }, directory) => app.setPath('downloads', directory), downloads);
    await call('downloadsPanel', false);
    console.log('PASS: completed path, duplicate-name suffix, progress, cancel, failure error, and trusted open/show actions');

    await call('selectTab', secondTab);
    await call('createProfile', 'Work');
    await poll(async () => (await state()).profiles.length === 2, 'work profile publishes');
    const workId = (await state()).profiles.find(profile => profile.id !== 'default').id;
    shell = await profileWindow(workId);
    assert.equal((await state()).mode, 'welcome'); assert.deepEqual((await state()).downloads, []);
    assert.equal((await call('download', 'open', completed.id)).ok, false, 'cross-profile download action rejected');
    await navigate(base + '/work');
    await call('newTab'); await navigate(base + '/work-two');
    await call('newTab'); // Welcome tabs are omitted from saved URLs.
    await call('selectTab', (await state()).tabs[0].id);
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), shell.id);
    await application.close(); application = null;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'tabs.json'))).urls, [base + '/first', base + '/same-origin', base + '/linked']);
    const workFile = path.join(data, 'profiles', workId, 'tabs.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(workFile)).urls, [base + '/work', base + '/work-two']);
    await launch();
    assert.equal((await state()).activeProfile.id, workId);
    // A new launch starts on the start page and offers the saved tabs.
    assert.equal((await state()).restoreOffer, 2); assert.deepEqual((await state()).tabs.map(tab => tab.url), ['']);
    await call('restoreTabs');
    await poll(async () => (await state()).tabs.length === 2 && !(await state()).loading, 'restored active page');
    assert.deepEqual((await state()).tabs.map(tab => tab.url), [base + '/work', base + '/work-two']);
    assert.equal((await state()).url, base + '/work');
    await call('switchProfile', 'default'); shell = await profileWindow('default');
    await call('restoreTabs');
    await poll(async () => (await state()).tabs.length === 3 && !(await state()).loading, 'default restored active page');
    assert.deepEqual((await state()).tabs.map(tab => tab.url), [base + '/first', base + '/same-origin', base + '/linked']);
    assert.equal((await state()).url, base + '/same-origin');
    // A manual close also writes the tab snapshot before disposing the views.
    await navigate(base + '/manual-close');
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), shell.id);
    await poll(() => application.evaluate(({ BrowserWindow }, id) => !BrowserWindow.fromId(id), shell.id), 'manual window finishes closing');
    await poll(() => JSON.parse(fs.readFileSync(path.join(data, 'tabs.json'))).urls.includes(base + '/manual-close'), 'manual window close saves tabs');
    console.log('PASS: restart and manual close restore HTTP(S) URLs and active tab in the correct profile');
    await application.close(); application = null;
    const registryBefore = fs.readFileSync(path.join(data, 'profiles.json'));
    const tabsBefore = fs.readFileSync(workFile);
    await launch(true, randomUUID());
    assert.equal((await state()).mode, 'welcome'); assert.equal((await state()).activeProfile.id, 'default');
    await application.close(); application = null;
    assert.deepEqual(fs.readFileSync(path.join(data, 'profiles.json')), registryBefore);
    assert.deepEqual(fs.readFileSync(workFile), tabsBefore);
    console.log('PASS: MINI_BROWSER_TEST leaves persistent profiles and saved tabs untouched');
  } finally { if (application) await application.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
