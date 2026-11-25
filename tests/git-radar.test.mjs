import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  parseGitStatusPorcelainV2,
  parseGitNumstat,
  mergeGitNumstats,
  normalizeRepoKey,
  analyzeFleetGitRadar
} from '../openrig/assets/domain/git-radar.js';
import {
  collectFleetGitRadar,
  fetchSeatGitDiff,
  isSafeRelativeRepoPath,
  isSensitiveRepoFile
} from '../openrig/lib/git-radar.mjs';
import { GitConflictDetector } from '../openrig/lib/fleet-intelligence/detectors/git-conflict.mjs';
import { buildOntologySnapshot } from '../openrig/assets/ontology/snapshot.js';
import { resolveActionFromFinding } from '../openrig/assets/ontology/actions.js';

const execFileAsync = promisify(execFile);

test('parseGitStatusPorcelainV2 parses branch, ahead/behind, detached, tracked, renamed, unmerged & untracked entries', () => {
  const sample = [
    '# branch.oid e5e13fa89911223344556677889900aabbccdd00',
    '# branch.head dev',
    '# branch.upstream origin/dev',
    '# branch.ab +3 -18',
    '1 .M N... 100644 100644 100644 abcdef1 abcdef2 src/app/main.ts',
    '1 M. N... 100644 100644 100644 abcdef1 abcdef2 src/core/router.ts',
    '2 R. N... 100644 100644 100644 abcdef1 abcdef2 R100 src/new name.ts\tsrc/old name.ts',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 src/conflict.ts',
    '? docs/new-note.md'
  ].join('\n');

  const parsed = parseGitStatusPorcelainV2(sample);
  assert.equal(parsed.branch, 'dev');
  assert.equal(parsed.oid, 'e5e13fa8');
  assert.equal(parsed.upstream, 'origin/dev');
  assert.equal(parsed.ahead, 3);
  assert.equal(parsed.behind, 18);
  assert.equal(parsed.detached, false);
  assert.equal(parsed.dirtyCount, 5);
  assert.equal(parsed.stagedCount, 2);
  assert.equal(parsed.unstagedCount, 1);
  assert.equal(parsed.unmergedCount, 1);
  assert.equal(parsed.untrackedCount, 1);
  assert.equal(parsed.files[2].path, 'src/new name.ts');
  assert.equal(parsed.files[3].unmerged, true);
  assert.equal(parsed.files[4].untracked, true);

  const det = parseGitStatusPorcelainV2('# branch.oid 65fab51100\n# branch.head (detached)\n');
  assert.equal(det.detached, true);
  assert.equal(det.branch, '(detached)');
  assert.equal(det.dirtyCount, 0);
});

test('parseGitNumstat & mergeGitNumstats sum insertions, deletions and tolerate binary files', () => {
  const unstaged = parseGitNumstat('12\t4\tsrc/a.js\n-\t-\tassets/logo.png\n');
  const staged = parseGitNumstat('5\t2\tsrc/a.js\n20\t0\tsrc/b.js\n');
  const merged = mergeGitNumstats(unstaged, staged);
  assert.equal(merged.insertions, 37);
  assert.equal(merged.deletions, 6);
  assert.deepEqual(merged.byFile['src/a.js'], { ins: 17, del: 6 });
  assert.deepEqual(merged.byFile['src/b.js'], { ins: 20, del: 0 });
});

test('normalizeRepoKey unifies SSH and HTTPS remotes so worktrees and separate clones map to one repoKey', () => {
  const ssh = normalizeRepoKey({ originUrl: 'git@github.com:AcmeOrg/DemoApp.git' });
  const https = normalizeRepoKey({ originUrl: 'https://token@github.com/acmeorg/demoapp.git' });
  assert.equal(ssh.repoKey, https.repoKey);
  assert.equal(ssh.repoLabel, 'demoapp');

  const localFallback = normalizeRepoKey({ commonDir: '/home/alice/projects/my-app/.git' });
  const localSame = normalizeRepoKey({ commonDir: '/home/alice/projects/my-app/.git' });
  const localOtherDir = normalizeRepoKey({ commonDir: '/home/alice/archive/my-app/.git' });
  assert.equal(localFallback.repoLabel, 'my-app');
  assert.equal(localFallback.repoKey, localSame.repoKey);
  assert.notEqual(localFallback.repoKey, localOtherDir.repoKey);
  assert.equal(localFallback.repoKey.toLowerCase().includes('/home/'), false, 'local repoKey must never leak OS paths');
  assert.equal(localFallback.repoKey.toLowerCase().includes('alice'), false, 'local repoKey must never leak usernames');
});

test('analyzeFleetGitRadar detects cross-worktree/cross-clone overlaps, shared-CWD concurrent writers, and stale drift without false positives', () => {
  const radar = analyzeFleetGitRadar(
    [
      {
        isGit: true,
        workspaceId: 'app-main#1',
        dirName: 'app-main',
        originUrl: 'git@github.com:acme/app.git',
        branch: 'dev',
        oid: 'aaaa1111',
        ahead: 0,
        behind: 24,
        isWorktree: false,
        dirtyCount: 2,
        insertions: 40,
        deletions: 10,
        files: [
          { path: 'src/shared.ts', code: '.M', unstaged: true },
          { path: 'src/main-only.ts', code: '.M', unstaged: true }
        ],
        seatIds: ['dev-coder@rig', 'dev-owner@rig']
      },
      {
        isGit: true,
        workspaceId: 'app-coder4#2',
        dirName: 'app-coder4',
        originUrl: 'https://github.com/acme/app.git',
        branch: '(detached)',
        oid: 'bbbb2222',
        ahead: 0,
        behind: 0,
        isWorktree: true,
        dirtyCount: 1,
        insertions: 15,
        deletions: 3,
        files: [{ path: 'src/shared.ts', code: 'M.', staged: true }],
        seatIds: ['dev-coder4@rig']
      },
      {
        isGit: true,
        workspaceId: 'other-repo#3',
        dirName: 'other-repo',
        originUrl: 'git@github.com:acme/other.git',
        branch: 'main',
        oid: 'cccc3333',
        dirtyCount: 1,
        unmergedCount: 1,
        files: [{ path: 'src/shared.ts', code: 'UU', unmerged: true }],
        seatIds: ['dev-other@rig2']
      }
    ],
    {
      'dev-coder@rig': 'working',
      'dev-owner@rig': 'working',
      'dev-coder4@rig': 'idle',
      'dev-other@rig2': 'idle'
    }
  );

  // Only app-main and app-coder4 share repoKey (other-repo has same filename but different repoKey -> no false conflict!)
  assert.equal(radar.conflicts.length, 1);
  assert.equal(radar.conflicts[0].filePath, 'src/shared.ts');
  assert.equal(radar.conflicts[0].severity, 'high');
  assert.equal(radar.conflicts[0].workspaces.length, 2);

  // Shared checkout hazard: dev-coder + dev-owner both working in app-main
  assert.equal(radar.sharedWriteHazards.length, 1);
  assert.deepEqual(radar.sharedWriteHazards[0].activeSeatIds, ['dev-coder@rig', 'dev-owner@rig']);

  // Stale behind & unmerged
  assert.equal(radar.staleWorkspaces.length, 1);
  assert.equal(radar.staleWorkspaces[0].behind, 24);
  assert.equal(radar.unmergedWorkspaces.length, 1);

  // Per-seat projection
  assert.equal(radar.bySeatId['dev-coder4@rig'].conflictFilesCount, 1);
  assert.ok(radar.bySeatId['dev-coder4@rig'].conflictPeers.includes('dev-coder@rig'));
  assert.equal(radar.bySeatId['dev-other@rig2'].conflictFilesCount, 0);

  // GitConflictDetector emits P0 unmerged, P1 overlap, P2 shared-cwd, P2 stale-behind
  const det = new GitConflictDetector();
  const findings = det.evaluate({ gitRadar: radar });
  assert.ok(findings.some(f => f.severity === 'p0_urgent' && f.id.startsWith('git-unmerged-')));
  assert.ok(findings.some(f => f.severity === 'p1_high' && f.id.startsWith('git-overlap-')));
  assert.ok(findings.some(f => f.severity === 'p2_medium' && f.id.startsWith('git-shared-cwd-')));
  assert.ok(findings.some(f => f.severity === 'p2_medium' && f.id.startsWith('git-behind-')));
});

test('collectFleetGitRadar & fetchSeatGitDiff work on a real git repo + linked worktree, redact secrets, and block unsafe paths', async () => {
  assert.equal(isSafeRelativeRepoPath('../secret'), false);
  assert.equal(isSafeRelativeRepoPath('/etc/passwd'), false);
  assert.equal(isSafeRelativeRepoPath('--exec=evil'), false);
  assert.equal(isSafeRelativeRepoPath('src/index.js'), true);
  assert.equal(isSensitiveRepoFile('.env.local'), true);
  assert.equal(isSensitiveRepoFile('certs/prod.pem'), true);
  assert.equal(isSensitiveRepoFile('src/app.js'), false);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rigcmd-git-radar-'));
  const mainRepo = path.join(tmpRoot, 'demo-repo');
  const wtRepo = path.join(tmpRoot, 'demo-repo-wt2');
  const git = (cwd, args) => execFileAsync('git', ['-C', cwd, ...args]);

  try {
    await fs.mkdir(mainRepo, { recursive: true });
    await git(mainRepo, ['init', '-b', 'main']);
    await git(mainRepo, ['config', 'user.email', 'test@example.com']);
    await git(mainRepo, ['config', 'user.name', 'Test User']);
    await fs.writeFile(path.join(mainRepo, 'app.js'), 'export const v = 1;\n', 'utf-8');
    await git(mainRepo, ['add', 'app.js']);
    await git(mainRepo, ['commit', '-m', 'init']);

    // Create a linked git worktree at wtRepo
    await git(mainRepo, ['worktree', 'add', '--detach', wtRepo, 'HEAD']);

    // Both mainRepo and wtRepo modify app.js (real cross-worktree conflict!)
    await fs.writeFile(path.join(mainRepo, 'app.js'), 'export const v = 2;\nconst apiKey = "sk-proj-abc1234567890123456789012345";\n', 'utf-8');
    await fs.writeFile(path.join(wtRepo, 'app.js'), 'export const v = 3;\n', 'utf-8');

    const radar = await collectFleetGitRadar([
      { canonicalSessionName: 'dev-coder@demo', cwd: mainRepo, activityState: { display: 'working' } },
      { canonicalSessionName: 'dev-coder4@demo', cwd: wtRepo, activityState: { display: 'idle' } }
    ]);

    assert.equal(radar.workspaces.length, 2);
    assert.equal(radar.conflicts.length, 1);
    assert.equal(radar.conflicts[0].filePath, 'app.js');
    assert.equal(radar.conflicts[0].severity, 'high');
    assert.equal(radar.bySeatId['dev-coder4@demo'].isWorktree, true);
    assert.equal(radar.bySeatId['dev-coder@demo'].insertions, 2);

    // Fetch diff and verify secret redaction + path guard
    const diffOk = await fetchSeatGitDiff({ seatId: 'dev-coder@demo', cwd: mainRepo, file: 'app.js' });
    assert.equal(diffOk.ok, true);
    assert.match(diffOk.diff, /export const v = 2;/);
    assert.equal(diffOk.diff.includes('sk-proj-abc1234567890123456789012345'), false, 'API secret must be redacted from diff');

    const blockedEnv = await fetchSeatGitDiff({ seatId: 'dev-coder@demo', cwd: mainRepo, file: '.env' });
    assert.equal(blockedEnv.ok, true);
    assert.equal(blockedEnv.blockedSensitive, true);

    const badPath = await fetchSeatGitDiff({ seatId: 'dev-coder@demo', cwd: mainRepo, file: '../../etc/passwd' });
    assert.equal(badPath.ok, false);
    assert.equal(badPath.statusCode, 400);

    // Ontology snapshot projects seat.git and resolves open_git_diff actions
    const snap = buildOntologySnapshot({
      timestamp: new Date().toISOString(),
      nodes: [
        { canonicalSessionName: 'dev-coder@demo', rigId: 'demo', harness: 'codex', activityState: { display: 'working' } },
        { canonicalSessionName: 'dev-coder4@demo', rigId: 'demo', harness: 'codex', activityState: { display: 'idle' } }
      ],
      gitRadar: radar
    });
    assert.equal(snap.gitRadar.conflicts.length, 1);
    assert.equal(snap.seatsById['dev-coder4@demo'].git.isWorktree, true);
    assert.equal(snap.seatsById['dev-coder4@demo'].git.conflictFilesCount, 1);

    const det = new GitConflictDetector();
    const overlapFinding = det.evaluate({ gitRadar: radar }).find(f => f.id.startsWith('git-overlap-'));
    assert.ok(overlapFinding);
    const resolved = resolveActionFromFinding(overlapFinding.actionPlan, { id: 'dev-coder@demo' });
    assert.equal(resolved.transport, 'git_diff');
    assert.equal(resolved.payload, 'app.js');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
