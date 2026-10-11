'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const executablePath = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'test-app', 'Mini Browser.exe'));
assert.ok(executablePath.startsWith(root + path.sep), 'Only launch a workspace build');
const uuid = randomUUID(), data = path.join(path.dirname(executablePath), '.mini-browser', 'tests', uuid);
const temp = path.join(root, '.cache', 'tmp'), results = path.join(root, 'test-results');
for (const directory of [data, temp, results]) fs.mkdirSync(directory, { recursive: true });
const png = fs.readFileSync(path.join(root, 'assets', 'icon.png'));
const liveSites = process.env.MINI_BROWSER_LIVE_ICONS === '1'
  ? [['https://www.youtube.com/', 'YouTube'], ['https://gmail.com/', 'Gmail'], ['https://chat.deepseek.com/', 'DeepSeek']]
    .filter(([url]) => !process.env.MINI_BROWSER_LIVE_ICON_URL || url === process.env.MINI_BROWSER_LIVE_ICON_URL) : [];
let application, shell, metadataRequests = 0, metadataCookies = [], iconRequests = 0;
let htmlFavicon = false, protectedRequests = 0;
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/assets/')) { iconRequests++; response.setHeader('Content-Type', 'image/png'); return response.end(png); }
  if (request.url === '/favicon.ico') {
    if (htmlFavicon) { response.setHeader('Content-Type','text/html'); return response.end('<link rel="apple-touch-icon" href="/assets/from-favicon-html.png">'); }
    response.writeHead(404); return response.end();
  }
  if (request.url === '/protected') { protectedRequests++; response.writeHead(403); return response.end('Forbidden'); }
  if (request.url === '/static/start') { response.writeHead(302, { Location: '/static/landing' }); return response.end(); }
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/static/landing') {
    metadataRequests++; metadataCookies.push(request.headers.cookie || '');
    return response.end('<link rel="icon" href="../assets/static.png"><title>Static metadata</title>');
  }
  if (request.url === '/live-start' && request.headers.cookie?.includes('private=one')) {
    response.writeHead(302, { Location: '/live-end' }); return response.end();
  }
  if (request.url === '/live-end') return response.end('<link rel="icon" href="/assets/live.png"><title>Live redirected page</title>');
  response.end('<title>No metadata</title>');
});
async function poll(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label);
}
const state = () => shell.evaluate(() => window.miniBrowser.getState());
const call = (method, ...args) => shell.evaluate(({ method, args }) => window.miniBrowser[method](...args), { method, args });
async function launch() {
  const env = { ...process.env, MINI_BROWSER_TEST: '1', MINI_BROWSER_TEST_PROFILE: uuid, TEMP: temp, TMP: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath, cwd: root, env });
  shell = await application.firstWindow(); await shell.waitForURL('mini://app/index.html');
  await poll(async () => !!(await state()).activeProfile, 'shell');
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(data, 'bookmarks.json'), JSON.stringify([{ url: base + '/static/start', title: 'Unvisited redirected bookmark' }]));
  try {
    await launch();
    await poll(async () => !!(await state()).bookmarks[0].icon, 'unvisited bookmark HTML icon');
    assert.ok(metadataRequests > 0); assert.ok(metadataCookies.every(value => value === ''));
    assert.equal((await state()).mode, 'welcome', 'discovery never navigates a tab');
    assert.equal((await state()).tabs.length, 1);
    await application.evaluate(async ({ session }, base) => session.fromPartition('test-pages').cookies.set({ url: base, name: 'private', value: 'one' }), base);
    assert.equal((await call('addBookmark', base + '/live-start', 'Redirected live icon')).ok, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await state()).bookmarks[1].icon, undefined, 'signed-out metadata has no icon');
    assert.equal((await call('navigate', base + '/live-start')).ok, true);
    await poll(async () => { const s = await state(); return s.url === base + '/live-end' && !s.loading && !!s.bookmarks[1].icon; }, 'redirected page updates original bookmark');
    await poll(async () => { const s = await state(); return !!s.tabs.find(tab => tab.id === s.activeTabId)?.icon; }, 'tab favicon');
    await poll(() => shell.evaluate(() => document.querySelector('#site-permissions svg use').getAttribute('href') === '#globe' && !document.querySelector('#site-permissions img')), 'browser security indicator');
    assert.deepEqual(await shell.evaluate(() => { const icon = document.querySelector('#bookmark-bar .bookmark-monogram img').getBoundingClientRect(); return { width:icon.width,height:icon.height }; }), {width:16,height:16});
    await call('home');
    await poll(() => shell.evaluate(() => [...document.querySelectorAll('#bookmarks-list .bookmark-monogram img')].length === 2
      && [...document.querySelectorAll('#bookmarks-list .bookmark-monogram img')].every(img => img.complete && img.naturalWidth > 0)), 'cached icons render');
    const before = iconRequests;
    await application.close(); application = null; await launch();
    assert.ok((await state()).bookmarks.every(item => item.icon));
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(iconRequests, before, 'restart uses cached PNGs');
    console.log('PASS: unvisited HTML metadata, relative paths, redirects, live-page alias updates, cookie-free fetching and cached icons after restart');
    htmlFavicon = true;
    await call('addBookmark', base + '/protected', 'HTML favicon fallback');
    await poll(async()=>!!(await state()).bookmarks.find(item=>item.url===base+'/protected')?.icon,'HTML favicon metadata');
    assert.equal(protectedRequests,0,'metadata in the favicon response avoids the forbidden page');
    htmlFavicon = false;
    console.log('PASS: HTML returned from /favicon.ico discovers a real image without loading the protected homepage');
    if (process.env.MINI_BROWSER_LIVE_ICONS === '1') {
      await application.evaluate(async ({ session }) => {
        const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        if (proxy) await session.fromPartition('test-pages').setProxy({ proxyRules: new URL(proxy).host });
      });
      for (const [url, name] of liveSites) {
        assert.equal((await call('addBookmark', url, name)).ok, true);
        await poll(async () => !!(await state()).bookmarks.find(item => item.url === url)?.icon, name + ' official live icon', 65000);
        console.log('PASS: ' + name + ' official website icon downloaded and decoded by Windows Electron');
      }
      await shell.screenshot({ path: path.join(results, 'official-bookmark-icons.png') });
    }
    const original = shell;
    await call('createProfile', 'Separate icons');
    await poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length === 2), 'second profile');
    const ids = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').map(window => window.id));
    shell = application.window(ids.find(id => id !== original.id)); await shell.waitForURL('mini://app/index.html');
    assert.deepEqual((await state()).bookmarks, []);
    assert.equal((await original.evaluate(() => window.miniBrowser.getState())).bookmarks.length, 3 + liveSites.length);
    console.log('PASS: bookmark icons remain in their own profile; no extra view or window is used for discovery');
  } finally {
    if (application) await application.close().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
