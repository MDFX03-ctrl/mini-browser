'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { releaseConfig, appUpdateYaml } = require('./release-config.cjs');
const { signFile } = require('./sign.cjs');
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
  // Runtime dependencies (the updater) go into the archive with the application code.
  const listed = require('node:child_process').execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).slice(1);
  for (const directory of listed) {
    const relative = path.relative(root, directory);
    if (!relative.startsWith('node_modules' + path.sep)) throw new Error(`Unexpected dependency location: ${directory}`);
    fs.cpSync(directory, path.join(source, relative), { recursive: true });
  }
  const metadata = require('../package.json');
  const release = releaseConfig(metadata);
  const stageOnly = process.argv.includes('--stage-only');
  if (!stageOnly && release.updates && !release.signing) {
    throw new Error('Automatic updates are configured, so the installer must be signed. Set release.certificateThumbprint in package.json.');
  }
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
  await require('./fuses.cjs')(path.join(stage, 'Mini Browser.exe'));
  fs.writeFileSync(path.join(resources, 'installed.flag'), 'Mini Browser installer edition\n');
  if (release.updates && release.signing) fs.writeFileSync(path.join(resources, 'app-update.yml'), appUpdateYaml(release));
  // Signed last: any later change to the executable would invalidate its signature.
  if (release.signing) signFile(path.join(stage, 'Mini Browser.exe'), release.signing.thumbprint);
  if (stageOnly) {
    console.log(`Staged application: ${path.join(stage, 'Mini Browser.exe')}`);
    return;
  }

  const { build, Platform, Arch } = require('electron-builder');
  const artifacts = await build({
    projectDir: root, prepackaged: stage, publish: 'never',
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      appId: 'local.mini-browser', productName: 'Mini Browser',
      electronVersion: metadata.devDependencies.electron,
      directories: { output, buildResources: path.join(root, 'assets') },
      // The GitHub publish target only produces latest.yml here; uploading stays a manual step.
      compression: 'normal', publish: release.updates ? [{ provider: 'github', ...release.updates }] : null,
      win: {
        icon: path.join(root, 'assets', 'icon.ico'),
        executableName: 'Mini Browser', signAndEditExecutable: false,
        ...(release.signing ? { signtoolOptions: {
          sign: configuration => signFile(configuration.path, release.signing.thumbprint),
          signingHashAlgorithms: ['sha256'], publisherName: release.signing.publisherName
        } } : {})
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
  if (release.updates) {
    const feed = path.join(output, 'latest.yml');
    if (!fs.existsSync(feed)) throw new Error('The update feed latest.yml was not produced.');
    fs.copyFileSync(projectPath(feed), path.join(root, 'dist', 'latest.yml'));
    console.log(`Update feed: ${path.join(root, 'dist', 'latest.yml')} (upload it with the installer to the GitHub release)`);
  }
}

buildInstaller().catch((error) => { console.error(error); process.exitCode = 1; });
