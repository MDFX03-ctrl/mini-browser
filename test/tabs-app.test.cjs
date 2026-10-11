'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executablePath = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'test-app', 'Mini Browser.exe'));
assert.ok(executablePath.startsWith(root + path.sep), 'Only test a project-local build');
const temp = path.join(root, '.cache', 'tmp');
const results = path.join(root, 'test-results');
for (const dir of [temp, results]) fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, MINI_BROWSER_TEST: '1', MINI_BROWSER_TEST_PROFILE: randomUUID(), TEMP: temp, TMP: temp };
delete env.ELECTRON_RUN_AS_NODE;
let application;
let shell;
let originalPointer;
const server = http.createServer((request, response) => {
  if (request.url === '/slow') {
    response.setHeader('Content-Type', 'text/html');
    response.write('<title>Slow tab</title>');
    const timer = setTimeout(() => response.end('finished'), 10000);
    response.on('close', () => clearTimeout(timer));
    return;
  }
  if (request.url === '/download') {
    response.setHeader('Content-Disposition', 'attachment; filename="blocked.txt"');
    return response.end('blocked');
  }
  if (request.url === '/headers') {
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify({ userAgent: request.headers['user-agent'], languages: request.headers['accept-language'] }));
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>${request.url === '/b' ? 'Tab B' : 'Tab A'}</title>
    <style>body{margin:20px;font:16px Segoe UI;background:#f0f3ed;color:#345844}video{width:320px;max-width:100%;background:#173d2c}video:fullscreen{width:100%;height:100%}</style>
    <h1>${request.url === '/b' ? 'Tab B' : 'Tab A'}</h1><input id="note" placeholder="Keep a note here">
    <a id="popup" href="/b" target="_blank">Open tab</a><a id="next" href="/b">Next</a>
    <video id="video" controls muted playsinline></video><button id="video-fullscreen" onclick="document.getElementById('video').requestFullscreen()">Fullscreen video</button>`);
});
async function poll(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const state = () => shell.evaluate(() => window.miniBrowser.getState());
const call = async (method, ...args) => {
  const previous = (await state()).activeTabId;
  const result = await shell.evaluate(({ method, args }) => window.miniBrowser[method](...args), { method, args });
  if (method === 'newTab') await poll(async () => (await state()).activeTabId !== previous, 'new tab publishes');
  if (method === 'selectTab') await poll(async () => (await state()).activeTabId === args[0], 'tab selection publishes');
  return result;
};
async function remote(code, id, gesture = true) {
  const s = await state();
  const index = s.tabs.findIndex((tab) => tab.id === (id || s.activeTabId));
  assert.ok(index >= 0);
  return application.evaluate(({ BrowserWindow }, { code, index, gesture, windowId }) =>
    BrowserWindow.fromId(windowId).contentView.children.filter(view => !view.browserChrome)[index].webContents.executeJavaScript(code, gesture), { code, index, gesture, windowId: shell.id });
}
async function popupChecks(base) {
  const expectedUA = await application.evaluate(() => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
  assert.equal(await remote('navigator.userAgent'), expectedUA);
  const headers = await remote("fetch('/headers').then(response => response.json())");
  assert.equal(headers.userAgent, expectedUA);
  assert.match(headers.languages, /^en-US,en(?:;q=0\.9)?$/);
  // Intercept HTTPS only in the test partition: no certificate bypass or real login.
  await application.evaluate(({ BrowserWindow }, id) => {
    const session = BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[0].webContents.session;
    session.protocol.handle('https', request => new Response(
      request.url.startsWith('https://popup.mini.test/') ? '<!doctype html><title>HTTPS login popup</title><script>if(window.opener) window.opener.postMessage({type:"popup-ready",userAgent:navigator.userAgent}, "*");</script>' : 'Not found',
      { headers: { 'Content-Type': 'text/html' } }));
  }, shell.id);
  await key('Shift');
  const count = (await state()).tabs.length;
  assert.equal(await remote(`(() => {
    window.popupMessages = [];
    addEventListener('message', event => { if (event.origin === 'https://popup.mini.test') window.popupMessages.push(event.data); });
    window.authPopup = window.open('https://popup.mini.test/login', 'auth', 'width=420,height=500,nodeIntegration=yes,contextIsolation=no,sandbox=no,webSecurity=no');
    return window.authPopup !== null;
  })()`), true, 'window.open returns a real window proxy');
  await poll(() => application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').some(win => win.getParentWindow()?.id === id && !win.webContents.isLoading()), shell.id), 'HTTPS popup loads');
  const popup = await application.evaluate(({ BrowserWindow }, id) => {
    const parent = BrowserWindow.fromId(id), child = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').find(win => win.getParentWindow() === parent);
    const preferences = child.webContents.getLastWebPreferences();
    return { id: child.id, sessionMatches: child.webContents.session === parent.contentView.children.filter(view => !view.browserChrome)[0].webContents.session,
      sandbox: preferences.sandbox, isolation: preferences.contextIsolation, security: preferences.webSecurity,
      node: preferences.nodeIntegration, preload: preferences.preload, menuVisible: child.isMenuBarVisible(), size: child.getSize() };
  }, shell.id);
  assert.equal(popup.sessionMatches, true); assert.equal(popup.sandbox, true); assert.equal(popup.isolation, true);
  assert.equal(popup.security, true); assert.equal(popup.node, false); assert.equal(popup.preload, undefined);
  assert.equal(popup.menuVisible, false); assert.ok(popup.size[0] <= 800 && popup.size[1] <= 900);
  assert.equal((await state()).tabs.length, count);
  await poll(async () => (await remote('window.popupMessages')).some(message => message.type === 'popup-ready'), 'popup can message its opener');
  assert.equal((await remote('window.popupMessages'))[0].userAgent, expectedUA, 'initial popup scripts see Chrome UA');
  const popupContent = (code) => application.evaluate(({ BrowserWindow }, { id, code }) => BrowserWindow.fromId(id).webContents.executeJavaScript(code, true), { id: popup.id, code });
  assert.equal(await popupContent('navigator.userAgent'), expectedUA);
  assert.equal(await popupContent('typeof require'), 'undefined');
  assert.equal(await popupContent('typeof window.miniBrowser'), 'undefined');
  for (const url of ['file:///C:/Windows', 'mini://app/index.html', 'javascript:void(0)']) {
    assert.equal(await remote(`window.open(${JSON.stringify(url)}, '_blank', 'width=400,height=400') === null`), true);
    assert.equal(await popupContent(`window.open(${JSON.stringify(url)}, '_blank', 'width=400,height=400') === null`), true);
  }
  await poll(async () => /Only http and https/.test((await state()).notice), 'blocked navigation notice');
  assert.equal(await shell.evaluate(() => window.open('https://popup.mini.test/shell', '_blank', 'width=400,height=400') === null), true, 'trusted shell still denies popups');
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), popup.id);
  await poll(async () => await remote('window.authPopup.closed'), 'opener observes popup closing');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length), 1);
  assert.equal((await state()).url, base + '/a');
  console.log('PASS: HTTPS popups return a live opener-connected window in the same session; secure preferences, Chrome UA/languages, and shell/protocol restrictions');
}
async function popupCloseCheck() {
  await navigate('https://popup.mini.test/opener');
  await key('Shift');
  assert.equal(await remote("window.authPopup = window.open('https://popup.mini.test/login', 'auth-close', 'width=420,height=500'); window.authPopup !== null"), true);
  await poll(() => application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').some(win => win.getParentWindow()?.id === id && !win.webContents.isLoading()), shell.id), 'final popup loads');
  const popup = await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').find(win => win.getParentWindow()?.id === id).id, shell.id);
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.executeJavaScript('onbeforeunload = () => false; "ready";'), popup);
  // A test-only empty window keeps Electron alive while we inspect parent cleanup.
  const keeper = await application.evaluate(({ BrowserWindow }) => new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }).id);
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), shell.id);
  await poll(() => application.evaluate(({ BrowserWindow }, { parent, popup, keeper }) => !BrowserWindow.fromId(parent) && !BrowserWindow.fromId(popup) && !!BrowserWindow.fromId(keeper), { parent: shell.id, popup, keeper }), 'closing opener window destroys its popup');
  console.log('PASS: closing the opener browser closes its popup, including a page with beforeunload');
}
async function key(keyCode, modifiers = [], shellTarget = false) {
  const s = await state();
  const index = s.tabs.findIndex((tab) => tab.id === s.activeTabId);
  await application.evaluate(({ BrowserWindow }, { keyCode, modifiers, index, shellTarget }) => {
    const win = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0];
    const content = shellTarget ? win.webContents : win.contentView.children.filter(view => !view.browserChrome)[index].webContents;
    content.focus();
    content.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    content.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { keyCode, modifiers, index, shellTarget });
}
async function navigate(url) {
  assert.equal((await call('navigate', url)).ok, true);
  await poll(async () => { const s = await state(); return s.url === url && s.mode === 'page' && !s.loading; }, 'page load');
}
function movePointer(point) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'move-pointer.ps1'), String(point.x), String(point.y)],
    { cwd: root, env, windowsHide: true, stdio: 'pipe' });
}
async function pointAt(point) {
  if (process.env.MINI_BROWSER_POINTER_SMOKE === '1') movePointer(point);
  else await application.evaluate(({ screen }, point) => { screen.getCursorScreenPoint = () => point; }, point);
}
async function windowDetails() {
  const s = await state();
  const index = s.tabs.findIndex((tab) => tab.id === s.activeTabId);
  return application.evaluate(({ BrowserWindow }, index) => {
    const win = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0];
    return { fullscreen: win.isFullScreen(), bounds: win.getBounds(), content: win.getContentBounds(), view: win.contentView.children.filter(view => !view.browserChrome)[index].getBounds() };
  }, index);
}
async function assertWebsiteFillsWindow() {
  await poll(async () => {
    const d = await windowDetails();
    return !(await state()).chromeVisible && d.view.y === 0 && d.view.width === d.content.width && d.view.height === d.content.height;
  }, 'website fills the floating window');
  assert.equal((await state()).chromeVisible, false);
  assert.equal(await shell.evaluate(() => document.getElementById('chrome').hidden), true);
}
async function startVideo() {
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0];
    if (win.isMinimized()) win.restore();
    win.showInactive();
  });
  await remote(`(async () => {
    const video = document.getElementById('video');
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#345844'; ctx.fillRect(0,0,640,360);
    ctx.fillStyle = '#ffffff'; ctx.font = '32px sans-serif'; ctx.fillText('Mini Browser video test', 90,180);
    window.testStream = canvas.captureStream(10); video.srcObject = window.testStream;
    await video.play(); return video.readyState;
  })()`);
  await remote(`(() => { window.fullscreenTrace = [];
    document.addEventListener('fullscreenchange', () => window.fullscreenTrace.push(['change', document.fullscreenElement?.id]));
    document.addEventListener('fullscreenerror', () => window.fullscreenTrace.push(['error', document.fullscreenElement?.id]));
    document.getElementById('video').requestFullscreen().then(() => window.fullscreenTrace.push(['resolved'])).catch(error => window.fullscreenTrace.push(['rejected', error.message]));
  })()`);
  try {
    await poll(async () => (await state()).videoFullscreen && await remote('document.fullscreenElement?.id') === 'video', 'video fullscreen entry');
  } catch (error) {
    console.error('Fullscreen diagnostics:', await remote('({ trace: window.fullscreenTrace, focused: document.hasFocus(), fullscreen: document.fullscreenElement?.id, visibility: document.visibilityState })'), await windowDetails());
    throw error;
  }
  assert.equal(await remote("document.fullscreenElement?.id"), 'video');
  await assertWebsiteFillsWindow();
}
async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    application = await electron.launch({ executablePath, cwd: root, env });
    shell = await application.firstWindow();
    await shell.waitForURL('mini://app/index.html');
    await application.evaluate(({ BrowserWindow }, realPointer) => {
      const win = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0];
      win.showInactive();
      if (realPointer) win.focus();
      else win.setIgnoreMouseEvents(true);
    }, process.env.MINI_BROWSER_POINTER_SMOKE === '1');
    originalPointer = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());
    const first = (await state()).activeTabId;
    await navigate(`${base}/a`);
    await popupChecks(base);
    await remote("document.cookie='shared=default;path=/'; localStorage.setItem('shared','default'); sessionStorage.setItem('owner','A'); document.getElementById('note').value='Keep A';");
    await shell.locator('#new-tab').click();
    await poll(async () => (await state()).activeTabId !== first, 'new tab publishes');
    const second = (await state()).activeTabId;
    assert.notEqual(first, second);
    assert.equal((await state()).mode, 'welcome');
    await navigate(`${base}/b`);
    assert.match(await remote('document.cookie'), /shared=default/);
    assert.equal(await remote("localStorage.getItem('shared')"), 'default');
    assert.equal(await remote("sessionStorage.getItem('owner')"), null);
    await remote("sessionStorage.setItem('owner','B'); document.getElementById('note').value='Keep B';");
    await call('selectTab', first);
    assert.equal((await state()).url, `${base}/a`);
    assert.equal(await remote("sessionStorage.getItem('owner')"), 'A');
    assert.equal(await remote("document.getElementById('note').value"), 'Keep A');
    await remote("document.getElementById('next').click();");
    await poll(async () => (await state()).url === `${base}/b` && !(await state()).loading, 'first tab follows link');
    await call('back');
    await poll(async () => (await state()).url === `${base}/a` && !(await state()).loading, 'first tab back');
    await remote("document.title='Background B';", second);
    assert.equal((await state()).title, 'Tab A');
    await poll(async () => (await state()).tabs.find(tab => tab.id === second).title === 'Background B', 'background title publishes');
    await call('selectTab', second);
    assert.equal(await remote("document.getElementById('note').value"), 'Keep B');
    assert.equal((await state()).canGoBack, false);
    console.log('PASS: independent tab views, forms, titles, history, and session storage; cookies/local storage shared only within the profile');

    await key('Shift');
    await remote("document.getElementById('popup').click();");
    await poll(async () => (await state()).tabs.length === 3 && !(await state()).loading, 'popup opens a tab');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length), 1);
    await key('T', ['control']);
    await poll(async () => (await state()).tabs.length === 4, 'Ctrl+T');
    await key('W', ['control'], true);
    await poll(async () => (await state()).tabs.length === 3, 'Ctrl+W');
    await key('1', ['control']);
    await poll(async () => (await state()).activeTabId === first, 'Ctrl+1');
    await key('Tab', ['control']);
    await poll(async () => (await state()).activeTabId === second, 'Ctrl+Tab');
    await call('navigate', `${base}/slow`);
    await poll(async () => (await state()).loading, 'slow background tab');
    await call('selectTab', first);
    const closingIndex = (await state()).tabs.findIndex((tab) => tab.id === second);
    const closingContent = await application.evaluate(({ BrowserWindow }, index) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0].contentView.children.filter(view => !view.browserChrome)[index].webContents.id, closingIndex);
    assert.equal((await call('closeTab', second)).ok, true);
    assert.equal(await application.evaluate(({ webContents }, id) => webContents.fromId(id) === undefined, closingContent), true);
    assert.equal((await state()).activeTabId, first);
    assert.equal((await state()).mode, 'page');
    await shell.screenshot({ path: path.join(results, 'tabs-toolbar.png') });
    console.log('PASS: new-tab links, add/select/close shortcuts, background load cancellation, and no extra windows');

    // Profile windows and transfers are exercised by profiles-app.test.cjs.
    for (const tab of (await state()).tabs.slice(1)) await call('closeTab', tab.id);
    await navigate(base + '/a');
    await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0]; win.setSize(480, 320); win.showInactive(); });
    if (process.env.MINI_BROWSER_POINTER_SMOKE === '1') await call('pin');
    const initialPin = (await state()).pinned;
    let previousBounds;
    await poll(async () => {
      const currentBounds = JSON.stringify((await windowDetails()).bounds);
      const settled = currentBounds === previousBounds;
      previousBounds = currentBounds;
      return settled;
    }, 'window size settles after native DPI changes');
    let normalBounds = (await windowDetails()).bounds;
    await pointAt({ x: normalBounds.x + Math.floor(normalBounds.width / 2), y: normalBounds.y + Math.floor(normalBounds.height / 2) });
    await shell.evaluate(() => window.miniBrowser.toggleUI());
    await assertWebsiteFillsWindow();
    assert.deepEqual((await windowDetails()).bounds, normalBounds);
    assert.equal((await windowDetails()).fullscreen, false);
    assert.equal((await state()).pinned, initialPin);
    let d = await windowDetails();
    await pointAt({ x: d.content.x + Math.floor(d.content.width / 2), y: d.content.y + 1 });
    await poll(async () => (await state()).chromeVisible, 'pointer at top edge reveals controls');
    assert.equal((await windowDetails()).view.y, (await state()).chromeHeight);
    await shell.screenshot({ path: path.join(results, 'fullscreen-controls.png') });
    // Simulated typing needs a focused native window to deliver focus/blur events.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0].focus());
    await key('L', ['control']);
    await pointAt({ x: d.content.x + Math.floor(d.content.width / 2), y: d.content.y + Math.floor(d.content.height / 2) });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal((await state()).chromeVisible, true, 'typing keeps controls visible');
    await shell.evaluate(() => document.getElementById('address').blur());
    await poll(async () => !(await state()).chromeVisible, 'controls hide after leaving the edge');
    await assertWebsiteFillsWindow();
    await key('Escape');
    await poll(async () => !(await state()).hideUI && (await state()).chromeVisible, 'Escape shows controls');
    assert.deepEqual((await windowDetails()).bounds, normalBounds);
    console.log('PASS: hiding UI preserves the small window and pin; edge input reveals/hides all controls, typing holds them open, and Escape restores them');


    await startVideo();
    assert.deepEqual((await windowDetails()).bounds, normalBounds);
    assert.equal((await windowDetails()).fullscreen, false);
    const videoRect = await remote(`(() => { const rect = document.getElementById('video').getBoundingClientRect(); return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight}; })()`);
    assert.deepEqual([videoRect.x, videoRect.y, videoRect.width, videoRect.height], [0, 0, videoRect.viewportWidth, videoRect.viewportHeight]);
    await application.evaluate(async ({ BrowserWindow }, file) => {
      const fs = process.mainModule.require('node:fs');
      fs.writeFileSync(file, (await BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0].contentView.children.filter(view => !view.browserChrome)[0].webContents.capturePage()).toPNG());
    }, path.join(results, 'floating-video.png'));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0].setSize(560, 360));
    await assertWebsiteFillsWindow();
    assert.equal(await remote('document.fullscreenElement?.id'), 'video');
    assert.equal((await windowDetails()).fullscreen, false);
    normalBounds = (await windowDetails()).bounds;
    d = await windowDetails();
    // Control the edge input so normal mouse use cannot interrupt this check.
    await application.evaluate(({ screen }, point) => {
      screen.testOriginalCursor = screen.getCursorScreenPoint;
      screen.getCursorScreenPoint = () => point;
    }, { x: d.content.x + Math.floor(d.content.width / 2), y: d.content.y + 1 });
    await poll(async () => (await state()).chromeVisible, 'video fullscreen edge reveal');
    assert.equal(await remote('document.fullscreenElement?.id'), 'video');
    await application.evaluate(({ screen }, point) => { screen.getCursorScreenPoint = () => point; },
      { x: d.content.x + Math.floor(d.content.width / 2), y: d.content.y + Math.floor(d.content.height / 2) });
    await poll(async () => !(await state()).chromeVisible, 'video fullscreen hides controls again');
    await call('toggleUI');
    await poll(async () => (await state()).chromeVisible, 'controls publish');
    assert.equal(await remote('document.fullscreenElement?.id'), 'video', 'the window icon only changes browser UI, keeping the video expanded');
    await call('toggleUI');
    await assertWebsiteFillsWindow();
    await call('toggleUI');
    await poll(async () => (await state()).chromeVisible, 'controls publish');
    assert.equal(await remote('document.fullscreenElement?.id'), 'video');
    await application.evaluate(({ screen }) => { screen.getCursorScreenPoint = screen.testOriginalCursor; delete screen.testOriginalCursor; });
    await key('Escape');
    await poll(async () => !(await state()).videoFullscreen && !(await windowDetails()).fullscreen, 'Escape leaves video fullscreen');
    assert.equal(await remote('Boolean(document.fullscreenElement)'), false);
    assert.deepEqual((await windowDetails()).bounds, normalBounds);
    await key('H', ['control', 'shift']);
    await assertWebsiteFillsWindow();
    await startVideo();
    await key('Escape');
    await poll(async () => !(await state()).videoFullscreen, 'video exits inside hidden-UI mode');
    assert.equal((await state()).hideUI, true);
    assert.equal((await windowDetails()).fullscreen, false);
    await assertWebsiteFillsWindow();
    await key('Escape');
    await poll(async () => !(await state()).hideUI && (await state()).chromeVisible, 'second Escape restores controls');
    await startVideo();
    await call('newTab');
    await poll(async () => !(await state()).videoFullscreen && !(await windowDetails()).fullscreen, 'tab change leaves video fullscreen');
    assert.equal((await state()).mode, 'welcome');
    console.log('PASS: video fills and resizes with the small floating window; HTML fullscreen never enlarges it, and exit restores the previous UI mode');

    await navigate(`${base}/a`);
    await remote(`new Promise((resolve) => {
      const frame = document.createElement('iframe'); frame.id = 'embed'; frame.allowFullscreen = true;
      frame.src = ${JSON.stringify(base + '/b')}; frame.onload = () => resolve(true); document.body.append(frame);
    })`);
    await remote(`(async () => {
      const frame = document.getElementById('embed'); const video = frame.contentDocument.getElementById('video');
      const canvas = frame.contentDocument.createElement('canvas'); canvas.width=160; canvas.height=90;
      canvas.getContext('2d').fillRect(0,0,160,90); video.srcObject = canvas.captureStream(10); await video.play();
    })()`);
    await remote("document.getElementById('embed').contentDocument.getElementById('video').requestFullscreen();");
    await poll(async () => (await state()).videoFullscreen && await remote('document.fullscreenElement?.id') === 'embed', 'embedded video fullscreen');
    assert.equal(await remote('document.fullscreenElement?.id'), 'embed');
    await assertWebsiteFillsWindow();
    assert.deepEqual((await windowDetails()).bounds, normalBounds);
    assert.equal((await windowDetails()).fullscreen, false);
    await key('Escape');
    await poll(async () => !(await state()).videoFullscreen && (await state()).chromeVisible, 'embedded video exits fullscreen');
    console.log('PASS: embedded video fullscreen stays inside the floating window');

    await key('F11');
    await poll(async () => (await windowDetails()).fullscreen, 'F11 enters screen fullscreen separately');
    await assertWebsiteFillsWindow();
    await call('toggleUI');
    await poll(async () => (await state()).chromeVisible, 'controls publish');
    assert.equal((await windowDetails()).fullscreen, true, 'UI icon does not exit monitor fullscreen either');
    await key('Escape');
    await poll(async () => !(await windowDetails()).fullscreen, 'Escape exits screen fullscreen');
    assert.deepEqual((await windowDetails()).bounds, normalBounds);

    await call('newTab');
    await navigate(`${base}/a`);
    const rejected = await remote("document.getElementById('video').requestFullscreen().then(() => 'allowed').catch(error => error.name)", undefined, false);
    assert.notEqual(rejected, 'allowed', 'automatic fullscreen without a user gesture is denied');
    for (const address of ['javascript:alert(1)', 'file:///C:/Windows', 'mini://app/index.html']) assert.equal((await call('navigate', address)).ok, false);
    await remote("location.href='/download';");
    await poll(async () => (await state()).downloads.some(item => item.state === 'completed'), 'completed download');
    await call('downloadsPanel', false);
    await remote("window.notificationResult = ''; Notification.requestPermission().then(value => window.notificationResult = value); 'requested'");
    await poll(async () => !!(await state()).permissionPrompt, 'notification permission prompt');
    await shell.locator('#permission-block').click();
    await poll(async () => await remote('window.notificationResult') === 'denied', 'notification blocked');
    const allPrefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0].contentView.children.filter(view => !view.browserChrome).map((view) => {
      const p = view.webContents.getLastWebPreferences();
      return p.sandbox && p.contextIsolation && p.webSecurity && !p.nodeIntegration && (!p.preload || p.preload.endsWith('page-preload.cjs'));
    }));
    assert.ok(allPrefs.every(Boolean));
    const beforeCloseState = await state();
    const beforeExternalClose = beforeCloseState.tabs.length;
    const externalIndex = beforeCloseState.tabs.findIndex((tab) => tab.id === beforeCloseState.activeTabId);
    await application.evaluate(({ BrowserWindow }, index) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0].contentView.children.filter(view => !view.browserChrome)[index].webContents.close(), externalIndex);
    await poll(async () => (await state()).tabs.length === beforeExternalClose - 1, 'external page close removes its tab');
    for (const tab of [...(await state()).tabs]) await call('closeTab', tab.id);
    await poll(async () => (await state()).tabs.length === 1 && (await state()).mode === 'welcome', 'last tab close publishes');
    assert.equal((await state()).mode, 'welcome');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0].contentView.children.filter(view => !view.browserChrome).length), 1);
    const data = await application.evaluate(({ app }) => app.getPath('userData'));
    assert.ok(data.startsWith(root + path.sep));
    assert.equal(fs.existsSync(path.join(data, 'profiles.json')), false);
    console.log('PASS: gestureless fullscreen and privileged navigation stay blocked; downloads complete and site permission choices work; closing the final tab leaves a clean start page');
    await popupCloseCheck();
    console.log('All tab/fullscreen/popup checks passed.');
  } catch (error) {
    if (application) {
      console.error('State on failure:', await state().catch(() => 'unavailable'));
      console.error('Pointer/window:', await application.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0];
        return {cursor: screen.getCursorScreenPoint(), content: win.getContentBounds(), focused: win.isFocused(), visible: win.isVisible()};
      }).catch(() => 'unavailable'));
    }
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    if (originalPointer && process.env.MINI_BROWSER_POINTER_SMOKE === '1') {
      try { movePointer(originalPointer); } catch { /* Do not hide a test failure if pointer restoration is unavailable. */ }
    }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
