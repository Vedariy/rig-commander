/**
 * Read-Only Git / Worktree & Diff Collector for RigCommander BFF.
 *
 * - Strictly read-only: always passes `--no-optional-locks -c core.fsmonitor=false`
 *   so inspecting a seat never blocks or locks an agent's own git commands.
 * - Deduplicates by unique `cwd` and bounds concurrency (`3`).
 * - Lazy on-demand diff endpoint redacts secrets and blocks sensitive filenames (`.env*`, keys).
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseGitStatusPorcelainV2,
  parseGitNumstat,
  mergeGitNumstats,
  normalizeRepoKey,
  analyzeFleetGitRadar
} from '../assets/domain/git-radar.js';
import { stripAnsiAndRedact } from './ai-evaluator/redactor.mjs';

const execFileAsync = promisify(execFile);

const GIT_BIN = process.env.GIT_BIN || 'git';
const GIT_TIMEOUT_MS = 4000;
const MAX_DIFF_BYTES = 40 * 1024;
const SENSITIVE_FILE_RE = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|credentials\.json|secrets?\.(json|ya?ml|toml))$/i;

async function execGit(cwd, args, { gitBin = GIT_BIN, timeoutMs = GIT_TIMEOUT_MS, maxBuffer = 2 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      { timeout: timeoutMs, maxBuffer }
    );
    return { ok: true, stdout: stdout || '' };
  } catch (err) {
    return { ok: false, stdout: (err && err.stdout) || '', error: (err && err.message) || 'git failed' };
  }
}

async function runBounded(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const cap = Math.max(1, Math.min(limit || 3, items.length));
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: cap }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await worker(items[idx], idx);
      }
    })
  );
  return results;
}

export function isSafeRelativeRepoPath(relPath) {
  const s = String(relPath || '').trim();
  if (!s) return true; // empty means whole-repo diff
  if (s.length > 320 || s.includes('\0') || s.startsWith('-') || path.isAbsolute(s)) return false;
  const parts = s.replace(/\\/g, '/').split('/');
  if (parts.some(seg => seg === '' || seg === '.' || seg === '..')) return false;
  if (parts[0] === '.git') return false;
  return true;
}

export function isSensitiveRepoFile(relPath) {
  return SENSITIVE_FILE_RE.test(String(relPath || '').replace(/\\/g, '/'));
}

export async function probeSingleWorkspace(cwd, seatIds = [], { execGitFn = execGit, gitBin = GIT_BIN } = {}) {
  const topRes = await execGitFn(cwd, ['rev-parse', '--show-toplevel'], { gitBin });
  const topLevel = topRes.ok ? topRes.stdout.trim() : '';
  if (!topLevel) {
    return { isGit: false, cwd, dirName: path.basename(cwd || '') || 'workspace', seatIds };
  }

  const [commonRes, originRes, statusRes, unstagedStatRes, stagedStatRes] = await Promise.all([
    execGitFn(topLevel, ['rev-parse', '--git-common-dir'], { gitBin }),
    execGitFn(topLevel, ['config', '--get', 'remote.origin.url'], { gitBin }),
    execGitFn(topLevel, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], { gitBin }),
    execGitFn(topLevel, ['diff', '--numstat'], { gitBin }),
    execGitFn(topLevel, ['diff', '--cached', '--numstat'], { gitBin })
  ]);

  const commonRaw = commonRes.ok ? commonRes.stdout.trim() : '.git';
  const commonAbs = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(topLevel, commonRaw);
  const isWorktree = Boolean(commonRaw && commonRaw !== '.git' && path.resolve(topLevel, '.git') !== commonAbs);
  const originUrl = originRes.ok ? originRes.stdout.trim() : '';

  const parsedStatus = parseGitStatusPorcelainV2(statusRes.ok ? statusRes.stdout : '');
  const mergedStat = mergeGitNumstats(
    parseGitNumstat(unstagedStatRes.ok ? unstagedStatRes.stdout : ''),
    parseGitNumstat(stagedStatRes.ok ? stagedStatRes.stdout : '')
  );

  const filesWithStats = parsedStatus.files.map(f => {
    const st = mergedStat.byFile[f.path];
    return st ? { ...f, ins: st.ins, del: st.del } : { ...f, ins: 0, del: 0 };
  });

  const { repoKey, repoLabel } = normalizeRepoKey({
    originUrl,
    commonDir: commonAbs,
    topLevel
  });

  const dirName = path.basename(topLevel) || repoLabel;
  // Deterministic non-leaky workspaceId (hash of absolute topLevel)
  const wsHash = crypto.createHash('sha1').update(topLevel).digest('hex').slice(0, 8);

  return {
    isGit: true,
    workspaceId: `${dirName}#${wsHash}`,
    dirName,
    topLevel,
    commonDir: commonAbs,
    originUrl,
    repoKey,
    repoLabel,
    isWorktree,
    seatIds,
    ...parsedStatus,
    insertions: mergedStat.insertions,
    deletions: mergedStat.deletions,
    files: filesWithStats
  };
}

export function computeGitRadarFingerprint(radar) {
  if (!radar || !Array.isArray(radar.workspaces) || radar.workspaces.length === 0) return 'git:empty';
  const h = crypto.createHash('sha1');
  for (const ws of radar.workspaces) {
    h.update(`|${ws.workspaceId}:${ws.branch}:${ws.oid}:${ws.ahead}:${ws.behind}:${ws.dirtyCount}:${ws.insertions}:${ws.deletions}:${ws.unmergedCount}`);
    for (const f of (ws.files || [])) {
      h.update(`,${f.path}=${f.code}`);
    }
  }
  return `git:${radar.workspaces.length}:${h.digest('hex').slice(0, 12)}`;
}

export async function collectFleetGitRadar(nodes = [], { execGitFn = execGit, gitBin = GIT_BIN, concurrency = 3 } = {}) {
  const byCwd = new Map(); // cwd -> seatIds[]
  const seatStateById = {};

  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n) continue;
    const seatId = n.canonicalSessionName || n.logicalId;
    if (!seatId) continue;
    const disp = (n.activityState && n.activityState.display) || (n.agentActivity && n.agentActivity.state) || 'idle';
    seatStateById[seatId] = disp;
    const cwd = typeof n.cwd === 'string' ? n.cwd.trim() : '';
    if (!cwd || !path.isAbsolute(cwd)) continue;
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(seatId);
  }

  const cwdEntries = Array.from(byCwd.entries());
  const probed = await runBounded(cwdEntries, concurrency, ([cwd, seatIds]) =>
    probeSingleWorkspace(cwd, seatIds, { execGitFn, gitBin })
  );

  // Merge seats that happened to resolve to the exact same git topLevel (e.g., subdirectory cwd inside same repo)
  const mergedByTop = new Map();
  for (const ws of probed) {
    if (!ws || !ws.isGit) continue;
    const existing = mergedByTop.get(ws.topLevel);
    if (existing) {
      existing.seatIds = [...new Set([...existing.seatIds, ...ws.seatIds])];
    } else {
      mergedByTop.set(ws.topLevel, ws);
    }
  }

  // Strip local filesystem absolute paths before leaving backend boundary
  const sanitizedWorkspaces = Array.from(mergedByTop.values()).map(({ topLevel, commonDir, originUrl, ...rest }) => rest);
  const radar = analyzeFleetGitRadar(sanitizedWorkspaces, seatStateById);
  return {
    ...radar,
    rev: computeGitRadarFingerprint(radar),
    sampledAt: new Date().toISOString()
  };
}

/**
 * Lazy read-only diff loader for a single seat (optionally scoped to one relative file).
 * Always redacts secrets and refuses sensitive files (.env, private keys).
 */
export async function fetchSeatGitDiff({
  seatId,
  cwd,
  file = '',
  execGitFn = execGit,
  gitBin = GIT_BIN
} = {}) {
  if (!seatId || !/^[a-zA-Z0-9._@-]{2,140}$/.test(String(seatId))) {
    return { ok: false, statusCode: 400, error: 'Invalid seat identifier' };
  }
  if (!cwd || !path.isAbsolute(String(cwd))) {
    return { ok: false, statusCode: 404, error: 'Workspace path unavailable for seat' };
  }
  const relFile = String(file || '').trim();
  if (!isSafeRelativeRepoPath(relFile)) {
    return { ok: false, statusCode: 400, error: 'Invalid relative file path' };
  }
  if (relFile && isSensitiveRepoFile(relFile)) {
    return {
      ok: true,
      statusCode: 200,
      seatId,
      file: relFile,
      redacted: true,
      blockedSensitive: true,
      stat: '',
      diff: '# Diff hidden by RigCommander Security Gate: sensitive secret/credential file.'
    };
  }

  const topRes = await execGitFn(cwd, ['rev-parse', '--show-toplevel'], { gitBin });
  const topLevel = topRes.ok ? topRes.stdout.trim() : '';
  if (!topLevel) {
    return { ok: false, statusCode: 404, error: 'Seat directory is not a git repository' };
  }

  const pathArgs = relFile ? ['--', relFile] : [];
  const [statRes, unstagedRes, stagedRes] = await Promise.all([
    execGitFn(topLevel, ['diff', '--stat', '--no-color', ...pathArgs], { gitBin }),
    execGitFn(topLevel, ['diff', '--no-color', '--unified=3', ...pathArgs], { gitBin, maxBuffer: 4 * 1024 * 1024 }),
    execGitFn(topLevel, ['diff', '--cached', '--no-color', '--unified=3', ...pathArgs], { gitBin, maxBuffer: 4 * 1024 * 1024 })
  ]);

  let combined = '';
  const stagedTxt = stagedRes.ok ? stagedRes.stdout.trim() : '';
  const unstagedTxt = unstagedRes.ok ? unstagedRes.stdout.trim() : '';
  if (stagedTxt && unstagedTxt) {
    combined = `# === STAGED CHANGES ===\n${stagedTxt}\n\n# === UNSTAGED CHANGES ===\n${unstagedTxt}`;
  } else {
    combined = unstagedTxt || stagedTxt;
  }

  // If specific file had no tracked diff (likely untracked), show safe notice instead of arbitrary file read
  let truncated = false;
  if (combined.length > MAX_DIFF_BYTES) {
    combined = combined.slice(0, MAX_DIFF_BYTES) + `\n\n... [truncated at ${Math.round(MAX_DIFF_BYTES / 1024)} KB — run git diff locally for full output]`;
    truncated = true;
  }

  const safeDiffOut = stripAnsiAndRedact(combined, { redactPaths: true });
  const safeStatOut = stripAnsiAndRedact(statRes.ok ? statRes.stdout.trim() : '', { redactPaths: true });

  return {
    ok: true,
    statusCode: 200,
    seatId,
    dirName: path.basename(topLevel),
    file: relFile,
    truncated,
    redacted: safeDiffOut.redactionCount > 0 || safeStatOut.redactionCount > 0,
    stat: safeStatOut.text,
    diff: safeDiffOut.text
  };
}
