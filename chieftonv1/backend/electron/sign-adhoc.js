/**
 * electron-builder afterPack hook — ad-hoc signs the macOS app bundle.
 * Prevents Gatekeeper "file is damaged" errors on unsigned apps.
 * Users will see "unidentified developer" instead, bypassable via right-click → Open.
 */
exports.default = async function(context) {
  if (process.platform !== 'darwin') return;
  const { execSync } = require('child_process');
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`Ad-hoc signing: ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
};
