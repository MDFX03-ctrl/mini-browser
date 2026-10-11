'use strict';
const { isWebUrl } = require('./navigation.cjs');
const path = require('node:path');
const { inlineIcon, iconSource } = require('./icon-decoder.cjs');
function webAddress(value, base) {
  try { const url = new URL(value, base); url.hash = ''; return isWebUrl(url.href) ? url.href : null; }
  catch { return null; }
}
function entities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, name) => {
    if (name[0] !== '#') return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name.toLowerCase()];
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
function iconAddress(value, base) { return inlineIcon(value) ? value : webAddress(value, base); }
// Read bounded, static metadata only. Never execute a bookmarked page to find its icon.
function iconLinks(html, address) {
  const clean = html.slice(0, 1048576).replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const links = []; let base = address, baseSeen = false;
  for (const match of clean.matchAll(/<(base|link)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = {};
    for (const attr of match[2].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g)) {
      const name = attr[1].toLowerCase();
      if (!Object.hasOwn(attributes, name)) attributes[name] = entities(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    if (match[1].toLowerCase() === 'base') {
      if (!baseSeen && attributes.href) { base = webAddress(attributes.href, address) || address; baseSeen = true; }
      continue;
    }
    const rel = (attributes.rel || '').toLowerCase().split(/\s+/);
    if (!rel.some(value => ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'].includes(value))) continue;
    const url = attributes.href && iconAddress(attributes.href, base);
    if (!url) continue;
    const svg = attributes.type === 'image/svg+xml' || /\.svg(?:\?|$)/i.test(url);
    links.push({ url, rank: svg ? 3 : rel.includes('icon') ? 0 : 1 });
    if (links.length >= 32) break;
  }
  return [...new Set(links.sort((a, b) => a.rank - b.rank).map(item => item.url))].slice(0, 8);
}

// Fetch site-published icons using the bookmark's profile session without cookies.
// The shell displays locally decoded PNGs; no remote image or third-party icon service.
class BookmarkIcons {
  constructor(changed, { retryDelays = [15000, 60000], request, renderImage } = {}) {
    this.changed = changed; this.retryDelays = retryDelays; this.request = request; this.renderImage = renderImage;
    this.tasks = new WeakMap(); this.queue = []; this.running = 0;
    this.tabCache = new WeakMap(); this.tabQueue = []; this.tabRunning = 0;
  }
  tabIcon(session, urls, directory) {
    const candidates = urls.filter(url => iconAddress(url)).slice(0, 8), key = JSON.stringify(candidates);
    if (!candidates.length) return Promise.resolve('');
    if (!this.tabCache.has(session)) this.tabCache.set(session, new Map());
    const cache = this.tabCache.get(session);
    if (cache.has(key)) return cache.get(key);
    const promise = new Promise(resolve => this.tabQueue.push(async () => {
      for (const address of candidates) {
        const response = await this.fetch(session, address);
        if (!response) continue;
        try { const icon = await this.decode(response.buffer, { file: path.join(directory, 'bookmarks.json') }, session, response.contentType, response.url); if (icon) return resolve(icon); } catch {}
      }
      cache.delete(key); resolve('');
    }));
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, promise); this.runTabIcons(); return promise;
  }
  runTabIcons() {
    while (this.tabRunning < 3 && this.tabQueue.length) {
      this.tabRunning++; this.tabQueue.shift()().finally(() => { this.tabRunning--; this.runTabIcons(); });
    }
  }
  refresh(store, session, address, advertised = [], aliases = []) {
    const addresses = new Set([address, ...aliases].map(value => webAddress(value)).filter(Boolean));
    const items = store.list().filter(item => !address || addresses.has(webAddress(item.url)));
    if (!this.tasks.has(store)) this.tasks.set(store, new Map());
    for (const item of items) {
      if (store.removed || (item.icon && !advertised.length)) continue;
      const candidates = [...new Set(advertised.filter(url => iconAddress(url)).slice(0, 8))];
      // Gmail's signed-out redirects can lose its icon metadata. The canonical
      // mail host publishes the service's favicon without requiring sign-in.
      if (['gmail.com', 'www.gmail.com', 'googlemail.com', 'www.googlemail.com'].includes(new URL(item.url).hostname)) {
        candidates.push('https://mail.google.com/favicon.ico');
      }
      candidates.push(new URL('/favicon.ico', item.url).href);
      const key = JSON.stringify(candidates), previous = this.tasks.get(store).get(item.url);
      if (!advertised.length && previous?.pending) continue;
      if (previous?.key === key && (previous.pending || (previous.success && item.icon) || Date.now() < previous.retryAt)) continue;
      clearTimeout(previous?.timer);
      const task = { store, session, address: item.url, candidates: [...new Set(candidates)], key, failures: 0, pending: true };
      this.tasks.get(store).set(item.url, task);
      this.queue.push(task);
    }
    this.run();
  }
  current(task) {
    return !task.store.removed && this.tasks.get(task.store)?.get(task.address) === task
      && task.store.list().some(item => item.url === task.address);
  }
  run() {
    while (this.running < 3 && this.queue.length) {
      const task = this.queue.shift(); this.running++;
      this.load(task).then(success => { task.success = success; }).catch(() => {}).finally(() => {
        task.pending = false; this.running--;
        if (!task.success && this.current(task)) {
          const delay = this.retryDelays[task.failures++];
          task.retryAt = Date.now() + (delay ?? 60000);
          if (delay !== undefined) {
            task.timer = setTimeout(() => {
              if (!this.current(task)) return;
              task.pending = true; this.queue.push(task); this.run();
            }, delay);
            task.timer.unref();
          }
        }
        this.run();
      });
    }
  }
  fetch(session, address, metadata = false) {
    const inline = inlineIcon(address);
    if (inline && !metadata) return Promise.resolve(inline);
    if (!isWebUrl(address)) return Promise.resolve(null);
    return new Promise(resolve => {
      let request, timer, settled = false, redirects = 0, url = address;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(result);
        try { request?.abort(); } catch { /* The native request may already be closed. */ }
      };
      try {
        const createRequest = this.request || require('electron').net.request;
        request = createRequest({ url, session, credentials: 'omit', redirect: 'manual',
          headers: { Accept: metadata ? 'text/html,application/xhtml+xml' : 'image/avif,image/webp,image/svg+xml,image/png,image/*;q=0.9,*/*;q=0.1',
            ...(session.getUserAgent ? { 'User-Agent': session.getUserAgent() } : {}) } });
        timer = setTimeout(() => finish(null), metadata ? 10000 : 6000);
        request.on('error', () => finish(null));
        // Electron fetch cancels manual redirects instead of exposing a 3xx Response.
        // ClientRequest lets us validate every hop before following it synchronously.
        request.on('redirect', (_status, _method, next) => {
          if (settled) return;
          if (!isWebUrl(next) || ++redirects > 5) return finish(null);
          url = next;
          try { request.followRedirect(); } catch { finish(null); }
        });
        request.on('response', response => {
          response.on('error', () => finish(null)); response.on('aborted', () => finish(null));
          const header = name => [].concat(response.headers[name] || []).join(', ');
          const limit = metadata ? 1048576 : 262144, chunks = []; let bytes = 0;
          if (response.statusCode < 200 || response.statusCode >= 300
            || (!metadata && Number(header('content-length')) > limit)
            || (metadata && !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(header('content-type')))) return finish(null);
          response.on('data', chunk => {
            if (settled) return;
            if (!metadata && bytes + chunk.length > limit) return finish(null);
            chunks.push(Buffer.from(chunk.subarray(0, limit - bytes))); bytes += chunk.length;
            if (metadata && bytes >= limit) finish({ buffer: Buffer.concat(chunks), url, contentType: header('content-type') });
          });
          response.on('end', () => finish({ buffer: Buffer.concat(chunks), url, contentType: header('content-type') }));
        });
        request.end();
      } catch { finish(null); }
    });
  }
  async decode(buffer, store, session, contentType, address) {
    if (store.removed || !this.renderImage) return null;
    const source = iconSource(buffer, contentType, address);
    if (!source) return null;
    const icon = await this.renderImage(session, source);
    return !store.removed && typeof icon === 'string' && icon.length <= 65536 && /^data:image\/png;base64,[A-Za-z\d+/]+={0,2}$/.test(icon) ? icon : null;
  }
  async load(task) {
    const { store, session, address, candidates } = task;
    const seen = new Set();
    const discovered = [];
    const tryIcons = async (urls, readMetadata = false) => {
      for (const url of urls) {
        if (!this.current(task)) return false;
        if (seen.has(url)) continue; seen.add(url);
        const response = await this.fetch(session, url);
        if (!response || !this.current(task)) continue;
        let icon;
        try { icon = await this.decode(response.buffer, store, session, response.contentType, response.url); } catch { /* Try static metadata below. */ }
        if (!this.current(task)) return false;
        if (!icon) {
          // Decode first: some image servers send text/html for actual images.
          // A real HTML favicon response can still advertise the site's icon.
          if (readMetadata && /^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.contentType)) discovered.push(...iconLinks(response.buffer.toString('utf8'), response.url));
          continue;
        }
        if (store.setIcon(address, icon)) this.changed();
        return true;
      }
      return false;
    };
    if (await tryIcons(candidates, true)) return true;
    if (await tryIcons([...new Set(discovered)].slice(0, 8))) return true;
    if (!this.current(task)) return false;
    const page = await this.fetch(session, address, true);
    if (!page || !this.current(task)) return false;
    return tryIcons([...iconLinks(page.buffer.toString('utf8'), page.url), new URL('/favicon.ico', page.url).href]);
  }
}
module.exports = { BookmarkIcons, iconLinks };
