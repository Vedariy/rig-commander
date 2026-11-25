import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PLAYBOOK_CONFIG,
  PLAYBOOK_VETO_CODES,
  sanitizePlaybookConfig,
  evaluatePlaybookCandidates,
  buildPlaybookFaviconDataUri
} from '../openrig/assets/domain/playbooks-model.js';
import { SafePlaybookEngine } from '../openrig/lib/playbook-engine.mjs';

test('SafePlaybook defaults are strictly non-destructive (disabled, dry_run, all write rules off)', () => {
  const cfg = sanitizePlaybookConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, 'dry_run');
  assert.equal(cfg.maxActionsPerHour, 6);
  assert.equal(cfg.rules.auto_compact_idle_hot.enabled, false);
  assert.equal(cfg.rules.auto_wake_parked.enabled, false);
  assert.equal(cfg.rules.auto_nudge_stalled_queue.enabled, false);
  assert.equal(cfg.rules.auto_notify_critical_sa.enabled, true);

  // Out-of-range clamping
  const clamped = sanitizePlaybookConfig({
    enabled: true,
    mode: 'bogus',
    maxActionsPerHour: 999,
    rules: {
      auto_compact_idle_hot: { enabled: true, thresholdPct: 10, cooldownMin: 0 },
      auto_wake_parked: { enabled: true, minIdleMin: 999, cooldownMin: 500 }
    }
  });
  assert.equal(clamped.mode, 'dry_run');
  assert.equal(clamped.maxActionsPerHour, 30);
  assert.equal(clamped.rules.auto_compact_idle_hot.thresholdPct, 65);
  assert.equal(clamped.rules.auto_compact_idle_hot.cooldownMin, 2);
  assert.equal(clamped.rules.auto_wake_parked.minIdleMin, 120);
  assert.equal(clamped.rules.auto_wake_parked.cooldownMin, 180);
});

test('Hard Safety Vetoes block shellExited, HITL prompts, working seats, unsupported Pi harness, anti-loop audit, and tripped breaker', () => {
  const now = 1_760_000_000_000;
  const oldTs = new Date(now - 30 * 60_000).toISOString();
  const cfg = sanitizePlaybookConfig({
    enabled: true,
    mode: 'armed',
    maxActionsPerHour: 10,
    rules: {
      auto_compact_idle_hot: { enabled: true, thresholdPct: 75, cooldownMin: 15 },
      auto_wake_parked: { enabled: true, minIdleMin: 5, cooldownMin: 20 },
      auto_nudge_stalled_queue: { enabled: true, minWaitMin: 10, cooldownMin: 25 },
      auto_notify_critical_sa: { enabled: false }
    }
  });

  const snapshot = {
    nodes: [
      { canonicalSessionName: 'shell@rig', runtime: 'codex', contextUsage: { usedPercentage: 88 }, activityState: { display: 'idle', shellExited: true }, lastActivityAt: oldTs },
      { canonicalSessionName: 'hitl@rig', runtime: 'codex', contextUsage: { usedPercentage: 90 }, activityState: { display: 'needs-input', needsInput: { count: 1 } }, lastActivityAt: oldTs },
      { canonicalSessionName: 'busy@rig', runtime: 'claude', contextUsage: { usedPercentage: 85 }, activityState: { display: 'working' }, lastActivityAt: oldTs },
      { canonicalSessionName: 'pi-seat@rig', runtime: 'pi', contextUsage: { usedPercentage: 82 }, activityState: { display: 'idle' }, lastActivityAt: oldTs },
      { canonicalSessionName: 'loop@rig', runtime: 'codex', contextUsage: { usedPercentage: 80 }, activityState: { display: 'idle' }, lastActivityAt: oldTs },
      { canonicalSessionName: 'tripped@rig', runtime: 'codex', contextUsage: { usedPercentage: 20 }, activityState: { display: 'idle' }, lastActivityAt: oldTs }
    ],
    parkedSeats: {
      'tripped@rig': { parked: true, openCount: 2 },
      'shell@rig': { parked: true, openCount: 1 }
    },
    activeQueue: [
      { id: 'qitem-1', owner: 'busy@rig', status: 'pending', updatedAt: oldTs, summary: 'Real task' },
      { id: 'qitem-noise', owner: 'pi-seat@rig', status: 'pending', updatedAt: oldTs, summary: 'Wake escalation: undelivered-wake' }
    ],
    actionAudit: [
      { targetSeatId: 'loop@rig', actionId: 'compact_context', postconditionStatus: 'unchanged', executedAt: new Date(now - 5 * 60_000).toISOString() }
    ],
    breakerState: {
      status: 'tripped',
      trippedSeats: [{ seatId: 'tripped@rig', rule: 'seat_spend_cap' }]
    }
  };

  const res = evaluatePlaybookCandidates(snapshot, cfg, { nowMs: now });
  assert.equal(res.eligible.length, 0, 'Every unsafe candidate must be vetoed');

  const vetoMap = new Map(res.vetoed.map((v) => [`${v.ruleId}:${v.seatId}`, v.vetoCode]));
  assert.equal(vetoMap.get('auto_compact_idle_hot:shell@rig'), PLAYBOOK_VETO_CODES.SHELL_EXITED);
  assert.equal(vetoMap.get('auto_compact_idle_hot:hitl@rig'), PLAYBOOK_VETO_CODES.HITL_PROMPT);
  assert.equal(vetoMap.get('auto_compact_idle_hot:busy@rig'), PLAYBOOK_VETO_CODES.SEAT_WORKING);
  assert.equal(vetoMap.get('auto_compact_idle_hot:pi-seat@rig'), PLAYBOOK_VETO_CODES.UNSUPPORTED_HARNESS);
  assert.equal(vetoMap.get('auto_compact_idle_hot:loop@rig'), PLAYBOOK_VETO_CODES.CLOSED_LOOP_UNCHANGED);
  assert.equal(vetoMap.get('auto_wake_parked:tripped@rig'), PLAYBOOK_VETO_CODES.BREAKER_TRIPPED);
  assert.equal(vetoMap.get('auto_wake_parked:shell@rig'), PLAYBOOK_VETO_CODES.SHELL_EXITED);
  assert.equal(vetoMap.get('auto_nudge_stalled_queue:busy@rig'), PLAYBOOK_VETO_CODES.SEAT_WORKING);
  assert.equal(vetoMap.has('auto_nudge_stalled_queue:pi-seat@rig'), false, 'Daemon noise item must never trigger nudge');
});

test('SafePlaybookEngine dry_run records preview with 0 side effects, armed executes with cooldown & hourly cap, and persists 0600 config', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pb-test-'));
  const cfgPath = path.join(tmpDir, 'playbooks.json');
  const calls = [];
  const now = 1_760_000_000_000;
  const oldTs = new Date(now - 25 * 60_000).toISOString();

  const engine = new SafePlaybookEngine({
    configPath: cfgPath,
    onCompact: async (c) => { calls.push(`compact:${c.seatId}`); return { ok: true, detail: 'Sent /compact' }; },
    onWake: async (c) => { calls.push(`wake:${c.seatId}`); return { ok: true, detail: 'Sent Enter' }; },
    onNudge: async (c) => { calls.push(`nudge:${c.seatId}`); return { ok: true, detail: 'Sent nudge' }; },
    onNotify: async (c) => { calls.push(`notify:${c.seatId}:${c.reason}`); return { ok: true, detail: 'Notified' }; }
  });

  const snapshot = {
    nodes: [
      { canonicalSessionName: 'hot@rig', runtime: 'codex', contextUsage: { usedPercentage: 84 }, activityState: { display: 'idle' }, lastActivityAt: oldTs },
      { canonicalSessionName: 'parked@rig', runtime: 'claude', contextUsage: { usedPercentage: 30 }, activityState: { display: 'idle' }, lastActivityAt: oldTs },
      { canonicalSessionName: 'stalled@rig', runtime: 'codex', contextUsage: { usedPercentage: 25 }, activityState: { display: 'idle' }, lastActivityAt: oldTs },
      { canonicalSessionName: 'hitl@rig', runtime: 'codex', contextUsage: { usedPercentage: 40 }, activityState: { display: 'needs-input', needsInput: { count: 1 } }, lastActivityAt: oldTs }
    ],
    parkedSeats: { 'parked@rig': { parked: true, openCount: 2 } },
    activeQueue: [{ id: 'qitem-99', owner: 'stalled@rig', status: 'pending', updatedAt: oldTs, summary: 'Review PR #42' }],
    gitRadar: { conflicts: [{ file: 'src/app.js', seats: ['hot@rig', 'stalled@rig'] }] }
  };

  // 1. Disabled by default -> evaluateAndRun does nothing
  assert.deepEqual(await engine.evaluateAndRun(snapshot, now), []);
  assert.equal(calls.length, 0);

  // 2. Enable in dry_run mode -> write actions only preview, notify fires
  engine.updateConfig({
    enabled: true,
    mode: 'dry_run',
    maxActionsPerHour: 2,
    rules: {
      auto_compact_idle_hot: { enabled: true, thresholdPct: 78, cooldownMin: 15 },
      auto_wake_parked: { enabled: true, minIdleMin: 10, cooldownMin: 20 },
      auto_nudge_stalled_queue: { enabled: true, minWaitMin: 10, cooldownMin: 25 },
      auto_notify_critical_sa: { enabled: true, minHitlMin: 3, cooldownMin: 10, notifyTelegram: true }
    }
  });
  const stat = fs.statSync(cfgPath);
  assert.equal(stat.mode & 0o777, 0o600, 'Config persisted with 0600 permissions');

  const dryRuns = await engine.evaluateAndRun(snapshot, now);
  assert.ok(dryRuns.some((r) => r.ruleId === 'auto_compact_idle_hot' && r.status === 'dry_run'));
  assert.ok(dryRuns.some((r) => r.ruleId === 'auto_wake_parked' && r.status === 'dry_run'));
  assert.ok(dryRuns.some((r) => r.ruleId === 'auto_notify_critical_sa' && r.status === 'executed'));
  assert.equal(calls.filter((c) => !c.startsWith('notify:')).length, 0, 'Zero write dispatches in dry_run mode');

  // 3. Switch to armed + reset cooldowns -> respects maxActionsPerHour = 2!
  engine.resetCooldowns();
  engine.updateConfig({ mode: 'armed' });
  const armedRuns = await engine.evaluateAndRun(snapshot, now + 1000);
  const writeExecs = armedRuns.filter((r) => r.kind === 'write' && r.status === 'executed');
  assert.equal(writeExecs.length, 2, 'Hourly cap of 2 write actions enforced strictly');
  assert.equal(engine.getState(now + 1000).status, 'capped');
  assert.equal(engine.getState(now + 1000).remainingHourlyQuota, 0);

  // 4. Subsequent run inside cooldown fires 0 write actions
  const secondRuns = await engine.evaluateAndRun(snapshot, now + 60_000);
  assert.equal(secondRuns.filter((r) => r.kind === 'write').length, 0);

  // 5. Emergency pause persists across reload
  engine.pauseAll();
  const reloaded = new SafePlaybookEngine({ configPath: cfgPath });
  assert.equal(reloaded.getConfig().enabled, false);
  assert.equal(reloaded.getConfig().mode, 'dry_run');
  assert.equal(reloaded.getConfig().maxActionsPerHour, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('buildPlaybookFaviconDataUri builds valid SVG data URIs with critical and warn badges', () => {
  const okUri = buildPlaybookFaviconDataUri('ok', 0);
  const critUri = buildPlaybookFaviconDataUri('critical', 3);
  const bigUri = buildPlaybookFaviconDataUri('warn', 14);
  assert.ok(okUri.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.ok(decodeURIComponent(critUri).includes('#ff0055') && decodeURIComponent(critUri).includes('>3<'));
  assert.ok(decodeURIComponent(bigUri).includes('#fbbf24') && decodeURIComponent(bigUri).includes('>9+<'));
  assert.ok(!decodeURIComponent(okUri).includes('#ff0055'));
});
