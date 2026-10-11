'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const validId = (id) => id === 'default' || (typeof id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id));
function validPicture(value) {
  if (typeof value !== 'string' || value.length > 131072 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value.slice(22), 'base64');
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 128
    && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 128;
}

function profileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Enter a profile name between 1 and 40 characters.');
  }
  return value.trim();
}

class ProfileStore {
  constructor(directory, test = false) {
    this.directory = directory;
    this.test = test;
    this.file = test ? null : path.join(directory, 'profiles.json');
    this.data = { version: 1, activeId: 'default', profiles: [{ id: 'default', name: 'Default' }], pendingDeletion: [] };
    if (test) return; // Test mode never opens profiles.json, even if it already exists.
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.profiles) || !saved.profiles.length
        || saved.profiles.some((p) => !validId(p.id) || profileName(p.name) !== p.name || (p.picture !== undefined && !validPicture(p.picture)))
        || new Set(saved.profiles.map((p) => p.id)).size !== saved.profiles.length
        || !saved.profiles.some((p) => p.id === saved.activeId)
        || !Array.isArray(saved.pendingDeletion) || saved.pendingDeletion.some((id) => !validId(id)
          || saved.profiles.some((p) => p.id === id))) throw new Error('Invalid profiles');
      this.data = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Saved profiles could not be read. profiles.json has been kept unchanged.');
      this.commit(this.data);
    }
  }

  list() { return this.data.profiles.map((p) => ({ ...p })); }
  reorder(ids) { this.commit({ ...this.data, profiles: require('./ordering.cjs').reorder(this.list(), ids, 'id') }); }
  active() { return this.get(this.data.activeId); }
  get(id) {
    const profile = this.data.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Profile not found.');
    return { ...profile };
  }
  partition(id) {
    this.get(id);
    return this.test ? (id === 'default' ? 'test-pages' : `test-profile-${id}`)
      : (id === 'default' ? 'persist:pages' : `persist:profile-${id}`);
  }
  bookmarkDirectory(id) {
    if (!validId(id)) throw new Error('Invalid profile id.');
    return id === 'default' ? this.directory : path.join(this.directory, 'profiles', id);
  }
  storageDirectory(id) {
    if (!validId(id)) throw new Error('Invalid profile id.');
    return path.join(this.directory, 'session', 'Partitions', id === 'default' ? 'pages' : `profile-${id}`);
  }
  commit(data) {
    if (this.file) {
      const temporary = `${this.file}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
        fs.renameSync(temporary, this.file);
      } catch {
        try { fs.unlinkSync(temporary); } catch { /* Nothing to remove. */ }
        throw new Error('Could not save profiles. Check that the browser data folder is writable.');
      }
    }
    this.data = data;
  }
  create(name) {
    name = profileName(name);
    const profile = { id: randomUUID(), name };
    this.commit({ ...this.data, profiles: [...this.list(), profile] });
    return profile;
  }
  rename(id, name) {
    this.get(id);
    name = profileName(name);
    this.commit({ ...this.data, profiles: this.list().map((p) => p.id === id ? { ...p, name } : p) });
  }
  picture(id, picture) {
    this.get(id);
    if (picture !== null && !validPicture(picture)) throw new Error('Choose a PNG, JPEG, or WebP profile picture.');
    this.commit({ ...this.data, profiles: this.list().map(profile => {
      if (profile.id !== id) return profile;
      const updated = { ...profile }; if (picture === null) delete updated.picture; else updated.picture = picture; return updated;
    }) });
  }
  select(id) {
    this.get(id);
    this.commit({ ...this.data, activeId: id });
  }
  remove(id) {
    this.get(id);
    if (this.data.profiles.length === 1) throw new Error('Keep at least one profile.');
    if (id === this.data.activeId) throw new Error('Switch profiles before deleting the active profile.');
    this.commit({ ...this.data, profiles: this.list().filter((p) => p.id !== id),
      pendingDeletion: [...this.data.pendingDeletion, id] });
  }
  cleanupDeleted() {
    for (const id of [...this.data.pendingDeletion]) {
      // Chromium holds partition database locks until exit. Only remove the physical
      // directory on the next launch, before any session for this id can be created.
      fs.rmSync(this.storageDirectory(id), { recursive: true, force: true });
      this.deleteBookmarks(id);
      this.commit({ ...this.data, pendingDeletion: this.data.pendingDeletion.filter((item) => item !== id) });
    }
  }
  deleteBookmarks(id) {
    if (id === 'default') {
      for (const name of ['bookmarks.json', 'permissions.json', 'tabs.json', 'history.json', 'preferences.json', 'passwords.json']) {
        fs.rmSync(path.join(this.directory, name), { force: true }); fs.rmSync(path.join(this.directory, name + '.tmp'), { force: true });
      }
    } else fs.rmSync(this.bookmarkDirectory(id), { recursive: true, force: true });
  }
}

module.exports = { ProfileStore, profileName };
