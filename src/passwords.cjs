'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { read, write } = require('./profile-data.cjs');
const { isWebUrl } = require('./navigation.cjs');
function loginOrigin(url) {
  if (!isWebUrl(url)) return null;
  const address = new URL(url);
  return address.protocol === 'https:' || address.hostname === 'localhost' || address.hostname.endsWith('.localhost')
    || address.hostname === '[::1]' || /^127\./.test(address.hostname) ? address.origin : null;
}
class PasswordStore {
  constructor(directory, cipher) {
    this.file = path.join(directory, 'passwords.json'); this.cipher = cipher;
    this.entries = read(this.file, []);
    if (!Array.isArray(this.entries) || this.entries.some(entry => typeof entry.id !== 'string' || loginOrigin(entry.origin) !== entry.origin
      || typeof entry.username !== 'string' || typeof entry.encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.encrypted))) {
      throw new Error('Invalid password file. The original file was preserved.');
    }
  }
  list(origin) { return this.entries.filter(entry => !origin || entry.origin === origin).map(({ id, origin, username }) => ({ id, origin, username })); }
  save(origin, username, password) {
    if (loginOrigin(origin) !== origin || typeof username !== 'string' || username.length > 1024
      || typeof password !== 'string' || !password || password.length > 8192) throw new Error('Invalid login.');
    if (!this.cipher.isEncryptionAvailable()) throw new Error('Windows password encryption is unavailable. No password was saved.');
    const previous = this.entries.find(entry => entry.origin === origin && entry.username === username);
    const entry = { id: previous?.id || randomUUID(), origin, username, encrypted: this.cipher.encryptString(password).toString('base64') };
    const entries = [...this.entries.filter(item => item.id !== entry.id), entry]; write(this.file, entries); this.entries = entries;
  }
  get(id) {
    const entry = this.entries.find(entry => entry.id === id); if (!entry) throw new Error('Saved login not found.');
    if (!this.cipher.isEncryptionAvailable()) throw new Error('Windows password encryption is unavailable.');
    return { ...entry, password: this.cipher.decryptString(Buffer.from(entry.encrypted, 'base64')) };
  }
  delete(id) { const entries = this.entries.filter(entry => entry.id !== id); write(this.file, entries); this.entries = entries; }
  clear() { write(this.file, []); this.entries = []; }
}
module.exports = { PasswordStore, loginOrigin };
