'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isWebUrl } = require('./navigation.cjs');
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Saved browser data could not be read. The original file was preserved.'); }
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); }
  catch { try { fs.unlinkSync(file + '.tmp'); } catch {} throw new Error('Could not save browser data.'); }
}
class ProfileData {
  constructor(directory) {
    this.file = path.join(directory, 'history.json'); this.preferencesFile = path.join(directory, 'preferences.json');
    const data = read(this.file, { entries: [], closed: [] });
    if (!Array.isArray(data.entries) || !Array.isArray(data.closed)
      || data.entries.some(entry => !isWebUrl(entry.url) || typeof entry.title !== 'string' || !Number.isFinite(entry.visited))
      || data.closed.some(entry => !isWebUrl(entry.url))) throw new Error('Invalid history file. The original file was preserved.');
    this.entries = data.entries.slice(0, 5000); this.closed = data.closed.slice(-25);
    this.preferences = { bookmarkBar: read(this.preferencesFile, {}).bookmarkBar !== false };
  }
  save(entries = this.entries, closed = this.closed) { write(this.file, { entries, closed }); this.entries = entries; this.closed = closed; }
  visit(url, title = '') {
    if (!isWebUrl(url)) return;
    const previous = this.entries.find(entry => entry.url === url);
    this.save([{ url, title: title.slice(0, 300) || previous?.title || url, visited: Date.now(), visits: (previous?.visits || 0) + 1 }, ...this.entries.filter(entry => entry.url !== url)].slice(0, 5000));
  }
  title(url, title) {
    if (!title || !this.entries.some(entry => entry.url === url && entry.title !== title)) return;
    this.save(this.entries.map(entry => entry.url === url ? { ...entry, title: title.slice(0, 300) } : entry));
  }
  remember(tab) {
    if (isWebUrl(tab.url)) this.save(this.entries, [...this.closed, { url: tab.url, pinned: !!tab.pinned, muted: tab.content.isAudioMuted() }].slice(-25));
  }
  reopen() { const entry = this.closed.at(-1); if (entry) this.save(this.entries, this.closed.slice(0, -1)); return entry; }
  clear() { this.save([], []); }
  bookmarkBar(show) { const preferences = { bookmarkBar: show === true }; write(this.preferencesFile, preferences); this.preferences = preferences; }
  suggest(text, bookmarks) {
    const query = String(text).trim().toLowerCase().slice(0, 2048); if (!query) return [];
    const seen = new Set(), entries = [];
    for (const [source, items] of [['bookmark', bookmarks], ['history', this.entries]]) for (const item of items) {
      if (seen.has(item.url) || !`${item.title} ${item.url}`.toLowerCase().includes(query)) continue;
      seen.add(item.url); entries.push({ url: item.url, title: item.title, source, icon: item.icon || '',
        score: item.url.toLowerCase().startsWith(query) || item.title.toLowerCase().startsWith(query) ? 0 : 1 });
    }
    return entries.sort((a, b) => a.score - b.score).slice(0, 8).map(({ score, ...entry }) => entry);
  }
}
module.exports = { ProfileData, write, read };
