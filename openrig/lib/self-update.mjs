import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isNewerVersion, normalizeNpmReleaseInfo, parseSemver } from '../assets/domain/semver.js';

const execFileAsync = promisify(execFile);

export const RESTART_FOR_UPDATE_EXIT_CODE = 75;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_REGISTRY_TIMEOUT_MS = 4500;

export function readInstalledVersion(installRoot, fallback = '3.2.0') {
  const candidates = [
    path.join(installRoot, 'package.json'),
    path.join(installRoot, 'openrig', 'package.json')
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      const sem = parseSemver(parsed && parsed.version);
      if (sem) return sem.normalized;
    } catch {
      // try next candidate
    }
  }
  return fallback;
}

export function detectInstallMode(installRoot) {
  const resolved = path.resolve(String(installRoot || ''));
  try {
    if (fs.existsSync(path.join(resolved, '.git'))) {
      return 'git-checkout';
    }
  } catch {
    // ignore fs probe errors
  }
  if (/[\\/]_npx[\\/]/.test(resolved)) {
    return 'npx-cache';
  }
  return 'global-npm';
}

export function getRecommendedUpdateCommand(installMode, packageName = 'rig-commander') {
  if (installMode === 'git-checkout') return 'git pull --ff-only && npm run sync:public';
  if (installMode === 'npx-cache') return `npx ${packageName}@latest`;
  return `npm install -g ${packageName}@latest`;
}

export class SelfUpdater {
  constructor(options = {}) {
    this.installRoot = path.resolve(options.installRoot || process.cwd());
    this.packageName = String(options.packageName || 'rig-commander');
    this.currentVersion = options.currentVersion || readInstalledVersion(this.installRoot);
    this.installMode = options.installMode || detectInstallMode(this.installRoot);
    this.registryUrl = options.registryUrl || `https://registry.npmjs.org/${encodeURIComponent(this.packageName)}/latest`;
    this.cacheTtlMs = Number(options.cacheTtlMs || DEFAULT_CACHE_TTL_MS);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.execFileImpl = options.execFileImpl || execFileAsync;
    this.onRestart = typeof options.onRestart === 'function' ? options.onRestart : null;

    this.latestVersion = '';
    this.releaseUrl = `https://www.npmjs.com/package/${this.packageName}`;
    this.updateAvailable = false;
    this.state = 'idle'; // 'idle' | 'checking' | 'updating' | 'restarting' | 'error'
    this.lastCheckedAt = null;
    this.lastCheckedMs = 0;
    this.lastError = '';
    this.progressLog = '';
  }

  getStatus() {
    return {
      packageName: this.packageName,
      currentVersion: this.currentVersion,
      latestVersion: this.latestVersion || this.currentVersion,
      updateAvailable: Boolean(this.updateAvailable),
      installMode: this.installMode,
      updateCommand: getRecommendedUpdateCommand(this.installMode, this.packageName),
      state: this.state,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      releaseUrl: this.releaseUrl,
      progressLog: this.progressLog
    };
  }

  async check({ force = false } = {}) {
    if (this.state === 'updating' || this.state === 'restarting') {
      return this.getStatus();
    }
    const now = Date.now();
    if (!force && this.lastCheckedMs > 0 && (now - this.lastCheckedMs) < this.cacheTtlMs) {
      return this.getStatus();
    }
    if (typeof this.fetchImpl !== 'function') {
      this.lastError = 'fetch unavailable in runtime';
      return this.getStatus();
    }

    const prevState = this.state;
    this.state = 'checking';
    this.lastError = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_REGISTRY_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(this.registryUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!res || !res.ok) {
        throw new Error(`Registry HTTP ${res ? res.status : 'error'}`);
      }
      const data = await res.json();
      const norm = normalizeNpmReleaseInfo(data, this.packageName);
      if (!norm.ok) {
        throw new Error(norm.error || 'Invalid registry response');
      }
      this.latestVersion = norm.version;
      this.releaseUrl = norm.releaseUrl;
      this.updateAvailable = isNewerVersion(norm.version, this.currentVersion);
      this.lastCheckedMs = Date.now();
      this.lastCheckedAt = new Date(this.lastCheckedMs).toISOString();
      this.state = prevState === 'updating' ? prevState : 'idle';
    } catch (err) {
      this.lastCheckedMs = Date.now();
      this.lastCheckedAt = new Date(this.lastCheckedMs).toISOString();
      this.lastError = (err && err.name === 'AbortError') ? 'Registry timeout' : String((err && err.message) || err);
      this.state = 'idle';
    } finally {
      clearTimeout(timer);
    }
    return this.getStatus();
  }

  async applyUpdate() {
    if (this.state === 'updating' || this.state === 'restarting') {
      return { ok: false, error: 'Update already in progress', status: this.getStatus() };
    }
    this.state = 'updating';
    this.lastError = '';
    this.progressLog = `Running ${getRecommendedUpdateCommand(this.installMode, this.packageName)}...`;

    try {
      if (this.installMode === 'git-checkout') {
        const pullOut = await this.execFileImpl('git', ['pull', '--ff-only'], {
          cwd: this.installRoot,
          timeout: 60_000
        });
        const syncScript = path.join(this.installRoot, 'scripts', 'sync-public.mjs');
        let syncOut = { stdout: '' };
        if (fs.existsSync(syncScript)) {
          syncOut = await this.execFileImpl(process.execPath, [syncScript], {
            cwd: this.installRoot,
            timeout: 30_000
          });
        }
        this.progressLog = [pullOut && pullOut.stdout, syncOut && syncOut.stdout]
          .filter(Boolean)
          .join('\n')
          .trim()
          .slice(0, 400) || 'Updated git checkout & synced public assets.';
      } else if (this.installMode === 'npx-cache') {
        const out = await this.execFileImpl('npx', ['--yes', `${this.packageName}@latest`, '--version'], {
          timeout: 120_000
        });
        this.progressLog = String((out && out.stdout) || '').trim().slice(0, 400) || `Downloaded ${this.packageName}@latest.`;
      } else {
        const out = await this.execFileImpl('npm', ['install', '-g', `${this.packageName}@latest`], {
          timeout: 120_000
        });
        this.progressLog = String((out && out.stdout) || '').trim().slice(0, 400) || `Installed ${this.packageName}@latest globally.`;
      }

      this.state = 'restarting';
      const statusSnapshot = this.getStatus();
      if (this.onRestart) {
        setTimeout(() => {
          try {
            this.onRestart({
              installMode: this.installMode,
              targetVersion: this.latestVersion || 'latest'
            });
          } catch {
            // ignore restart callback errors
          }
        }, 350);
      }
      return { ok: true, status: statusSnapshot };
    } catch (err) {
      const stderr = err && err.stderr ? String(err.stderr).trim() : '';
      const msg = stderr || String((err && err.message) || err || 'Update failed');
      this.state = 'error';
      this.lastError = msg.slice(0, 400);
      return { ok: false, error: this.lastError, status: this.getStatus() };
    }
  }
}
