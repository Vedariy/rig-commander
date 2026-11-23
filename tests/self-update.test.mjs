import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSemver,
  compareSemver,
  isNewerVersion,
  normalizeNpmReleaseInfo
} from '../openrig/assets/domain/semver.js';
import {
  SelfUpdater,
  detectInstallMode,
  getRecommendedUpdateCommand,
  readInstalledVersion
} from '../openrig/lib/self-update.mjs';

test('parseSemver, compareSemver and isNewerVersion handle semver precedence accurately', () => {
  assert.deepEqual(parseSemver('v3.2.0').normalized, '3.2.0');
  assert.equal(parseSemver('not-a-version'), null);
  assert.equal(parseSemver('3.2'), null);

  assert.equal(compareSemver('3.2.1', '3.2.0'), 1);
  assert.equal(compareSemver('3.10.0', '3.2.9'), 1);
  assert.equal(compareSemver('4.0.0', '3.99.99'), 1);
  assert.equal(compareSemver('3.2.0', '3.2.0'), 0);
  assert.equal(compareSemver('3.2.0', '3.2.0-beta.1'), 1);
  assert.equal(compareSemver('3.2.0-beta.2', '3.2.0-beta.1'), 1);
  assert.equal(compareSemver('3.1.9', '3.2.0'), -1);

  assert.equal(isNewerVersion('3.2.1', '3.2.0'), true);
  assert.equal(isNewerVersion('3.2.0', '3.2.0'), false);
  assert.equal(isNewerVersion('3.1.9', '3.2.0'), false);
  assert.equal(isNewerVersion('bad', '3.2.0'), false);
});

test('normalizeNpmReleaseInfo validates npmjs payload and builds safe release URL', () => {
  const ok = normalizeNpmReleaseInfo({ version: '3.3.0' }, 'rig-commander');
  assert.equal(ok.ok, true);
  assert.equal(ok.version, '3.3.0');
  assert.equal(ok.releaseUrl, 'https://www.npmjs.com/package/rig-commander/v/3.3.0');

  assert.equal(normalizeNpmReleaseInfo(null).ok, false);
  assert.equal(normalizeNpmReleaseInfo({ version: '3.3.0; rm -rf /' }).ok, false);
});

test('detectInstallMode and readInstalledVersion distinguish git-checkout, npx-cache and global-npm', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigcmd-upd-mode-'));
  try {
    const gitDir = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'package.json'), JSON.stringify({ version: '3.2.0' }));
    assert.equal(detectInstallMode(gitDir), 'git-checkout');
    assert.equal(readInstalledVersion(gitDir), '3.2.0');
    assert.equal(getRecommendedUpdateCommand('git-checkout'), 'git pull --ff-only && npm run sync:public');

    const npxDir = path.join(tmp, '_npx', 'abc123', 'node_modules', 'rig-commander');
    fs.mkdirSync(npxDir, { recursive: true });
    assert.equal(detectInstallMode(npxDir), 'npx-cache');
    assert.equal(getRecommendedUpdateCommand('npx-cache'), 'npx rig-commander@latest');

    const globDir = path.join(tmp, 'lib', 'node_modules', 'rig-commander');
    fs.mkdirSync(globDir, { recursive: true });
    assert.equal(detectInstallMode(globDir), 'global-npm');
    assert.equal(getRecommendedUpdateCommand('global-npm'), 'npm install -g rig-commander@latest');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SelfUpdater.check detects newer npmjs version, respects cache TTL, and handles errors safely', async () => {
  let fetchCalls = 0;
  const mockFetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { version: '3.4.0' };
      }
    };
  };

  const updater = new SelfUpdater({
    currentVersion: '3.2.0',
    installMode: 'global-npm',
    cacheTtlMs: 60_000,
    fetchImpl: mockFetch
  });

  const st1 = await updater.check();
  assert.equal(fetchCalls, 1);
  assert.equal(st1.updateAvailable, true);
  assert.equal(st1.latestVersion, '3.4.0');
  assert.equal(st1.releaseUrl, 'https://www.npmjs.com/package/rig-commander/v/3.4.0');

  // Cached within TTL
  await updater.check();
  assert.equal(fetchCalls, 1);

  // Force bypasses cache
  await updater.check({ force: true });
  assert.equal(fetchCalls, 2);

  // Offline / failure does not throw and preserves graceful error message
  const failing = new SelfUpdater({
    currentVersion: '3.2.0',
    installMode: 'global-npm',
    fetchImpl: async () => { throw new Error('ENOTFOUND registry.npmjs.org'); }
  });
  const stFail = await failing.check({ force: true });
  assert.equal(stFail.updateAvailable, false);
  assert.match(stFail.lastError, /ENOTFOUND/);
});

test('SelfUpdater.applyUpdate executes strict hardcoded commands per installMode and triggers restart only on success', async () => {
  const calls = [];
  let restartedWith = null;

  const updaterGlobal = new SelfUpdater({
    currentVersion: '3.2.0',
    installMode: 'global-npm',
    execFileImpl: async (bin, args) => {
      calls.push([bin, args]);
      return { stdout: 'changed 1 package', stderr: '' };
    },
    onRestart: (info) => { restartedWith = info; }
  });
  updaterGlobal.latestVersion = '3.3.0';
  updaterGlobal.updateAvailable = true;

  const resOk = await updaterGlobal.applyUpdate();
  assert.equal(resOk.ok, true);
  assert.equal(resOk.status.state, 'restarting');
  assert.deepEqual(calls[0], ['npm', ['install', '-g', 'rig-commander@latest']]);

  // Wait briefly for 350ms deferred onRestart callback
  await new Promise(r => setTimeout(r, 420));
  assert.deepEqual(restartedWith, { installMode: 'global-npm', targetVersion: '3.3.0' });

  // npx-cache mode runs npx --yes rig-commander@latest --version
  const npxCalls = [];
  const updaterNpx = new SelfUpdater({
    currentVersion: '3.2.0',
    installMode: 'npx-cache',
    execFileImpl: async (bin, args) => {
      npxCalls.push([bin, args]);
      return { stdout: 'rig-commander v3.3.0', stderr: '' };
    }
  });
  const resNpx = await updaterNpx.applyUpdate();
  assert.equal(resNpx.ok, true);
  assert.deepEqual(npxCalls[0], ['npx', ['--yes', 'rig-commander@latest', '--version']]);

  // Failing git pull sets state='error' and MUST NOT restart
  let restartCalledOnErr = false;
  const updaterFail = new SelfUpdater({
    currentVersion: '3.2.0',
    installMode: 'git-checkout',
    execFileImpl: async () => {
      const e = new Error('git failed');
      e.stderr = 'fatal: Not possible to fast-forward, aborting.';
      throw e;
    },
    onRestart: () => { restartCalledOnErr = true; }
  });
  const resFail = await updaterFail.applyUpdate();
  assert.equal(resFail.ok, false);
  assert.equal(resFail.status.state, 'error');
  assert.match(resFail.error, /fast-forward/);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(restartCalledOnErr, false);
});
