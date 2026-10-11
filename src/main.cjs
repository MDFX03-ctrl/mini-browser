'use strict';

const { app, BrowserWindow, ipcMain, protocol, session, screen, safeStorage, Tray, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { BookmarkStore } = require('./bookmarks.cjs');
const { ProfileStore } = require('./profiles.cjs');
const { PermissionManager } = require('./permissions.cjs');
const { BookmarkIcons } = require('./bookmark-icons.cjs');
const { rasterizeIcon } = require('./icon-decoder.cjs');
const { Downloads } = require('./downloads.cjs');
const { TabRestore } = require('./tab-restore.cjs');
const { ProfileData } = require('./profile-data.cjs');
const { PasswordStore, loginOrigin } = require('./passwords.cjs');
const { isWebUrl } = require('./navigation.cjs');

app.setName('Mini Browser');
const root = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
const installed = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'installed.flag'));
const testProfile = process.env.MINI_BROWSER_TEST === '1'
  && /^[a-f\d-]{36}$/i.test(process.env.MINI_BROWSER_TEST_PROFILE || '')
  ? path.join(root, '.mini-browser', 'tests', process.env.MINI_BROWSER_TEST_PROFILE) : null;
const dataDirectory = testProfile || (installed && process.env.MINI_BROWSER_TEST !== '1'
  ? app.getPath('userData') : path.join(root, '.mini-browser'));
fs.mkdirSync(dataDirectory, { recursive: true });
const hidden = process.env.MINI_BROWSER_TEST === '1';
if (hidden) { const directory = path.join(dataDirectory, 'downloads'); fs.mkdirSync(directory, { recursive: true }); app.setPath('downloads', directory); }
app.setPath('userData', dataDirectory);
app.setPath('sessionData', path.join(dataDirectory, 'session'));
app.setPath('crashDumps', path.join(dataDirectory, 'crashes'));
app.setAppLogsPath(path.join(dataDirectory, 'logs'));
app.setAppUserModelId('local.mini-browser');
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) { app.quit(); return; }
const profiles = new ProfileStore(dataDirectory, hidden);
const restoredTabs = new TabRestore(profiles);
profiles.cleanupDeleted();
app.on('second-instance', () => app.whenReady().then(async () => {
  const current = [...windows.values()].find(item => item.profileId === profiles.active().id);
  if (current) { current.window.restore(); current.window.show(); current.window.focus(); }
  else await (await createWindow(profiles.active().id)).ready;
}).catch(console.error));

protocol.registerSchemesAsPrivileged([
  { scheme: 'mini', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const { createBrowserWindow } = require('./browser-window.cjs');

function readBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'window.json'), 'utf8'));
    if (![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return {};
    const display = screen.getDisplayMatching(saved).workArea;
    const width = Math.min(Math.max(360, saved.width), display.width);
    const height = Math.min(Math.max(280, saved.height), display.height);
    return {
      width, height,
      x: Math.max(display.x, Math.min(saved.x, display.x + display.width - width)),
      y: Math.max(display.y, Math.min(saved.y, display.y + display.height - height))
    };
  } catch { return {}; }
}

const { randomUUID } = require('node:crypto');
const windows = new Map();
const bookmarkStores = new Map();
const dataStores = new Map(), passwordStores = new Map();
let tray;
function dataFor(id) {
  if (!dataStores.has(id)) dataStores.set(id, new ProfileData(profiles.bookmarkDirectory(id)));
  return dataStores.get(id);
}
function passwordsFor(id) {
  if (!passwordStores.has(id)) passwordStores.set(id, new PasswordStore(profiles.bookmarkDirectory(id), safeStorage));
  return passwordStores.get(id);
}
const configuredSessions = new WeakSet();
let profilesBusy = false;
let quitting = false;
app.on('before-quit', () => {
  if (quitting) return;
  for (const id of openProfiles()) {
    const group = [...windows.values()].filter(item => item.profileId === id);
    restoredTabs.save(id, group, group.find(item => item.window.isFocused()) || group.at(-1));
  }
  quitting = true;
});
let dragging = null;
function openProfiles() { return [...new Set([...windows.values()].map((item) => item.profileId))]; }
function publishAll() { for (const controller of windows.values()) controller.publish(); }
const icons = new BookmarkIcons(publishAll, { renderImage: async (browsingSession, source) => {
  const owner = [...windows.values()].find(item => !item.window.isDestroyed() && item.tabs.session === browsingSession);
  if (!owner) return null;
  await owner.ready;
  const content = owner.window.webContents;
  if (content.isDestroyed() || content.getURL() !== 'mini://app/index.html') return null;
  return content.executeJavaScript(`(${rasterizeIcon.toString()})(${JSON.stringify(source)})`);
} });
function bookmarksFor(id) {
  if (!bookmarkStores.has(id)) {
    const directory = profiles.bookmarkDirectory(id);
    fs.mkdirSync(directory, { recursive: true });
    bookmarkStores.set(id, new BookmarkStore(directory));
  }
  return bookmarkStores.get(id);
}
function ownerOf(content) {
  return [...windows.values()].find((controller) => controller.tabs.items.some((tab) => tab.content === content));
}
const downloads = new Downloads(content => {
  if (!content || content.isDestroyed()) return;
  const owner = ownerOf(content);
  if (owner) return owner;
  const parent = BrowserWindow.fromWebContents(content)?.getParentWindow();
  return [...windows.values()].find(item => item.window === parent);
});
const access = new PermissionManager({ profiles, testing: hidden, ownerOf, publishAll,
  allWindows: () => [...windows.values()] });
function browsingSessionFor(id) {
  const browsingSession = session.fromPartition(profiles.partition(id));
  if (!configuredSessions.has(browsingSession)) {
    configuredSessions.add(browsingSession);
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
    browsingSession.setUserAgent(userAgent, 'en-US,en');
    browsingSession.setSpellCheckerLanguages(['en-US']);
    // Native popup documents can initialize before their WebContents UA override.
    app.userAgentFallback = userAgent;
    browsingSession.setPermissionCheckHandler((...args) => access.check(id, ...args));
    browsingSession.setPermissionRequestHandler((...args) => access.request(id, ...args));
    browsingSession.setDisplayMediaRequestHandler((request, callback) => access.share(id, request, callback));
    browsingSession.setDevicePermissionHandler(() => false);
    browsingSession.on('will-download', (event, item, content) => downloads.start(id, event, item, content));
  }
  return browsingSession;
}
function windowBounds(origin, point) {
  if (!origin && !point) return hidden ? {} : readBounds();
  const previous = origin?.window.getNormalBounds() || { width: 480, height: 640, x: 80, y: 80 };
  const area = screen.getDisplayNearestPoint(point || { x: previous.x, y: previous.y }).workArea;
  const width = Math.min(previous.width, area.width), height = Math.min(previous.height, area.height);
  return { width, height,
    x: Math.max(area.x, Math.min(point ? point.x - 70 : previous.x + 28, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(point ? point.y - 44 : previous.y + 28, area.y + area.height - height)) };
}
async function createWindow(id, origin, point, empty = false) {
  const controller = await createBrowserWindow({ profileId: id, bookmarks: bookmarksFor(id), profiles,
    data: dataFor(id), passwords: passwordsFor(id), quit: () => app.quit(),
    browsingSession: browsingSessionFor(id), hidden, dataDirectory, bounds: windowBounds(origin, point), empty,
    isBusy: () => profilesBusy, openProfiles, publishAll, access, icons, downloads,
    restore: !empty && !openProfiles().includes(id) ? restoredTabs.read(id) : null,
    onClosing: (item) => {
      if (!quitting && item.tabs.items.length) restoredTabs.save(id,
        [...windows.values()].filter(other => other.profileId === id), item);
    },
    onCreated: (item) => {
      item.shellId = item.window.webContents.id; windows.set(item.shellId, item);
      item.window.webContents.on('before-input-event', (_event, input) => {
        if (dragging?.source === item && input.type === 'keyDown' && input.key === 'Escape') dragging.cancelled = true;
      });
    },
    onClosed: (item) => {
      downloads.close(item);
      windows.delete(item.shellId);
      if (dragging?.source === item) dragging = null;
      publishAll();
    },
    onFocused: (item) => {
      if (!quitting && !profilesBusy && profiles.active().id !== item.profileId) {
        try { profiles.select(item.profileId); } catch (error) { console.error(error.message); }
      }
    }
  });
  // A newly opened profile is the one restored on the next launch.
  profiles.select(id);
  publishAll();
  return controller;
}
async function profileCommand(source, command, id, name) {
  if (source.busy()) throw new Error('Please wait for the current change to finish.');
  profilesBusy = true;
  try {
    if (command === 'switch') {
      profiles.get(id);
      if (!openProfiles().includes(id)) await (await createWindow(id, source)).ready;
      source.panel(false);
    } else if (command === 'create') {
      const profile = profiles.create(name);
      await (await createWindow(profile.id, source)).ready;
      source.panel(false);
    } else if (command === 'rename') profiles.rename(id, name);
    else if (command === 'picture') profiles.picture(id, name);
    else if (command === 'reorder') profiles.reorder(id);
    else if (command === 'delete') {
      profiles.get(id);
      if (profiles.list().length === 1) throw new Error('Keep at least one profile.');
      const replacement = profiles.list().find((item) => item.id !== id).id;
      if (![...windows.values()].some((item) => item.profileId !== id)) {
        await (await createWindow(replacement, source)).ready;
      }
      const closing = [...windows.values()].filter((item) => item.profileId === id);
      await Promise.all(closing.map((item) => item.close()));
      if (profiles.active().id === id) profiles.select(replacement);
      const removed = browsingSessionFor(id);
      await removed.closeAllConnections();
      await removed.clearData();
      await removed.clearAuthCache();
      removed.clearHostResolverCache();
      removed.flushStorageData();
      await removed.cookies.flushStore();
      profiles.remove(id);
      if (bookmarkStores.has(id)) bookmarkStores.get(id).removed = true;
      profiles.deleteBookmarks(id);
      bookmarkStores.delete(id);
      access.removeProfile(id);
      dataStores.delete(id); passwordStores.delete(id);
    } else throw new Error('Unknown profile action.');
    return { ok: true };
  } finally { profilesBusy = false; publishAll(); }
}
function startDrag(source, id) {
  if (source.busy() || dragging) throw new Error('Please finish the current change first.');
  source.tabs.get(id);
  const token = randomUUID();
  dragging = { source, id, token };
  source.hold(true);
  return { ok: true, token };
}
async function finishDrag(source, token, cancel) {
  const drag = dragging;
  if (!drag || drag.source !== source || drag.token !== token) throw new Error('Tab drag expired.');
  dragging = null;
  source.hold(false);
  if (cancel === true || drag.cancelled) return { ok: true };
  if (source.busy()) throw new Error('Please finish the current change first.');
  profilesBusy = true;
  try {
    const point = screen.getCursorScreenPoint();
    const contains = (bounds) => point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    const candidates = [...windows.values()].filter((item) => !item.window.isMinimized() && item.window.isVisible() && contains(item.window.getContentBounds()));
    // Prefer the focused window when windows overlap; otherwise the most recently opened.
    let target = candidates.find((item) => item.window.isFocused()) || candidates.at(-1);
    let index;
    if (target) {
      if (target.profileId !== source.profileId) throw new Error('Tabs can move between windows of the same profile.');
      const bounds = target.window.getContentBounds();
      const local = { x: point.x - bounds.x, y: point.y - bounds.y };
      index = await target.window.webContents.executeJavaScript(`(() => {
        const strip = document.querySelector('.tab-strip');
        const rect = strip.getBoundingClientRect();
        const point = ${JSON.stringify(local)};
        if (strip.closest('[hidden]') || point.y < rect.top || point.y >= rect.bottom) return -1;
        const cards = [...document.querySelectorAll('.tab-card')];
        const found = cards.findIndex(card => { const r = card.getBoundingClientRect(); return point.x < r.x + r.width / 2; });
        return found < 0 ? cards.length : found;
      })()`);
      if (index < 0) return { ok: true };
    }
    source.exitVideo();
    if (!target) target = await createWindow(source.profileId, source, point, true);
    source.tabs.transfer(drag.id, target.tabs, index);
    if (source !== target && source.tabs.items.length === 0) source.window.close();
    await target.ready;
    if (!target.window.isDestroyed() && !hidden) { target.window.show(); target.window.focus(); }
    return { ok: true };
  } finally { profilesBusy = false; publishAll(); }
}
function caller(event) {
  const item = [...windows.values()].find(item => event.sender === item.window.webContents || event.sender === item.overlayContent);
  const expected = event.sender === item?.overlayContent ? 'mini://app/index.html?overlay=1' : 'mini://app/index.html';
  if (!item || item.window.isDestroyed() || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expected) {
    throw new Error('Untrusted browser request.');
  }
  return item;
}
function handle(channel, callback) {
  ipcMain.handle(`browser:${channel}`, async (event, ...args) => {
    const source = caller(event);
    try { return await callback(source, ...args); }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
handle('state', (item) => item.state);
handle('navigate', (item, address) => item.navigate(address));
handle('action', (item, command) => item.action(command));
handle('tab', (item, command, id) => item.tabCommand(command, id));
handle('find', (item, ...args) => item.find(...args));
handle('zoom', (item, command) => item.zoom(command));
handle('download', (item, command, id) => downloads.command(item, command, id));
handle('downloads-panel', (item, open) => item.downloadPanel(open));
handle('bookmark', (item, ...args) => item.bookmark(...args));
handle('profile', profileCommand);
handle('profile-panel', (item, open, height) => item.panel(open, height));
handle('site-panel', (item, open) => item.accessPanel(open));
handle('permission-response', (item, ...args) => access.respond(item, ...args));
handle('permission-update', (item, ...args) => access.update(item, ...args));
handle('chrome-hold', (item, hold) => item.hold(hold));
handle('tab-drag-start', startDrag);
handle('tab-drag-end', finishDrag);
handle('ui', (item, command, value) => item.ui(command, value));
handle('suggest', (item, text, anchor) => item.suggest(text, anchor));
handle('password', (item, command, id) => item.password(command, id));
handle('clear-data', async (item, choices) => {
  const result = await item.clearData(choices);
  for (const other of windows.values()) if (other.profileId === item.profileId) other.resetPrivateData(choices);
  publishAll(); return result;
});
function pageCaller(event) {
  const item = ownerOf(event.sender), tab = item?.tabs.items.find(tab => tab.content === event.sender);
  if (!tab || item.busy() || item.tabs.active !== tab || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame
    || loginOrigin(event.senderFrame.url) !== loginOrigin(event.sender.getURL()) || !loginOrigin(event.sender.getURL())) return null;
  return { item, tab };
}
ipcMain.on('browser:login-submit', (event, login) => {
  const owner = pageCaller(event);
  if (!owner || !login || typeof login.username !== 'string' || login.username.length > 1024 || typeof login.password !== 'string' || !login.password || login.password.length > 8192) return;
  owner.tab.loginCandidate = { ...login, origin: loginOrigin(event.sender.getURL()), expires: Date.now() + 60000 };
});
ipcMain.on('browser:login-page', (event, info) => { const owner = pageCaller(event); if (owner && info && typeof info.hasPassword === 'boolean') owner.item.loginPage(owner.tab, info); });
ipcMain.on('browser:page-activity', event => {
  const item = ownerOf(event.sender);
  if (item?.tabs.active?.content === event.sender && event.senderFrame === event.sender.mainFrame && isWebUrl(event.sender.getURL())) item.pageActivity();
});

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  const assets = { '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/renderer.js': ['renderer.js', 'text/javascript'] };
  protocol.handle('mini', (request) => {
    const url = new URL(request.url);
    const asset = url.hostname === 'app' && assets[url.pathname];
    if (!asset || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(__dirname, 'ui', asset[0])), { headers: {
      'Content-Type': `${asset[1]}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"
    } });
  });
  await (await createWindow(profiles.active().id)).ready;
  if (!hidden) {
    tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.ico'));
    tray.setToolTip('Mini Browser');
    const reopen = async () => {
      const current = [...windows.values()].find(item => item.profileId === profiles.active().id);
      if (current) { current.window.restore(); current.window.show(); current.window.focus(); }
      else await (await createWindow(profiles.active().id)).ready;
    };
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Mini Browser', click: () => reopen().catch(console.error) }, { type: 'separator' }, { label: 'Exit', click: () => app.quit() }]));
    tray.on('double-click', () => reopen().catch(console.error));
  }
}).catch((error) => { console.error(error); app.quit(); });
app.on('window-all-closed', () => {});
app.on('will-quit', () => { tray?.destroy(); });

