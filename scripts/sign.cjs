'use strict';
const { execFileSync } = require('node:child_process');

// Signs with a certificate from the current user's store; the private key never leaves Windows.
// Values reach PowerShell through the environment, never through the command text.
const SCRIPT = "$ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Security; "
  + "$c = Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $env:SIGN_THUMBPRINT); "
  + "$r = Set-AuthenticodeSignature -LiteralPath $env:SIGN_FILE -Certificate $c -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'; "
  + "if ($r.Status -ne 'Valid') { throw ('Signing failed: ' + $r.StatusMessage) }";

function signFile(file, thumbprint) {
  if (!/^[A-F\d]{40}$/.test(thumbprint)) throw new Error('Invalid signing certificate thumbprint.');
  // A PSModulePath inherited from PowerShell 7 makes Windows PowerShell load the wrong
  // Security module, which leaves it without the Cert: drive.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { env: { ...env, SIGN_FILE: file, SIGN_THUMBPRINT: thumbprint }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
}

module.exports = { signFile };
