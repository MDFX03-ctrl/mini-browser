'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const stage = path.join(root, '.cache', 'installer-app');
const installer = path.resolve(process.argv[2] || (fs.existsSync(stage) ? stage : path.join(root, 'dist', `Mini-Browser-Setup-${version}-x64.exe`)));
const staged = fs.statSync(installer).isDirectory();
const destination = path.join(root, '.cache', 'installer-check');
let application = path.join(destination, 'application');
const unpackedInstaller = path.join(destination, 'setup');

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? files(absolute) : [absolute];
  });
}

async function verify() {
  const relative = path.relative(root, fs.realpathSync(installer));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Installer must be inside the workspace');
  if (staged) application = installer;
  else {
    assert.ok(fs.statSync(installer).size > 1000000, 'Installer includes its offline payload');
    const header = Buffer.alloc(2);
    const descriptor = fs.openSync(installer, 'r');
    try { fs.readSync(descriptor, header, 0, 2, 0); } finally { fs.closeSync(descriptor); }
    assert.equal(header.toString(), 'MZ', 'Setup is a Windows executable');

    const sevenZip = files(path.join(root, '.cache', 'electron-builder')).find((file) => path.basename(file) === '7za.exe');
    assert.ok(sevenZip, 'Project-local 7-Zip tool is available');
    const run = (args) => execFileSync(sevenZip, args, { cwd: root, windowsHide: true, encoding: 'utf8' });
    run(['t', installer]);
    if (fs.existsSync(destination)) {
      const resolved = fs.realpathSync(destination);
      const relativeDestination = path.relative(fs.realpathSync(root), resolved);
      assert.ok(relativeDestination.startsWith(`.cache${path.sep}`) && !path.isAbsolute(relativeDestination));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    fs.mkdirSync(unpackedInstaller, { recursive: true });
    run(['x', installer, `-o${unpackedInstaller}`, '-y']);
    const payload = files(unpackedInstaller).find((file) => path.basename(file) === 'app-64.7z');
    if (payload) {
      run(['t', payload]);
      fs.mkdirSync(application, { recursive: true });
      run(['x', payload, `-o${application}`, '-y']);
    } else {
      // 7-Zip can expose the embedded application archive directly for NSIS builds.
      application = unpackedInstaller;
    }
  }
  assert.ok(fs.existsSync(path.join(application, 'Mini Browser.exe')));
  const executableHeader = Buffer.alloc(4096);
  const appDescriptor = fs.openSync(path.join(application, 'Mini Browser.exe'), 'r');
  try { fs.readSync(appDescriptor, executableHeader, 0, 4096, 0); } finally { fs.closeSync(appDescriptor); }
  const peOffset = executableHeader.readUInt32LE(0x3c);
  assert.equal(executableHeader.readUInt16LE(peOffset + 4), 0x8664, 'Bundled application is Windows x64');
  assert.ok(fs.existsSync(path.join(application, 'resources', 'installed.flag')));
  assert.ok(!fs.existsSync(path.join(application, '.mini-browser')), 'No browsing data in the installer');
  const { extractFile } = await import('@electron/asar');
  const archive = path.join(application, 'resources', 'app.asar');
  for (const relativeFile of [
    ['src', 'main.cjs'], ['src', 'browser-window.cjs'], ['src', 'ordering.cjs'], ['src', 'tabs.cjs'], ['src', 'navigation.cjs'], ['src', 'bookmarks.cjs'], ['src', 'profiles.cjs'],
    ['src', 'bookmark-icons.cjs'], ['src', 'icon-decoder.cjs'], ['src', 'page-compatibility.cjs'], ['src', 'permissions.cjs'], ['src', 'downloads.cjs'], ['src', 'download-policy.cjs'], ['src', 'updates.cjs'], ['src', 'page-menu.cjs'], ['src', 'tab-restore.cjs'], ['src', 'profile-data.cjs'], ['src', 'passwords.cjs'], ['src', 'page-preload.cjs'], ['src', 'preload.cjs'], ['src', 'ui', 'renderer.js'], ['src', 'ui', 'index.html'], ['src', 'ui', 'styles.css']
  ]) {
    const file = path.join(...relativeFile);
    assert.deepEqual(extractFile(archive, file), fs.readFileSync(path.join(root, file)));
  }
  assert.equal(JSON.parse(extractFile(archive, 'package.json').toString()).version, version);
  assert.equal(JSON.parse(extractFile(archive, path.join('node_modules', 'electron-updater', 'package.json')).toString()).version, require('../package.json').dependencies['electron-updater'], 'Updater is bundled');
  const { releaseConfig } = require('../scripts/release-config.cjs');
  const release = releaseConfig(require('../package.json'));
  assert.equal(fs.existsSync(path.join(application, 'resources', 'app-update.yml')), !!(release.updates && release.signing), 'Update feed only in signed, configured builds');
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
  const { FuseState } = require('@electron/fuses/dist/constants');
  const wire = await getCurrentFuseWire(path.join(application, 'Mini Browser.exe'));
  for (const option of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments, FuseV1Options.EnableEmbeddedAsarIntegrityValidation]) assert.equal(wire[option], FuseState.DISABLE);
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
  console.log('PASS: ' + (staged ? 'staged application' : 'Windows setup archive') + ', x64 payload, 23 current source files, bundled updater, update settings, metadata, no browsing data and five fuse settings');
  console.log(`Extracted application for runtime tests: ${path.join(application, 'Mini Browser.exe')}`);
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
