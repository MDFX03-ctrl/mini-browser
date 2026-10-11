'use strict';
const { BrowserWindow, WebContentsView, screen, Menu, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { isWebUrl, resolveAddress } = require('./navigation.cjs');
const { BrowserTabs } = require('./tabs.cjs');
const { loginOrigin } = require('./passwords.cjs');

async function createBrowserWindow({ profileId, bookmarks, profiles, browsingSession, hidden,
  bounds, dataDirectory, data, passwords, quit, isBusy, openProfiles, publishAll, access, icons, downloads, restore, onClosing, onCreated, onClosed, onFocused, onChanged, empty = false }) {
  const SHELL_URL = 'mini://app/index.html';
  const chromeHeight = () => 88 + (data.preferences.bookmarkBar && bookmarks.list().length ? 32 : 0);
  let window;
  let tabs;
  let overlayView, overlay = null, overlayHeight = 360, suggestions = [], suggestionIndex = 0, suggestionAnchor;

  let tabsBusy = false;
  let bookmarkTarget = null, bookmarkAnchor = null;
  let sitePanelOpen = false;
  let downloadsPanelOpen = false;
  let zoomNotice = false;
  let zoomTimer;
  const pushOpen = () => sitePanelOpen || access.state(controller).permissionPrompt !== null;
  const panelsOpen = () => pushOpen() || overlay !== null;
  let panelHeight = 0;
  let hideUI = false;
  let screenFullscreen = false;
  let screenControlsShown = false;
  let videoTabId = null;
  let videoEntering = false;
  let videoControlsShown = false;
  let chromeRevealed = false;
  let chromeHeld = false;
  let edgeTimer;
  let lastChromeUse = 0;

  let state = {};

  function uiAutoHide() {
    return hideUI || (videoTabId !== null && !videoControlsShown) || (screenFullscreen && !screenControlsShown);
  }
  function controlsVisible() {
    return videoEntering || zoomNotice || !uiAutoHide() || chromeRevealed || panelsOpen() || tabs?.active?.mode !== 'page';
  }
  function layout() {
    if (!window || window.isDestroyed() || !tabs) return;
    const [width, height] = window.getContentSize();
    const top = controlsVisible() ? chromeHeight() + (pushOpen() ? panelHeight : 0) : 0;
    tabs.layout({ width, height, top, hidden: false });
    if (overlayView) {
      const w = Math.min(width - 16, overlay === 'suggestions' ? suggestionAnchor?.width || 360 : ['menu', 'profiles'].includes(overlay) ? 280 : overlay === 'bookmark-menu' ? 160 : 360);
      const anchor = overlay === 'suggestions' ? suggestionAnchor : overlay === 'bookmark-menu' ? bookmarkAnchor : null;
      const x = anchor ? Math.max(8, Math.min(anchor.x || 8, width - w - 8)) : width - w - 8;
      const y = anchor ? Math.max(chromeHeight(), Math.min(anchor.y || top, height - 80)) : top;
      const bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.max(40, Math.min(overlayHeight, height - y - 8)) };
      const previous = overlayView.getBounds();
      if (Object.keys(bounds).some(key => previous[key] !== bounds[key])) overlayView.setBounds(bounds);
      const visible = !!overlay && controlsVisible();
      if (overlayView.getVisible() !== visible) overlayView.setVisible(visible);
      // Audio, favicon and history updates must not repeatedly reorder native
      // views while a website is handling pointer input or keeping a dialog open.
      if (window.contentView.children.at(-1) !== overlayView) window.contentView.addChildView(overlayView);
    }
  }
  let publishTimer = null;
  function publish() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => { publishTimer = null; publishNow(); }, 24);
    publishTimer.unref?.();
  }
  function publishNow() {
    if (!window || window.isDestroyed() || !tabs?.active) return;
    const tab = tabs.active;
    const content = tab.view.webContents;
    if (content.isDestroyed()) return;
    const items = bookmarks.list();
    state = {
      url: tab.url, title: tab.title, loading: tab.loading, mode: tab.mode, error: tab.error, notice: tab.notice,
      canGoBack: content.navigationHistory.canGoBack(), canGoForward: content.navigationHistory.canGoForward(),
      pinned: window.isAlwaysOnTop(), bookmarks: items,
      canBookmark: tab.mode === 'page' && !tab.loading && isWebUrl(content.getURL()),
      bookmarked: items.some((item) => item.url === tab.url),
      profiles: profiles.list(), activeProfile: profiles.get(profileId), openProfiles: openProfiles(),
      tabs: tabs.list(), activeTabId: tabs.activeId, hideUI, videoFullscreen: videoTabId !== null,
      fullscreen: screenFullscreen, maximized: window.isMaximized(),
      autoHide: uiAutoHide(), chromeVisible: controlsVisible(), profilePanelOpen: overlay === 'profiles', sitePanelOpen,
      find: { ...tab.find }, zoomPercent: Math.round(content.getZoomFactor() * 100), zoomNotice,
      downloads: downloads.list(controller), downloadsPanelOpen,
      overlay, suggestions, suggestionIndex, chromeHeight: chromeHeight(), bookmarkBar: data.preferences.bookmarkBar,
      bookmarkEdit: bookmarks.list().find(item => item.url === bookmarkTarget) || null,
      history: overlay === 'history' ? data.entries.slice(0, 500) : [],
      passwords: overlay === 'passwords' ? passwords.list() : [], passwordOffer: tab.passwordOffer || [],
      passwordPrompt: tab.passwordPrompt ? { origin: tab.passwordPrompt.origin, username: tab.passwordPrompt.username } : null,
      canReopen: data.closed.length > 0,
      ...access.state(controller), panelHeight: pushOpen() ? panelHeight : 0
    };
    layout();
    const popup = window.getParentWindow();
    if (!popup) window.setTitle(tab.title && tab.mode === 'page' ? `${tab.title} — Mini Browser` : 'Mini Browser');
    window.webContents.send('browser:state', state);
    if (overlayView && !overlayView.webContents.isDestroyed()) overlayView.webContents.send('browser:state', state);
  }
  function revealChrome() {
    chromeRevealed = true;
    lastChromeUse = Date.now();
    publish();
  }
  function focusAddress() {
    revealChrome();
    chromeHeld = true;
    window.webContents.focus();
    window.webContents.send('browser:focus-address');
  }
  function syncChrome() {
    if (!window || window.isDestroyed()) return;
    if (edgeTimer) clearInterval(edgeTimer);
    edgeTimer = null;
    if (uiAutoHide()) {
      edgeTimer = setInterval(() => {
        // A pinned video window may be watched while another application has focus.
        if (!window || window.isDestroyed() || window.isMinimized()) return;
        const cursor = screen.getCursorScreenPoint();
        const bounds = window.getContentBounds();
        const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width
          && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
        const relativeY = cursor.y - bounds.y;
        if (inside && relativeY <= 6 && !chromeRevealed) revealChrome();
        if (chromeRevealed) {
          if (inside && relativeY <= chromeHeight() + 8) lastChromeUse = Date.now();
          else if (!chromeHeld && overlay !== 'profiles' && Date.now() - lastChromeUse > 650) {
            chromeRevealed = false;
            publish();
          }
        }
      }, 100);
    }
    publish();
  }
  function exitVideo() {
    if (!videoTabId) return;
    const previous = tabs?.items.find((tab) => tab.id === videoTabId);
    videoTabId = null;
    videoEntering = false;
    if (previous && !previous.view.webContents.isDestroyed()) {
      previous.view.webContents.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen();', true).catch(() => {});
    }
    syncChrome();
  }
  function htmlFullscreen(tab, entered) {
    if (entered) {
      if (tabs.active !== tab || isBusy() || tabsBusy) {
        tab.view.webContents.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen();', true).catch(() => {});
        return;
      }
      videoTabId = tab.id;
      videoEntering = true;
      videoControlsShown = false;
      chromeRevealed = false;
      chromeHeld = false;
      // Electron's event precedes the DOM transition. Keep the viewport unchanged
      // until Chromium commits fullscreen, including during unrelated state updates.
      setImmediate(() => {
        if (videoTabId !== tab.id || tab.content.isDestroyed()) return;
        tab.content.executeJavaScript(`new Promise(resolve => {
          if (document.fullscreenElement) { resolve(true); return; }
          const changed = () => { clearTimeout(timer); resolve(!!document.fullscreenElement); };
          const timer = setTimeout(() => { document.removeEventListener('fullscreenchange', changed); resolve(false); }, 5000);
          document.addEventListener('fullscreenchange', changed, { once: true });
        })`).then(entered => {
          if (videoTabId !== tab.id) return;
          videoEntering = false;
          if (!entered) videoTabId = null;
          syncChrome();
        }).catch(() => { if (videoTabId === tab.id) { videoEntering = false; videoTabId = null; syncChrome(); } });
      });
      return;
    } else {
      if (videoTabId !== tab.id) return;
      videoTabId = null;
      videoEntering = false;
      chromeRevealed = false;
    }
    syncChrome();
  }
  function toggleUI() {
    overlay = null; downloadsPanelOpen = false;
    if (uiAutoHide()) {
      hideUI = false;
      videoControlsShown = videoTabId !== null;
      screenControlsShown = screenFullscreen;
    } else {
      hideUI = true;
      videoControlsShown = false;
      screenControlsShown = false;
    }
    chromeHeld = false;
    chromeRevealed = false;
    syncChrome();
  }
  function busy() { return isBusy() || tabsBusy || !tabs?.active; }
  function action(command) {
    if (busy()) return state;
    const tab = tabs.active;
    const content = tab.view.webContents;
    switch (command) {
      case 'back':
      case 'forward': {
        exitVideo();
        const history = content.navigationHistory;
        if (command === 'back' ? history.canGoBack() : history.canGoForward()) {
          tab.navigationId++;
          tab.mode = 'page';
          tab.error = '';
          command === 'back' ? history.goBack() : history.goForward();
        }
        break;
      }
      case 'reload':
        if (tab.loading) tabs.stop();
        else if (tab.mode === 'error' && tab.lastAddress) tabs.load(tab.lastAddress);
        else if (tab.mode === 'page') content.reload();
        break;
      case 'retry': if (tab.lastAddress) tabs.load(tab.lastAddress); break;
      case 'pin': overlay = null; window.setAlwaysOnTop(!window.isAlwaysOnTop()); break;
      case 'bookmark':
        if (state.canBookmark) {
          try {
            if (bookmarks.list().some((item) => item.url === content.getURL())) bookmarks.remove(content.getURL());
            else { bookmarks.add(content.getURL(), content.getTitle()); icons.refresh(bookmarks, browsingSession, content.getURL(), tab.favicons); }
            tab.notice = '';
          } catch (error) { tab.notice = error.message; }
        }
        break;
      case 'home': tabs.home(); icons.refresh(bookmarks, browsingSession); focusAddress(); break;
      case 'toggle-ui': toggleUI(); break;
      case 'minimize': window.minimize(); break;
      case 'maximize': window.isMaximized() ? window.unmaximize() : window.maximize(); break;
      case 'close': window.close(); return state;
      case 'exit': quit(); return state;
      case 'print': if (tab.mode === 'page') content.print({ silent: false }, (success, reason) => { if (!success && reason && !/cancel/i.test(reason)) { tab.notice = reason; publish(); } }); break;
      default: throw new Error('Unknown browser action.');
    }
    publishAll();
    return state;
  }
  async function tabCommand(command, id) {
    if (busy()) throw new Error('Please wait for the current change to finish.');
    if (command === 'new') { tabs.create(); focusAddress(); }
    else if (command === 'select') tabs.select(id);
    else if (command === 'close') {
      tabsBusy = true;
      try { await tabs.close(id); } finally { tabsBusy = false; }
    } else if (command === 'reopen') {
      const saved = data.reopen();
      if (saved) { const tab = tabs.create(saved.url); tab.pinned = saved.pinned; tab.content.setAudioMuted(saved.muted); sortTabs(); }
    } else if (command === 'reload') { const tab = tabs.get(id); if (tab.mode === 'page') tab.content.reload(); }
    else if (command === 'duplicate') { const tab = tabs.get(id); tabs.create(isWebUrl(tab.url) ? tab.url : null); }
    else if (command === 'pin-tab') { const tab = tabs.get(id); tab.pinned = !tab.pinned; sortTabs(); }
    else if (command === 'mute') { const tab = tabs.get(id); tab.content.setAudioMuted(!tab.content.isAudioMuted()); }
    else if (command === 'close-others') { for (const tab of [...tabs.items]) if (tab.id !== id) await tabs.close(tab.id); tabs.select(id); }
    else throw new Error('Unknown tab action.');
    publish();
    return { ok: true };
  }
  function find(command, text) {
    if (busy()) throw new Error('Please wait for the current change to finish.');
    if (command === 'open') {
      if (tabs.active.mode !== 'page') return { ok: true };
      exitVideo(); revealChrome();
      overlay = 'find'; downloadsPanelOpen = false;
    }
    tabs.find(command, text);
    if (command === 'open') {
      overlayView.webContents.focus(); overlayView.webContents.send('browser:focus-find');
    } else if (command === 'close') { if (overlay === 'find') overlay = null; chromeHeld = false; tabs.active.content.focus(); publish(); }
    return { ok: true };
  }
  function zoom(command) {
    if (busy()) throw new Error('Please wait for the current change to finish.');
    const steps = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    const content = tabs.active.content, factor = content.getZoomFactor();
    let next;
    if (command === 'in') next = steps.find(value => value > factor + 0.001) || 3;
    else if (command === 'out') next = steps.findLast(value => value < factor - 0.001) || 0.5;
    else if (command === 'reset') next = 1;
    else throw new Error('Unknown zoom action.');
    content.setZoomFactor(next);
    clearTimeout(zoomTimer); zoomNotice = true;
    zoomTimer = setTimeout(() => { zoomNotice = false; publish(); }, 1500);
    publish(); return { ok: true };
  }
  function keyboard(event, input) {
    if (input.type !== 'keyDown') return;
    if (busy()) { event.preventDefault(); return; }
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    let handled = true;
    if (key === 'f11') {
      chromeHeld = false; chromeRevealed = false; overlay = null;
      window.setFullScreen(!screenFullscreen);
    }
    else if (ctrl && input.shift && key === 'h') toggleUI();
    else if (ctrl && input.shift && key === 't') tabCommand('reopen').catch(() => {});
    else if (ctrl && key === 'h') ui('history');
    else if (ctrl && key === 'p' && !input.shift) action('print');
    else if (key === 'escape' && overlay && overlay !== 'suggestions') ui('close');
    else if (ctrl && key === 'f') find('open');
    else if (key === 'escape' && tabs.active.find.open) find('close');
    else if (ctrl && ['+', '=', 'add'].includes(key)) zoom('in');
    else if (ctrl && ['-', '_', 'subtract'].includes(key)) zoom('out');
    else if (ctrl && key === '0') zoom('reset');
    else if (key === 'escape' && videoTabId) exitVideo();
    else if (key === 'escape' && (hideUI || screenFullscreen)) {
      hideUI = false;
      if (screenFullscreen) window.setFullScreen(false);
      syncChrome();
    }
    else if (ctrl && key === 'l') focusAddress();
    else if (ctrl && key === 't') tabCommand('new').catch(() => {});
    else if (ctrl && key === 'w') tabCommand('close', tabs.activeId).catch(() => {});
    else if (ctrl && key === 'tab') {
      const index = tabs.items.indexOf(tabs.active);
      tabs.select(tabs.items[(index + (input.shift ? -1 : 1) + tabs.items.length) % tabs.items.length].id);
    } else if (ctrl && /^[1-9]$/.test(key)) {
      const index = key === '9' ? tabs.items.length - 1 : Number(key) - 1;
      if (tabs.items[index]) tabs.select(tabs.items[index].id);
    } else if (ctrl && key === 'd') action('bookmark');
    else if (input.alt && key === 'home') action('home');
    else if (ctrl && input.shift && key === 'p') action('pin');
    else if (key === 'f5' || (ctrl && key === 'r')) action('reload');
    else if (input.alt && key === 'arrowleft') action('back');
    else if (input.alt && key === 'arrowright') action('forward');
    else if (key === 'escape' && tabs.active.loading) { tabs.stop(); publish(); }
    else handled = false;
    if (handled) event.preventDefault();
  }

  function sortTabs() {
    tabs.items.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    for (const tab of tabs.items) window.contentView.addChildView(tab.view);
  }
  function ui(command, value) {
    if (command === 'size') { if (Number.isFinite(value)) { overlayHeight = Math.max(40, Math.min(1200, value)); layout(); } return { ok: true }; }
    if (command === 'bookmark-menu' || command === 'bookmark-edit') {
      const address = command === 'bookmark-menu' ? value?.url : value || bookmarkTarget;
      if (!bookmarks.list().some(item => item.url === address)) throw new Error('Bookmark not found.');
      bookmarkTarget = address;
      bookmarkAnchor = command === 'bookmark-menu' && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null;
    }
    if (command === 'tab-menu') {
      const tab = tabs.get(value);
      const run = command => () => tabCommand(command, tab.id).catch(error => { tabs.active.notice = error.message; publish(); });
      Menu.buildFromTemplate([
        { label: 'New tab', click: run('new') }, { label: 'Reload', enabled: tab.mode === 'page', click: run('reload') },
        { label: 'Duplicate', click: run('duplicate') }, { type: 'separator' },
        { label: tab.pinned ? 'Unpin tab' : 'Pin tab', click: run('pin-tab') },
        { label: tab.content.isAudioMuted() ? 'Unmute tab' : 'Mute', click: run('mute') }, { type: 'separator' },
        { label: 'Close', click: run('close') }, { label: 'Close others', enabled: tabs.items.length > 1, click: run('close-others') }
      ]).popup({ window }); return { ok: true };
    }
    if (command === 'bookmark-bar') { data.bookmarkBar(value); publishAll(); return { ok: true }; }
    if (command === 'suggest-select') { suggestionIndex = Math.max(0, Math.min(suggestions.length - 1, value)); publish(); return { ok: true }; }
    if (command === 'exit') { quit(); return { ok: true }; }
    if (command === 'print') { overlay = null; action('print'); return { ok: true }; }
    if (command === 'find') { find('open'); return { ok: true }; }
    if (!['menu', 'profiles', 'bookmark-menu', 'bookmark-edit', 'history', 'bookmarks', 'passwords', 'clear', 'downloads', 'password', 'fill', 'close'].includes(command)) throw new Error('Unknown browser control.');
    const next = command === 'close' || (overlay === command && !['bookmark-menu', 'bookmark-edit'].includes(command)) ? null : command;
    if (tabs.active.find.open && next !== 'find') tabs.find('close');
    overlay = next; downloadsPanelOpen = next === 'downloads';
    if (next === 'profiles') sitePanelOpen = false;
    overlayHeight = next === 'find' ? 52 : 420;
    if (overlay) { revealChrome(); overlayView.webContents.focus(); }
    else { chromeHeld = false; if (tabs.active.mode === 'page') tabs.active.content.focus(); }
    publish(); return { ok: true };
  }
  function suggest(text, anchor) {
    if (typeof text !== 'string' || text.length > 8192) throw new Error('Invalid address.');
    suggestions = data.suggest(text, bookmarks.list()); suggestionIndex = 0;
    if (anchor && ['x', 'y', 'width'].every(key => Number.isFinite(anchor[key]))) suggestionAnchor = anchor;
    overlay = suggestions.length ? 'suggestions' : null; overlayHeight = suggestions.length * 56 + 8;
    downloadsPanelOpen = false; publish(); return { ok: true, suggestions };
  }
  function loginPage(tab, info) {
    const origin = loginOrigin(tab.content.getURL()), candidate = tab.loginCandidate;
    if (info.failed) tab.loginCandidate = null;
    if (candidate && candidate.expires > Date.now() && candidate.origin === origin && !info.hasPassword && !info.failed && (tab.httpStatus === undefined || tab.httpStatus < 400)) {
      tab.passwordPrompt = candidate; tab.loginCandidate = null; overlay = 'password'; overlayHeight = 200; revealChrome();
    }
    tab.passwordOffer = info.hasPassword && origin ? passwords.list(origin) : [];
    publish();
  }
  async function password(command, id) {
    const tab = tabs.active;
    if (command === 'save') {
      const entry = tab.passwordPrompt;
      if (!entry || entry.origin !== loginOrigin(tab.content.getURL()) || entry.expires < Date.now()) throw new Error('This login prompt has expired.');
      passwords.save(entry.origin, entry.username, entry.password); tab.passwordPrompt = null; overlay = null;
    } else if (command === 'dismiss') { tab.passwordPrompt = null; overlay = null; }
    else if (command === 'delete') passwords.delete(id);
    else if (['show', 'copy', 'fill'].includes(command)) {
      const entry = passwords.get(id);
      if (command === 'fill') {
        if (entry.origin !== loginOrigin(tab.content.getURL())) throw new Error('Saved login belongs to another site.');
        tab.content.send('browser:login-fill', { origin: entry.origin, username: entry.username, password: entry.password }); overlay = null; tab.content.focus();
      } else if (command === 'copy') {
        const copied = entry.password; clipboard.writeText(copied);
        const timer = setTimeout(() => { try { if (clipboard.readText() === copied) clipboard.clear(); } catch {} }, 30000);
        timer.unref?.();
      }
      else return { ok: true, password: entry.password };
    } else throw new Error('Unknown password action.');
    publishAll(); return { ok: true };
  }
  async function clearData(choices) {
    if (!choices || ['history', 'cache', 'cookies', 'passwords'].some(key => typeof choices[key] !== 'boolean')) throw new Error('Choose the data to clear.');
    if (choices.cache) await browsingSession.clearCache();
    if (choices.cookies) { await browsingSession.clearStorageData({ storages: ['cookies'] }); await browsingSession.clearAuthCache(); }
    if (choices.history) { data.clear(); data.flush(); }
    if (choices.passwords) passwords.clear();
    for (const tab of tabs.items) { tab.loginCandidate = null; tab.passwordPrompt = null; if (choices.passwords) tab.passwordOffer = []; }
    suggestions = []; overlay = null; publishAll(); return { ok: true };
  }

  const controller = {
    profileId, get window() { return window; }, get tabs() { return tabs; }, get state() { return state; },
    publish, action, tabCommand, exitVideo, busy, find, zoom, ui, suggest, password, clearData, loginPage,
    get overlayContent() { return overlayView?.webContents; },
    resetPrivateData(choices) {
      for (const tab of tabs.items) { tab.loginCandidate = null; tab.passwordPrompt = null; if (choices.passwords) tab.passwordOffer = []; }
      suggestions = []; if (['suggestions', 'password', 'fill'].includes(overlay)) overlay = null;
    },
    pageActivity() { if (tabs.active) tabs.active.lastUserActivation = Date.now(); if (overlay && !['find', 'password'].includes(overlay)) ui('close'); },
    showDownloads() { if (tabs.active.find.open) tabs.find('close'); overlay = 'downloads'; overlayHeight = 380; downloadsPanelOpen = true; revealChrome(); },
    downloadPanel(open) { if (open === true && overlay !== 'downloads') ui('downloads'); else if (open !== true && overlay === 'downloads') ui('close'); return { ok: true }; },
    allowsFullscreen: (content, permission, origin) => !busy() && permission === 'fullscreen'
      && tabs.active?.content === content && isWebUrl(content.getURL()) && (!origin || isWebUrl(origin)),
    navigate(address) {
      if (busy()) throw new Error('Please wait for the current change to finish.');
      const url = resolveAddress(address);
      if (url) { overlay = null; suggestions = []; exitVideo(); tabs.load(url); }
      return { ok: true };
    },
    bookmark(command, address, title, newTitle) {
      if (busy()) throw new Error('Please wait for the current change to finish.');
      if (command === 'add') { bookmarks.add(address, title); icons.refresh(bookmarks, browsingSession); }
      else if (command === 'remove') bookmarks.remove(address);
      else if (command === 'reorder') bookmarks.reorder(address);
      else if (command === 'edit') { bookmarks.edit(address, title, newTitle); icons.refresh(bookmarks, browsingSession); overlay = null; }
      else throw new Error('Unknown bookmark action.');
      tabs.active.notice = ''; publishAll(); return { ok: true };
    },
    panel(open, height) {
      if (typeof open === 'boolean' && open !== (overlay === 'profiles')) return ui(open ? 'profiles' : 'close');
      if (Number.isFinite(height)) panelHeight = Math.max(0, Math.min(Math.ceil(height), window.getContentSize()[1] - chromeHeight() - 64));
      publish(); return { ok: true };
    },
    showAccess() { if (overlay === 'profiles') overlay = null; sitePanelOpen = false; exitVideo(); revealChrome(); },
    accessPanel(open) { sitePanelOpen = open === true && !!access.state(controller).siteOrigin; if (overlay === 'profiles') overlay = null; revealChrome(); return { ok: true }; },
    hold(hold) { chromeHeld = hold === true; if (chromeHeld) revealChrome(); return { ok: true }; },
    async close() { access.cancelWindow(controller); exitVideo(); await tabs.destroy(); if (!window.isDestroyed()) window.close(); }
  };
  window = new BrowserWindow({
    width: 480, height: 640, minWidth: 360, minHeight: 280, ...bounds,
    title: 'Mini Browser', backgroundColor: '#ffffff', show: false, frame: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, devTools: hidden }
  });
  overlayView = new WebContentsView({ webPreferences: { session: window.webContents.session,
    preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
    webSecurity: true, spellcheck: false, devTools: hidden } });
  overlayView.browserChrome = true; overlayView.setVisible(false); window.contentView.addChildView(overlayView);
  overlayView.setBackgroundColor('#00000000');
  overlayView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayView.webContents.on('will-navigate', event => event.preventDefault());
  overlayView.webContents.on('before-input-event', keyboard);
  window.removeMenu();
  tabs = new BrowserTabs({ window, session: browsingSession,
    favicon: (tab, urls) => {
      icons.refresh(bookmarks, browsingSession, tab.content.getURL(), urls, tab.iconAddresses);
      const url = tab.content.getURL();
      icons.tabIcon(browsingSession, urls, profiles.bookmarkDirectory(profileId)).then(icon => {
        if (!tab.content.isDestroyed() && tab.content.getURL() === url) { tab.icon = icon; tab.owner.changed(); }
      }).catch(() => {});
    },
    visited: (tab, url) => { try { data.visit(url, tab.title); } catch (error) { tab.notice = error.message; } },
    titleChanged: (tab, title) => { try { data.title(tab.url, title); } catch (error) { tab.notice = error.message; } },
    closedTab: tab => { try { data.remember(tab); } catch (error) { tab.notice = error.message; } },
    testing: hidden, changed: () => { publish(); onChanged?.(); }, keyboard, fullscreen: htmlFullscreen, beforeSwitch: (navigating = false) => {
      if (tabs?.active?.find.open) tabs.find('close');
      if (tabs?.active) { if (!navigating) tabs.active.loginCandidate = null; tabs.active.passwordPrompt = null; }
      overlay = null; downloadsPanelOpen = false;
      access.cancelWindow(controller); sitePanelOpen = false; exitVideo();
    } });
  if (!empty) {
    if (restore?.urls.length) {
      const restored = restore.urls.map(url => tabs.create(url, false));
      restored.forEach((tab, index) => { tab.pinned = restore.states?.[index]?.pinned === true; tab.content.setAudioMuted(restore.states?.[index]?.muted === true); });
      sortTabs();
      tabs.select(restored[restore.active]?.id || restored[0].id);
    } else tabs.create();
    tabs.active.notice = [bookmarks.error, data.notice, passwords.notice].filter(Boolean).join(' ');
  }
  onCreated(controller);
  icons.refresh(bookmarks, browsingSession);
  window.on('focus', () => onFocused(controller));
  window.webContents.on('before-input-event', keyboard);
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('resize', layout);
  window.on('always-on-top-changed', publish);
  window.on('maximize', publish);
  window.on('unmaximize', publish);
  window.on('enter-full-screen', () => { screenFullscreen = true; screenControlsShown = false; syncChrome(); });
  window.on('leave-full-screen', () => {
    screenFullscreen = false;
    exitVideo();
    syncChrome();
  });
  window.on('close', () => {
    onClosing(controller);
    access.cancelWindow(controller);
    if (!hidden) {
      try { fs.writeFileSync(path.join(dataDirectory, 'window.json'), JSON.stringify(window.getNormalBounds())); }
      catch (error) { console.error('Could not save window position:', error.message); }
    }
  });
  window.on('closed', () => {
    clearTimeout(zoomTimer);
    clearInterval(edgeTimer);
    tabs.destroy().catch(() => {});
    if (!overlayView.webContents.isDestroyed()) overlayView.webContents.close();
    onClosed(controller);
  });

  controller.ready = Promise.all([window.loadURL(SHELL_URL), overlayView.webContents.loadURL(SHELL_URL + '?overlay=1')]).then(() => {
    if (window.isDestroyed()) return;
    publish();
    if (!hidden) window.show();
  });
  // Register synchronously before loading the shell; callers may adopt a tab first.
  return controller;
}
module.exports = { createBrowserWindow };
