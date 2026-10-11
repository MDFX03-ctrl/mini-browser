'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BookmarkStore } = require('../src/bookmarks.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'installer-app', 'Mini Browser.exe'));
assert.ok(source.startsWith(root + path.sep), 'Only test project-local builds');
const fixture = path.join(root, '.cache', `p-${randomUUID().slice(0, 8)}`);
const temp = path.join(root, '.cache', 'tmp');
const results = path.join(root, 'test-results');
for (const dir of [fixture, temp, results]) fs.mkdirSync(dir, { recursive: true });
fs.cpSync(path.dirname(source), fixture, { recursive: true, filter: (file) => {
  const relative = path.relative(path.dirname(source), file);
  return relative.split(path.sep)[0] !== '.mini-browser' && relative !== path.join('resources', 'installed.flag');
} });
// No installed.flag: this fixture uses real persistent partitions in its own
// portable data directory. Nothing under the user's AppData is opened.
const data = path.join(fixture, '.mini-browser');
fs.mkdirSync(data, { recursive: true });
new BookmarkStore(data).add('https://example.com/', 'Legacy bookmark');
const registry = path.join(data, 'profiles.json');
let application;
let shell;
let cacheHits = 0;
let browserErrors = '';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/login') {
    response.setHeader('Set-Cookie', `account=${url.searchParams.get('user')}; HttpOnly; Max-Age=3600; SameSite=Lax; Path=/`);
    return response.end('signed in');
  }
  if (url.pathname === '/who') return response.end(request.headers.cookie || '');
  if (url.pathname === '/cached') {
    response.setHeader('Cache-Control', 'public, max-age=3600');
    cacheHits++;
    return response.end(`cached-response-${cacheHits}`);
  }
  if (url.pathname === '/sw.js') {
    response.setHeader('Content-Type', 'application/javascript');
    return response.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));");
  }
  if (url.pathname === '/slow') {
    response.setHeader('Content-Type', 'text/html');
    response.write('<title>In flight</title>');
    const timer = setTimeout(() => response.end('finished'), 10000);
    response.on('close', () => clearTimeout(timer));
    return;
  }
  if (url.pathname === '/download') {
    response.setHeader('Content-Disposition', 'attachment; filename="blocked.txt"');
    return response.end('blocked');
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Profile fixture</title><h1>Profile fixture</h1>');
});

async function poll(check, message, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}
const state = () => shell.evaluate(() => window.miniBrowser.getState());
const call = (method, ...args) => shell.evaluate(async ({ method, args }) => window.miniBrowser[method](...args), { method, args });
async function remote(code) {
  let timer;
  try {
    return await Promise.race([application.evaluate(({ BrowserWindow }, { expression, id }) =>
      BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[0].webContents.executeJavaScript(expression, true), { expression: code, id: shell.id }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Remote storage operation timed out: ' + code.slice(0, 100))), 20000);
    })]);
  } finally { clearTimeout(timer); }
}
async function launch() {
  const env = { ...process.env, MINI_BROWSER_TEST: '0', TEMP: temp, TMP: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: path.join(fixture, 'Mini Browser.exe'), args: [], cwd: root, env });
  application.process().stderr.on('data', (chunk) => { browserErrors += chunk.toString(); });
  shell = await application.firstWindow();
  await shell.waitForURL('mini://app/index.html');
  await poll(async () => !!(await state()).activeProfile, 'shell ready');
  const downloadDirectory = path.join(fixture, 'downloads'); fs.mkdirSync(downloadDirectory, { recursive: true });
  await application.evaluate(({ app }, directory) => app.setPath('downloads', directory), downloadDirectory);
  await poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'app window is shown');
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), data);
}
async function navigate(url) {
  assert.equal((await call('navigate', url)).ok, true);
  await poll(async () => { const s = await state(); return s.url === url && !s.loading && s.mode === 'page'; }, 'page load');
}
async function writeStorage(base, value) {
  const cached = await remote(`(async () => {
    const value = ${JSON.stringify(value)};
    window.storageStage = 'login';
    await fetch('/login?user=' + value);
    window.storageStage = 'DOM storage';
    localStorage.setItem('owner', value);
    sessionStorage.setItem('owner', value);
    window.storageStage = 'IndexedDB';
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('profile-db', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('values');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('values', 'readwrite');
        transaction.objectStore('values').put(value, 'owner');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    window.storageStage = 'CacheStorage';
    await (await caches.open('profile-cache')).put('/stored', new Response(value));
    window.storageStage = 'HTTP cache';
    return (await fetch('/cached')).text();
  })()`);
  // Let the main-process debugger return before waiting for worker startup.
  await remote(`window.workerReady = false; window.storageStage = 'service worker registration';
    navigator.serviceWorker.register('/sw.js?owner=' + ${JSON.stringify(value)})
      .then(() => navigator.serviceWorker.ready).then(() => { window.workerReady = true; })
      .catch(error => { window.workerError = error.message; }); 'started';`);
  await poll(async () => {
    const result = await remote('({ ready: window.workerReady, error: window.workerError })');
    if (result.error) throw new Error(result.error);
    return result.ready;
  }, 'service worker activation', 25000);
  return cached;
}
async function readStorage() {
  return remote(`(async () => {
    const names = await indexedDB.databases();
    const indexed = names.some(item => item.name === 'profile-db') ? await new Promise((resolve, reject) => {
      const request = indexedDB.open('profile-db');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('values');
        const value = transaction.objectStore('values').get('owner');
        value.onsuccess = () => resolve(value.result || null);
        transaction.oncomplete = () => db.close();
      };
    }) : null;
    const cache = await caches.match('/stored');
    const workers = await navigator.serviceWorker.getRegistrations();
    return { cookie: await (await fetch('/who')).text(), local: localStorage.getItem('owner'),
      session: sessionStorage.getItem('owner'), indexed, cache: cache ? await cache.text() : null,
      workers: workers.map(worker => worker.active?.scriptURL).filter(Boolean) };
  })()`);
}

async function windowFor(profileId, exclude = []) {
  let id;
  await poll(async () => {
    id = await application.evaluate(async ({ BrowserWindow }, { profileId, exclude }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (exclude.includes(win.id) || win.webContents.getURL() !== 'mini://app/index.html') continue;
        const state = await win.webContents.executeJavaScript('window.miniBrowser?.getState()');
        if (state?.activeProfile?.id === profileId) return win.id;
      }
    }, { profileId, exclude });
    return !!id;
  }, 'profile window');
  return application.window(id);
}
const count = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
async function details(target = shell) {
  return application.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id);
    return { bounds: win.getBounds(), visible: win.isVisible(), views: win.contentView.children.filter(view => !view.browserChrome).map(v => ({ id: v.webContents.id, bounds: v.getBounds(), visible: v.getVisible() })) };
  }, target.id);
}
async function dragTab(source, tabId, point, cancel = false) {
  const result = await source.evaluate(id => window.miniBrowser.startTabDrag(id), tabId);
  assert.equal(result.ok, true);
  await application.evaluate(({ screen }, point) => { screen.getCursorScreenPoint = () => point; }, point);
  return source.evaluate(({ token, cancel }) => window.miniBrowser.endTabDrag(token, cancel), { token: result.token, cancel });
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pageUrl = base + '/';
  try {
    await launch();
    const original = shell;
    assert.equal((await state()).activeProfile.id, 'default');
    assert.equal((await state()).bookmarks[0].title, 'Legacy bookmark');
    assert.equal(await application.evaluate(({ BrowserWindow, session }, id) => BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[0].webContents.session === session.fromPartition('persist:pages'), shell.id), true);
    await navigate(pageUrl);
    const firstCache = await writeStorage(base, 'default');
    const initial = await details();
    await shell.locator('#profile-toggle').click();
    await poll(async () => (await state()).overlay === 'profiles', 'floating profile picker');
    let layout = await details();
    assert.equal(layout.views[0].visible, true);
    assert.equal((await state()).panelHeight, 0);
    assert.deepEqual(layout.views[0].bounds, initial.views[0].bounds);
    assert.deepEqual(layout.bounds, initial.bounds);
    await shell.overlay().locator('#profile-new').click();
    await shell.overlay().locator('#profile-name').fill('Work');
    await shell.overlay().locator('#profile-form button[type=submit]').click();
    await poll(async () => (await state()).profiles.length === 2 && !(await state()).profilePanelOpen, 'Work creation');
    const work = (await state()).profiles.find(p => p.id !== 'default');
    const workShell = await windowFor(work.id);
    assert.equal(await count(), 2);
    assert.equal((await state()).activeProfile.id, 'default');
    assert.equal((await details()).views[0].id, initial.views[0].id);
    assert.equal((await state()).url, pageUrl);
    assert.equal((await readStorage()).session, 'default');
    shell = workShell;
    assert.equal((await state()).mode, 'welcome');
    assert.deepEqual((await state()).bookmarks, []);
    await navigate(pageUrl);
    assert.deepEqual(await readStorage(), { cookie: '', local: null, session: null, indexed: null, cache: null, workers: [] });
    const workCache = await writeStorage(base, 'work');
    assert.notEqual(workCache, firstCache);
    await call('addBookmark', pageUrl, 'Work bookmark');
    const workState = await state();
    shell = original;
    const originalState = await state();
    await shell.locator('#profile-toggle').click();
    assert.equal(await shell.overlay().evaluate(() => document.querySelectorAll('.profile-card').length), 2);
    const registryBefore = fs.readFileSync(registry, 'utf8');
    const focusedBefore = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id);
    await shell.overlay().locator(`.profile-card[data-id="${work.id}"] .profile-open`).click();
    await poll(async () => !(await state()).profilePanelOpen, 'open profile only dismisses picker');
    assert.equal(await count(), 2);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id), focusedBefore);
    assert.equal(fs.readFileSync(registry, 'utf8'), registryBefore);
    assert.deepEqual((await state()).tabs, originalState.tabs);
    assert.deepEqual(await workShell.evaluate(() => window.miniBrowser.getState()).then(s => s.tabs), workState.tabs);
    const restored = await readStorage();
    assert.match(restored.cookie, /account=default/);
    assert.equal(restored.session, 'default');
    assert.equal(restored.local, 'default'); assert.equal(restored.indexed, 'default'); assert.equal(restored.cache, 'default');
    assert.ok(restored.workers.every(url => url.endsWith('owner=default')));
    assert.equal(await remote("fetch('/cached').then(r => r.text())"), firstCache);
    shell = workShell;
    assert.match((await readStorage()).cookie, /account=work/);
    assert.equal((await readStorage()).session, 'work');
    console.log('PASS: independent simultaneous accounts and all storage types; open-profile selection changes no window, focus, page, or registry');

    await shell.locator('#profile-toggle').click();
    await shell.overlay().locator(`.profile-card[data-id="${work.id}"] .profile-rename`).click();
    await shell.overlay().locator('#profile-name').fill('Business');
    await shell.overlay().locator('#profile-form button[type=submit]').click();
    await poll(async () => (await state()).activeProfile.name === 'Business', 'rename');
    assert.equal((await call('reorderProfiles', [work.id, 'default'])).ok, true);
    await call('addBookmark', base + '/two', 'Second');
    assert.equal((await call('reorderBookmarks', [base + '/two', pageUrl])).ok, true);
    assert.equal((await call('reorderProfiles', [work.id, work.id])).ok, false);
    assert.equal((await call('reorderBookmarks', [pageUrl, pageUrl])).ok, false);
    await shell.locator('#profile-toggle').click();
    await shell.screenshot({ path: path.join(results, 'profiles-panel.png') });
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setSize(360, 280), shell.id);
    await poll(async () => { const d = await details(); return d.views[0].bounds.height >= 64 && d.views[0].bounds.y === (await state()).chromeHeight + (await state()).panelHeight; }, 'small picker keeps usable page');
    assert.equal((await details()).views[0].visible, true);
    await shell.screenshot({ path: path.join(results, 'profiles-small.png') });
    await call('profilePanel', false);
    await application.evaluate(({ BrowserWindow }, id) => { const win = BrowserWindow.fromId(id); win.setSize(480,640); win.focus(); }, shell.id);
    await application.close(); application = null;
    await launch();
    assert.deepEqual((await state()).activeProfile, { id: work.id, name: 'Business' });
    assert.deepEqual((await state()).profiles.map(p => p.id), [work.id, 'default']);
    assert.deepEqual((await state()).bookmarks.map(b => b.url), [base + '/two', pageUrl]);
    await navigate(pageUrl);
    const restarted = await readStorage();
    assert.match(restarted.cookie, /account=work/); assert.equal(restarted.local, 'work');
    assert.equal(restarted.indexed, 'work'); assert.equal(restarted.cache, 'work');
    assert.ok(restarted.workers.some(url => url.endsWith('owner=work')));
    console.log('PASS: vertical picker floats over the unchanged website; names and profile/bookmark order survive restart with account data');

    const business = shell;
    assert.equal((await call('switchProfile', 'default')).ok, true);
    const defaultShell = await windowFor('default');
    shell = defaultShell; await navigate(pageUrl);
    await remote("sessionStorage.setItem('moving','keep'); document.body.append(Object.assign(document.createElement('input'),{id:'note',value:'Keep this form'})); window.movedCount=42; history.pushState({kept:true},'', '/history');");
    const movingId = (await state()).activeTabId;
    const movingContent = (await details()).views[0].id;
    await call('newTab'); await navigate(base + '/two');
    const desktop = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    await application.evaluate(({ BrowserWindow }, { a, b, desktop }) => {
      BrowserWindow.fromId(a).setBounds({ x: desktop.x + 10, y: desktop.y + 10, width: 400, height: 360 });
      BrowserWindow.fromId(b).setBounds({ x: desktop.x + 450, y: desktop.y + 10, width: 400, height: 360 });
    }, { a: defaultShell.id, b: business.id, desktop });
    const outside = { x: desktop.x + 30, y: desktop.y + desktop.height - 10 };
    assert.equal((await dragTab(defaultShell, movingId, outside, true)).ok, true);
    assert.equal(await count(), 2);
    assert.equal((await dragTab(defaultShell, movingId, outside)).ok, true);
    const detached = await windowFor('default', [defaultShell.id]);
    assert.equal(await count(), 3);
    assert.equal((await details(detached)).views[0].id, movingContent);
    const preserved = await application.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("({ note: document.getElementById('note').value, session: sessionStorage.getItem('moving'), count: window.movedCount })"), movingContent);
    assert.deepEqual(preserved, { note: 'Keep this form', session: 'keep', count: 42 });
    assert.equal((await detached.evaluate(() => window.miniBrowser.getState())).canGoBack, true);
    await application.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.title='Transferred page'"), movingContent);
    await poll(async () => (await detached.evaluate(() => window.miniBrowser.getState())).title === 'Transferred page', 'transferred callbacks publish to the new owner');
    let b = (await details(business)).bounds;
    assert.equal((await dragTab(detached, movingId, { x: b.x + 30, y: b.y + 20 })).ok, false);
    assert.equal((await details(detached)).views[0].id, movingContent);
    await detached.evaluate(() => window.miniBrowser.addBookmark('https://example.org/', 'Shared bookmark'));
    assert.ok((await state()).bookmarks.some(item => item.title === 'Shared bookmark'));
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), defaultShell.id);
    b = (await details(defaultShell)).bounds;
    const finalDrag = await detached.evaluate(id => window.miniBrowser.startTabDrag(id), movingId);
    await application.evaluate(({ screen }, point) => { screen.getCursorScreenPoint = () => point; }, { x: b.x + 30, y: b.y + 20 });
    // The source shell is destroyed when its final tab moves; observe the destination.
    await detached.evaluate(token => { window.miniBrowser.endTabDrag(token, false).catch(() => {}); }, finalDrag.token);
    await poll(async () => await count() === 2, 'last tab transfer closes empty window');
    assert.equal((await state()).activeTabId, movingId);
    assert.ok((await details()).views.some(v => v.id === movingContent));
    assert.equal(await application.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.movedCount'), movingContent), 42);
    console.log('PASS: detach and reattach retain the same live view, form and session storage; cancellation and cross-profile rejection; empty source window closes');

    shell = business;
    for (const address of ['file:///C:/Windows', 'mini://app/index.html', 'javascript:alert(1)', 'plain text']) assert.equal((await call('navigate', address)).ok, false);
    assert.equal(await remote('typeof require'), 'undefined'); assert.equal(await remote('typeof window.miniBrowser'), 'undefined');
    await remote("window.notificationResult = ''; Notification.requestPermission().then(value => window.notificationResult = value); 'requested'");
    await poll(async () => !!(await state()).permissionPrompt, 'notification permission prompt');
    await shell.locator('#permission-block').click();
    await poll(async () => await remote('window.notificationResult') === 'denied', 'notification blocked');
    await remote("location.href='/download'");
    await poll(async () => (await state()).downloads.some(item => item.state === 'completed'), 'download completes in its profile');
    await call('downloadsPanel', false);
    await call('navigate', base + '/slow');
    await poll(async () => (await state()).loading, 'in-flight request');
    // Delete an open profile from a surviving window and verify its views and data disappear.
    shell = defaultShell;
    assert.equal((await call('deleteProfile', work.id)).ok, true);
    assert.equal(await count(), 1);
    assert.equal(fs.existsSync(path.join(data, 'profiles', work.id, 'bookmarks.json')), false);
    const cleared = await application.evaluate(async ({ session }, id) => ({ cookies: await session.fromPartition(`persist:profile-${id}`).cookies.get({}), cache: await session.fromPartition(`persist:profile-${id}`).getCacheSize() }), work.id);
    assert.deepEqual(cleared, { cookies: [], cache: 0 });
    assert.equal((await call('deleteProfile', 'default')).ok, false);
    assert.equal((await call('switchProfile', work.id)).ok, false);
    await application.close(); application = null;
    await launch();
    assert.equal(fs.existsSync(path.join(data, 'session', 'Partitions', `profile-${work.id}`)), false);
    assert.equal(fs.existsSync(path.join(data, 'window.json')), true);
    await navigate(pageUrl); assert.match((await readStorage()).cookie, /account=default/);
    console.log('PASS: HTTP/HTTPS, sandbox, permissions and profile downloads; deletion cancels navigation, closes profile windows and clears only its data');
    // Deleting the sole open profile creates a surviving-profile window first.
    const lastDefault = shell;
    assert.equal((await call('createProfile', 'Keeper')).ok, true);
    const keeper = (await state()).profiles.find(p => p.id !== 'default');
    shell = await windowFor(keeper.id); await navigate(pageUrl);
    await writeStorage(base, 'keeper'); await call('addBookmark', pageUrl, 'Keeper');
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), lastDefault.id);
    // Invoke deletion from the active profile; its own shell closes before IPC returns.
    await shell.evaluate(id => { window.miniBrowser.deleteProfile(id).catch(() => {}); }, keeper.id);
    shell = await windowFor('default');
    await poll(async () => (await state()).profiles.length === 1, 'active deletion completes');
    assert.equal(await count(), 1);
    assert.equal((await state()).profiles.length, 1);
    console.log('PASS: deleting the only open profile opens a surviving profile without exiting the app');
  } catch (error) {
    console.error('Browser stderr:', browserErrors);
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

