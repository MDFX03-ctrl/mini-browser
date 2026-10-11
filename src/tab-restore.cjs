'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isWebUrl } = require('./navigation.cjs');

class TabRestore {
  constructor(profiles) { this.profiles = profiles; }
  file(id) { return path.join(this.profiles.bookmarkDirectory(id), 'tabs.json'); }
  read(id) {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      if (!Array.isArray(saved.urls) || saved.urls.length > 1000 || saved.urls.some(url => typeof url !== 'string' || !isWebUrl(url))) return null;
      return { urls: saved.urls, states: saved.urls.map((_, index) => ({ pinned: saved.states?.[index]?.pinned === true, muted: saved.states?.[index]?.muted === true })), active: Number.isInteger(saved.active) ? Math.max(0, Math.min(saved.active, saved.urls.length - 1)) : 0 };
    } catch { return null; }
  }
  save(id, controllers, focused) {
    const urls = [], states = []; let active = 0;
    for (const controller of controllers) for (const tab of controller.tabs.items) {
      if (!isWebUrl(tab.url)) continue;
      if (controller === focused && tab.id === controller.tabs.activeId) active = urls.length;
      urls.push(tab.url);
      states.push({ pinned: !!tab.pinned, muted: tab.content.isAudioMuted() });
    }
    // Start pages alone are not a session: keep the last real one on offer.
    if (!urls.length) return;
    const file = this.file(id), temporary = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ urls: urls.slice(0, 1000), states: states.slice(0, 1000), active: Math.min(active, 999) }));
      fs.renameSync(temporary, file);
    } catch (error) { console.error('Could not save tabs:', error.message); }
  }
}
module.exports = { TabRestore };
