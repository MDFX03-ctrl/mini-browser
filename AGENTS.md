# Updating and releasing Mini Browser

Installed copies (1.8.0 and later) update themselves from the GitHub Releases of `MDFX03-ctrl/mini-browser`. They accept an update only when it is signed by `CN=MDFX03 Mini Browser`. See [SIGNING.md](SIGNING.md) for the certificate.

## 1. Change and test

1. Make the change. For an engine update, move `devDependencies.electron` to the newest supported version and check the Electron release notes for breaking changes.
2. Raise `version` in `package.json` and the two top-level `"version"` entries of `package-lock.json` (not dependency versions). Update the installer file name in `README.md`.
3. Run `npm test`, then the app suites that touch the change, at least `npm run test:profiles` and `npm run test:windows`. Before an engine update, run every `test:*` suite.
4. Commit on `main`. Commits must use the private address `306214390+MDFX03-ctrl@users.noreply.github.com` (already set in this repository's git config). Never commit a thumbprint, certificate or `.pfx`.

## 2. Build (the owner runs this)

Signing reads the owner's Windows certificate store, so the owner runs the build in a terminal:

```powershell
npm run build:installer
```

The thumbprint comes from the user environment variable `MINI_BROWSER_SIGN_THUMBPRINT`. In a terminal opened before it was set, load it first:

```powershell
$env:MINI_BROWSER_SIGN_THUMBPRINT = [Environment]::GetEnvironmentVariable('MINI_BROWSER_SIGN_THUMBPRINT', 'User')
```

The build ends with `Windows installer: ...\dist\Mini-Browser-Setup-<version>-x64.exe` and writes `dist/latest.yml`.

## 3. Check the build

- `Get-AuthenticodeSignature` on the installer reports `Valid`, signer `CN=MDFX03 Mini Browser`, with a timestamp.
- `dist/latest.yml` names the new version, and its `sha512` equals the Base64 SHA-512 of the installer.
- `.cache/installer-app/resources/app-update.yml` points at `MDFX03-ctrl/mini-browser` with `publisherName` `CN=MDFX03 Mini Browser`.

## 4. Publish (only after the owner says yes)

Publishing is public, so ask the owner before each publish.

```bash
git push origin main
gh release create v<version> -R MDFX03-ctrl/mini-browser --target main --title "Mini Browser <version>" --latest --notes "<what changed>" dist/Mini-Browser-Setup-<version>-x64.exe dist/latest.yml
```

- Publish a full release, not a draft or pre-release, and upload both files with their original names.
- Afterwards, check that `https://github.com/MDFX03-ctrl/mini-browser/releases/latest/download/latest.yml` shows the new version.
- Push only `main`. Never push the local branch `backup-before-publish`: it contains old personal data.

## 5. What happens next

Installed copies check 15 seconds after start and every 4 hours, download quietly, and install when the browser quits. The ⋮ menu and the tray menu also offer **Restart to update to <version>**.

## If something fails

- **`gh` returns 403 or is signed out:** the owner runs `gh auth login --web` and chooses HTTPS and browser login.
- **"the installer must be signed":** the thumbprint variable is missing in that terminal; see step 2.
- **"Cannot find drive 'Cert'":** fixed in `scripts/sign.cjs`, which drops the PSModulePath that PowerShell 7 passes to Windows PowerShell. If it reappears, check that fix.
- **Certificate expired:** create a new self-signed code-signing certificate with the same subject `CN=MDFX03 Mini Browser`, trust it as described in SIGNING.md, and update the thumbprint variable. Existing installs keep accepting updates because they check the subject.
