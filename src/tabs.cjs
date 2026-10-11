'use strict';
const { WebContentsView } = require('electron');
const { isWebUrl } = require('./navigation.cjs');
const { pageMenu } = require('./page-menu.cjs');
const { configurePageContents } = require('./page-compatibility.cjs');
const { recentlyActivated } = require('./download-policy.cjs');
const path = require('node:path');
let nextId = 0;
const allowedSubframeUrl = url => ['about:blank', 'about:srcdoc'].includes(url) || /^(?:blob|data):/i.test(url);

class BrowserTabs {
  constructor({ window, session, testing, changed, keyboard, fullscreen, beforeSwitch, favicon, visited, closedTab, titleChanged }) {
    Object.assign(this, { window, session, testing, changed, keyboard, fullscreen, beforeSwitch, favicon, visited, closedTab, titleChanged });
    this.items = [];
    this.activeId = null;
    this.closed = false;
  }
  get active() { return this.items.find((tab) => tab.id === this.activeId); }
  get(id) {
    const tab = this.items.find((item) => item.id === id);
    if (!tab) throw new Error('Tab not found.');
    return tab;
  }
  list() {
    return this.items.map(({ id, url, title, loading, mode, pinned, icon, content }) => ({ id, url, title, loading, mode, pinned: !!pinned,
      icon: icon || '', muted: content.isAudioMuted(), audible: content.isCurrentlyAudible() }));
  }
  create(url = null, activate = true) {
    if (url && !isWebUrl(url)) throw new Error('Use an http or https website address.');
    const tab = { id: `tab-${++nextId}`, url: '', title: '', loading: false,
      mode: 'welcome', error: '', notice: '', lastAddress: '', navigationId: 0, pinned: false, icon: '',
      find: { open: false, text: '', matches: 0, ordinal: 0, requestId: null } };
    tab.view = new WebContentsView({ webPreferences: {
      session: this.session, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: true,
      preload: path.join(__dirname, 'page-preload.cjs'),
      // HTML/video fullscreen fills this view without enlarging the floating window.
      disableHtmlFullscreenWindowResize: true, devTools: this.testing
    } });
    tab.content = tab.view.webContents;
    tab.content.setZoomMode('isolated');
    tab.owner = this;
    this.items.push(tab);
    this.window.contentView.addChildView(tab.view);
    tab.view.setVisible(false);
    this.bind(tab);
    if (activate || !this.active) this.select(tab.id);
    if (url) this.load(url, tab);
    this.changed();
    return tab;
  }
  select(id) {
    const next = this.get(id);
    if (next.id !== this.activeId) this.beforeSwitch();
    this.activeId = next.id;
    // Keep the visible mini-player rendering while another app has focus.
    // Background tabs retain Chromium's normal throttling.
    for (const tab of this.items) tab.content.setBackgroundThrottling(tab !== next);
    this.changed();
    if (next.mode === 'page') next.view.webContents.focus();
    return next;
  }
  layout({ width, height, top, hidden }) {
    const views = this.window.contentView.children.filter(view => !view.browserChrome);
    if (this.items.some((tab, index) => views[index] !== tab.view)) for (const tab of this.items) this.window.contentView.addChildView(tab.view);
    for (const tab of this.items) {
      const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
      const previous = tab.view.getBounds();
      if (Object.keys(bounds).some((key) => previous[key] !== bounds[key])) tab.view.setBounds(bounds);
      const visible = tab.id === this.activeId && tab.mode === 'page' && !hidden;
      if (tab.view.getVisible() !== visible) tab.view.setVisible(visible);
    }
  }
  stop(tab = this.active) {
    if (!tab) return;
    tab.navigationId++;
    tab.view.webContents.stop();
    tab.loading = false;
  }
  find(command, text, tab = this.active) {
    if (!tab || tab.content.isDestroyed()) return;
    const state = tab.find;
    if (command === 'close') {
      tab.content.stopFindInPage('clearSelection');
      Object.assign(state, { open: false, requestId: null, matches: 0, ordinal: 0 });
    } else if (command === 'open') {
      state.open = true;
      if (state.text) this.find('text', state.text, tab);
    }
    else if (['text', 'next', 'previous'].includes(command)) {
      if (!state.open || tab.mode !== 'page') return;
      if (command === 'text') {
        if (typeof text !== 'string' || text.length > 1024) throw new Error('Find text is too long.');
        tab.content.stopFindInPage('clearSelection');
        Object.assign(state, { text, matches: 0, ordinal: 0, requestId: null });
      }
      if (state.text) state.requestId = tab.content.findInPage(state.text, { forward: command !== 'previous', findNext: command === 'text' });
    } else throw new Error('Unknown find action.');
    this.changed();
  }
  load(url, tab = this.active) {
    if (!isWebUrl(url) || !tab) return;
    const requestId = ++tab.navigationId;
    Object.assign(tab, { lastAddress: url, url, mode: 'page', error: '', notice: '', loading: true });
    this.changed();
    tab.view.webContents.loadURL(url).catch((error) => {
      if (tab.owner.items.includes(tab) && requestId === tab.navigationId && error.code !== 'ERR_ABORTED'
        && error.errno !== -3 && tab.lastAddress === url && tab.mode !== 'error') {
        tab.owner.fail(tab, url, error.code || 'The website could not be reached.');
      }
    });
  }
  fail(tab, url, error) {
    Object.assign(tab, { mode: 'error', url, error, loading: false });
    this.changed();
  }
  home(tab = this.active) {
    this.beforeSwitch();
    this.stop(tab);
    Object.assign(tab, { mode: 'welcome', url: '', title: '', error: '', notice: '' });
    // Returning home leaves the site, including its camera/microphone streams.
    tab.content.loadURL('about:blank').catch(() => {});
    this.changed();
  }
  async dispose(tab) {
    tab.navigationId++;
    if (!this.window.isDestroyed()) {
      try { this.window.contentView.removeChildView(tab.view); }
      catch { /* Electron may already have detached an externally destroyed view. */ }
    }
    const content = tab.content;
    if (content.isDestroyed()) return;
    content.stop();
    await new Promise((resolve) => {
      content.once('destroyed', resolve);
      content.close({ waitForBeforeUnload: false });
    });
  }
  async close(id) {
    const tab = this.get(id);
    this.closedTab?.(tab);
    const index = this.items.indexOf(tab);
    if (id === this.activeId) this.beforeSwitch();
    this.items.splice(index, 1); // Ignore late events before destroying the view.
    await this.dispose(tab);
    if (id === this.activeId) this.activeId = this.items[Math.min(index, this.items.length - 1)]?.id || null;
    if (!this.items.length) this.create();
    else this.select(this.activeId);
    if (this.active.mode === 'page') this.active.view.webContents.focus();
  }
  async destroy() {
    this.closed = true;
    const previous = this.items.splice(0);
    this.activeId = null;
    await Promise.all(previous.map((tab) => this.dispose(tab)));
  }
  transfer(id, destination, index = destination.items.length) {
    if (this.closed || destination.closed || this.session !== destination.session) throw new Error('Tabs need the same profile.');
    const tab = this.get(id);
    const previous = this.items.indexOf(tab);
    index = Math.max(0, Math.min(index, destination.items.length));
    const pinnedCount = destination.items.filter(item => item.pinned).length;
    index = tab.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
    if (destination === this) {
      this.items.splice(previous, 1);
      this.items.splice(index > previous ? index - 1 : index, 0, tab);
      this.changed();
      return;
    }
    this.beforeSwitch();
    // Reparent the existing view. Reloading its URL would lose live page state.
    this.window.contentView.removeChildView(tab.view);
    try { destination.window.contentView.addChildView(tab.view); }
    catch (error) { this.window.contentView.addChildView(tab.view); throw error; }
    this.items.splice(previous, 1);
    if (this.activeId === id) this.activeId = this.items[Math.min(previous, this.items.length - 1)]?.id || null;
    tab.owner = destination;
    destination.items.splice(index, 0, tab);
    if (this.activeId) this.select(this.activeId);
    destination.select(id);
    this.changed();
  }
  bind(tab) {
    const content = tab.view.webContents;
    configurePageContents(content);
    const live = () => !tab.owner.closed && tab.owner.items.includes(tab);
    content.once('destroyed', () => {
      // A site's window.close() or an external close must not leave a dead tab.
      if (live()) tab.owner.close(tab.id).catch((error) => console.error('Could not close tab:', error.message));
    });
    const listen = (name, callback) => content.on(name, (...args) => { if (live()) callback(...args); });
    const notice = (message) => { tab.notice = message; tab.owner.changed(); };
    // Choosing a page menu item is a user action, however long the menu stayed open.
    const activated = () => { tab.lastUserActivation = Date.now(); };
    listen('context-menu', (_event, params) => {
      pageMenu(content, params, url => { if (live()) tab.owner.create(url); }, activated).popup({ window: tab.owner.window });
    });
    listen('found-in-page', (_event, result) => {
      if (!tab.find.open || result.requestId !== tab.find.requestId) return;
      Object.assign(tab.find, { matches: result.matches, ordinal: result.activeMatchOrdinal });
      tab.owner.changed();
    });
    listen('zoom-changed', (_event, direction) => {
      if (tab.owner.active === tab) tab.owner.keyboard({ preventDefault() {} }, { type: 'keyDown', key: direction === 'in' ? '+' : '-', control: true });
    });
    listen('page-favicon-updated', (_event, urls) => {
      tab.favicons = urls;
      tab.owner.favicon(tab, urls);
    });
    listen('audio-state-changed', () => tab.owner.changed());
    const openWindow = ({ url, disposition, features = '', referrer }) => {
      if (!live()) return { action: 'deny' };
      if (!recentlyActivated(tab)) { notice('Pop-up blocked.'); return { action: 'deny' }; }
      if (!isWebUrl(url)) { notice('Only http and https websites can be opened.'); return { action: 'deny' }; }
      if (disposition === 'new-window' || /(?:^|,)\s*(?:width|height)\s*(?:=|,|$)/i.test(features)) {
        const size = (key, fallback, minimum, maximum) => {
          const value = features.split(',').map(part => part.split('=').map(value => value.trim()))
            .find(([name]) => name.toLowerCase() === key)?.[1];
          const number = Number(value);
          return value && Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback;
        };
        return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: {
          parent: tab.owner.window, width: size('width', 480, 300, 800), height: size('height', 640, 240, 900),
          frame: true, autoHideMenuBar: true, show: !tab.owner.testing,
          webPreferences: { session: content.session, nodeIntegration: false, contextIsolation: true,
            sandbox: true, webSecurity: true, allowRunningInsecureContent: false, devTools: tab.owner.testing }
        } };
      }
      tab.owner.create(url, disposition !== 'background-tab');
      return { action: 'deny' };
    };
    const createdPopup = (popup) => {
      popup.removeMenu();
      const parent = popup.getParentWindow();
      const close = () => { if (!popup.isDestroyed()) popup.destroy(); };
      parent.once('closed', close);
      popup.once('closed', () => parent.removeListener('closed', close));
      const page = popup.webContents;
      page.miniBrowserOwnerTab = tab;
      configurePageContents(page);
      // Native window.open can retain Electron's fallback UA despite its session.
      page.setUserAgent(content.session.getUserAgent());
      page.setWindowOpenHandler(openWindow);
      page.on('before-input-event', (_event, input) => {
        if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'touchStart') tab.lastUserActivation = Date.now();
      });
      let popupOrigin = '';
      const updatePopupTitle = () => {
        let origin = '';
        try { origin = new URL(page.getURL()).origin; } catch {}
        if (origin === 'null') origin = '';
        if (origin) popupOrigin = origin;
        const host = popupOrigin;
        const title = page.getTitle();
        popup.setTitle(`${host || 'New window'}${title ? ` — ${title}` : ''}`);
      };
      page.on('page-title-updated', (event) => { event.preventDefault(); updatePopupTitle(); });
      page.on('did-navigate', updatePopupTitle);
      page.on('did-navigate-in-page', updatePopupTitle);
      page.on('did-start-navigation', (_event, url, _sameDocument, mainFrame) => { if (mainFrame) { try { popupOrigin = new URL(url).origin; } catch {} updatePopupTitle(); } });
      page.on('context-menu', (_event, params) => {
        if (live()) pageMenu(page, params, url => tab.owner.create(url), activated).popup({ window: popup });
      });
      page.on('did-create-window', createdPopup);
      page.on('will-attach-webview', event => event.preventDefault());
      for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
        page.on(name, event => {
          if (!event.isMainFrame && allowedSubframeUrl(event.url)) return;
          if (!isWebUrl(event.url)) { event.preventDefault(); if (live()) notice('Only http and https websites can be opened.'); }
        });
      }
    };
    content.setWindowOpenHandler(openWindow);
    listen('did-create-window', createdPopup);
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      listen(name, (event) => {
        if (!event.isMainFrame && allowedSubframeUrl(event.url)) return;
        if (!isWebUrl(event.url)) { event.preventDefault(); notice('Only http and https websites can be opened.'); }
      });
    }
    listen('content-bounds-updated', (event) => event.preventDefault());
    listen('will-attach-webview', (event) => event.preventDefault());
    listen('did-start-navigation', (event, url, _inPlace, mainFrame) => {
      if (!mainFrame || !isWebUrl(url)) return;
      if (!_inPlace) { tab.favicons = []; tab.icon = ''; tab.iconAddresses = [url]; tab.passwordPrompt = null; }
      if (tab.owner.active === tab) tab.owner.beforeSwitch(true);
      tab.lastAddress = url;
      if (event?.isRendererInitiated !== true && !event?.initiator) tab.url = url;
      Object.assign(tab, { mode: 'page', error: '', notice: '' });
      tab.owner.changed();
    });
    listen('did-redirect-navigation', (_event, url, _inPlace, mainFrame) => {
      if (mainFrame && isWebUrl(url)) tab.iconAddresses = [...new Set([...(tab.iconAddresses || []), url])].slice(-16);
    });
    listen('did-start-loading', () => { tab.loading = true; tab.owner.changed(); });
    listen('did-stop-loading', () => {
      tab.loading = false;
      if (tab.mode === 'page' && isWebUrl(content.getURL())) tab.url = content.getURL();
      tab.owner.changed();
    });
    for (const name of ['did-navigate', 'did-navigate-in-page']) {
      listen(name, (_event, url, ...details) => {
        if (name === 'did-navigate-in-page' && !details[0]) return;
        if (name === 'did-navigate') tab.httpStatus = details[0];
        if (tab.mode === 'page') tab.url = url;
        if (name === 'did-navigate-in-page' || !details[0] || (details[0] >= 200 && details[0] < 400)) tab.owner.visited?.(tab, url);
        tab.owner.changed();
      });
    }
    listen('page-title-updated', (_event, title) => { tab.title = title; tab.owner.titleChanged?.(tab, title); tab.owner.changed(); });
    listen('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame && code !== -3 && url === tab.lastAddress) tab.owner.fail(tab, url, description);
    });
    listen('render-process-gone', () => tab.owner.fail(tab, tab.lastAddress, 'The page stopped responding. Try loading it again.'));
    listen('before-input-event', (event, input) => {
      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'touchStart') tab.lastUserActivation = Date.now();
      if (tab.owner.active === tab) tab.owner.keyboard(event, input);
    });
    listen('enter-html-full-screen', () => { notice('Press Esc to exit full screen.'); tab.owner.fullscreen(tab, true); });
    listen('leave-html-full-screen', () => tab.owner.fullscreen(tab, false));
  }
}
module.exports = { BrowserTabs };
