'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseConfig, appUpdateYaml } = require('../scripts/release-config.cjs');

const thumbprint = 'AB'.repeat(20), publisherName = 'CN=MDFX03 Mini Browser';
const pkg = release => ({ release: { githubOwner: '', githubRepo: 'mini-browser', publisherName, certificateThumbprint: '', ...release } });

test('empty release settings leave builds unsigned and without updates', () => {
  assert.deepEqual(releaseConfig(pkg({}), {}), { updates: null, signing: null });
});

test('update feed requires a signature and names the trusted publisher', () => {
  const config = releaseConfig(pkg({ githubOwner: 'someone', certificateThumbprint: thumbprint.toLowerCase() }), {});
  assert.deepEqual(config.updates, { owner: 'someone', repo: 'mini-browser' });
  assert.equal(config.signing.thumbprint, thumbprint);
  assert.equal(appUpdateYaml(config), 'provider: github\nowner: someone\nrepo: mini-browser\nupdaterCacheDirName: mini-browser-updater\npublisherName:\n  - "CN=MDFX03 Mini Browser"\n');
  assert.throws(() => appUpdateYaml(releaseConfig(pkg({ githubOwner: 'someone' }), {})), /signing certificate/);
});

test('the environment can supply the thumbprint, with spaces and copy marks removed', () => {
  const spaced = '‎' + thumbprint.match(/../g).join(' ');
  assert.equal(releaseConfig(pkg({}), { MINI_BROWSER_SIGN_THUMBPRINT: spaced }).signing.thumbprint, thumbprint);
});

test('invalid settings are rejected before anything reaches YAML or PowerShell', () => {
  for (const release of [{ githubOwner: 'bad name' }, { githubOwner: '-x' }, { githubRepo: 'a/b' }, { githubOwner: 'x\nprovider: generic' },
    { certificateThumbprint: '12345' }, { certificateThumbprint: thumbprint + ';calc' }, { publisherName: 'MDFX03' }, { publisherName: 'CN=a", evil' }]) {
    assert.throws(() => releaseConfig(pkg(release), {}), undefined, JSON.stringify(release));
  }
});
