const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../utils/logger');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NODE_MODULES = path.join(__dirname, '..', '..', 'node_modules');

/**
 * Ships the Linux sqlite3 N-API binding into app/native/nativelibs/sqlite3/.
 *
 * The renderer and worker bundles open every local database (SecureLocalstorage,
 * DBState, Storage, ...) through this binding — without it the login flow dies
 * with "DBUnknownError: Cannot find module './binding/napi-v6-linux-x64/
 * node_sqlite3.node'" and the window spins on "Đang đăng nhập…" forever.
 *
 * Source of the binding, in order:
 *   1. node_modules/sqlite3/build/Release/node_sqlite3.node (prebuilt or built
 *      by a previous install step)
 *   2. built here with the node-gyp bundled in node_modules/sqlite3 (offline,
 *      no network needed)
 *
 * Failing to produce the binding aborts the build: shipping the app without it
 * produces a silently broken login (this exact bug), so a hard failure here is
 * much cheaper than a broken release.
 */
async function main() {
  const sqliteTargetDir = path.join(APP_DIR, 'native', 'nativelibs', 'sqlite3', 'binding', `napi-v6-linux-${arch}`);
  fs.mkdirSync(sqliteTargetDir, { recursive: true });

  const targetNodePath = path.join(sqliteTargetDir, 'node_sqlite3.node');
  const sourceNodePath = path.join(NODE_MODULES, 'sqlite3', 'build', 'Release', 'node_sqlite3.node');
  const sqlite3Dir = path.join(NODE_MODULES, 'sqlite3');

  if (!fs.existsSync(sourceNodePath) && fs.existsSync(sqlite3Dir)) {
    logger.info('sqlite3 Linux binding not built yet — compiling with node-gyp (offline)...');
    const nodeGypBin = path.join(sqlite3Dir, 'node_modules', '.bin', 'node-gyp');
    try {
      execFileSync(nodeGypBin, ['rebuild'], {
        cwd: sqlite3Dir,
        stdio: 'pipe',
        timeout: 10 * 60 * 1000,
        env: process.env
      });
    } catch (e) {
      throw new Error(
        'Failed to compile the sqlite3 Linux binding: ' + e.message +
        '\nBuild the dependency manually: cd node_modules/sqlite3 && ./node_modules/.bin/node-gyp rebuild'
      );
    }
  }

  if (!fs.existsSync(sourceNodePath)) {
    throw new Error(
      'sqlite3 binding missing: ' + sourceNodePath + ' not found.\n' +
      'Run "npm install" (and ensure the native build toolchain: make, gcc, python3) so the binding can be built. ' +
      'Without it the packaged app cannot open its local databases and login hangs forever.'
    );
  }

  fs.copyFileSync(sourceNodePath, targetNodePath);

  // Sanity check: must be an ELF/shared-object, not an error page or empty file.
  const head = fs.readFileSync(targetNodePath).subarray(0, 4);
  const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  if (!isElf) {
    throw new Error('sqlite3 binding at ' + targetNodePath + ' is not a native ELF binary — refusing to ship it');
  }

  logger.success(`SQLite3 Linux binding installed (${arch}, ${(fs.statSync(targetNodePath).size / 1024 / 1024).toFixed(1)} MB)`);
}

if (require.main === module) {
  main().catch((e) => {
    logger.error(e.message);
    process.exit(1);
  });
}

module.exports = { main };
