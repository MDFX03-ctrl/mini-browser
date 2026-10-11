'use strict';
const { execFileSync } = require('node:child_process');

// Signs with a certificate from the current user's store; the private key never leaves Windows.
// Timestamp servers occasionally fail, so each is tried in turn, twice over.
// Values reach PowerShell through the environment, never through the command text.
const SCRIPT = "$ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Security; "
  + "$c = Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $env:SIGN_THUMBPRINT); "
  + "$servers = 'http://timestamp.digicert.com', 'http://timestamp.sectigo.com', 'http://timestamp.globalsign.com/tsa/r6advanced1'; "
  + "foreach ($attempt in 1..2) { foreach ($server in $servers) { "
  + "$r = Set-AuthenticodeSignature -LiteralPath $env:SIGN_FILE -Certificate $c -HashAlgorithm SHA256 -TimestampServer $server; "
  + "if ($r.Status -eq 'Valid') { exit 0 }; Write-Warning ($server + ': ' + $r.StatusMessage); Start-Sleep -Seconds 2 } }; "
  + "throw ('Signing failed: ' + $r.StatusMessage)";

function signFile(file, thumbprint) {
  if (!/^[A-F\d]{40}$/.test(thumbprint)) throw new Error('Invalid signing certificate thumbprint.');
  // A PSModulePath inherited from PowerShell 7 makes Windows PowerShell load the wrong
  // Security module, which leaves it without the Cert: drive.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { env: { ...env, SIGN_FILE: file, SIGN_THUMBPRINT: thumbprint }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
}

module.exports = { signFile };
