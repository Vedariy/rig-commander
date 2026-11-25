import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  diffTelemetrySnapshots,
  buildShiftDigest,
  formatShiftDigestMarkdown
} from '../openrig/assets/domain/shift-digest.js';
import { ShiftHistoryStore } from '../openrig/lib/shift-history.mjs';

test('diffTelemetrySnapshots emits edge-triggered state, context, compaction, git conflict & checkpoint events', () => {
  const t0 = Date.parse('2026-11-25T00:00:00.000Z');
  const snap1 = {
    requestedRig: 'all',
    nodes: [
      { canonicalSessionName: 'dev-coder@core', rigId: 'core', activityState: { display: 'working' }, contextUsage: { usedPercentage: 70 } },
      { canonicalSessionName: 'dev-check@core', rigId: 'core', activityState: { display: 'working' }, contextUsage: { usedPercentage: 80 } }
    ],
    parkedSeats: {},
    fleetUsageSummary: { totalEstUsd: 1.0, totalTokens: 100000 },
    gitRadar: { conflicts: [], unmergedWorkspaces: [] },
    intelligence: { healthScore: 92 },
    activeQueue: []
  };

  const r1 = diffTelemetrySnapshots(null, snap1, t0);
  // First snapshot emits initial checkpoint, no spurious transitions
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0].kind, 'checkpoint');

  // Second snapshot 6 minutes later: dev-coder crosses 85%, dev-check enters HITL & compacts, git overlap appears, spend increases
  const t1 = t0 + 6 * 60 * 1000;
  const snap2 = {
    requestedRig: 'all',
    nodes: [
      { canonicalSessionName: 'dev-coder@core', rigId: 'core', activityState: { display: 'working' }, contextUsage: { usedPercentage: 87 } },
      {
        canonicalSessionName: 'dev-check@core',
        rigId: 'core',
        activityState: { display: 'needs-input', needsInput: { count: 1, reason: 'Approve npm test?' } },
        contextUsage: { usedPercentage: 30 }
      }
    ],
    parkedSeats: {},
    fleetUsageSummary: { totalEstUsd: 2.35, totalTokens: 420000 },
    gitRadar: {
      conflicts: [
        {
          repoKey: 'remote:demo/core',
          filePath: 'src/router.ts',
          severity: 'high',
          workspaces: [
            { dirName: 'core-main', seatIds: ['dev-coder@core'] },
            { dirName: 'core-wt2', seatIds: ['dev-coder4@core'] }
          ]
        }
      ],
      unmergedWorkspaces: []
    },
    intelligence: { healthScore: 61 },
    activeQueue: [{ qitemId: 'q1' }]
  };

  const r2 = diffTelemetrySnapshots(r1.nextState, snap2, t1);
  assert.ok(r2.events.some(e => e.kind === 'ctx_event' && e.severity === 'critical' && e.seatId === 'dev-coder@core'));
  assert.ok(r2.events.some(e => e.kind === 'seat_state' && e.severity === 'critical' && e.seatId === 'dev-check@core'));
  assert.ok(r2.events.some(e => e.kind === 'ctx_event' && e.meta.eventType === 'compacted' && e.seatId === 'dev-check@core'));
  assert.ok(r2.events.some(e => e.kind === 'git_alert' && e.meta.filePath === 'src/router.ts'));
  assert.ok(r2.events.some(e => e.kind === 'checkpoint' && e.meta.estUsd === 2.35));

  // Third snapshot with identical state 10s later emits ZERO duplicate events!
  const r3 = diffTelemetrySnapshots(r2.nextState, snap2, t1 + 10_000);
  assert.equal(r3.events.length, 0);
});

test('ShiftHistoryStore persists append-only JSONL with 0600 mode, redacts secrets/paths, survives reload & corrupt lines', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigcmd-shift-hist-'));
  const histFile = path.join(tmpDir, 'shift-events.jsonl');

  try {
    const store = new ShiftHistoryStore({ filePath: histFile, maxFileBytes: 512 * 1024 });
    store.loadSync();
    store.recordOperatorAction({
      execId: 'act-1',
      actionId: 'compact_context',
      targetSeatId: 'dev-check@core',
      payloadPreview: '/compact token=sk-proj-secret123456789012345678901234567',
      executedAt: new Date().toISOString(),
      httpStatus: 200,
      postconditionStatus: 'verified',
      postconditionDetail: 'CTX 82% -> 21% in /home/alice/secret-dir'
    });
    store.recordGuardrailEvent({
      severity: 'critical',
      rigId: 'core',
      seatId: 'dev-coder@core',
      title: 'Budget Circuit-Breaker tripped',
      detail: 'Hourly spend cap reached'
    });
    await store.flush();

    // Verify 0600 permissions and redaction on disk
    const stat = await fs.stat(histFile);
    assert.equal(stat.mode & 0o777, 0o600);
    const rawDisk = await fs.readFile(histFile, 'utf8');
    assert.equal(rawDisk.includes('sk-proj-secret123456789012345678901234567'), false, 'API key must be redacted before persisting');
    assert.equal(rawDisk.includes('/home/alice/'), false, 'OS home path must be redacted before persisting');

    // Append a corrupt truncated line to simulate crash mid-write
    await fs.appendFile(histFile, '{"ts":"2026-11-25","kind":"broken_trunc', 'utf8');

    // Reload in a fresh store instance
    const reloaded = new ShiftHistoryStore({ filePath: histFile });
    const loadedCount = reloaded.loadSync();
    assert.equal(loadedCount, 2);
    const meta = reloaded.getSummaryMeta();
    assert.equal(meta.totalStored, 2);
    assert.equal(meta.fileName, 'shift-events.jsonl');
    assert.equal(JSON.stringify(meta).includes(tmpDir), false, 'Summary meta must never leak full filesystem path');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('buildShiftDigest fuses persisted events, slices, spend deltas, live blockers & renders EN/RU Markdown', () => {
  const nowMs = Date.parse('2026-11-25T08:00:00.000Z');
  const events = [
    {
      ts: '2026-11-25T01:00:00.000Z',
      tsMs: nowMs - 7 * 3600 * 1000,
      kind: 'checkpoint',
      severity: 'info',
      rigId: 'all',
      seatId: null,
      title: 'Telemetry checkpoint',
      detail: '',
      meta: { estUsd: 1.5, totalTokens: 200000 }
    },
    {
      ts: '2026-11-25T03:30:00.000Z',
      tsMs: nowMs - 4.5 * 3600 * 1000,
      kind: 'ctx_event',
      severity: 'success',
      rigId: 'core',
      seatId: 'dev-coder4@core',
      title: 'dev-coder4 context compacted (81% → 22%)',
      detail: 'Reclaimed 59%',
      meta: { eventType: 'compacted' }
    },
    {
      ts: '2026-11-25T07:40:00.000Z',
      tsMs: nowMs - 20 * 60 * 1000,
      kind: 'checkpoint',
      severity: 'info',
      rigId: 'all',
      seatId: null,
      title: 'Telemetry checkpoint',
      detail: '',
      meta: { estUsd: 6.25, totalTokens: 950000 }
    }
  ];

  const digest = buildShiftDigest({
    windowHours: 8,
    nowMs,
    rigFilter: 'all',
    events,
    ganttItems: [
      { slice: 'auth-refresh', state: 'done', from: 'dev-coder@core', to: 'dev-check@core', endAt: new Date(nowMs - 2 * 3600 * 1000).toISOString(), summary: 'Accepted by QA' },
      { slice: 'git-radar', state: 'in-progress', from: 'dev-owner@core', to: 'dev-coder4@core', endAt: new Date(nowMs - 10 * 60 * 1000).toISOString(), summary: 'Implementing worktree UI' }
    ],
    decisions: [
      { id: 'd1', ts: new Date(nowMs - 3 * 3600 * 1000).toISOString(), title: 'Adopt read-only --no-optional-locks for git radar', scope: 'core' }
    ],
    nodes: [
      { canonicalSessionName: 'dev-check@core', rigId: 'core', activityState: { display: 'needs-input', needsInput: { count: 1, reason: 'Approve e2e run?' } }, contextUsage: { usedPercentage: 79 } }
    ],
    actionAudit: [
      { execId: 'a1', actionId: 'compact_context', targetSeatId: 'dev-coder4@core', payloadPreview: '/compact', executedAt: new Date(nowMs - 4.5 * 3600 * 1000).toISOString(), postconditionStatus: 'verified', postconditionDetail: 'CTX 81% -> 22%' }
    ]
  });

  assert.equal(digest.kpis.completedSlicesCount, 1);
  assert.equal(digest.kpis.activeSlicesCount, 1);
  assert.equal(digest.kpis.compactionsCount, 1);
  assert.equal(digest.kpis.actionsCount, 1);
  assert.equal(digest.kpis.verifiedActionsCount, 1);
  assert.equal(digest.kpis.spendSource, 'checkpoints');
  assert.equal(digest.kpis.spendUsd, 4.75);
  assert.equal(digest.kpis.totalTokens, 750000);
  assert.equal(digest.kpis.p0NowCount, 1);
  assert.equal(digest.openAttentionNow[0].kind, 'hitl');

  const mdEn = formatShiftDigestMarkdown(digest, 'en');
  const mdRu = formatShiftDigestMarkdown(digest, 'ru');
  assert.match(mdEn, /RigCommander Shift Catch-Up Digest/);
  assert.match(mdEn, /auth-refresh/);
  assert.match(mdEn, /\$4\.75/);
  assert.match(mdRu, /Сводка смены RigCommander/);
});
