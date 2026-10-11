'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BookmarkIcons, iconLinks } = require('../src/bookmark-icons.cjs');
const png = 'data:image/png;base64,aWNvbg==';
const html = body => new Response(body, { headers: { 'Content-Type': 'text/html' } });
const icon = value => new Response(value || 'icon', { headers: { 'Content-Type': 'image/png' } });
const missing = () => new Response('', { status: 404 });
function store(address) {
  return { items: [{ url: address }], list() { return this.items; }, setIcon(url, value) {
    const item = this.items.find(item => item.url === url); if (!item || this.removed) return false;
    item.icon = value; return true;
  } };
}
// Model Electron's redirect event: nothing follows unless followRedirect is called.
function requestFor({ url, session, ...options }) {
  const request = new EventEmitter(); let aborted = false, next;
  async function send(address) {
    try {
      const response = await session.fetch(address, options);
      if (aborted) return;
      if (response.status >= 300 && response.status < 400) {
        next = new URL(response.headers.get('location'), address).href;
        request.emit('redirect', response.status, 'GET', next);
        return;
      }
      const incoming = new EventEmitter(); incoming.statusCode = response.status;
      incoming.headers = Object.fromEntries([...response.headers].map(([key, value]) => [key, [value]]));
      request.emit('response', incoming);
      const reader = response.body.getReader();
      try {
        while (!aborted) { const { done, value } = await reader.read(); if (done) break; incoming.emit('data', Buffer.from(value)); }
      } finally { await reader.cancel(); }
      if (!aborted) { incoming.emit('end'); request.emit('close'); }
    } catch (error) { request.emit('error', error); }
  }
  // Electron 44 can close the writable request before delivering its response.
  request.end = () => { request.emit('finish'); request.emit('close'); send(url); };
  request.followRedirect = () => { send(next); };
  request.abort = () => { if (!aborted) { aborted = true; request.emit('close'); } };
  return request;
}
function manager(options = { retryDelays: [] }) {
  const icons = new BookmarkIcons(() => {}, { request: requestFor, ...options });
  icons.decode = bytes => bytes.toString().startsWith('icon') ? png : null;
  return icons;
}
async function poll(check) {
  const start = Date.now();
  while (!check()) { assert.ok(Date.now() - start < 3000, 'favicon task completed'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('static icon discovery resolves bases and entities, prefers raster icons and ignores executable metadata', () => {
  assert.deepEqual(iconLinks(`<!-- <link rel=icon href=/comment.png> -->
    <script>const fake = '<link rel=icon href=/script.png>';</script>
    <base href="https://cdn.example/assets/"><base href="https://wrong.example/">
    <LINK href='brand.png?a=1&amp;b=2' REL='shortcut ICON'>
    <link rel=icon href="file:///private.png"><link rel=icon href="javascript:bad()">
    <link rel=icon href="https://name:password@example.com/icon.png">
    <link rel=icon type="image/svg+xml" href="vector.svg">
    <link rel=apple-touch-icon href="touch&#46;png">
    <link rel=stylesheet href=style.css>`, 'https://site.example/start'), [
    'https://cdn.example/assets/brand.png?a=1&b=2', 'https://cdn.example/assets/touch.png', 'https://cdn.example/assets/vector.svg'
  ]);
});

test('missing standard favicon discovers a relative icon after redirects without cookies or scripts', async () => {
  const address = 'https://site.example/start', bookmarks = store(address), icons = manager(), requested = [];
  const session = { async fetch(url, options) {
    requested.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    if (url.endsWith('/favicon.ico')) return missing();
    if (url === address) return new Response('', { status: 302, headers: { location: '/landing/page' } });
    if (url.endsWith('/landing/page')) return html('<link rel="icon" href="../brand.png">');
    if (url.endsWith('/brand.png')) return icon();
    throw new Error('Unexpected fetch: ' + url);
  } };
  icons.refresh(bookmarks, session); await poll(() => icons.running === 0);
  assert.equal(bookmarks.items[0].icon, png);
  assert.ok(requested.includes('https://site.example/brand.png'));
  const before = requested.length; icons.refresh(bookmarks, session); assert.equal(requested.length, before, 'cached icon needs no network request');
});

test('temporary fetch failures retry and duplicate refreshes do not queue duplicate work', async () => {
  const bookmarks = store('https://retry.example/'), icons = manager({ retryDelays: [10] }); let attempts = 0;
  const session = { async fetch(url) {
    if (url.endsWith('/favicon.ico')) { if (++attempts === 1) throw new Error('offline'); return icon(); }
    return missing();
  } };
  icons.refresh(bookmarks, session); icons.refresh(bookmarks, session);
  await poll(() => !!bookmarks.items[0].icon);
  assert.equal(attempts, 2);
});

test('a favicon URL returning HTML discovers the official PNG even when the homepage is forbidden', async () => {
  const address = 'https://chat.deepseek.com/', bookmarks = store(address), icons = manager(), calls = [];
  const session = { fetch: async (url, options) => {
    calls.push(url); assert.equal(options.credentials,'omit');
    if (url === 'https://chat.deepseek.com/favicon.ico') return html('<link rel="icon" href="https://fe-static.deepseek.com/chat/favicon.svg"><link rel="apple-touch-icon" href="https://fe-static.deepseek.com/chat/icon-180.png">');
    if (url === 'https://fe-static.deepseek.com/chat/icon-180.png') return icon();
    return new Response('Forbidden',{status:403});
  } };
  icons.refresh(bookmarks,session); await poll(()=>icons.running===0);
  assert.equal(bookmarks.items[0].icon,png);
  assert.deepEqual(calls,['https://chat.deepseek.com/favicon.ico','https://fe-static.deepseek.com/chat/icon-180.png']);
});

test('redirected live-page icons update the original bookmark, not unrelated bookmarks', async () => {
  const bookmarks = store('https://alias.example/'), icons = manager();
  bookmarks.items.push({ url: 'https://unrelated.example/' });
  icons.refresh(bookmarks, { fetch: async () => icon() }, 'https://destination.example/inbox', ['https://destination.example/brand.png'], ['https://alias.example/']);
  await poll(() => icons.running === 0);
  assert.equal(bookmarks.items[0].icon, png); assert.equal(bookmarks.items[1].icon, undefined);
});

test('an obsolete request cannot overwrite a newer icon or write to a deleted profile', async () => {
  const bookmarks = store('https://site.example/'), icons = manager(); let release;
  icons.decode = bytes => 'data:image/png;base64,' + bytes.toString('base64');
  const session = { fetch: url => url.endsWith('/old.png') ? new Promise(resolve => { release = resolve; }) : Promise.resolve(icon('new')) };
  icons.refresh(bookmarks, session, bookmarks.items[0].url, ['https://site.example/old.png']);
  icons.refresh(bookmarks, session, bookmarks.items[0].url, ['https://site.example/new.png']);
  await poll(() => !!bookmarks.items[0].icon);
  const saved = bookmarks.items[0].icon; release(icon('old')); await poll(() => icons.running === 0);
  assert.equal(bookmarks.items[0].icon, saved);
  icons.refresh(bookmarks, session, bookmarks.items[0].url, ['https://site.example/old.png']);
  bookmarks.removed = true; release(icon('removed')); await poll(() => icons.running === 0);
  assert.equal(bookmarks.items[0].icon, saved);
});

test('Gmail aliases use the canonical public Gmail favicon with their own profile session', async () => {
  const icons = manager(), bookmarks = store('https://gmail.com/'), calls = [];
  const session = { fetch: async url => { calls.push(url); return icon(); } };
  icons.refresh(bookmarks, session); await poll(() => icons.running === 0);
  assert.deepEqual(calls, ['https://mail.google.com/favicon.ico']); assert.equal(bookmarks.items[0].icon, png);
  const other = store('https://gmail.com.attacker.example/'), otherCalls = [];
  icons.refresh(other, { fetch: async url => { otherCalls.push(url); return icon(); } }); await poll(() => icons.running === 0);
  assert.deepEqual(otherCalls, ['https://gmail.com.attacker.example/favicon.ico']);
});

test('icon fetches reject oversized images and non-http redirects and bound metadata reads', async () => {
  const icons = manager();
  assert.equal(await icons.fetch({ fetch: async () => new Response('oversized', { headers: { 'content-length': '262145' } }) }, 'https://site.example/icon'), null);
  let requests = 0;
  assert.equal(await icons.fetch({ fetch: async () => { requests++; return new Response('', { status: 302, headers: { location: 'file:///private.png' } }); } }, 'https://site.example/icon'), null);
  assert.equal(requests, 1);
  const response = await icons.fetch({ fetch: async () => html('<link rel=icon href=/brand.png>' + 'x'.repeat(1048576)) }, 'https://site.example/', true);
  assert.equal(response.buffer.length, 1048576); assert.deepEqual(iconLinks(response.buffer.toString(), response.url), ['https://site.example/brand.png']);
});

test('a stale asynchronous decode cannot overwrite newer icons or persist into a removed profile', async () => {
  const bookmarks = store('https://site.example/'), icons = manager();let release;
  icons.decode = bytes => bytes.toString() === 'old' ? new Promise(resolve=>{release=resolve;}) : Promise.resolve(png);
  const session = {fetch:async url=>icon(url.endsWith('/old.png')?'old':'new')};
  icons.refresh(bookmarks,session,bookmarks.items[0].url,['https://site.example/old.png']);
  await poll(()=>!!release);
  icons.refresh(bookmarks,session,bookmarks.items[0].url,['https://site.example/new.png']);
  await poll(()=>!!bookmarks.items[0].icon);
  release('data:image/png;base64,b2xk');await poll(()=>icons.running===0);
  assert.equal(bookmarks.items[0].icon,png);
  release=null;icons.refresh(bookmarks,session,bookmarks.items[0].url,['https://site.example/old.png']);
  await poll(()=>!!release);bookmarks.removed=true;release('data:image/png;base64,cmVtb3ZlZA==');await poll(()=>icons.running===0);
  assert.equal(bookmarks.items[0].icon,png);
});
