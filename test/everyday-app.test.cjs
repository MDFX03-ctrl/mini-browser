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
const fixture = path.join(root, '.cache', 'everyday-' + randomUUID().slice(0, 8));
const temp = path.join(root, '.cache', 'tmp'); fs.mkdirSync(temp, { recursive: true });
fs.cpSync(path.dirname(source), fixture, { recursive: true, filter: file => {
  const relative = path.relative(path.dirname(source), file);
  return relative.split(path.sep)[0] !== '.mini-browser' && relative !== path.join('resources', 'installed.flag');
} });
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/login') return response.end('<!doctype html><title>Sign in</title><form action="/signed-in" method="post"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>');
  if (request.url === '/failed') return response.end('<!doctype html><title>Failed</title><form><input autocomplete="username"><input type="password"><button>Sign in</button></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault(); document.body.insertAdjacentHTML("beforeend", "<p role=alert>Incorrect password</p>")}</script>');
  response.end('<!doctype html><title>' + (request.url === '/signed-in' ? 'Signed in' : request.url === '/alpha' ? 'Alpha history' : 'Beta history') + '</title><h1>Local browsing fixture</h1><p>needle needle</p>');
});
let application, shell, base, defaultProfile, otherProfile;
const state = () => shell.evaluate(() => window.miniBrowser.getState());
const call = (method, ...args) => shell.evaluate(({ method, args }) => window.miniBrowser[method](...args), { method, args });
async function poll(check, label, timeout = 20000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('Timed out: ' + label);
}
async function page(code) {
  const current = await state(), index = current.tabs.findIndex(tab => tab.id === current.activeTabId);
  return application.evaluate(({ BrowserWindow }, { id, index, code }) => BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[index].webContents.executeJavaScript(code, true), { id: shell.id, index, code });
}
async function key(keyCode, modifiers = [], overlay = false) {
  const current = await state(), index = current.tabs.findIndex(tab => tab.id === current.activeTabId);
  await application.evaluate(({ BrowserWindow }, { id, index, keyCode, modifiers, overlay }) => {
    const win = BrowserWindow.fromId(id), content = overlay ? win.contentView.children.find(view => view.browserChrome).webContents : win.contentView.children.filter(view => !view.browserChrome)[index].webContents;
    content.focus(); content.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); content.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { id: shell.id, index, keyCode, modifiers, overlay });
}
async function navigate(url) { assert.equal((await call('navigate', url)).ok, true); await poll(async () => { const s = await state(); return s.url === url && !s.loading && s.mode === 'page'; }, 'navigation'); }
async function launch() {
  const env = { ...process.env, MINI_BROWSER_TEST: '0', TEMP: temp, TMP: temp }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: path.join(fixture, 'Mini Browser.exe'), cwd: root, env });
  shell = await application.firstWindow(); await shell.waitForURL('mini://app/index.html'); await poll(async () => !!(await state()).activeProfile, 'shell state');
}
async function profileWindow(id) {
  let windowId;
  await poll(async () => {
    windowId = await application.evaluate(async ({ BrowserWindow }, id) => {
      for (const win of BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')) if ((await win.webContents.executeJavaScript('window.miniBrowser?.getState()'))?.activeProfile.id === id) return win.id;
    }, id); return !!windowId;
  }, 'profile window'); return application.window(windowId);
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  try {
    await launch(); defaultProfile = (await state()).activeProfile.id;
    await shell.screenshot({ path: path.join(fixture, 'new-tab.png') });
    assert.equal(await shell.evaluate(() => !!document.querySelector('#welcome-hero, footer, .eyebrow')), false);
    assert.equal(await shell.evaluate(() => new Set([...document.querySelectorAll('[id]')].map(node => node.id)).size === document.querySelectorAll('[id]').length), true, 'shell has no duplicate IDs');
    assert.equal(await shell.evaluate(() => getComputedStyle(document.querySelector('.tab-strip')).backgroundColor), 'rgb(237, 242, 231)');
    assert.equal(await shell.evaluate(() => document.getElementById('bookmark-bar').hidden), true);
    await shell.locator('#start-address').fill(base + '/alpha');
    await shell.evaluate(() => document.getElementById('start-form').requestSubmit());
    await poll(async () => (await state()).url === base + '/alpha' && !(await state()).loading, 'central address field navigates');
    await call('addBookmark', base + '/alpha', 'Alpha bookmark'); await call('addBookmark', base + '/beta', 'Beta bookmark');
    await poll(() => shell.evaluate(() => document.querySelectorAll('#bookmark-bar .bookmark-open').length === 2), 'bookmark bar updates');
    await call('reorderBookmarks', [base + '/beta', base + '/alpha']);
    await poll(() => shell.evaluate(() => [...document.querySelectorAll('#bookmark-bar strong')].map(node => node.textContent.trim()).join('|') === 'Beta bookmark|Alpha bookmark'), 'bookmark order updates');
    await shell.locator('#menu-toggle').click(); await shell.overlay().locator('#bookmark-bar-toggle').click();
    await poll(async () => !(await state()).bookmarkBar, 'bookmark bar toggle'); assert.equal((await state()).bookmarkBar, false); assert.equal(await shell.evaluate(() => document.getElementById('bookmark-bar').hidden), true);
    await shell.overlay().locator('#bookmark-bar-toggle').click();
    await call('ui', 'close'); await navigate(base + '/beta');
    const printing = await application.evaluate(({ BrowserWindow }, id) => {
      const page = BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[0].webContents;
      global.printCalls = []; const original = page.print.bind(page);
      page.print = (options, callback) => { global.printCalls.push({ id: page.id, options }); callback(false, 'Print job canceled'); };
      global.restorePrint = () => { page.print = original; };
      return { spellcheck: page.session.isSpellCheckerEnabled(), languages: page.session.getSpellCheckerLanguages() };
    }, shell.id);
    assert.equal(printing.spellcheck, true); assert.deepEqual(printing.languages, ['en-US']);
    await key('p', ['control']); await shell.locator('#menu-toggle').click(); await shell.overlay().locator('[data-ui="print"]').click();
    assert.deepEqual(await application.evaluate(() => global.printCalls.map(call => call.options)), [{ silent: false }, { silent: false }]);
    await application.evaluate(() => global.restorePrint());
    await shell.locator('#address').fill('Alpha'); await poll(async () => (await state()).suggestions.length > 0, 'omnibox suggestion');
    assert.equal((await state()).suggestions[0].source, 'bookmark');
    assert.equal(await shell.overlay().evaluate(() => document.querySelector('#suggestions [aria-selected="true"]').textContent.includes('Alpha bookmark')), true);
    await shell.evaluate(() => document.getElementById('address-form').requestSubmit());
    await poll(async () => (await state()).url === base + '/alpha', 'Enter opens highlighted suggestion');
    await key('h', ['control']); await poll(async () => (await state()).overlay === 'history', 'Ctrl+H history');
    await poll(() => application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).contentView.children.find(view => view.browserChrome).getBounds().height > 100, shell.id), 'history bubble expands to its contents');
    assert.ok((await state()).history.some(entry => entry.url === base + '/beta'));
    const topBefore = await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).contentView.children.find(view => !view.browserChrome).getBounds().y, shell.id);
    await shell.screenshot({ path: path.join(fixture, 'history.png') });
    const overlayPNG = await application.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).contentView.children.find(view => view.browserChrome).webContents.capturePage()).toPNG().toString('base64'), shell.id);
    fs.writeFileSync(path.join(fixture, 'history-bubble.png'), Buffer.from(overlayPNG, 'base64'));
    assert.equal(topBefore, (await state()).chromeHeight, 'library floats over the page without pushing it');
    await call('ui', 'close'); await call('newTab'); await navigate(base + '/recover'); const recover = (await state()).activeTabId;
    await call('closeTab', recover); await poll(async () => (await state()).activeTabId !== recover, 'closed tab publishes'); await key('t', ['control', 'shift']);
    await poll(async () => (await state()).url === base + '/recover', 'reopen last closed tab');
    const recoverId = (await state()).activeTabId;
    await call('tab', 'pin-tab', recoverId); await call('tab', 'mute', recoverId);
    await poll(async () => (await state()).tabs[0].id === recoverId && (await state()).tabs[0].muted, 'pin and mute publish'); assert.equal((await state()).tabs[0].id, recoverId); assert.equal((await state()).tabs[0].muted, true);
    // Capture a native context menu instead of selecting an OS popup through screen coordinates.
    await application.evaluate(({ Menu }) => { const build = Menu.buildFromTemplate; Menu.buildFromTemplate = template => { global.lastTabMenu = template; return { popup() {} }; }; global.restoreMenu = () => { Menu.buildFromTemplate = build; }; });
    await call('ui', 'tab-menu', recoverId);
    assert.deepEqual(await application.evaluate(() => global.lastTabMenu.filter(item => item.label).map(item => item.label)), ['New tab', 'Reload', 'Duplicate', 'Unpin tab', 'Unmute tab', 'Close', 'Close others']);
    await application.evaluate(() => { global.lastTabMenu.find(item => item.label === 'Duplicate').click(); global.restoreMenu(); });
    await poll(async () => (await state()).tabs.length === 3, 'duplicate tab');
    console.log('PASS: original chrome, clean new tab, bookmark bar/order/toggle, omnibox, Ctrl+H, reopen, pin/mute and tab context menu');
    await navigate(base + '/login');
    assert.equal(await page('typeof window.miniBrowser + ":" + typeof require'), 'undefined:undefined');
    await page('document.querySelector("[name=username]").value="alice";document.querySelector("[name=password]").value="private-fixture-password";document.querySelector("form").requestSubmit()');
    await poll(async () => (await state()).passwordPrompt?.username === 'alice', 'successful login prompts save');
    await shell.overlay().locator('#password-save').click(); await call('ui', 'passwords');
    await poll(async () => (await state()).passwords.length === 1, 'saved password library');
    const saved = (await state()).passwords[0]; assert.equal(saved.username, 'alice'); assert.equal(saved.password, undefined);
    const passwordFile = path.join(fixture, '.mini-browser', 'passwords.json');
    assert.ok(!fs.readFileSync(passwordFile, 'utf8').includes('private-fixture-password'), 'DPAPI ciphertext only');
    assert.equal((await call('password', 'show', saved.id)).password, 'private-fixture-password');
    await call('password', 'copy', saved.id);
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'private-fixture-password');
    await application.evaluate(({ clipboard }) => clipboard.clear());
    await navigate(base + '/login'); await poll(async () => (await state()).passwordOffer.length === 1, 'saved login offered');
    await shell.locator('#password-fill-toggle').click(); await shell.overlay().locator('#library-list button').click();
    await poll(async () => (await page('document.querySelector("[name=password]").value')) === 'private-fixture-password', 'fill saved login');
    assert.equal(await page('document.querySelector("[name=username]").value'), 'alice');
    await navigate(base + '/failed'); await page('document.querySelector("input[type=password]").value="bad";document.querySelector("form").requestSubmit()');
    await new Promise(resolve => setTimeout(resolve, 600)); assert.equal((await state()).passwordPrompt, null);
    await call('createProfile', 'Other'); await poll(async () => (await state()).profiles.some(profile => profile.name === 'Other'), 'profile publishes'); otherProfile = (await state()).profiles.find(profile => profile.name === 'Other').id;
    const firstShell = shell; shell = await profileWindow(otherProfile);
    await navigate(base + '/login'); await call('ui', 'passwords'); await poll(async () => (await state()).overlay === 'passwords', 'passwords publish'); assert.deepEqual((await state()).passwords, []); assert.deepEqual((await state()).passwordOffer, []);
    await key('h', ['control']); assert.ok(!(await state()).history.some(entry => entry.url === base + '/alpha'));
    await navigate(base + '/other');
    shell = firstShell;
    console.log('PASS: successful login prompt, Windows encrypted save/show/copy, same-origin fill, failure rejection and profile isolation');
    await application.close(); application = null; await launch();
    assert.equal((await state()).activeProfile.id, otherProfile);
    await call('switchProfile', defaultProfile); shell = await profileWindow(defaultProfile);
    await call('ui', 'history'); await poll(async () => (await state()).overlay === 'history', 'history publishes'); assert.ok((await state()).history.some(entry => entry.url === base + '/alpha'));
    await call('ui', 'passwords'); await poll(async () => (await state()).overlay === 'passwords', 'passwords publish'); assert.equal((await state()).passwords.length, 1);
    assert.equal((await state()).tabs[0].pinned, true); assert.equal((await state()).tabs[0].muted, true);
    await navigate(base + '/login'); await poll(async () => (await state()).passwordOffer.length === 1, 'login restored');
    await page('document.cookie="profileCookie=present; path=/"');
    await call('clearData', { history: true, cache: false, cookies: false, passwords: false });
    assert.ok((await page('document.cookie')).includes('profileCookie=present'));
    await call('ui', 'passwords'); await poll(async () => (await state()).overlay === 'passwords', 'passwords publish'); assert.equal((await state()).passwords.length, 1);
    await call('clearData', { history: false, cache: true, cookies: true, passwords: true });
    assert.equal(await page('document.cookie'), ''); await poll(async () => (await state()).passwords.length === 0, 'password clear publishes'); await call('ui', 'passwords'); await poll(async () => (await state()).overlay === 'passwords', 'passwords publish'); assert.deepEqual((await state()).passwords, []);
    const defaultShell = shell; shell = await profileWindow(otherProfile); await call('ui', 'history'); await poll(async () => (await state()).overlay === 'history', 'history publishes'); assert.ok((await state()).history.some(entry => entry.url === base + '/other')); shell = defaultShell;
    console.log('PASS: history/password/tab metadata survive restart; selective clear stays inside the selected profile');
    await application.evaluate(({ app }) => { global.quitCount = 0; global.preventQuit = event => { global.quitCount++; event.preventDefault(); }; app.on('before-quit', global.preventQuit); });
    const ids = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').map(win => win.id));
    await application.evaluate(({ BrowserWindow }, ids) => { for (const id of ids) BrowserWindow.fromId(id).close(); }, ids);
    await poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length === 0), 'all windows close');
    assert.equal(application.process().exitCode, null); assert.equal(await application.evaluate(() => global.quitCount), 0);
    const reopenId = JSON.parse(fs.readFileSync(path.join(fixture, '.mini-browser', 'profiles.json'))).activeId;
    await application.evaluate(({ app }) => app.emit('second-instance', {}, [], '', {}));
    shell = await profileWindow(reopenId);
    await shell.locator('#menu-toggle').click(); await shell.overlay().locator('[data-ui="exit"]').click();
    await poll(() => application.evaluate(() => global.quitCount === 1), 'Exit requests app quit');
    await application.evaluate(({ app }) => app.removeListener('before-quit', global.preventQuit));
    console.log('PASS: closing the last window keeps the process alive, relaunch reopens a window, and menu Exit quits the app');
  } finally { if (application) { await application.evaluate(({ app }) => { if (global.preventQuit) app.removeListener('before-quit', global.preventQuit); }).catch(() => {}); await application.close(); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

