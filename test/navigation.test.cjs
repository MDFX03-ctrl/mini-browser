'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAddress, isWebUrl } = require('../src/navigation.cjs');

test('ordinary addresses use HTTPS and preserve path, query, and hash', () => {
  assert.equal(resolveAddress(' example.com/path?q=test#section '), 'https://example.com/path?q=test#section');
  assert.equal(resolveAddress('https://example.com'), 'https://example.com/');
  assert.equal(resolveAddress('http://example.com'), 'http://example.com/');
  assert.equal(resolveAddress('example.com:8080/path'), 'https://example.com:8080/path');
});
test('local development addresses support ports and IPv6', () => {
  assert.equal(resolveAddress('localhost:3000/a'), 'http://localhost:3000/a');
  assert.equal(resolveAddress('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(resolveAddress('[::1]:3000'), 'http://[::1]:3000/');
});
test('plain text is rejected without choosing a search provider, and empty input does nothing', () => {
  for (const value of ['weather in Tokyo', 'cats & dogs', 'weather']) {
    assert.throws(() => resolveAddress(value), /Enter a website address/);
  }
  assert.equal(resolveAddress(''), null);
  assert.equal(resolveAddress('  '), null);
  assert.equal(resolveAddress('https://example.com/search?q=cats'), 'https://example.com/search?q=cats');
});
test('privileged schemes, credentials, malformed and oversized inputs are rejected', () => {
  for (const input of ['file:///C:/Windows', 'javascript:alert(1)', 'data:text/html,test', 'mini://app/index.html', 'mailto:test@example.com', 'https://user:password@example.com', 'https://']) {
    assert.throws(() => resolveAddress(input));
    assert.equal(isWebUrl(input), false);
  }
  assert.throws(() => resolveAddress('a'.repeat(8193)));
  assert.throws(() => resolveAddress({}));
});
