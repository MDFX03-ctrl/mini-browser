'use strict';
const fs = require('node:fs');
const path = require('node:path');

const RETRY_MINUTES = [2, 5, 15, 30, 60];

// Installed edition only. app-update.yml is written at build time only for signed releases, and
// its publisherName makes the updater reject any download not signed by that certificate.
function startUpdates({ installed, testing, changed }) {
  if (!installed || testing || !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return null;
  const { autoUpdater } = require('electron-updater');
  Object.assign(autoUpdater, { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: false, logger: null });
  let ready = null, failures = 0, retryTimer = null;
  // Downloads from GitHub sometimes break off, so a failure is retried soon instead of in 4 hours.
  const failed = error => {
    console.error('Update check failed:', error.message);
    if (ready || retryTimer) return;
    const minutes = RETRY_MINUTES[Math.min(failures++, RETRY_MINUTES.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; check(); }, minutes * 60 * 1000);
    retryTimer.unref();
  };
  autoUpdater.on('update-downloaded', info => { failures = 0; ready = String(info.version || ''); changed(); });
  autoUpdater.on('update-not-available', () => { failures = 0; });
  autoUpdater.on('error', failed);
  const check = () => { if (!ready) autoUpdater.checkForUpdates().catch(failed); };
  setTimeout(check, 15000).unref();
  setInterval(check, 4 * 60 * 60 * 1000).unref();
  return {
    get ready() { return ready; },
    install() { if (ready) autoUpdater.quitAndInstall(false, true); }
  };
}
module.exports = { startUpdates };
