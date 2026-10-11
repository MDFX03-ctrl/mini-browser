'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, shell } = require('electron');
const { riskyExtension, allowDownload } = require('./download-policy.cjs');

// Reserve the destination atomically, including downloads started concurrently.
function reserveDownload(directory, filename) {
  fs.mkdirSync(directory, { recursive: true });
  let name = path.win32.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  const extension = path.extname(name), stem = name.slice(0, name.length - extension.length);
  for (let suffix = 0; ; suffix++) {
    const destination = path.join(directory, suffix ? `${stem} (${suffix})${extension}` : name);
    try { fs.closeSync(fs.openSync(destination, 'wx')); return destination; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

class Downloads {
  constructor(ownerOf) { this.ownerOf = ownerOf; this.records = new Map(); }
  list(owner) {
    return [...this.records.values()].filter(record => record.owner === owner && record.profileId === owner.profileId)
      .map(({ id, name, path: destination, received, total, state, error, item, confirmed }) => ({ id, name, path: destination, received, total, state, error, confirmationRequired: !!confirmed, cancellable: !!item }));
  }
  start(profileId, event, item, content) {
    const owner = this.ownerOf(content);
    if (!owner || owner.profileId !== profileId || owner.window.isDestroyed()) { event.preventDefault(); return; }
    const tab = owner.tabs.items.find(candidate => candidate.content === content) || content.miniBrowserOwnerTab;
    let referrerUrl = '';
    try { referrerUrl = content.getURL(); } catch {}
    if (!allowDownload(tab)) {
      event.preventDefault();
      const error = 'Automatic download blocked. Interact with the page before downloading again.';
      tab.notice = error;
      const record = { id: randomUUID(), owner, profileId, item: null, name: item.getFilename(), path: '', received: 0, total: item.getTotalBytes(), state: 'blocked', error };
      this.records.set(record.id, record); owner.showDownloads(); owner.publish(); return;
    }
    const record = { id: randomUUID(), owner, profileId, item, name: item.getFilename(), path: '', received: 0, total: item.getTotalBytes(), state: 'progressing', error: '', confirmed: false };
    this.records.set(record.id, record);
    try {
      record.path = reserveDownload(app.getPath('downloads'), record.name);
      record.name = path.basename(record.path);
      item.setSavePath(record.path);
    } catch (error) {
      event.preventDefault(); record.state = 'interrupted'; record.error = error.message; record.item = null;
      if (record.path) { try { fs.unlinkSync(record.path); } catch { /* The destination may already be gone. */ } }
      owner.showDownloads(); return;
    }
    const update = () => {
      record.received = item.getReceivedBytes(); record.total = item.getTotalBytes();
      // Throttle, not debounce: continuous progress events must not postpone every update.
      if (!owner.window.isDestroyed() && !record.progressTimer) {
        record.progressTimer = setTimeout(() => { record.progressTimer = null; if (!owner.window.isDestroyed()) owner.publish(); }, 250);
        record.progressTimer.unref?.();
      }
    };
    item.on('updated', (_event, state) => {
      record.state = state;
      record.error = state === 'interrupted' ? 'Download interrupted. Check your connection and available disk space.' : '';
      update();
    });
    item.once('done', (_event, state) => {
      record.state = state;
      record.error = state === 'interrupted' ? 'Download failed: interrupted. Check your connection and available disk space.' : '';
      record.item = null; update();
      clearTimeout(record.progressTimer); record.progressTimer = null;
      if (!owner.window.isDestroyed()) owner.publish();
      if (state === 'completed') {
        const details = `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${item.getURL()}\r\nReferrerUrl=${referrerUrl}\r\n`;
        try { fs.writeFileSync(`${record.path}:Zone.Identifier`, details, 'utf8'); } catch {}
      }
      if (state !== 'completed') { try { fs.unlinkSync(record.path); } catch { /* Chromium may have removed it. */ } }
    });
    owner.showDownloads();
  }
  async command(owner, command, id) {
    const record = this.records.get(id);
    if (!record || record.owner !== owner || record.profileId !== owner.profileId) throw new Error('Download not found.');
    if (command === 'cancel') { if (record.item) record.item.cancel(); }
    else if (['open', 'show'].includes(command) && record.state === 'completed') {
      if (command === 'show') shell.showItemInFolder(record.path);
      else {
        if (riskyExtension(record.name) && !record.confirmed) { record.confirmed = true; owner.publish(); return { ok: false, confirmationRequired: true }; }
        const error = await shell.openPath(record.path); if (error) { record.error = error; owner.publish(); throw new Error(error); }
      }
    } else throw new Error('Download is not ready.');
    return { ok: true };
  }
  close(owner) {
    for (const record of this.records.values()) if (record.owner === owner) {
      if (record.item) record.item.cancel();
      this.records.delete(record.id);
    }
  }
}
module.exports = { Downloads, reserveDownload };
