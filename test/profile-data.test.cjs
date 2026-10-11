'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ProfileData } = require('../src/profile-data.cjs');
const { PasswordStore } = require('../src/passwords.cjs');
const { TabRestore } = require('../src/tab-restore.cjs');
function fixture(t) {
  const dir = path.resolve(__dirname, '..', '.cache', 'unit-' + randomUUID());
  fs.mkdirSync(dir, { recursive: true }); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
test('history, closed tabs, bookmark suggestions and preferences persist separately by profile', t => {
  const root = fixture(t), a = new ProfileData(path.join(root, 'a')), b = new ProfileData(path.join(root, 'b'));
  a.visit('https://example.com/first', 'First history'); a.visit('https://example.com/second', 'Second history');
  a.remember({ url: 'https://example.com/first', pinned: true, content: { isAudioMuted: () => true } });
  a.bookmarkBar(false);
  const restarted = new ProfileData(path.join(root, 'a'));
  assert.equal(restarted.entries.length, 2); assert.equal(b.entries.length, 0); assert.equal(restarted.preferences.bookmarkBar, false);
  assert.deepEqual(restarted.reopen(), { url: 'https://example.com/first', pinned: true, muted: true }); assert.equal(restarted.reopen(), undefined);
  const suggestions = restarted.suggest('first', [{ url: 'https://example.com/first', title: 'First bookmark' }]);
  assert.equal(suggestions.length, 1); assert.equal(suggestions[0].source, 'bookmark');
  assert.equal(restarted.suggest('second', [])[0].source, 'history'); assert.deepEqual(restarted.suggest('unknown', []), []);
  restarted.clear(); assert.equal(new ProfileData(path.join(root, 'a')).entries.length, 0);
});
test('passwords require encryption, never store plaintext, and stay in their profile', t => {
  const root = fixture(t);
  // A deterministic stand-in lets this storage test run without Windows DPAPI.
  const cipher = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') };
  const a = new PasswordStore(path.join(root, 'a'), cipher), b = new PasswordStore(path.join(root, 'b'), cipher);
  a.save('https://example.com', 'alice', 'fixture-secret');
  const entry = a.list()[0]; assert.equal(entry.password, undefined); assert.equal(b.list().length, 0);
  assert.ok(!fs.readFileSync(a.file, 'utf8').includes('fixture-secret'));
  assert.equal(new PasswordStore(path.join(root, 'a'), cipher).get(entry.id).password, 'fixture-secret');
  assert.throws(() => a.save('http://example.com', 'alice', 'secret'));
  assert.throws(() => new PasswordStore(path.join(root, 'c'), { isEncryptionAvailable: () => false }).save('https://example.com', 'a', 'secret'));
  a.delete(entry.id); assert.equal(a.list().length, 0);
});
test('tab restore preserves active, pinned and muted tabs only inside their profile', t => {
  const root = fixture(t), restore = new TabRestore({ bookmarkDirectory: id => path.join(root, id) });
  const controller = { tabs: { activeId: 'two', items: [
    { id: 'one', url: 'https://example.com/one', pinned: true, content: { isAudioMuted: () => true } },
    { id: 'two', url: 'https://example.com/two', content: { isAudioMuted: () => false } },
    { id: 'blank', url: '' }
  ] } };
  restore.save('a', [controller], controller);
  assert.deepEqual(restore.read('a'), { urls: ['https://example.com/one', 'https://example.com/two'], states: [{ pinned: true, muted: true }, { pinned: false, muted: false }], active: 1 });
  assert.equal(restore.read('b'), null);
});
