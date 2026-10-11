'use strict';
// Matches Chromium's transient user activation window.
const ACTIVATION_MS = 5000;
const riskyExtension = filename => /\.(?:exe|msi|msp|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|scf|reg|cpl|chm|jar|application|gadget|appx|msix|appxbundle|msixbundle|iso|img|vhd|vhdx)$/i.test(filename);
const recentlyActivated = (tab, now = Date.now()) => now - (tab?.lastUserActivation || 0) <= ACTIVATION_MS;
function allowDownload(tab, now = Date.now()) {
  if (!tab) return true;
  if (recentlyActivated(tab, now)) { tab.automaticDownloads = 0; return true; }
  tab.automaticDownloads = (tab.automaticDownloads || 0) + 1;
  return tab.automaticDownloads <= 1;
}
module.exports = { ACTIVATION_MS, riskyExtension, recentlyActivated, allowDownload };
