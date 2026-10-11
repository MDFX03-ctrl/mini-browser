'use strict';
// Release settings live in package.json "release". Empty values mean "not configured".
const OWNER = /^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/, REPO = /^[A-Za-z\d._-]{1,100}$/;
const THUMBPRINT = /^[A-F\d]{40}$/i, PUBLISHER = /^CN=[^,"\r\n]{1,64}$/;

function releaseConfig(pkg, env = process.env) {
  const release = pkg.release || {};
  const owner = release.githubOwner || '', repo = release.githubRepo || '', publisherName = release.publisherName || '';
  const thumbprint = String(env.MINI_BROWSER_SIGN_THUMBPRINT || release.certificateThumbprint || '').replace(/[\s‎‏]/g, '');
  if (owner && !OWNER.test(owner)) throw new Error('release.githubOwner is not a valid GitHub user name.');
  if (repo && !REPO.test(repo)) throw new Error('release.githubRepo is not a valid GitHub repository name.');
  if (thumbprint && !THUMBPRINT.test(thumbprint)) throw new Error('The signing certificate thumbprint must be 40 hexadecimal characters.');
  if (!PUBLISHER.test(publisherName)) throw new Error('release.publisherName must look like "CN=Name", exactly as in the certificate.');
  return {
    updates: owner && repo ? { owner, repo } : null,
    signing: thumbprint ? { thumbprint: thumbprint.toUpperCase(), publisherName } : null
  };
}

// The updater rejects any downloaded update that is not validly signed by publisherName.
function appUpdateYaml({ updates, signing }) {
  if (!updates || !signing) throw new Error('Automatic updates need both a GitHub repository and a signing certificate.');
  return `provider: github\nowner: ${updates.owner}\nrepo: ${updates.repo}\nupdaterCacheDirName: mini-browser-updater\npublisherName:\n  - ${JSON.stringify(signing.publisherName)}\n`;
}

module.exports = { releaseConfig, appUpdateYaml };
