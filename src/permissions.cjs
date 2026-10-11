'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isWebUrl } = require('./navigation.cjs');

const LABELS = Object.freeze({ microphone: 'Microphone', camera: 'Camera', location: 'Location',
  notifications: 'Notifications', clipboard: 'Read clipboard', speakers: 'Audio output',
  'pointer-lock': 'Capture mouse pointer', 'local-network': 'Local network',
  'local-fonts': 'Local fonts', 'idle-detection': 'Idle detection' });
const TYPES = Object.freeze({ geolocation: 'location', 'geolocation-approximate': 'location', notifications: 'notifications',
  'clipboard-read': 'clipboard', 'speaker-selection': 'speakers', pointerLock: 'pointer-lock',
  'local-network': 'local-network', 'local-network-access': 'local-network', 'loopback-network': 'local-network',
  'local-fonts': 'local-fonts', 'idle-detection': 'idle-detection' });
const AUTOMATIC = new Set(['clipboard-sanitized-write', 'persistent-storage', 'screen-wake-lock']);

function originOf(value) {
  if (!isWebUrl(value)) return null;
  return new URL(value).origin;
}
function secureOrigin(value) {
  const origin = originOf(value);
  if (!origin) return null;
  const url = new URL(origin);
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    || url.hostname === '[::1]' || /^127\./.test(url.hostname) ? origin : null;
}
function permissionKeys(permission, details = {}, check = false) {
  if (permission !== 'media') return TYPES[permission] ? [TYPES[permission]] : [];
  const types = check ? [details.mediaType] : details.mediaTypes;
  if (!Array.isArray(types) || !types.length || types.some(type => !['audio', 'video'].includes(type))) return [];
  return [...new Set(types.map(type => type === 'audio' ? 'microphone' : 'camera'))];
}
function hasLiveOrigin(content, origin) {
  try {
    return content.mainFrame?.framesInSubtree?.some(frame => {
      // Frames can disappear or become detached during a permission callback.
      try { return !!frame && !frame.detached && !frame.isDestroyed?.() && originOf(frame.url) === origin; }
      catch { return false; }
    }) === true;
  } catch { return false; }
}

class PermissionStore {
  constructor(directory, test = false) {
    this.file = test ? null : path.join(directory, 'permissions.json');
    this.entries = [];
    this.error = '';
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const seen = new Set();
      if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Invalid permissions');
      for (const item of saved.entries) {
        const key = JSON.stringify([item.topOrigin, item.origin, item.permission]);
        if (secureOrigin(item.topOrigin) !== item.topOrigin || secureOrigin(item.origin) !== item.origin
          || !Object.hasOwn(LABELS, item.permission) || !['allow', 'block'].includes(item.state) || seen.has(key)) throw new Error('Invalid permissions');
        seen.add(key);
      }
      this.entries = saved.entries;
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'Saved site permissions could not be read. The permission file has been kept unchanged.';
    }
  }
  get(topOrigin, origin, permission) {
    if (this.error) return 'block';
    return this.entries.find(e => e.topOrigin === topOrigin && e.origin === origin && e.permission === permission)?.state || 'ask';
  }
  list(topOrigin) {
    if (!topOrigin) return [];
    const rows = Object.keys(LABELS).map(permission => ({ topOrigin, origin: topOrigin, permission, state: this.get(topOrigin, topOrigin, permission) }));
    return [...rows, ...this.entries.filter(e => e.topOrigin === topOrigin && e.origin !== topOrigin)].map(e => ({ ...e, label: LABELS[e.permission] }));
  }
  save(entries) {
    if (this.error) throw new Error(this.error);
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, entries }, null, 2));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch {
        try { fs.unlinkSync(this.file + '.tmp'); } catch { /* No temporary file. */ }
        throw new Error('Could not save site permissions. Check that the browser data folder is writable.');
      }
    }
    this.entries = entries;
  }
  set(topOrigin, origin, permission, state) {
    if (secureOrigin(topOrigin) !== topOrigin || secureOrigin(origin) !== origin
      || !Object.hasOwn(LABELS, permission) || !['ask', 'allow', 'block'].includes(state)) throw new Error('Invalid site permission.');
    const entries = this.entries.filter(e => !(e.topOrigin === topOrigin && e.origin === origin && e.permission === permission));
    if (state !== 'ask') entries.push({ topOrigin, origin, permission, state });
    this.save(entries);
  }
  reset(topOrigin) { this.save(this.entries.filter(e => e.topOrigin !== topOrigin)); }
}

class PermissionManager {
  constructor({ profiles, testing, ownerOf, publishAll, allWindows }) {
    Object.assign(this, { profiles, testing, ownerOf, publishAll, allWindows });
    this.stores = new Map();
    this.pending = new Map();
  }
  store(id) {
    if (!this.stores.has(id)) this.stores.set(id, new PermissionStore(this.profiles.bookmarkDirectory(id), this.testing));
    return this.stores.get(id);
  }
  context(profileId, content, requestingUrl) {
    const controller = content && !content.isDestroyed() && this.ownerOf(content);
    if (!controller || controller.profileId !== profileId || controller.busy()
      || controller.tabs.active?.mode !== 'page' || controller.tabs.active.content !== content) return null;
    const topOrigin = secureOrigin(content.getURL());
    const origin = secureOrigin(requestingUrl);
    if (!topOrigin || !origin) return null;
    // Attribute embedded requests only to origins actually present in this page.
    if (!hasLiveOrigin(content, origin)) return null;
    const navigationId = controller.tabs.active.navigationId;
    return { controller, content, profileId, topOrigin, origin,
      valid: () => !content.isDestroyed() && this.ownerOf(content) === controller && !controller.busy()
        && controller.tabs.active?.content === content && controller.tabs.active.navigationId === navigationId
        && controller.tabs.active.mode === 'page'
        && secureOrigin(content.getURL()) === topOrigin
        && hasLiveOrigin(content, origin) };
  }
  check(profileId, content, permission, requestingOrigin, details = {}) {
    if (permission === 'fullscreen') return this.ownerOf(content)?.allowsFullscreen(content, permission, requestingOrigin) === true;
    const context = this.context(profileId, content, details.requestingUrl || requestingOrigin);
    // Notifications may be checked on behalf of an origin's service worker.
    if (!context) return !content && permission === 'notifications' && !!secureOrigin(requestingOrigin)
      && this.store(profileId).get(secureOrigin(requestingOrigin), secureOrigin(requestingOrigin), 'notifications') === 'allow';
    if (AUTOMATIC.has(permission) || permission === 'display-capture') return true;
    const keys = permissionKeys(permission, details, true);
    return keys.length > 0 && keys.every(key => this.store(profileId).get(context.topOrigin, context.origin, key) === 'allow');
  }
  request(profileId, content, permission, callback, details = {}) {
    if (permission === 'fullscreen') { callback(this.ownerOf(content)?.allowsFullscreen(content, permission, details.requestingUrl) === true); return; }
    const context = this.context(profileId, content, details.requestingUrl || details.securityOrigin);
    if (!context) { callback(false); return; }
    if (AUTOMATIC.has(permission) || permission === 'display-capture') { callback(true); return; }
    // Electron's getDisplayMedia preflight reports media with no camera/mic
    // types. The display handler below still requires a gesture and source choice.
    if (permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0) { callback(true); return; }
    const keys = permissionKeys(permission, details);
    const store = this.store(profileId);
    if (!keys.length || keys.some(key => store.get(context.topOrigin, context.origin, key) === 'block')) { callback(false); return; }
    const asking = keys.filter(key => store.get(context.topOrigin, context.origin, key) !== 'allow');
    if (!asking.length) { callback(true); return; }
    this.enqueue({ ...context, kind: 'permission', keys: asking, callback });
  }
  enqueue(request) {
    if ([...this.pending.values()].filter(p => p.controller === request.controller).length >= 8) { request.callback(request.kind === 'screen' ? null : false); return; }
    request.id = randomUUID();
    const cancel = () => this.finish(request, 'dismiss');
    const navigated = (_event, _url, inPlace) => { if (!inPlace) cancel(); };
    request.content.on('did-start-navigation', navigated);
    request.content.once('destroyed', cancel);
    request.content.once('render-process-gone', cancel);
    const timeout = setTimeout(cancel, 120000);
    request.cleanup = () => {
      clearTimeout(timeout);
      request.content.removeListener('did-start-navigation', navigated);
      request.content.removeListener('destroyed', cancel);
      request.content.removeListener('render-process-gone', cancel);
    };
    this.pending.set(request.id, request);
    request.controller.showAccess();
    this.publishAll();
  }
  finish(request, choice, sourceId, audio = false) {
    if (!this.pending.delete(request.id)) return;
    request.cleanup();
    let result = request.kind === 'screen' ? null : false;
    try {
      if (request.valid()) {
        if (request.kind === 'screen' && choice === 'share') {
          const source = request.sources.find(item => item.id === sourceId);
          if (!source) throw new Error('Choose a screen or window to share.');
          result = { video: source };
          if (request.audioRequested && audio === true && process.platform === 'win32') result.audio = 'loopback';
        } else if (request.kind === 'permission' && ['allow', 'block'].includes(choice)) {
          const store = this.store(request.profileId);
          // Commit a combined camera/microphone decision atomically.
          const entries = store.entries.filter(e => !(e.topOrigin === request.topOrigin && e.origin === request.origin && request.keys.includes(e.permission)));
          store.save([...entries, ...request.keys.map(permission => ({ topOrigin: request.topOrigin, origin: request.origin, permission, state: choice }))]);
          result = choice === 'allow';
        }
      }
    } catch (error) {
      if (request.controller.tabs.active) request.controller.tabs.active.notice = error.message;
    }
    try { request.callback(result); } catch { /* The requesting frame may already be gone. */ }
    this.publishAll();
  }
  respond(controller, id, choice, sourceId, audio) {
    const request = this.pending.get(id);
    if (!request || request.controller !== controller) throw new Error('This permission request has expired.');
    if (!['allow', 'block', 'dismiss', 'share'].includes(choice)) throw new Error('Invalid permission choice.');
    this.finish(request, choice, sourceId, audio);
    return { ok: true };
  }
  cancelWindow(controller) {
    for (const request of [...this.pending.values()]) if (request.controller === controller) this.finish(request, 'dismiss');
  }
  removeProfile(id) { this.stores.delete(id); }
  state(controller) {
    const tab = controller.tabs?.active;
    const origin = tab?.mode === 'page' && !tab.content.isDestroyed() ? secureOrigin(tab.content.getURL()) : null;
    const request = [...this.pending.values()].find(p => p.controller === controller);
    return { siteOrigin: origin, sitePermissions: origin ? this.store(controller.profileId).list(origin) : [],
      permissionError: this.store(controller.profileId).error,
      permissionPrompt: request ? { id: request.id, kind: request.kind, origin: request.origin, topOrigin: request.topOrigin,
        labels: request.keys?.map(key => LABELS[key]) || [], audioRequested: request.audioRequested === true,
        sources: request.sources?.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })) || [] } : null };
  }
  update(controller, command, origin, permission, state) {
    const topOrigin = secureOrigin(controller.tabs.active?.content.getURL());
    if (!topOrigin || controller.busy()) throw new Error('Open a secure website first.');
    const store = this.store(controller.profileId);
    if (command === 'reset') store.reset(topOrigin);
    else if (command === 'set') {
      if (origin !== topOrigin && !store.entries.some(e => e.topOrigin === topOrigin && e.origin === origin && e.permission === permission)) throw new Error('Site permission not found.');
      store.set(topOrigin, origin, permission, state);
    } else throw new Error('Unknown permission action.');
    // Reload matching profile pages to stop existing microphone/camera/share streams.
    for (const item of this.allWindows()) if (item.profileId === controller.profileId) {
      for (const tab of item.tabs.items) if (!tab.content.isDestroyed() && secureOrigin(tab.content.getURL()) === topOrigin) {
        this.cancelWindow(item); tab.content.reload();
      }
    }
    this.publishAll(); return { ok: true };
  }
  async share(profileId, request, callback) {
    const { webContents, desktopCapturer } = require('electron');
    const content = request.frame && webContents.fromFrame(request.frame);
    const context = this.context(profileId, content, request.securityOrigin);
    if (!context || !request.userGesture || !request.videoRequested) { callback(null); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } });
      if (!context.valid() || !sources.length) { callback(null); return; }
      this.enqueue({ ...context, kind: 'screen', sources, audioRequested: request.audioRequested, callback });
    } catch { callback(null); }
  }
}
module.exports = { PermissionStore, PermissionManager, permissionKeys, originOf, secureOrigin, LABELS };
