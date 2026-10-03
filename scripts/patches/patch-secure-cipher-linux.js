const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_JS_PATH = path.join(APP_DIR, 'main-dist', 'main.js');

// Zalo's secure-cipher module runs `codesign --verify <Zalo.app>` on startup to
// decide between macOS Keychain and raw secret-key storage. On Linux the binary
// does not exist, and upstream's internal promise-queue helpers let the
// resulting ENOENT rejection escape as an UnhandledPromiseRejectionWarning.
// Short-circuiting checkAppSigned() to return false is the same outcome as the
// intended fallback (raw storage), minus the noise.
const ANCHOR = 'async checkAppSigned(){return null!=this.isAppSigned';
const PATCHED_ANCHOR = 'async checkAppSigned(){return!1;return null!=this.isAppSigned';
const MARKER = 'checkAppSigned(){return!1;';

function patchSecureCipherLinux(content) {
  if (content.includes(MARKER)) return content;
  if (!content.includes(ANCHOR)) return null;
  return content.replace(ANCHOR, PATCHED_ANCHOR);
}

async function main() {
  if (!fs.existsSync(MAIN_JS_PATH)) {
    logger.warn('main.js not present, skipping secure-cipher patch');
    return;
  }

  const original = fs.readFileSync(MAIN_JS_PATH, 'utf8');
  const patched = patchSecureCipherLinux(original);

  if (patched === null) {
    logger.warn('Pattern "async checkAppSigned(){return null!=this.isAppSigned" not found in main.js, skipping patch');
    return;
  }

  if (patched !== original) {
    fs.writeFileSync(MAIN_JS_PATH, patched, 'utf8');
    logger.dim('Patched main.js: short-circuited checkAppSigned (codesign/keychain is macOS-only)');
  }

  logger.success('Secure-cipher Linux patch applied');
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Secure-cipher Linux patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  patchSecureCipherLinux
};
