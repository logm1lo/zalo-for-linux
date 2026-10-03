const fs = require('fs');
const path = require('path');

let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    success: (...args) => console.log('[SUCCESS]', ...args),
    dim: (...args) => console.log(' ', ...args)
  };
}

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/**
 * Patch Zalo network state detection (gwig) and sync controller routing:
 * 1. Force getStateNetwork() to return CONNECTED for OUTSIDE callers so sync and
 *    calls proceed, while the manager's own state machine keeps reading the real
 *    stateCur. Its connectivity probe (_pingToDomain) is left as the original
 *    real XHR check — NOT stubbed to always-resolve (upstream #87, never detects
 *    offline) and NOT tied to navigator.onLine (stays false after resume from
 *    suspend, leaving it stuck offline). The real probe fails when wifi is off
 *    and succeeds once the link is back after resume, so the manager goes
 *    DISCONNECT -> CHECKING -> CONNECTED again in both cases and re-signals the
 *    socket and UI, instead of staying stuck showing "no internet".
 * 2. Remove premature NO_NETWORK (1106) throw in main-startup.
 * 3. Route Sync Messages to SyncMessageController (V1) which sends push confirmation
 *    to mobile devices and saves message data via db-cross-v4 / sqlite3.
 * 4. Enable SQLite backup data adapter flag in main process.
 *
 * Every file is verified after patching; a missed pattern aborts the build
 * instead of shipping a half-patched bundle. Upstream Zalo shuffles minified
 * log tags and module names between releases ("3m6V8S" -> "Ab7ZX-",
 * "_g"/"mg" -> "Ag"/"Rg"), which silently broke exact-string patterns here and
 * left the network_disconnected guard active in the login bundle — one cause
 * of an eternal "Đang đăng nhập…" spinner. Patterns that only differ in such
 * tags are therefore written as regexes.
 */

// Exact-string group for the gwig network manager, shared by the renderer and
// worker bundles.
const NETWORK_STATE_FIX = [
  ['networkConnected(){this.getStateNetwork()!==u.CONNECTED&&', 'networkConnected(){this.stateCur!==u.CONNECTED&&'],
  ['const n=()=>{this.getStateNetwork()===u.CHECKING?', 'const n=()=>{this.stateCur===u.CHECKING?'],
  ['t<=0?(this.getStateNetwork()===u.CONNECTED?', 't<=0?(this.stateCur===u.CONNECTED?'],
  ['getStateNetwork(){return this.stateCur}', 'getStateNetwork(){return u.CONNECTED}'],
  // NOT_SET is the manager's true initial state; forcing CONNECTED here makes
  // networkConnected() skip its first probe/signal and the socket layer then
  // waits for a network event that never fires.
  ['this.stateCur=u.NOT_SET', 'this.stateCur=u.CONNECTED'],
  // _pingToDomain is deliberately NOT replaced — see the header comment.
];

// Guards whose minified log tags / identifiers churn between Zalo releases:
// regex-based.
const GUARD_REGEX_FIXES = [
  [
    /checkFeatureEnabled\(\)\{return this\.configService\.isFeatureEnabled\(\)\?\{ok:!0\}:\(this\.logger\.zsymb\(9,"[^"]*",\["Guard feature disabled by server config","[^"]*"\]\),\{ok:!1,reason:"feature_disabled"\}\)\}/,
    'checkFeatureEnabled(){return{ok:!0}}'
  ],
  [
    /checkNetwork\(\)\{const e=ge\.b\.getStateNetwork\(\);return e!==ge\.a\.DISCONNECT\?\{ok:!0\}:\(this\.logger\.zsymb\(9,"[^"]*",\["Guard network disconnected","[^"]*"\],\{networkState:e\}\),\{ok:!1,reason:"network_disconnected",networkState:e\}\)\}/,
    'checkNetwork(){return{ok:!0}}'
  ],
  [
    // NO_NETWORK guard before the first requestSyncMessage. Minified module
    // names changed upstream (_g/mg -> Ag/Rg), which silently broke the old
    // exact-string replacement. Lookahead keeps the throw statement intact:
    // only the condition is replaced with "!1".
    /ge\.b\.getStateNetwork\(\)===ge\.a\.DISCONNECT\|\|[A-Za-z_$][\w$]*\.default\.getSocketState\(\)!==[A-Za-z_$][\w$]*\.l\.OPEN(?=\)throw new [A-Za-z_$][\w$]*\.a\([A-Za-z_$][\w$]*\.c\.NO_NETWORK\))/,
    '!1'
  ]
];

// The login/main-startup bundle must NOT keep these markers after patching —
// their presence means the guard bodies were not stubbed and can still throw
// "network_disconnected" / "feature_disabled" at login time. (The bare reason
// strings also occur in the guard dispatch switch and the backup flow, where
// they are legitimate — so the bodies are checked, not the literals.)
const GUARD_FORBIDDEN_MARKERS = [
  /checkNetwork\(\)\{const e=ge\.b\.getStateNetwork\(\)/,
  /checkFeatureEnabled\(\)\{return this\.configService\.isFeatureEnabled\(\)/
];
const NO_NETWORK_GUARD_LEFTOVER = /getStateNetwork\(\)===ge\.a\.DISCONNECT\|\|[A-Za-z_$][\w$]*\.default\.getSocketState\(\)!==[A-Za-z_$][\w$]*\.l\.OPEN\)throw/;

function findFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => pattern.test(f))
    .map(f => path.join(dir, f));
}

// Applies one replacement, returns the new content. String replacements are
// skipped when their result is already present (idempotency); regex
// replacements simply do nothing when the pattern no longer matches.
function applyOne(content, from, to) {
  if (typeof from === 'string') {
    if (!content.includes(from) || content.includes(to)) return content;
    return content.split(from).join(to);
  }
  if (from instanceof RegExp) {
    if (!from.test(content)) return content;
    return content.replace(from, to);
  }
  return content;
}

// Applies a whole [from, to] list; returns the resulting content.
function applyList(content, list) {
  for (const [from, to] of list) {
    content = applyOne(content, from, to);
  }
  return content;
}

function writeIfChanged(filePath, before, after) {
  if (after !== before) {
    fs.writeFileSync(filePath, after, 'utf8');
  }
}

const showMarker = m => JSON.stringify(typeof m === 'string' ? m.slice(0, 70) : String(m));

function verifyMarkers(filePath, requiredPresent, requiredAbsent, label) {
  const content = fs.readFileSync(filePath, 'utf8');
  const missing = requiredPresent.filter(m => !content.includes(m));
  const leftover = (requiredAbsent || []).filter(m => (m instanceof RegExp) ? m.test(content) : content.includes(m));
  if (missing.length || leftover.length) {
    const parts = [];
    if (missing.length) parts.push('missing markers: ' + missing.map(showMarker).join(', '));
    if (leftover.length) parts.push('forbidden markers still present: ' + leftover.map(showMarker).join(', '));
    throw new Error(`network-and-sync patch verification FAILED for ${label} (${path.basename(filePath)}): ${parts.join('; ')}` +
      '\nUpstream Zalo changed and the patch needs updating — do NOT ship this build.');
  }
}

async function main() {
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const mainDistDir = path.join(APP_DIR, 'main-dist');
  const lazyDir = path.join(pcDistDir, 'lazy');

  if (!fs.existsSync(pcDistDir)) {
    logger.warn('pc-dist directory not found, skipping network-and-sync fix');
    return;
  }

  // 1. main-startup bundle in lazy/
  const startupFiles = findFiles(lazyDir, /^main-startup\..*\.js$/);
  if (!startupFiles.length) throw new Error('network-and-sync: no main-startup.*.js found in ' + lazyDir);
  for (const f of startupFiles) {
    const before = fs.readFileSync(f, 'utf8');
    const after = applyList(before, [
      ['isEnable(){const e=this.config.get("cross_setting.offFeature"),t=this.config.get("cross_setting.enable");return!e&&t}', 'isEnable(){return !0}'],
      ['isEnableResume(){return!!this.isEnable()&&this.config.get("cross_setting.enableResume")}', 'isEnableResume(){return !0}'],
      ...GUARD_REGEX_FIXES
    ]);
    writeIfChanged(f, before, after);
    logger.dim(`main-startup: ${after !== before ? 'patched' : 'already ok'}`);
    verifyMarkers(f, [
      'checkNetwork(){return{ok:!0}}',
      'checkFeatureEnabled(){return{ok:!0}}',
      'isEnable(){return !0}',
      'isEnableResume(){return !0}'
    ], [...GUARD_FORBIDDEN_MARKERS, NO_NETWORK_GUARD_LEFTOVER], 'main-startup');
  }

  // 2. default-login bundle in lazy/
  const defaultLoginFiles = findFiles(lazyDir, /^default-login-main-startup-shared-worker-znotification\..*\.js$/);
  if (!defaultLoginFiles.length) throw new Error('network-and-sync: no default-login-main-startup-shared-worker-znotification.*.js found');
  for (const f of defaultLoginFiles) {
    const before = fs.readFileSync(f, 'utf8');
    const after = applyList(before, [
      ['const a=!0,s=!0,r=!0', 'const a=!0,s=!1,r=!0'],
      ...NETWORK_STATE_FIX,
      ['canUseIpcCall(){return A.default.enable_ipc_call&&ne}', 'canUseIpcCall(){return !0}'],
      ['isSupport(){return!!A.default.enable_mac_call&&(A.default.enableCall&&se)}', 'isSupport(){return !0}'],
      ['isSupportVideoCall(){return this.isSupport()&&A.default.enableVideoCall}', 'isSupportVideoCall(){return !0}']
    ]);
    writeIfChanged(f, before, after);
    logger.dim(`default-login: ${after !== before ? 'patched' : 'already ok'}`);
    verifyMarkers(f, [
      'networkConnected(){this.stateCur!==u.CONNECTED&&',
      'getStateNetwork(){return u.CONNECTED}',
      'this.stateCur=u.CONNECTED',
      'canUseIpcCall(){return !0}',
      'isSupport(){return !0}',
      'isSupportVideoCall(){return !0}'
    ], [], 'default-login');
  }

  // 3. Other worker & renderer bundles
  const otherBundles = [
    ...findFiles(pcDistDir, /^compact-app-pc\..*\.js$/),
    ...findFiles(pcDistDir, /^search-worker\..*\.js$/),
    ...findFiles(pcDistDir, /^sync-v2-sub-worker\..*\.js$/)
  ];
  if (otherBundles.length !== 3) throw new Error(`network-and-sync: expected 3 worker bundles, found ${otherBundles.length}`);
  for (const f of otherBundles) {
    const before = fs.readFileSync(f, 'utf8');
    const after = applyList(before, [
      ['const a=!0,i=!0,o=!0', 'const a=!0,i=!1,o=!0'],
      ...NETWORK_STATE_FIX,
      ['canUseIpcCall(){return A.default.enable_ipc_call&&ne}', 'canUseIpcCall(){return !0}'],
      ['isSupport(){return!!A.default.enable_mac_call&&(A.default.enableCall&&ie)}', 'isSupport(){return !0}'],
      ['isSupportVideoCall(){return this.isSupport()&&A.default.enableVideoCall}', 'isSupportVideoCall(){return !0}']
    ]);
    writeIfChanged(f, before, after);
    verifyMarkers(f, [
      'networkConnected(){this.stateCur!==u.CONNECTED&&',
      'getStateNetwork(){return u.CONNECTED}',
      'this.stateCur=u.CONNECTED',
      'canUseIpcCall(){return !0}',
      'isSupport(){return !0}',
      'isSupportVideoCall(){return !0}'
    ], [], path.basename(f));
  }

  // 4. preload-sqlite.js
  const preloadSqlite = path.join(mainDistDir, 'preload-sqlite.js');
  if (!fs.existsSync(preloadSqlite)) throw new Error('network-and-sync: preload-sqlite.js not found');
  {
    const before = fs.readFileSync(preloadSqlite, 'utf8');
    const after = applyList(before, [
      ['cross_setting:{offFeature:!1,isMobileSupport:!1,', 'cross_setting:{enable:!0,offFeature:!1,isMobileSupport:!0,'],
      ['try{let t=1==e.settings.chat.enable_call;at.enableCall=t}catch(ht){}', 'try{let t=1==e.settings.chat.enable_call;at.enableCall=!0}catch(ht){}'],
      ['try{let t=1==e.settings.chat.enable_video_call;at.enableVideoCall=t}catch(ht){}', 'try{let t=1==e.settings.chat.enable_video_call;at.enableVideoCall=!0}catch(ht){}'],
      ['enable_group_call_for_user:0,enable_group_call_entry_for_group:0', 'enable_group_call_for_user:1,enable_group_call_entry_for_group:1']
    ]);
    writeIfChanged(preloadSqlite, before, after);
    verifyMarkers(preloadSqlite, ['cross_setting:{enable:!0,offFeature:!1,isMobileSupport:!0,'], [], 'preload-sqlite');
  }

  // 5. Enable SQLite backup data adapter flag in main process
  const mainJs = path.join(mainDistDir, 'main.js');
  if (!fs.existsSync(mainJs)) throw new Error('network-and-sync: main-dist/main.js not found');
  {
    const before = fs.readFileSync(mainJs, 'utf8');
    const after = applyList(before, [
      [
        'const a=!1,s="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",l="CREATE_BACKING_UP_FOR_NO_SESSION";const d=!1',
        'const a=!0,s="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",l="CREATE_BACKING_UP_FOR_NO_SESSION";const d=!0'
      ]
    ]);
    writeIfChanged(mainJs, before, after);
    verifyMarkers(mainJs, ['const a=!0,s="--backupdata"', ';const d=!0'], [], 'main.js backupdata');
  }

  const utilSqlite = path.join(mainDistDir, 'utility-process-sqlite.js');
  if (!fs.existsSync(utilSqlite)) throw new Error('network-and-sync: utility-process-sqlite.js not found');
  {
    const before = fs.readFileSync(utilSqlite, 'utf8');
    const after = applyList(before, [
      [
        'const s=!1,a="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",u="CREATE_BACKING_UP_FOR_NO_SESSION";const l=!1',
        'const s=!0,a="--backupdata",c="ABORT_BACKING_UP_FOR_ALL_SESSION",u="CREATE_BACKING_UP_FOR_NO_SESSION";const l=!0'
      ]
    ]);
    writeIfChanged(utilSqlite, before, after);
    verifyMarkers(utilSqlite, ['const s=!0,a="--backupdata"'], [], 'utility-process-sqlite backupdata');
  }

  logger.success('Network and sync patches applied and verified');
}

if (require.main === module) {
  main().catch((e) => {
    logger.error(e.message);
    process.exit(1);
  });
}

module.exports = { main };
