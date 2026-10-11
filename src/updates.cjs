'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Installed edition only. app-update.yml is written at build time only for signed releases, and
// its publisherName makes the updater reject any download not signed by that certificate.
function startUpdates({ installed, testing, changed }) {
  if (!installed || testing || !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return null;
  const { autoUpdater } = require('electron-updater');
  Object.assign(autoUpdater, { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: false, logger: null });
  let ready = null;
  autoUpdater.on('update-downloaded', info => { ready = String(info.version || ''); changed(); });
  autoUpdater.on('error', error => console.error('Update check failed:', error.message));
  const check = () => autoUpdater.checkForUpdates().catch(error => console.error('Update check failed:', error.message));
  setTimeout(check, 15000).unref();
  setInterval(check, 4 * 60 * 60 * 1000).unref();
  return {
    get ready() { return ready; },
    install() { if (ready) autoUpdater.quitAndInstall(false, true); }
  };
}
module.exports = { startUpdates };
