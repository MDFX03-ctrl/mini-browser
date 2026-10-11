'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const results = path.join(root, 'test-results');
const temp = path.join(root, '.cache', 'tmp');
fs.mkdirSync(results, { recursive: true });
fs.mkdirSync(temp, { recursive: true });
process.env.electron_config_cache = path.join(root, '.cache', 'electron');
process.env.ELECTRON_CACHE = process.env.electron_config_cache;
process.env.ELECTRON_GET_USE_PROXY = '1';
process.env.NODE_USE_ENV_PROXY = '1';
process.env.TEMP = temp;
process.env.TMP = temp;

const server = http.createServer((request, response) => {
  if (request.url === '/slow') {
    response.setHeader('Content-Type', 'text/html');
    response.write('<!doctype html><title>Slow page</title><h1>Loading</h1>');
    const timer = setTimeout(() => response.end('<p>Done.</p>'), 10000);
    response.on('close', () => clearTimeout(timer));
    return;
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/two' });
    return response.end();
  }
  if (request.url === '/download') {
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename="test.txt"' });
    return response.end('test download');
  }
  response.setHeader('Content-Type', 'text/html');
  const second = request.url === '/two';
  response.end(`<!doctype html><title>${second ? 'Page Two' : 'Page One'}</title><style>body{font:16px Segoe UI;margin:32px;background:#fafbf7;color:#345844}a{color:#345844}</style><h1>${second ? 'Page Two' : 'Page One'}</h1><a id="next" href="/two">Next page</a><br><a id="popup" href="/two" target="_blank">Open another window</a><br><a id="download" href="/download">Download</a><br><a id="file" href="mini://app/index.html">Blocked protocol</a>`);
});

async function poll(check, message, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}

async function captureShell(application, shell, file) {
  // Capture through Electron: CDP screenshots can stall when a native child view
  // is hidden for the shell's error screen or the floating window loses focus.
  const handle = await application.browserWindow(shell);
  await shell.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await handle.evaluate(async win => {
    if (win.isMinimized()) win.restore();
    win.showInactive();
    return (await win.capturePage()).toPNG().toString('base64');
  });
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  await handle.dispose();
}

async function run(executablePath) {
  let application;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, MINI_BROWSER_TEST: '1', MINI_BROWSER_TEST_PROFILE: require('node:crypto').randomUUID(), TEMP: temp, TMP: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    application = await electron.launch({
      ...(executablePath ? { executablePath, args: ['--disable-features=CalculateNativeWinOcclusion'] } : { args: [root, '--disable-features=CalculateNativeWinOcclusion'] }),
      cwd: root, env, timeout: 30000
    });
    await application.firstWindow();
    for (let attempts = 0; !application.windows().some(page => page.url() === 'mini://app/index.html'); attempts++) { if (attempts > 200) throw new Error('Shell did not load'); await new Promise(resolve => setTimeout(resolve, 100)); }
    const shell = application.windows().find(page => page.url() === 'mini://app/index.html');
    await shell.waitForURL('mini://app/index.html');
    await shell.locator('#welcome').waitFor({ state: 'visible' });
    // Windows can suspend compositing for an entirely hidden packaged window.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    const getState = () => shell.evaluate(() => window.miniBrowser.getState());
    assert.equal((await getState()).pinned, false);
    assert.equal((await getState()).url, '');
    assert.equal((await getState()).mode, 'welcome');
    const navigate = (address) => shell.evaluate((value) => window.miniBrowser.navigate(value), address);
    const remoteEval = (expression) => application.evaluate(({ webContents }, code) => {
      const content = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('http://127.0.0.1'));
      if (!content) throw new Error('Remote page missing');
      return content.executeJavaScript(code, true);
    }, expression);

    await captureShell(application, shell, path.join(results, executablePath ? 'packaged-welcome.png' : 'welcome.png'));
    console.log('PASS: welcome screen and local toolbar render');
    await shell.locator('#address').click();
    await shell.locator('#address').fill(`${base}/one`);
    await shell.locator('#address').press('Enter');
    await poll(async () => { const s = await getState(); return s.title === 'Page One' && !s.loading; }, 'first page');
    assert.equal(await remoteEval('typeof require'), 'undefined');
    assert.equal(await remoteEval('typeof window.miniBrowser'), 'undefined');
    assert.equal(await shell.evaluate(() => typeof require), 'undefined');
    const preferences = await application.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith('http://127.0.0.1'));
      const p = wc.getLastWebPreferences();
      return { sandbox: p.sandbox, isolated: p.contextIsolation, node: p.nodeIntegration, preload: p.preload };
    });
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.isolated, true);
    assert.equal(preferences.node, false);
    assert.ok(!preferences.preload || preferences.preload.endsWith('page-preload.cjs'));
    assert.equal(await application.evaluate(({ BrowserWindow, session }) =>
      BrowserWindow.getAllWindows().some(win => win.contentView.children.filter(view => !view.browserChrome)[0].webContents.session === session.fromPartition('test-pages'))), true);
    const isolatedData = await application.evaluate(({ app }) => app.getPath('userData'));
    assert.ok(path.relative(root, isolatedData) && !path.relative(root, isolatedData).startsWith('..'));
    assert.equal(fs.existsSync(path.join(isolatedData, 'profiles.json')), false);
    console.log('PASS: real page loads; remote content has no Node or application bridge');

    const currentUrl = (await getState()).url;
    for (const value of ['weather in Tokyo', 'cats & dogs', 'weather']) {
      const result = await navigate(value);
      assert.equal(result.ok, false);
      assert.match(result.error, /Enter a website address/);
      assert.equal((await getState()).url, currentUrl);
    }
    await shell.locator('#address').fill('weather in Tokyo');
    await shell.locator('#address').press('Enter');
    await shell.locator('#notice').waitFor({ state: 'visible' });
    assert.match(await shell.locator('#notice').textContent(), /Enter a website address/);
    await shell.locator('#notice').click();
    await shell.locator('#address').press('Escape');
    console.log('PASS: blank start page and address-only navigation; plain text does not trigger a search');

    await remoteEval("document.querySelector('#next').click()");
    await poll(async () => { const s = await getState(); return s.title === 'Page Two' && s.canGoBack && !s.loading; }, 'next link');
    await shell.locator('#back').click();
    await poll(async () => { const s = await getState(); return s.title === 'Page One' && s.canGoForward; }, 'back');
    await shell.locator('#forward').click();
    await poll(async () => (await getState()).title === 'Page Two', 'forward');
    await navigate(`${base}/redirect`);
    await poll(async () => { const s = await getState(); return s.url === `${base}/two` && !s.loading; }, 'redirect');
    await shell.locator('#reload').click();
    await poll(async () => !(await getState()).loading, 'reload');
    await navigate(`${base}/slow`);
    await poll(async () => (await getState()).loading, 'slow page starts loading');
    await shell.locator('#reload').click();
    await poll(async () => !(await getState()).loading, 'stop loading');
    assert.notEqual((await getState()).mode, 'error');
    await navigate(`${base}/two`);
    await poll(async () => { const s = await getState(); return s.title === 'Page Two' && !s.loading; }, 'load after stop');
    console.log('PASS: links, back, forward, redirects, reload, and stop');

    await shell.locator('#bookmark').click();
    await poll(async () => (await getState()).bookmarked, 'current page bookmarked');
    assert.equal((await getState()).bookmarks.filter((item) => item.url === `${base}/two`).length, 1);
    await shell.evaluate((url) => window.miniBrowser.addBookmark(url, 'Duplicate'), `${base}/two`);
    assert.equal((await getState()).bookmarks.filter((item) => item.url === `${base}/two`).length, 1);
    await shell.evaluate(() => window.miniBrowser.home());
    await shell.locator('#bookmarks-list .bookmark-open').filter({ hasText: 'Page Two' }).waitFor({ state: 'visible' });
    await shell.locator('#add-bookmark').click();
    await shell.locator('#bookmark-url').fill('javascript:alert(1)');
    await shell.locator('#bookmark-name').fill('Unsafe website');
    await shell.locator('#bookmark-form button[type="submit"]').click();
    await shell.locator('#bookmark-error').waitFor({ state: 'visible' });
    await shell.locator('#bookmark-url').fill(`${base}/one`);
    await shell.locator('#bookmark-name').fill('<img src=x onerror=alert(1)>');
    await shell.locator('#bookmark-form button[type="submit"]').click();
    await poll(async () => (await getState()).bookmarks.length === 2, 'manually added bookmark');
    assert.equal(await shell.locator('#bookmarks-list img').count(), 0);
    const userData = await application.evaluate(({ app }) => app.getPath('userData'));
    const relativeProfile = path.relative(root, userData);
    assert.ok(relativeProfile && !relativeProfile.startsWith('..') && !path.isAbsolute(relativeProfile));
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'bookmarks.json'), 'utf8'));
    assert.equal(stored.length, 2);
    await captureShell(application, shell, path.join(results, 'bookmarks.png'));
    await shell.locator('.bookmark-remove').filter({ hasText: '×' }).last().click();
    await poll(async () => (await getState()).bookmarks.length === 1, 'bookmark removed');
    await shell.locator('#bookmarks-list .bookmark-open').filter({ hasText: 'Page Two' }).click();
    await poll(async () => { const s = await getState(); return s.mode === 'page' && !s.loading; }, 'open bookmark');
    assert.equal((await getState()).url, `${base}/two`);
    assert.equal(await shell.locator('#bookmark').getAttribute('aria-pressed'), 'true');
    await shell.locator('#bookmark').click();
    await poll(async () => (await getState()).bookmarks.length === 0, 'star removes bookmark');
    console.log('PASS: bookmark star, start-page add/open/remove, duplicate prevention, safe labels, and disk persistence');

    await shell.evaluate(() => window.miniBrowser.pin());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
    await shell.evaluate(() => window.miniBrowser.pin());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false);
    for (const [width, height] of [[360, 280], [800, 700], [480, 640]]) {
      const bounds = await application.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(...size);
        const [width, height] = win.getContentSize();
        return { width, height };
      }, [width, height]);
      await poll(async () => application.evaluate(({ BrowserWindow }, expected) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.filter(view => !view.browserChrome)[0];
        const b = view.getBounds();
        return b.x === 0 && b.y === 88 && b.width === expected.width && b.height === expected.height - 88;
      }, bounds), 'resized view follows window');
      const toolbar = await shell.locator('.toolbar').boundingBox();
      assert.equal(toolbar.width, bounds.width);
      if (width === 360) await captureShell(application, shell, path.join(results, 'minimum-size.png'));
    }
    console.log('PASS: pin toggles and content follows resizing at minimum and larger sizes');

    const previousTabs = (await getState()).tabs.length;
    await remoteEval("document.querySelector('#popup').click()");
    await poll(async () => { const s = await getState(); return s.tabs.length === previousTabs + 1 && !s.loading; }, 'link opens a new tab');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await shell.evaluate(async () => { const s = await window.miniBrowser.getState(); await window.miniBrowser.closeTab(s.activeTabId); });
    await remoteEval("document.querySelector('#download').click()");
    await poll(async () => (await getState()).downloads.some(item => item.state === 'completed'), 'completed download');
    await shell.evaluate(() => window.miniBrowser.downloadsPanel(false));
    for (const value of ['file:///C:/Windows', 'javascript:alert(1)', 'mini://app/index.html']) {
      assert.equal((await navigate(value)).ok, false);
    }
    await remoteEval("document.querySelector('#file').click()");
    assert.equal(await remoteEval('typeof window.miniBrowser'), 'undefined');
    await remoteEval("window.notificationResult = ''; Notification.requestPermission().then(value => window.notificationResult = value); 'requested'");
    await poll(async () => !!(await getState()).permissionPrompt, 'notification permission prompt');
    await shell.locator('#permission-block').click();
    await poll(async () => await remoteEval('window.notificationResult') === 'denied', 'notification blocked');
    console.log('PASS: new-tab links stay in one window; downloads complete and privileged addresses remain blocked');

    await shell.locator('#address').fill('partially typed address');
    await remoteEval("document.title = 'Updated title'");
    await poll(async () => (await getState()).title === 'Updated title', 'title change');
    assert.equal(await shell.locator('#address').inputValue(), 'partially typed address');
    await shell.locator('#address').press('Escape');
    await application.evaluate(({ BrowserWindow, webContents }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.show();
      win.focus();
      const content = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('http://127.0.0.1'));
      content.focus();
      content.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] });
      content.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] });
    });
    await poll(async () => shell.locator('#address').evaluate((element) => document.activeElement === element), 'Ctrl+L focus');
    console.log('PASS: address editing survives page events; Ctrl+L focuses address');

    await shell.locator('#minimize').evaluate(element => element.click());
    await poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), 'minimize');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await shell.locator('#maximize').evaluate(element => element.click());
    await poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), 'maximize');
    await shell.locator('#maximize').evaluate(element => element.click());
    await poll(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMaximized()), 'restore');
    const previousPosition = await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const before = win.getPosition();
      win.setPosition(before[0] + 30, before[1] + 30);
      return before;
    });
    await poll(async () => {
      const position = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getPosition());
      return position[0] !== previousPosition[0] || position[1] !== previousPosition[1];
    }, 'native window move');
    const capture = await application.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].capturePage();
      return image.toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(results, 'browser.png'), Buffer.from(capture, 'base64'));
    const websiteCapture = await application.evaluate(async ({ webContents }) => {
      const content = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('http://127.0.0.1'));
      return (await content.capturePage()).toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(results, 'website.png'), Buffer.from(websiteCapture, 'base64'));
    assert.equal(await shell.locator('.caption').evaluate((element) => getComputedStyle(element).webkitAppRegion), 'drag');
    console.log('PASS: title-bar minimize/maximize/restore controls and draggable window');

    const failure = `${base}/unreachable`;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await navigate(failure);
    await poll(async () => (await getState()).mode === 'error', 'failed page');
    await shell.locator('#error').waitFor({ state: 'visible' });
    await captureShell(application, shell, path.join(results, 'error.png'));
    await new Promise((resolve) => server.listen(Number(new URL(base).port), '127.0.0.1', resolve));
    await shell.locator('#retry').click();
    await poll(async () => { const s = await getState(); return s.mode === 'page' && !s.loading && s.title === 'Page One'; }, 'retry recovered');
    console.log('PASS: readable error and retry recovery');
    if (process.env.MINI_BROWSER_WEB_SMOKE === '1') {
      await navigate('https://example.com/');
      await poll(async () => { const s = await getState(); return s.title === 'Example Domain' && !s.loading; }, 'public HTTPS website', 30000);
      console.log('PASS: public HTTPS website (example.com)');
    }
    await shell.evaluate((url) => window.miniBrowser.addBookmark(url, 'Saved across restarts'), `${base}/one`);
    await application.close();
    application = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: [root] }),
      cwd: root, env, timeout: 30000
    });
    await poll(() => application.windows().some(page => page.url() === 'mini://app/index.html'), 'restored shell window');
    const reopened = application.windows().find(page => page.url() === 'mini://app/index.html');
    await reopened.waitForURL('mini://app/index.html');
    await reopened.evaluate(() => window.miniBrowser.home());
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await reopened.locator('#bookmarks-list .bookmark-open').filter({ hasText: 'Saved across restarts' }).waitFor({ state: 'visible' });
    await reopened.locator('#bookmarks-list .bookmark-open').filter({ hasText: 'Saved across restarts' }).click();
    await poll(async () => { const s = await reopened.evaluate(() => window.miniBrowser.getState()); return s.url === `${base}/one` && !s.loading; }, 'reopened bookmark navigation');
    await reopened.evaluate((url) => window.miniBrowser.removeBookmark(url), `${base}/one`);
    console.log('PASS: saved bookmarks appear on startup after closing and reopening the browser');
    assert.equal(fs.existsSync(path.join(isolatedData, 'profiles.json')), false);
    assert.equal((await reopened.evaluate(() => window.miniBrowser.createProfile('Test profile'))).ok, true);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => !view.browserChrome)[0].webContents.session.storagePath), null);
    assert.equal((await reopened.evaluate(() => window.miniBrowser.switchProfile('default'))).ok, true);
    assert.equal(await application.evaluate(({ BrowserWindow, session }) =>
      BrowserWindow.getAllWindows().some(win => win.contentView.children.filter(view => !view.browserChrome)[0].webContents.session === session.fromPartition('test-pages'))), true);
    assert.equal(fs.existsSync(path.join(isolatedData, 'profiles.json')), false);
    console.log('PASS: MINI_BROWSER_TEST keeps test-pages and never creates profiles.json');
    console.log(executablePath ? 'Packaged browser checks passed.' : 'All Electron checks passed.');
  } catch (error) {
    if (application) {
      console.error('Browser state on failure:', await application.evaluate(({ BrowserWindow, webContents }) => ({
        windows: BrowserWindow.getAllWindows().map((win) => win.getBounds()),
        pages: webContents.getAllWebContents().map((wc) => ({ url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), back: wc.navigationHistory.canGoBack() }))
      })).catch(() => 'Application unavailable'));
      const shell = await application.firstWindow().catch(() => null);
      if (shell) console.error('Toolbar state:', await shell.evaluate(() => window.miniBrowser.getState()).catch(() => null));
    }
    throw error;
  } finally {
    if (application) await application.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}
run(process.argv[2]).catch((error) => { console.error(error); process.exitCode = 1; });
