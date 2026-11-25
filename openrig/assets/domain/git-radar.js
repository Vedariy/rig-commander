/**
 * Git / Worktree & Conflict Radar (Pure Domain Module).
 *
 * Parses read-only `git status --porcelain=v2 --branch` & `git diff --numstat`,
 * normalizes repository identity across linked worktrees and separate clones,
 * and detects real merge-conflict hazards, shared-checkout concurrent writers,
 * unmerged index entries, and stale upstream drift.
 *
 * Zero DOM / Node dependencies — 100% deterministic & unit-testable.
 */

export const GIT_STALE_BEHIND_WARN = 15;
export const GIT_STALE_BEHIND_FINDING = 20;

const MAX_EXPOSED_FILES = 40;

/**
 * Parses `git status --porcelain=v2 --branch` output into structured state.
 */
export function parseGitStatusPorcelainV2(stdout = '') {
  const result = {
    branch: '',
    oid: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    unmergedCount: 0,
    dirtyCount: 0,
    files: []
  };

  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const raw = line.slice('# branch.oid '.length).trim();
      result.oid = raw === '(initial)' ? 'initial' : raw.slice(0, 8);
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      result.branch = head;
      result.detached = head === '(detached)';
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line.slice('# branch.ab '.length));
      if (m) {
        result.ahead = Number(m[1]) || 0;
        result.behind = Number(m[2]) || 0;
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      if (parts.length < 9) continue;
      const xy = parts[1] || '..';
      const filePath = parts.slice(8).join(' ');
      const x = xy[0] || '.';
      const y = xy[1] || '.';
      const staged = x !== '.';
      const unstaged = y !== '.';
      if (staged) result.stagedCount++;
      if (unstaged) result.unstagedCount++;
      result.files.push({
        path: filePath,
        code: xy,
        staged,
        unstaged,
        untracked: false,
        unmerged: false
      });
      continue;
    }

    // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
    if (line.startsWith('2 ')) {
      const parts = line.split(' ');
      if (parts.length < 10) continue;
      const xy = parts[1] || '..';
      const rawTail = parts.slice(9).join(' ');
      const filePath = rawTail.split('\t')[0];
      const x = xy[0] || '.';
      const y = xy[1] || '.';
      const staged = x !== '.';
      const unstaged = y !== '.';
      if (staged) result.stagedCount++;
      if (unstaged) result.unstagedCount++;
      result.files.push({
        path: filePath,
        code: xy,
        staged,
        unstaged,
        untracked: false,
        unmerged: false
      });
      continue;
    }

    // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    if (line.startsWith('u ')) {
      const parts = line.split(' ');
      if (parts.length < 11) continue;
      const xy = parts[1] || 'UU';
      const filePath = parts.slice(10).join(' ');
      result.unmergedCount++;
      result.files.push({
        path: filePath,
        code: xy,
        staged: true,
        unstaged: true,
        untracked: false,
        unmerged: true
      });
      continue;
    }

    // ? <path>
    if (line.startsWith('? ')) {
      const filePath = line.slice(2);
      if (!filePath) continue;
      result.untrackedCount++;
      result.files.push({
        path: filePath,
        code: '??',
        staged: false,
        unstaged: false,
        untracked: true,
        unmerged: false
      });
    }
  }

  result.dirtyCount = result.files.length;
  return result;
}

/**
 * Parses `git diff --numstat` (unstaged or staged) into aggregate + per-file counts.
 */
export function parseGitNumstat(stdout = '') {
  let insertions = 0;
  let deletions = 0;
  const byFile = {};
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const ins = parts[0] === '-' ? 0 : (Number(parts[0]) || 0);
    const del = parts[1] === '-' ? 0 : (Number(parts[1]) || 0);
    const filePath = parts.slice(2).join('\t').trim();
    if (!filePath) continue;
    insertions += ins;
    deletions += del;
    if (!byFile[filePath]) byFile[filePath] = { ins: 0, del: 0 };
    byFile[filePath].ins += ins;
    byFile[filePath].del += del;
  }
  return { insertions, deletions, byFile };
}

/**
 * Merges unstaged + staged numstat results cleanly.
 */
export function mergeGitNumstats(a, b) {
  const byFile = {};
  let insertions = 0;
  let deletions = 0;
  for (const src of [a, b]) {
    if (!src || !src.byFile) continue;
    for (const [fp, counts] of Object.entries(src.byFile)) {
      if (!byFile[fp]) byFile[fp] = { ins: 0, del: 0 };
      byFile[fp].ins += Number(counts.ins) || 0;
      byFile[fp].del += Number(counts.del) || 0;
      insertions += Number(counts.ins) || 0;
      deletions += Number(counts.del) || 0;
    }
  }
  return { insertions, deletions, byFile };
}

/**
 * Normalizes a git remote URL or common dir into a canonical repo key so linked
 * worktrees AND separate clones of the same repository share one `repoKey`
 * without leaking local user paths.
 */
export function normalizeRepoKey({ originUrl = '', commonDir = '', topLevel = '' } = {}) {
  const rawUrl = String(originUrl || '').trim();
  if (rawUrl) {
    // Strip credentials, protocol, host prefix, and trailing .git
    let cleaned = rawUrl
      .replace(/^https?:\/\/[^@/]+@/i, 'https://')
      .replace(/^ssh:\/\/[^@/]+@/i, 'ssh://')
      .replace(/\.git\/?$/i, '')
      .replace(/\/+$/, '');
    // scp-like: git@host:org/repo
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(cleaned);
    if (scp) {
      const slug = scp[2].replace(/^\/+/, '').toLowerCase();
      const label = slug.split('/').pop() || slug;
      return { repoKey: `remote:${scp[1].toLowerCase()}/${slug}`, repoLabel: label };
    }
    // URL: https://host/org/repo
    const httpMatch = /^[a-z+]+:\/\/([^/]+)\/(.+)$/i.exec(cleaned);
    if (httpMatch) {
      const host = httpMatch[1].toLowerCase();
      const slug = httpMatch[2].replace(/^\/+/, '').toLowerCase();
      const label = slug.split('/').pop() || slug;
      return { repoKey: `remote:${host}/${slug}`, repoLabel: label };
    }
  }

  const basePath = String(commonDir || topLevel || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const withoutGit = basePath.endsWith('/.git') ? basePath.slice(0, -5) : basePath;
  const label = withoutGit.split('/').filter(Boolean).pop() || 'workspace';
  const normalized = withoutGit.toLowerCase() || label.toLowerCase();
  // Pure zero-dep deterministic hash so linked worktrees share one key without ever leaking local OS paths
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b) >>> 0;
  }
  const hash = h1.toString(16).padStart(8, '0').slice(0, 6) + h2.toString(16).padStart(8, '0').slice(0, 4);
  return {
    repoKey: `local:${label.toLowerCase()}#${hash}`,
    repoLabel: label
  };
}

/**
 * Analyzes fleet-wide git worktree snapshots and computes:
 *  - cross-worktree / cross-clone file edit overlaps (true merge-conflict hazards)
 *  - shared-checkout concurrent writer hazards
 *  - unmerged index entries & stale upstream drift
 *  - per-seat projection (`bySeatId`) and fleet KPIs
 */
export function analyzeFleetGitRadar(rawWorkspaces = [], seatStateById = {}) {
  const input = Array.isArray(rawWorkspaces) ? rawWorkspaces.filter(w => w && w.isGit) : [];

  const workspaces = input.map((w, idx) => {
    const dirName = String(w.dirName || w.workspaceId || `ws-${idx}`).trim();
    const repoInfo = (w.repoKey && w.repoLabel)
      ? { repoKey: w.repoKey, repoLabel: w.repoLabel }
      : normalizeRepoKey({ originUrl: w.originUrl, commonDir: w.commonDir, topLevel: w.topLevel || dirName });

    const seatIds = Array.isArray(w.seatIds) ? [...new Set(w.seatIds.filter(Boolean))] : [];
    const activeSeatIds = seatIds.filter(sid => {
      const st = String(seatStateById[sid] || '').toLowerCase();
      return st === 'working' || st === 'running';
    });
    const files = Array.isArray(w.files) ? w.files : [];
    const trackedModifiedFiles = files.filter(f => f && !f.untracked);

    return {
      workspaceId: String(w.workspaceId || `${repoInfo.repoLabel}:${dirName}`),
      dirName,
      repoKey: repoInfo.repoKey,
      repoLabel: repoInfo.repoLabel,
      branch: String(w.branch || ''),
      oid: String(w.oid || ''),
      upstream: String(w.upstream || ''),
      ahead: Number(w.ahead) || 0,
      behind: Number(w.behind) || 0,
      detached: Boolean(w.detached || w.branch === '(detached)'),
      isWorktree: Boolean(w.isWorktree),
      isSharedCheckout: seatIds.length > 1,
      dirtyCount: typeof w.dirtyCount === 'number' ? w.dirtyCount : files.length,
      stagedCount: Number(w.stagedCount) || 0,
      unstagedCount: Number(w.unstagedCount) || 0,
      untrackedCount: Number(w.untrackedCount) || 0,
      unmergedCount: Number(w.unmergedCount) || 0,
      insertions: Number(w.insertions) || 0,
      deletions: Number(w.deletions) || 0,
      totalFiles: files.length,
      trackedDirtyCount: trackedModifiedFiles.length,
      files: files.slice(0, MAX_EXPOSED_FILES).map(f => ({
        path: f.path,
        code: f.code || 'M.',
        staged: Boolean(f.staged),
        unstaged: Boolean(f.unstaged),
        untracked: Boolean(f.untracked),
        unmerged: Boolean(f.unmerged),
        ins: Number(f.ins) || 0,
        del: Number(f.del) || 0
      })),
      _allFilePaths: files,
      seatIds,
      activeSeatIds
    };
  });

  // 1. Cross-worktree / cross-clone file overlap detection (grouped by canonical repoKey)
  const fileOwnersByRepo = new Map(); // `${repoKey}::${filePath}` -> { repoKey, repoLabel, filePath, entries: [] }
  for (const ws of workspaces) {
    for (const f of ws._allFilePaths) {
      if (!f || !f.path) continue;
      const key = `${ws.repoKey}::${f.path}`;
      if (!fileOwnersByRepo.has(key)) {
        fileOwnersByRepo.set(key, {
          repoKey: ws.repoKey,
          repoLabel: ws.repoLabel,
          filePath: f.path,
          entries: []
        });
      }
      fileOwnersByRepo.get(key).entries.push({
        workspaceId: ws.workspaceId,
        dirName: ws.dirName,
        branch: ws.branch || ws.oid || 'HEAD',
        oid: ws.oid,
        code: f.code || 'M.',
        untracked: Boolean(f.untracked),
        unmerged: Boolean(f.unmerged),
        seatIds: ws.seatIds,
        hasActiveSeat: ws.activeSeatIds.length > 0
      });
    }
  }

  const conflicts = [];
  const conflictFilesByWs = new Map(); // workspaceId -> Set<filePath>
  const conflictPeersByWs = new Map(); // workspaceId -> Set<seatId>

  for (const bucket of fileOwnersByRepo.values()) {
    if (bucket.entries.length < 2) continue;
    const anyTracked = bucket.entries.some(e => !e.untracked);
    const anyActive = bucket.entries.some(e => e.hasActiveSeat);
    const severity = (anyTracked && anyActive) || bucket.entries.filter(e => !e.untracked).length >= 2
      ? 'high'
      : 'medium';

    conflicts.push({
      repoKey: bucket.repoKey,
      repoLabel: bucket.repoLabel,
      filePath: bucket.filePath,
      severity,
      workspaces: bucket.entries.map(({ hasActiveSeat, ...rest }) => ({ ...rest, active: hasActiveSeat }))
    });

    for (const e of bucket.entries) {
      if (!conflictFilesByWs.has(e.workspaceId)) conflictFilesByWs.set(e.workspaceId, new Set());
      conflictFilesByWs.get(e.workspaceId).add(bucket.filePath);
      if (!conflictPeersByWs.has(e.workspaceId)) conflictPeersByWs.set(e.workspaceId, new Set());
      for (const other of bucket.entries) {
        if (other.workspaceId === e.workspaceId) continue;
        for (const sid of other.seatIds) conflictPeersByWs.get(e.workspaceId).add(sid);
      }
    }
  }

  conflicts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return a.filePath.localeCompare(b.filePath);
  });

  // 2. Shared-checkout concurrent writer hazards (2+ active working seats in same checkout!)
  const sharedWriteHazards = [];
  for (const ws of workspaces) {
    if (ws.activeSeatIds.length >= 2) {
      sharedWriteHazards.push({
        workspaceId: ws.workspaceId,
        dirName: ws.dirName,
        repoLabel: ws.repoLabel,
        branch: ws.branch,
        dirtyCount: ws.dirtyCount,
        activeSeatIds: ws.activeSeatIds,
        allSeatIds: ws.seatIds
      });
    }
  }

  // 3. Stale behind & unmerged workspaces
  const staleWorkspaces = [];
  const unmergedWorkspaces = [];
  for (const ws of workspaces) {
    if (ws.unmergedCount > 0) {
      unmergedWorkspaces.push({
        workspaceId: ws.workspaceId,
        dirName: ws.dirName,
        repoLabel: ws.repoLabel,
        branch: ws.branch,
        unmergedCount: ws.unmergedCount,
        seatIds: ws.seatIds
      });
    }
    if (ws.behind >= GIT_STALE_BEHIND_WARN) {
      staleWorkspaces.push({
        workspaceId: ws.workspaceId,
        dirName: ws.dirName,
        repoLabel: ws.repoLabel,
        branch: ws.branch,
        behind: ws.behind,
        ahead: ws.ahead,
        dirtyCount: ws.dirtyCount,
        seatIds: ws.seatIds
      });
    }
  }
  staleWorkspaces.sort((a, b) => b.behind - a.behind);

  // 4. Clean output workspaces (strip private _allFilePaths) & build bySeatId map
  const cleanWorkspaces = workspaces.map(({ _allFilePaths, ...ws }) => {
    const cFiles = conflictFilesByWs.get(ws.workspaceId);
    const cPeers = conflictPeersByWs.get(ws.workspaceId);
    return {
      ...ws,
      conflictFiles: cFiles ? Array.from(cFiles).sort() : [],
      conflictFilesCount: cFiles ? cFiles.size : 0,
      conflictPeers: cPeers ? Array.from(cPeers).sort() : []
    };
  });

  const bySeatId = {};
  for (const ws of cleanWorkspaces) {
    for (const sid of ws.seatIds) {
      bySeatId[sid] = {
        workspaceId: ws.workspaceId,
        dirName: ws.dirName,
        repoKey: ws.repoKey,
        repoLabel: ws.repoLabel,
        branch: ws.branch,
        oid: ws.oid,
        ahead: ws.ahead,
        behind: ws.behind,
        detached: ws.detached,
        isWorktree: ws.isWorktree,
        isSharedCheckout: ws.isSharedCheckout,
        sharedWithSeats: ws.seatIds.filter(x => x !== sid),
        dirtyCount: ws.dirtyCount,
        stagedCount: ws.stagedCount,
        unstagedCount: ws.unstagedCount,
        untrackedCount: ws.untrackedCount,
        unmergedCount: ws.unmergedCount,
        insertions: ws.insertions,
        deletions: ws.deletions,
        totalFiles: ws.totalFiles,
        files: ws.files,
        conflictFiles: ws.conflictFiles,
        conflictFilesCount: ws.conflictFilesCount,
        conflictPeers: ws.conflictPeers,
        isSharedWriteHazard: ws.activeSeatIds.length >= 2 && ws.activeSeatIds.includes(sid)
      };
    }
  }

  const kpis = {
    totalWorkspaces: cleanWorkspaces.length,
    dirtyWorkspaces: cleanWorkspaces.filter(w => w.dirtyCount > 0).length,
    totalDirtyFiles: cleanWorkspaces.reduce((s, w) => s + w.dirtyCount, 0),
    totalInsertions: cleanWorkspaces.reduce((s, w) => s + w.insertions, 0),
    totalDeletions: cleanWorkspaces.reduce((s, w) => s + w.deletions, 0),
    conflictFileCount: conflicts.length,
    highConflictCount: conflicts.filter(c => c.severity === 'high').length,
    unmergedCount: unmergedWorkspaces.reduce((s, w) => s + w.unmergedCount, 0),
    sharedHazardCount: sharedWriteHazards.length,
    staleBehindCount: staleWorkspaces.length
  };

  return {
    workspaces: cleanWorkspaces,
    bySeatId,
    conflicts,
    sharedWriteHazards,
    staleWorkspaces,
    unmergedWorkspaces,
    kpis
  };
}
