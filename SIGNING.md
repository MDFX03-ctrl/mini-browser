# Signing is needed for installer builds

This repository does not include a code-signing certificate or its thumbprint. The installer is configured for automatic updates from GitHub Releases, and an installed Mini Browser accepts an update only when Windows reports a valid signature from the publisher named in `package.json` (`release.publisherName`, currently `CN=MDFX03 Mini Browser`). So `npm run build:installer` stops with an error until a certificate is supplied.

You do not need a certificate to run the tests (`npm test`) or to build the portable edition (`npm run build`).

## Building a signed installer

1. Have a code-signing certificate, with its private key, in the current Windows user's store (`Cert:\CurrentUser\My`). Its subject must match `release.publisherName` exactly.
2. Find its thumbprint (40 hexadecimal characters):

   ```powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter
   ```

3. Give the thumbprint to the build without committing it, for example once per Windows user:

   ```powershell
   setx MINI_BROWSER_SIGN_THUMBPRINT <thumbprint>
   ```

   Open a new terminal afterwards. Setting `release.certificateThumbprint` in `package.json` also works, but do not commit it.
4. Run `npm run build:installer`. The build signs `Mini Browser.exe`, the installer and the uninstaller with PowerShell's `Set-AuthenticodeSignature` and a DigiCert timestamp, and fails if Windows does not report the signature as valid. The private key never leaves the certificate store.

## Self-made certificates

A self-made certificate costs nothing but is trusted only on PCs where its public part is in the current user's **Trusted Root Certification Authorities** and **Trusted Publishers** stores, so it suits personal use. Keep a password-protected backup (`.pfx`) somewhere safe and never commit it.

Installed copies accept updates only from the certificate subject they were built with. A release signed under a different subject is refused, and those installations need one manual reinstall.

## Builds by someone else

To publish your own builds, change `release.githubOwner`, `release.githubRepo` and `release.publisherName` in `package.json` to your repository and certificate. To build without automatic updates, empty `release.githubOwner`; the installer is then built unsigned and never checks for updates.
