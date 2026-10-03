const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const logger = require('./utils/logger');

const ZADARK_DIR = path.join(__dirname, '..', 'plugins', 'zadark');

// AppImage architecture suffix this runner produces (must match the asset
// naming used by build.js: x86_64 or aarch64).
function getArchSuffix() {
  return process.arch === 'arm64' ? 'aarch64' : 'x86_64';
}

async function main() {
  try {
    // Get all required versions
    const targetZaloVersion = process.env.ZALO_VERSION || await getLatestZaloVersion();
    const targetZaDarkVersion = process.env.ZADARK_VERSION || await getLatestZaDarkVersion();

    process.env.ZALO_VERSION = targetZaloVersion;
    process.env.ZADARK_VERSION = targetZaDarkVersion;

    // Only check combinations in GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
      logger.info('GitHub Actions detected - checking existing combinations');

      const targetCommit = execSync('git rev-parse --short HEAD', {
        encoding: 'utf8'
      }).trim();
      fs.appendFileSync(process.env.GITHUB_ENV, `COMMIT_HASH=${targetCommit}\n`);

      // Check existing combinations in releases
      const existingCombo = await getExistingCombinations();
      logger.info(`Found ${existingCombo.length} existing combinations in releases`);

      // Check if combination already exists — per architecture, so an
      // aarch64-only release never marks the x86_64 runner as done.
      const targetArch = getArchSuffix();
      const targetCombo = `${targetZaloVersion}+${targetZaDarkVersion}+${targetCommit}+${targetArch}`;
      const isExist = existingCombo.includes(targetCombo);

      if (isExist) {
        logger.info(`Workflow decision: skip (found ${targetCombo})`);
        process.env.BUILD = 'false';
      } else {
        logger.info(`Workflow decision: build (missing ${targetCombo})`);
        process.env.BUILD = 'true';
      }

      // Always publish the decision so the workflow can act on it explicitly
      // (a skipped leg must be distinguishable from a crashed one).
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=${process.env.BUILD}\n`);
      }
    }

    // Output for CI/scripts
    logger.dim(`ZALO_VERSION=${process.env.ZALO_VERSION}`);
    logger.dim(`ZADARK_VERSION=${process.env.ZADARK_VERSION}`);
    if (process.env.BUILD) logger.dim(`BUILD=${process.env.BUILD}`);
  } catch (error) {
    logger.error('Version check failed:', error.message);
    // Fail loudly: an aborted version check must never green-light a build
    // job that produces nothing while the release job publishes anyway.
    process.exit(1);
  }
}

async function getLatestZaloVersion() {
  return new Promise((resolve, reject) => {
    const request = https.get('https://zalo.me/download/zalo-pc?utm=90000', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        if (redirectUrl && redirectUrl.includes('.dmg')) {
          const match = redirectUrl.match(/ZaloSetup-universal-([0-9.]+)\.dmg/);
          if (match) {
            resolve(match[1]);
          } else {
            reject(new Error('Could not parse version from DMG URL'));
          }
        } else {
          reject(new Error('Redirect URL is not a DMG file'));
        }
        return;
      }
      reject(new Error(`Unexpected HTTP ${response.statusCode}`));
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function getLatestZaDarkVersion() {
  return new Promise((resolve, reject) => {
    try {
      // First ensure submodule is initialized and updated
      execSync('git submodule update --init --recursive --remote', {
        stdio: 'pipe'
      });

      execSync('git fetch --tags', {
        cwd: ZADARK_DIR,
        stdio: 'pipe'
      });

      // Get latest tag from submodule
      const latestTag = execSync('git tag --sort=-version:refname | head -1', {
        cwd: ZADARK_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();

      if (latestTag) {
        resolve(latestTag);
      } else {
        reject(new Error('No ZaDark tags found'));
      }
    } catch (error) {
      reject(new Error(`Could not get ZaDark version: ${error.message}`));
    }
  });
}

async function getExistingCombinations() {
  return new Promise((resolve) => {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases`,
      headers: { 'User-Agent': 'Node.js' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const releases = JSON.parse(data);
          const combinations = new Set();

          const KNOWN_ARCHES = ['x86_64', 'aarch64'];
          releases.forEach(release => {
            release.assets.forEach(asset => {
              const match = asset.name.match(/^Zalo-([0-9.]+)\+ZaDark-([0-9.]+)-([0-9a-fA-F]{7,})(?:-([A-Za-z0-9_-]+))?\.AppImage$/);
              if (match) {
                const zaloVer = match[1];
                const zadarkVer = match[2];
                const commitHash = match[3];
                // Variants (Full/PlainFull) add extra hyphen segments; the
                // architecture is always the final segment when present.
                const tail = (match[4] || '').split('-').pop();
                const arch = KNOWN_ARCHES.includes(tail) ? tail : 'unknown';
                combinations.add(`${zaloVer}+${zadarkVer}+${commitHash}+${arch}`);
              }
            });
          });

          resolve(Array.from(combinations));
        } catch (error) {
          logger.warn('Could not parse releases, assuming no existing combinations');
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };