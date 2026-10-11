'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProfileStore } = require('../src/profiles.cjs');
const { BookmarkStore } = require('../src/bookmarks.cjs');
const temporaryRoot = path.resolve(__dirname, '..', '.cache', 'profile-unit-tests');
fs.mkdirSync(temporaryRoot, { recursive: true });
test('profile order persists without changing the selected profile or its partition', (t) => {
  const dir = directory(t), store = new ProfileStore(dir);
  const work = store.create('Work');
  store.select(work.id); store.reorder([work.id, 'default']);
  const reopened = new ProfileStore(dir);
  assert.deepEqual(reopened.list().map(p => p.id), [work.id, 'default']);
  assert.equal(reopened.active().id, work.id);
  assert.equal(reopened.partition('default'), 'persist:pages');
  for (const ids of [null, ['default'], [work.id, work.id], [work.id, '../escape']]) {
    assert.throws(() => store.reorder(ids)); assert.deepEqual(store.list(), reopened.list());
  }
});
function directory(t) {
  const dir = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.ok(resolved.startsWith(fs.realpathSync(temporaryRoot) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}

test('profile pictures persist locally, stay with their profile, and reject external or oversized images', t => {
  const dir = directory(t), profiles = new ProfileStore(dir), work = profiles.create('Work');
  const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII=';
  profiles.picture('default', picture); profiles.rename('default', 'Personal');
  assert.equal(new ProfileStore(dir).get('default').picture, picture);
  assert.equal(profiles.get(work.id).picture, undefined);
  for (const invalid of ['https://example.com/pic.png', 'data:image/svg+xml;base64,PHN2Zz4=', picture + 'a'.repeat(131072), 'data:image/png;base64,AAAA']) assert.throws(() => profiles.picture('default', invalid));
  assert.equal(profiles.get('default').picture,picture);
  profiles.picture('default',null); assert.equal(new ProfileStore(dir).get('default').picture,undefined);
});

test('first launch preserves legacy partition and bookmark file; ids and selection survive restart', (t) => {
  const dir = directory(t);
  new BookmarkStore(dir).add('example.com', 'Existing bookmark');
  const profiles = new ProfileStore(dir);
  assert.equal(profiles.partition('default'), 'persist:pages');
  assert.equal(profiles.bookmarkDirectory('default'), dir);
  assert.equal(new BookmarkStore(profiles.bookmarkDirectory('default')).list()[0].title, 'Existing bookmark');
  const work = profiles.create('Work');
  const personal = profiles.create('Personal');
  assert.notEqual(profiles.partition(work.id), profiles.partition(personal.id));
  assert.equal(profiles.partition(work.id), `persist:profile-${work.id}`);
  profiles.rename(work.id, 'Business');
  profiles.select(work.id);
  const reopened = new ProfileStore(dir);
  assert.deepEqual(reopened.active(), { id: work.id, name: 'Business' });
  assert.deepEqual(reopened.list(), profiles.list());
});

test('profile validation, final-profile protection, and deletion cleanup cannot affect other data', (t) => {
  const dir = directory(t);
  const profiles = new ProfileStore(dir);
  assert.throws(() => profiles.remove('default'), /at least one/);
  for (const name of ['', '   ', 'a'.repeat(41), '\nBad']) assert.throws(() => profiles.create(name));
  assert.throws(() => profiles.select('../other'));
  assert.throws(() => profiles.bookmarkDirectory('../other'));
  const work = profiles.create('Work');
  const workDirectory = profiles.bookmarkDirectory(work.id);
  fs.mkdirSync(workDirectory, { recursive: true });
  new BookmarkStore(workDirectory).add('example.com');
  fs.mkdirSync(profiles.storageDirectory(work.id), { recursive: true });
  fs.writeFileSync(path.join(profiles.storageDirectory(work.id), 'fixture'), 'private');
  fs.writeFileSync(path.join(dir, 'window.json'), 'global bounds');
  profiles.select(work.id);
  assert.throws(() => profiles.remove(work.id), /Switch profiles/);
  profiles.select('default');
  profiles.remove(work.id);
  profiles.cleanupDeleted();
  assert.equal(fs.existsSync(workDirectory), false);
  assert.equal(fs.existsSync(profiles.storageDirectory(work.id)), false);
  assert.equal(fs.readFileSync(path.join(dir, 'window.json'), 'utf8'), 'global bounds');
  assert.deepEqual(new ProfileStore(dir).data.pendingDeletion, []);
});

test('corrupt profile metadata is preserved and test mode never reads or overwrites profiles.json', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new ProfileStore(dir), /kept unchanged/);
  const profiles = new ProfileStore(dir, true);
  assert.equal(profiles.partition('default'), 'test-pages');
  const work = profiles.create('Test');
  assert.equal(profiles.partition(work.id), `test-profile-${work.id}`);
  profiles.select(work.id);
  profiles.rename(work.id, 'Renamed');
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('failed writes leave the active profile and metadata unchanged', (t) => {
  const dir = directory(t);
  const profiles = new ProfileStore(dir);
  const work = profiles.create('Work');
  fs.mkdirSync(`${profiles.file}.tmp`);
  assert.throws(() => profiles.select(work.id), /Could not save profiles/);
  assert.equal(profiles.active().id, 'default');
  assert.equal(new ProfileStore(dir).active().id, 'default');
});
