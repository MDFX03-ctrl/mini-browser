'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BookmarkStore, normalizeBookmark } = require('../src/bookmarks.cjs');
const temporaryRoot = path.resolve(__dirname, '..', '.cache', 'bookmark-tests');
fs.mkdirSync(temporaryRoot, { recursive: true });
test('cached favicon survives restart and ordering; invalid icons cannot enter the shell', t => {
  const dir = directory(t), store = new BookmarkStore(dir);
  store.add('https://a.test', 'A'); store.add('https://b.test', 'B');
  const icon = 'data:image/png;base64,aGVsbG8=';
  assert.equal(store.setIcon('https://a.test/', icon),true);
  store.reorder(['https://b.test/', 'https://a.test/']);
  const reopened = new BookmarkStore(dir);
  assert.equal(reopened.list()[1].icon,icon);
  for(const invalid of ['https://tracker.test/icon.png','data:image/svg+xml,<svg onload="alert(1)">', 'data:image/png;base64,'+'a'.repeat(65536)]) assert.equal(reopened.setIcon('https://a.test/',invalid),false);
  reopened.removed=true;assert.equal(reopened.setIcon('https://a.test/','data:image/png;base64,bmV3'),false);
});

test('reordering bookmarks persists and rejects stale, duplicate, or foreign entries', (t) => {
  const profile = directory(t);
  const store = new BookmarkStore(profile);
  store.add('https://a.example/', 'A'); store.add('https://b.example/', 'B');
  store.reorder(['https://b.example/', 'https://a.example/']);
  const expected = store.list();
  assert.deepEqual(new BookmarkStore(profile).list(), expected);
  for (const order of [null, [], ['https://b.example/', 'https://b.example/'], ['https://a.example/', 'https://foreign.example/']]) {
    assert.throws(() => store.reorder(order)); assert.deepEqual(store.list(), expected);
  }
});

test('editing a bookmark preserves its order and same-site icon, clears changed icons, and rejects invalid or duplicate URLs', t => {
  const dir = directory(t), store = new BookmarkStore(dir);
  store.add('https://a.test', 'A'); store.add('https://b.test', 'B');
  const icon = 'data:image/png;base64,aWNvbg=='; store.setIcon('https://a.test/', icon);
  store.edit('https://a.test/', 'https://a.test/', 'Renamed');
  assert.deepEqual(store.list()[0], {url:'https://a.test/',title:'Renamed',icon});
  const before = store.list();
  for (const url of ['javascript:alert(1)', 'https://b.test/', 'not a website']) {
    assert.throws(()=>store.edit('https://a.test/',url,'Bad')); assert.deepEqual(store.list(),before);
  }
  store.edit('https://a.test/', 'https://new.test/path', 'New address');
  assert.deepEqual(new BookmarkStore(dir).list(), [{url:'https://new.test/path',title:'New address'}, {url:'https://b.test/',title:'B'}]);
  assert.throws(()=>store.edit('https://missing.test/', 'https://else.test/', 'Missing'), /not found/);
});

function directory(t) {
  const result = fs.mkdtempSync(path.join(temporaryRoot, 'profile-'));
  t.after(() => {
    const resolved = fs.realpathSync(result);
    assert.ok(resolved.startsWith(fs.realpathSync(temporaryRoot) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return result;
}

test('bookmarks persist across restarts, retain order, and avoid duplicates', (t) => {
  const profile = directory(t);
  const store = new BookmarkStore(profile);
  store.add('example.com', 'Example');
  store.add('https://www.wikipedia.org/', 'Wikipedia');
  store.add('https://example.com/', 'Duplicate');
  const reopened = new BookmarkStore(profile);
  assert.deepEqual(reopened.list(), [
    { url: 'https://example.com/', title: 'Example' },
    { url: 'https://www.wikipedia.org/', title: 'Wikipedia' }
  ]);
  reopened.remove('https://example.com/');
  assert.deepEqual(new BookmarkStore(profile).list(), [{ url: 'https://www.wikipedia.org/', title: 'Wikipedia' }]);
});
test('bookmark addresses block privileged schemes and credentials', () => {
  for (const address of ['javascript:alert(1)', 'file:///C:/Windows', 'mini://app/index.html', 'data:text/html,test', 'https://user:password@example.com', '', 'not a website']) {
    assert.throws(() => normalizeBookmark(address));
  }
  assert.equal(normalizeBookmark('example.com', '').title, 'example.com');
  assert.equal(normalizeBookmark('http://localhost:3000').url, 'http://localhost:3000/');
});
test('malformed bookmark files are retained and cannot be overwritten by a new bookmark', (t) => {
  const profile = directory(t);
  const file = path.join(profile, 'bookmarks.json');
  fs.writeFileSync(file, '{broken');
  const store = new BookmarkStore(profile);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.add('example.com'), /could not be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('failed saves do not change the in-memory list or leave temporary files', (t) => {
  const profile = directory(t);
  const store = new BookmarkStore(profile);
  fs.mkdirSync(path.join(profile, 'bookmarks.json'));
  assert.throws(() => store.add('example.com'), /Could not save bookmarks/);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(path.join(profile, 'bookmarks.json.tmp')), false);
});
