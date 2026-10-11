'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, '.cache');
const temp = path.join(cache, 'tmp');
fs.mkdirSync(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.ELECTRON_BUILDER_CACHE = path.join(cache, 'electron-builder');
process.env.ELECTRON_CACHE = path.join(cache, 'electron');
process.env.electron_config_cache = process.env.ELECTRON_CACHE;
process.env.ELECTRON_GET_USE_PROXY = '1';
process.env.NODE_USE_ENV_PROXY = '1';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

function projectPath(value) {
  const resolved = fs.realpathSync(value);
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Build inputs and temporary output must stay inside this project.');
  }
  return resolved;
}

async function buildInstaller() {
  const stage = path.join(cache, 'installer-app');
  const source = path.join(cache, 'installer-source');
  const output = path.join(cache, 'installer-output');
  for (const directory of [stage, source, output]) {
    if (fs.existsSync(directory)) fs.rmSync(projectPath(directory), { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
  }

  // Reuse an extracted portable runtime when available; otherwise Electron downloads
  // its pinned runtime into the project's cache. Application code is always rebuilt.
  const candidates = [
    process.argv[2],
    path.join(cache, 'installer-runtime'),
    path.join(root, 'dist', 'Mini-Browser-Windows-x64', 'Mini Browser-win32-x64'),
    path.join(root, 'dist', 'Mini Browser-win32-x64')
  ].filter(Boolean);
  let runtime = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'Mini Browser.exe')));
  let executable = 'Mini Browser.exe';
  if (!runtime) {
    runtime = path.dirname(require('electron'));
    executable = 'electron.exe';
  }
  runtime = projectPath(runtime);
  fs.cpSync(runtime, stage, {
    recursive: true,
    filter: (candidate) => {
      const first = path.relative(runtime, candidate).split(path.sep)[0];
      return !['resources', '.mini-browser', 'README.txt', 'README.md', 'Uninstall Mini Browser.exe'].includes(first);
    }
  });
  if (executable !== 'Mini Browser.exe') {
    fs.renameSync(path.join(stage, executable), path.join(stage, 'Mini Browser.exe'));
  }
  for (const directory of ['src', 'assets']) {
    fs.cpSync(path.join(root, directory), path.join(source, directory), { recursive: true });
  }
  const metadata = require('../package.json');
  {
    const { resedit } = await import('@electron/packager/resedit');
    await resedit(path.join(stage, 'Mini Browser.exe'), {
      productName: 'Mini Browser', productVersion: metadata.version, fileVersion: metadata.version,
      iconPath: path.join(root, 'assets', 'icon.ico'),
      win32Metadata: { CompanyName: 'Mini Browser', FileDescription: 'Mini Browser' }
    });
  }
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: metadata.name, productName: metadata.productName, version: metadata.version,
    description: metadata.description, main: metadata.main
  }, null, 2));
  const resources = path.join(stage, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const { createPackage } = await import('@electron/asar');
  await createPackage(source, path.join(resources, 'app.asar'));
  fs.writeFileSync(path.join(resources, 'installed.flag'), 'Mini Browser installer edition\n');
  if (process.argv.includes('--stage-only')) {
    console.log(`Staged application: ${path.join(stage, 'Mini Browser.exe')}`);
    return;
  }

  const { build, Platform, Arch } = require('electron-builder');
  const artifacts = await build({
    projectDir: root, prepackaged: stage,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      appId: 'local.mini-browser', productName: 'Mini Browser',
      electronVersion: metadata.devDependencies.electron,
      directories: { output, buildResources: path.join(root, 'assets') },
      compression: 'normal', publish: null,
      win: {
        icon: path.join(root, 'assets', 'icon.ico'),
        executableName: 'Mini Browser', signAndEditExecutable: false
      },
      nsis: {
        oneClick: false, perMachine: false, allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true, createStartMenuShortcut: true,
        shortcutName: 'Mini Browser', uninstallDisplayName: 'Mini Browser',
        installerIcon: path.join(root, 'assets', 'icon.ico'),
        uninstallerIcon: path.join(root, 'assets', 'icon.ico'),
        runAfterFinish: true, deleteAppDataOnUninstall: false,
        differentialPackage: false,
        include: path.join(__dirname, 'installer.nsh'),
        artifactName: 'Mini-Browser-Setup-${version}-${arch}.${ext}'
      }
    }
  });
  const installers = artifacts.filter((artifact) => artifact.endsWith('.exe'));
  if (installers.length !== 1) throw new Error('Expected one Windows setup executable.');
  const destination = path.join(root, 'dist', path.basename(installers[0]));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(projectPath(installers[0]), destination);
  console.log(`Windows installer: ${destination}`);
}

buildInstaller().catch((error) => { console.error(error); process.exitCode = 1; });
