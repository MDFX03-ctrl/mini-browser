'use strict';
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
module.exports = (executable, integrity = false) => flipFuses(executable, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: integrity
});
