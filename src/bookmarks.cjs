'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isWebUrl } = require('./navigation.cjs');

function normalizeBookmark(address, title = '') {
  if (typeof address !== 'string' || address.length > 8192 || typeof title !== 'string') {
    throw new Error('Enter a valid website address and name.');
  }
  let url = address.trim();
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^[^:/\s]+:\d+(?:[/?#]|$)/.test(url)) {
      throw new Error('Bookmarks need an http or https website address.');
    }
    url = `https://${url}`;
  }
  if (!address.trim() || /\s/.test(url) || !isWebUrl(url)) {
    throw new Error('Enter a valid website address.');
  }
  url = new URL(url).href;
  return { url, title: title.trim().slice(0, 120) || new URL(url).hostname };
}

class BookmarkStore {
  constructor(directory) {
    this.file = path.join(directory, 'bookmarks.json');
    this.items = [];
    this.error = '';
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Invalid bookmark data');
      const seen = new Set();
      this.items = saved.map((item) => ({ ...normalizeBookmark(item.url, item.title), ...(validIcon(item.icon) ? { icon: item.icon } : {}) })).filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'Saved bookmarks could not be read. Your bookmark file has been kept unchanged.';
    }
  }

  list() { return this.items.map((item) => ({ ...item })); }

  reorder(urls) { return this.save(require('./ordering.cjs').reorder(this.items, urls, 'url')); }

  save(items) {
    if (this.error) throw new Error(this.error);
    const temporary = `${this.file}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(items, null, 2), 'utf8');
      fs.renameSync(temporary, this.file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* No temporary file to remove. */ }
      throw new Error('Could not save bookmarks. Check that the browser data folder is writable.');
    }
    this.items = items;
    return this.list();
  }

  add(address, title) {
    const bookmark = normalizeBookmark(address, title);
    if (this.error) throw new Error(this.error);
    if (this.items.some((item) => item.url === bookmark.url)) return this.list();
    return this.save([...this.items, bookmark]);
  }

  remove(address) {
    const { url } = normalizeBookmark(address);
    if (this.error) throw new Error(this.error);
    return this.save(this.items.filter((item) => item.url !== url));
  }
  edit(originalAddress, address, title) {
    const original = normalizeBookmark(originalAddress).url;
    const updated = normalizeBookmark(address, title);
    if (!this.items.some(item => item.url === original)) throw new Error('Bookmark not found.');
    if (this.items.some(item => item.url === updated.url && item.url !== original)) throw new Error('This address is already bookmarked.');
    return this.save(this.items.map(item => item.url === original
      ? { ...updated, ...(updated.url === original && item.icon ? { icon: item.icon } : {}) } : item));
  }
  setIcon(address, icon) {
    if (!validIcon(icon) || this.removed || !this.items.some(item => item.url === address && item.icon !== icon)) return false;
    this.save(this.items.map(item => item.url === address ? { ...item, icon } : item)); return true;
  }
}
function validIcon(icon) { return typeof icon === 'string' && icon.length <= 65536 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(icon); }

module.exports = { BookmarkStore, normalizeBookmark };
