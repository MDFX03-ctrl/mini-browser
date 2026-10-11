'use strict';

const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const temp = path.join(root, '.cache', 'tmp');
fs.mkdirSync(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.ELECTRON_CACHE = path.join(root, '.cache', 'electron');
process.env.electron_config_cache = process.env.ELECTRON_CACHE;
process.env.ELECTRON_GET_USE_PROXY = '1';

async function build() {
  require('./icon.cjs');
  const { packager } = await import('@electron/packager');
  const outputs = await packager({
    dir: root, out: path.join(temp, 'portable-build'), name: 'Mini Browser',
    platform: 'win32', arch: 'x64', overwrite: true, asar: true,
    icon: path.join(root, 'assets', 'icon.ico'),
    appVersion: require('../package.json').version,
    executableName: 'Mini Browser',
    win32metadata: { ProductName: 'Mini Browser', FileDescription: 'Mini Browser', CompanyName: 'Mini Browser' },
    download: {
      cacheRoot: path.join(root, '.cache', 'electron'),
      checksums: require('electron/checksums.json')
    },
    tmpdir: temp,
    ignore: [/^\/(?:\.cache|\.mini-browser|\.git|dist|test|test-results|scripts)(?:\/|$)/, /^\/(?:\.npmrc.*|\.gitignore|README\.md)$/]
  });
  for (const output of outputs) {
    await require('./fuses.cjs')(path.join(output, 'Mini Browser.exe'), true);
    fs.copyFileSync(path.join(__dirname, 'portable-readme.txt'), path.join(output, 'README.txt'));
  }
  const { ZipFile } = require('yazl');
  const zipPath = path.join(root, 'dist', 'Mini-Browser-Windows-x64.zip');
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const archive = new ZipFile();
  function addDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.mini-browser') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) addDirectory(absolute);
      else if (entry.isFile()) archive.addFile(absolute, path.relative(path.dirname(outputs[0]), absolute).split(path.sep).join('/'));
    }
  }
  addDirectory(outputs[0]);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.outputStream.on('error', reject);
    archive.outputStream.pipe(output);
    archive.end();
  });
  console.log(`Portable ZIP: ${zipPath}`);
  for (const output of outputs) {
    const resolvedOutput = fs.realpathSync(output);
    const relative = path.relative(fs.realpathSync(temp), resolvedOutput);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to remove build output outside the project temporary folder.');
    }
    fs.rmSync(resolvedOutput, { recursive: true, force: true });
  }
}
build().catch((error) => { console.error(error); process.exitCode = 1; });
