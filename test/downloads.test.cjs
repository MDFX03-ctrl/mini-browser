'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVATION_MS, riskyExtension, allowDownload } = require('../src/download-policy.cjs');

test('risky download extensions require explicit open confirmation', () => {
  for (const name of ['setup.exe', 'package.msi', 'run.ps1', 'shortcut.url', 'script.js', 'install.msix', 'disk.ISO', 'image.img', 'drive.vhdx', 'help.chm', 'old.pif', 'code.vbe']) assert.equal(riskyExtension(name), true, name);
  for (const name of ['photo.png', 'notes.txt', 'archive.zip', 'exe.txt', 'report.pdf']) assert.equal(riskyExtension(name), false, name);
});

test('automatic downloads allow one per tab until a recent user gesture', () => {
  const start = 1_000_000, tab = {};
  assert.equal(allowDownload(tab, start), true);
  assert.equal(allowDownload(tab, start + 1), false);
  tab.lastUserActivation = start + 10;
  assert.equal(allowDownload(tab, start + 10 + ACTIVATION_MS), true, 'a gesture stays valid for the whole activation window');
  assert.equal(tab.automaticDownloads, 0);
  assert.equal(allowDownload(tab, start + 11 + ACTIVATION_MS), true, 'the first automatic download after a gesture is allowed');
  assert.equal(allowDownload(tab, start + 12 + ACTIVATION_MS), false);
  assert.equal(allowDownload(undefined), true, 'downloads without an owning tab are not gated');
});
