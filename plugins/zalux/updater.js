/**
 * plugins/zalux/updater.js
 *
 * Core update-checking and download logic for the Zalux plugin.
 */

'use strict';

const fs      = require('fs');
const https   = require('https');
const path    = require('path');
const crypto  = require('crypto');

// The project lives under the VN-Linux-Family org (moved from doandat943 —
// the old URL now answers HTTP 301, which killed the update check).
const RELEASES_URL = 'https://api.github.com/repos/VN-Linux-Family/zalo-for-linux/releases/latest';

const MAX_REDIRECTS      = 5;
const CHECK_TIMEOUT_MS   = 10000;

// Sanity constants used to verify a download before it may replace the
// running app (see _verifyAppImageFile). Added after the 26.10.10 incident,
// where the aarch64-only release was downloaded onto an x86_64 machine and
// swapped in unverified → exec format error.
const ELF_MAGIC          = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF at offset 0
const APPIMAGE_MAGIC     = Buffer.from([0x41, 0x49, 0x02]);       // 'AI' + type-2 marker at offset 8
const ELF_MACHINE        = { x86_64: 0x3e, aarch64: 0xb7 };       // ELF e_machine values
const MIN_APPIMAGE_BYTES = 10 * 1024 * 1024;                      // real builds are ~170-290 MB
const RELAUNCH_GRACE_MS  = 10000;

let _appDir        = null;
let _getMainWindow = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function init({ appDir, getMainWindow }) {
  _appDir        = appDir;
  _getMainWindow = getMainWindow;
}

/**
 * Check for updates and call `callback` with a result object.
 *
 * Result shape:
 * {
 *   isAppImage   : boolean,
 *   needsUpdate  : boolean,
 *   buildInfo    : object | null,    — local build-info.json
 *   remoteInfo   : object | null,    — parsed from asset filename
 *   release      : object | null,    — full GitHub release object
 *   asset        : object | null,    — the matching AppImage asset
 *   currentAppImagePath : string | null,
 *   error        : string | null,    — set on network / parse failures
 * }
 *
 * This function NEVER shows dialogs on its own — all UI is handled by index.js.
 *
 * @param {function} callback
 */
function checkUpdates(callback) {
  const { app } = require('electron');
  const isAppImage = app.isPackaged && typeof process.env.APPIMAGE === 'string';
  const currentAppImagePath = isAppImage ? process.env.APPIMAGE : null;

  // Always read local build info if available
  const buildInfoPath = path.join(_appDir, 'pc-dist', 'build-info.json');
  const buildInfo = fs.existsSync(buildInfoPath)
    ? JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
    : null;

  const done = (overrides = {}) => {
    callback({
      isAppImage,
      currentAppImagePath,
      buildInfo,
      needsUpdate: false,
      remoteInfo: null,
      release: null,
      asset: null,
      error: null,
      ...overrides
    });
  };

  // If not AppImage, we can still display version info but cannot update
  if (!isAppImage) return done();

  if (!buildInfo) return done({ error: 'build-info.json not found' });

  // One wall-clock timeout + settle guard for the whole check (redirects
  // hop through several sockets, so a per-request idle timeout is fragile).
  let settled   = false;
  const reqRef  = { current: null };

  const finish = (overrides = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(overrides);
  };

  const timer = setTimeout(() => {
    console.error('[Zalux] Timeout');
    if (reqRef.current) reqRef.current.destroy();
    finish({ error: 'Kết nối quá hạn' });
  }, CHECK_TIMEOUT_MS);

  _getFollowRedirects(
    RELEASES_URL,
    { headers: { 'User-Agent': 'zalo-for-linux-updater' } },
    (res, err) => {
      if (err) {
        console.error('[Zalux] Network error:', err);
        return finish({ error: 'Lỗi kết nối mạng' });
      }

      if (res.statusCode !== 200) {
        console.warn('[Zalux] GitHub API status:', res.statusCode);
        return finish({ error: `GitHub API trả về ${res.statusCode}` });
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const asset = _pickAsset(release.assets, buildInfo);

          if (!asset || !asset.browser_download_url) {
            // A release exists but has no AppImage for this machine's
            // architecture — surface that instead of silently ignoring it
            // (a release can legitimately ship only aarch64 or only x86_64).
            const hasAnyAppImage = Array.isArray(release.assets) &&
              release.assets.some(a => a && typeof a.name === 'string' && a.name.endsWith('.AppImage'));
            if (hasAnyAppImage) {
              console.warn('[Zalux] Latest release has no build for', _runningArch());
              return finish({
                release,
                error: `Bản mới nhất chưa có bản dựng cho kiến trúc máy bạn (${_runningArch()})`
              });
            }
            return finish({ release });
          }

          const remoteInfo = _parseAssetName(asset.name);
          if (!remoteInfo || !remoteInfo.commit) return finish({ release, asset });

          // Never offer a downgrade: only newer versions, or a rebuild
          // (different commit) of the same version.
          const zaloCmp = _cmpVersion(remoteInfo.zaloVersion, buildInfo.version);
          const zadarkCmp = (buildInfo.zadarkVersion && remoteInfo.zadarkVersion)
            ? _cmpVersion(remoteInfo.zadarkVersion, buildInfo.zadarkVersion)
            : 0;

          const needsUpdate =
            zaloCmp > 0 ||
            zadarkCmp > 0 ||
            (zaloCmp === 0 && remoteInfo.commit !== buildInfo.commit);

          finish({ needsUpdate, remoteInfo, release, asset });
        } catch (e) {
          console.error('[Zalux] Parse error:', e);
          finish({ error: 'Lỗi phân tích phản hồi máy chủ' });
        }
      });
    },
    0,
    reqRef
  );
}

/**
 * Download the new AppImage, verify it, swap it in-place and relaunch.
 * Sends IPC progress events to `versionWin`.
 *
 * Safety rails (added after the aarch64-on-x86_64 incident):
 *  - refuses assets built for a foreign architecture before downloading
 *  - verifies the downloaded file (ELF + AppImage magic, e_machine, size,
 *    and the release's sha256 digest when GitHub provides one) BEFORE the
 *    current AppImage is touched
 *  - hard-links the current file as `.update-bak` and restores it if the
 *    new binary cannot be launched
 */
function downloadAndSwap(asset, currentAppImagePath, versionWin) {
  const { app } = require('electron');

  // Pre-flight: never download a build for a foreign architecture.
  const info = _parseAssetName(asset && asset.name);
  if (info && info.arch && info.arch !== _runningArch()) {
    console.error('[Zalux] Refusing download:', asset.name, 'is for', info.arch);
    try {
      versionWin.webContents.send('download-error',
        `Bản cập nhật dành cho ${info.arch}, máy bạn chạy ${_runningArch()} — đã hủy`);
    } catch (_) {}
    return;
  }

  const dir             = path.dirname(currentAppImagePath);
  const newAppImagePath = path.join(dir, asset.name);
  const backupPath      = currentAppImagePath + '.update-bak';
  let fileStream        = null;
  let settled           = false;

  // Clear any stale backup left over from a previous attempt.
  try { fs.unlinkSync(backupPath); } catch (_) {}

  const fail = (msg, e) => {
    if (settled) return;
    settled = true;
    if (e) console.error('[Zalux] Download error:', e);
    if (fileStream) { try { fileStream.destroy(); } catch (_) {} }
    fs.unlink(newAppImagePath, () => {});
    try { versionWin.webContents.send('download-error', msg); } catch (_) {}
  };

  // Runs after the download is fully written and closed. Verifies the file,
  // swaps it in, and relaunches — in that order, aborting on any failure
  // while the current AppImage is still untouched.
  const finalize = async () => {
    const verdict = await _verifyAppImageFile(newAppImagePath, {
      expectedSize:   fileStream.bytesWritten,
      expectedSha256: asset && asset.digest
    });
    if (!verdict.ok) {
      console.error('[Zalux] Download failed verification:', verdict.reason);
      return fail(`Tệp tải về không hợp lệ (${verdict.reason}) — đã hủy`);
    }

    try { versionWin.webContents.send('download-done'); } catch (_) {}

    // Swap with a rollback link: the old inode survives as .update-bak
    // until the new binary has actually launched.
    try {
      try { fs.linkSync(currentAppImagePath, backupPath); }
      catch (linkErr) {
        // Cross-device or unsupported — proceed without a rollback net.
        console.warn('[Zalux] Rollback link unavailable:', linkErr.message);
      }

      // On Linux, unlinking a running file is safe: the kernel keeps
      // the inode alive until the process exits.
      fs.unlinkSync(currentAppImagePath);
      fs.renameSync(newAppImagePath, currentAppImagePath);
    } catch (e) {
      _restoreBackup(currentAppImagePath, backupPath);
      return fail(`Lỗi cài đặt: ${e.message || e}`, e);
    }

    // Relaunch. If the new file cannot be executed (e.g. wrong arch,
    // corrupt), restore the backup instead of leaving a brick behind.
    try {
      const { spawn } = require('child_process');

      // Clear AppImage env vars so the new process mounts fresh.
      const env = { ...process.env };
      delete env.APPIMAGE;
      delete env.APPDIR;
      delete env.OWD;

      const child = spawn(currentAppImagePath, process.argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        env
      });

      child.on('error', (spawnErr) => {
        if (settled) return;
        settled = true;
        console.error('[Zalux] Relaunch failed:', spawnErr);
        _restoreBackup(currentAppImagePath, backupPath);
        try {
          versionWin.webContents.send('download-error',
            `Không thể khởi động bản mới — đã khôi phục bản cũ (${spawnErr.code || spawnErr.message})`);
        } catch (_) {}
      });

      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        try { fs.unlinkSync(backupPath); } catch (_) {}
        setTimeout(() => app.exit(0), 500);
      });

      // If neither event fires within the grace period, assume the worst.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        console.error('[Zalux] Relaunch inconclusive — restoring backup');
        _restoreBackup(currentAppImagePath, backupPath);
        try {
          versionWin.webContents.send('download-error',
            'Không xác nhận được bản mới có chạy được — đã khôi phục bản cũ');
        } catch (_) {}
      }, RELAUNCH_GRACE_MS);
    } catch (e) {
      console.error('[Zalux] Relaunch threw:', e);
      _restoreBackup(currentAppImagePath, backupPath);
      try {
        versionWin.webContents.send('download-error', `Lỗi khởi động: ${e.message || e}`);
      } catch (_) {}
    }
  };

  fileStream = fs.createWriteStream(newAppImagePath);

  _getFollowRedirects(
    asset.browser_download_url,
    { headers: { 'User-Agent': 'zalo-for-linux-updater' } },
    (res, err) => {
      if (err) return fail('Mất kết nối mạng.', err);

      if (res.statusCode !== 200) {
        return fail(`Lỗi tải về: HTTP ${res.statusCode}`);
      }

      const totalBytes = parseInt(res.headers['content-length'], 10);
      let downloadedBytes = 0;
      let lastPercent = -1;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const percent = totalBytes
          ? Math.round((downloadedBytes / totalBytes) * 1000) / 10
          : 0;
        if (Math.round(percent) > lastPercent) {
          try {
            versionWin.webContents.send('download-progress', percent);
          } catch (_) {}
          lastPercent = Math.round(percent);
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        // Wait for the file to be fully closed before verifying it.
        fileStream.close((closeErr) => {
          if (settled) return;
          if (closeErr) return fail(`Lỗi ghi tệp: ${closeErr.message || closeErr}`, closeErr);
          finalize().catch((e) => fail(`Lỗi kiểm tra tệp: ${e.message || e}`, e));
        });
      });

      fileStream.on('error', (e) => fail(`Lỗi ghi tệp: ${e.message || e}`, e));
    }
  );
}

// ---------------------------------------------------------------------------
// Badge helper (called from index.js after check)
// ---------------------------------------------------------------------------

function showBadge(visible) {
  const mainWindow = _getMainWindow ? _getMainWindow() : null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = visible ? 'block' : 'none';
  mainWindow.webContents
    .executeJavaScript(`const b = document.getElementById('zalu-badge'); if (b) b.style.display = '${display}';`)
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** The arch name used in our asset filenames for the running process. */
function _runningArch() {
  return (process.arch === 'arm64' || process.arch === 'aarch64') ? 'aarch64' : 'x86_64';
}

/**
 * https.get does not follow redirects on its own (this is exactly what broke
 * the update check when the repo moved orgs — api.github.com answered 301).
 * Follow up to MAX_REDIRECTS and hand the final response to onResponse.
 */
function _getFollowRedirects(url, options, onResponse, hops = 0, reqRef = null) {
  const req = https.get(url, options, (res) => {
    const status   = res.statusCode || 0;
    const location = res.headers.location;

    if ([301, 302, 303, 307, 308].includes(status) && location && hops < MAX_REDIRECTS) {
      res.resume(); // drain the redirect body
      const next = new URL(location, url).toString();
      _getFollowRedirects(next, options, onResponse, hops + 1, reqRef);
      return;
    }

    onResponse(res);
  });

  if (reqRef) reqRef.current = req;
  req.on('error', (e) => onResponse(null, e));
  return req;
}

/**
 * Pick the release asset that matches the running build:
 * same channel (ZaDark vs Original), SAME architecture (mandatory — the
 * 26.10.10 release shipped only aarch64 and the old cross-arch fallback
 * bricked x86_64 installs), and prefer the `-Full` variant (bundled wine
 * runtime) when the running app has one.
 */
function _pickAsset(assets, buildInfo) {
  if (!Array.isArray(assets)) return null;

  const isZaDark = !!buildInfo.zadarkVersion;
  const arch = _runningArch();
  const preferFull = _detectPrefersFull();

  const parsed = assets
    .filter(a => a && typeof a.name === 'string' &&
      a.name.endsWith('.AppImage') &&          // excludes .AppImage.zsync
      a.browser_download_url)
    .map(a => ({ asset: a, info: _parseAssetName(a.name) }))
    .filter(x => x.info);

  const sameChannel = parsed.filter(x =>
    isZaDark ? !!x.info.zadarkVersion : !x.info.zadarkVersion
  );
  if (sameChannel.length === 0) return null;

  const pool = sameChannel.filter(x => x.info.arch === arch);
  if (pool.length === 0) return null; // no same-arch build → never cross architectures

  if (preferFull) {
    const fulls = pool.filter(x => x.info.full);
    if (fulls.length) return fulls[0].asset;
  } else {
    const standards = pool.filter(x => !x.info.full);
    if (standards.length) return standards[0].asset;
  }

  return pool[0].asset;
}

/** The `-Full` variants bundle the wine runtime — detect the local one. */
function _detectPrefersFull() {
  try {
    return fs.existsSync(path.join(_appDir, 'native', 'wine-runtime', 'bin', 'wine'));
  } catch (_) {
    return false;
  }
}

/**
 * Parse the current AppImage asset naming:
 *   Zalo-<zalo>-Original-<commit>[-Full][-<arch>].AppImage
 *   Zalo-<zalo>+ZaDark-<zadark>-<commit>[-Full][-<arch>].AppImage
 * The 7+ hex commit never contains '-', so a lazy match is safe.
 */
function _parseAssetName(name) {
  const match = String(name || '').match(
    /^Zalo-(\d+(?:\.\d+)*)(?:-Original|\+ZaDark-(\d+(?:\.\d+)*))?-([0-9a-f]{7,40})(-Full)?-(x86_64|aarch64)\.AppImage$/
  );
  if (!match) return null;
  return {
    zaloVersion:   match[1],
    zadarkVersion: match[2] || null,
    commit:        match[3],
    full:          !!match[4],
    arch:          match[5]
  };
}

/** Dotted-version compare: -1 (a<b), 0 (a==b), 1 (a>b). */
function _cmpVersion(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Verify that a downloaded file is a real, complete AppImage for THIS
 * machine, before it is allowed to replace the running app:
 *   - at least MIN_APPIMAGE_BYTES (catches HTML error pages / stub files)
 *   - size equals the expected byte count when known (catches truncation)
 *   - ELF magic at offset 0, AppImage magic 'AI\x01\x02' at offset 8
 *   - ELF e_machine (offset 18) matches the running architecture
 *   - sha256 matches the release asset digest when GitHub provides one
 *
 * @param {string} filePath
 * @param {{expectedSize?: number, expectedSha256?: string}} [expectations]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function _verifyAppImageFile(filePath, { expectedSize, expectedSha256 } = {}) {
  let fd = null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (st.size < MIN_APPIMAGE_BYTES) {
      return { ok: false, reason: `quá nhỏ (${st.size} bytes)` };
    }
    if (Number.isFinite(expectedSize) && expectedSize > 0 && st.size !== expectedSize) {
      return { ok: false, reason: `kích thước lệch (got ${st.size}, expected ${expectedSize})` };
    }

    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(20);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < header.length) return { ok: false, reason: 'header bị cụt' };

    if (!header.subarray(0, 4).equals(ELF_MAGIC)) {
      return { ok: false, reason: 'thiếu ELF magic' };
    }
    if (!header.subarray(8, 11).equals(APPIMAGE_MAGIC)) {
      return { ok: false, reason: 'thiếu AppImage magic' };
    }

    const machine = header.readUInt16LE(18);
    const expectedMachine = ELF_MACHINE[_runningArch()];
    if (machine !== expectedMachine) {
      return {
        ok: false,
        reason: `sai kiến trúc (e_machine=0x${machine.toString(16)}, cần 0x${expectedMachine.toString(16)})`
      };
    }
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }

  if (expectedSha256 && /^sha256:[0-9a-f]{64}$/i.test(String(expectedSha256))) {
    const wanted = String(expectedSha256).slice(7).toLowerCase();
    const got = await _sha256File(filePath).catch(() => null);
    if (!got) return { ok: false, reason: 'không đọc được tệp để băm' };
    if (got !== wanted) return { ok: false, reason: 'sha256 không khớp' };
  }

  return { ok: true };
}

/** Streamed sha256 hex digest of a file. */
function _sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Restore `currentPath` from `backupPath` (used when a freshly swapped-in
 * AppImage cannot be launched). Returns true when a restore happened.
 */
function _restoreBackup(currentPath, backupPath) {
  try {
    if (!fs.existsSync(backupPath)) return false;
    try { fs.unlinkSync(currentPath); } catch (_) {}
    fs.renameSync(backupPath, currentPath);
    console.warn('[Zalux] Restored previous AppImage from backup');
    return true;
  } catch (e) {
    console.error('[Zalux] Backup restore failed:', e);
    return false;
  }
}

module.exports = {
  init,
  checkUpdates,
  downloadAndSwap,
  showBadge,
  // exported for offline test harnesses
  _runningArch,
  _parseAssetName,
  _cmpVersion,
  _pickAsset,
  _detectPrefersFull,
  _verifyAppImageFile,
  _restoreBackup
};
