'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

function load(results) {
  const updater = Object.assign(new EventEmitter(), { checks: 0 });
  updater.checkForUpdates = () => {
    updater.checks++;
    const result = results.shift() || 'none';
    if (result === 'fail') { const error = new Error('net::ERR_CONNECTION_CLOSED'); updater.emit('error', error); return Promise.reject(error); }
    updater.emit(result === 'downloaded' ? 'update-downloaded' : 'update-not-available', { version: '9.9.9' });
    return Promise.resolve();
  };
  require.cache[require.resolve('electron-updater')] = { exports: { autoUpdater: updater } };
  delete require.cache[require.resolve('../src/updates.cjs')];
  return { updater, ...require('../src/updates.cjs') };
}

test('a failed update is retried after 2, 5 and 15 minutes, then ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(console, 'error', () => {});
  process.resourcesPath ??= __dirname;
  const { updater, startUpdates } = load(['fail', 'fail', 'fail', 'downloaded']);
  let changes = 0;
  const handle = startUpdates({ installed: true, testing: false, changed: () => changes++ });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15000); await flush();
  assert.equal(updater.checks, 1);
  t.mock.timers.tick(2 * 60000 - 1); await flush();
  assert.equal(updater.checks, 1, 'one failure schedules one retry, not two');
  t.mock.timers.tick(1); await flush();
  assert.equal(updater.checks, 2);
  t.mock.timers.tick(5 * 60000); await flush();
  assert.equal(updater.checks, 3);
  t.mock.timers.tick(15 * 60000); await flush();
  assert.equal(updater.checks, 4);
  assert.equal(handle.ready, '9.9.9');
  assert.equal(changes, 1);
  t.mock.timers.tick(8 * 60 * 60000); await flush();
  assert.equal(updater.checks, 4, 'no more checks once an update is ready');
});

test('no updater without the installed flag or in test mode', () => {
  const { startUpdates } = load([]);
  assert.equal(startUpdates({ installed: false, testing: false, changed() {} }), null);
  assert.equal(startUpdates({ installed: true, testing: true, changed() {} }), null);
});
