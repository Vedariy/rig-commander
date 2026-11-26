import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AutoConsentEngine,
  computePromptHash,
  deriveSeatSessionEpoch
} from '../openrig/lib/auto-consent-engine.mjs';
import { ActionAuditLog } from '../openrig/lib/action-audit.mjs';
import { ShiftHistoryStore } from '../openrig/lib/shift-history.mjs';
import { TelegramHitlBridge } from '../openrig/lib/telegram-bridge.mjs';
import { AUTO_CONSENT_VETO_CODES } from '../openrig/assets/domain/auto-consent-model.js';

function makeManualClock(startMs = 1_760_000_000_000) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map(); // id -> { fireAt, fn, cleared }

  return {
    now: () => now,
    setTimeoutFn: (fn, delayMs) => {
      const id = nextId++;
      const handle = { id, unref() {} };
      timers.set(id, { fireAt: now + Math.max(0, Number(delayMs) || 0), fn, cleared: false });
      return handle;
    },
    clearTimeoutFn: (handle) => {
      if (!handle) return;
      const entry = timers.get(handle.id);
      if (entry) entry.cleared = true;
      timers.delete(handle.id);
    },
    activeTimerCount: () => timers.size,
    async advanceBy(ms) {
      const target = now + ms;
      while (true) {
        let earliest = null;
        for (const [id, t] of timers.entries()) {
          if (t.cleared) { timers.delete(id); continue; }
          if (t.fireAt <= target && (!earliest || t.fireAt < earliest.t.fireAt)) {
            earliest = { id, t };
          }
        }
        if (!earliest) break;
        now = earliest.t.fireAt;
        timers.delete(earliest.id);
        await earliest.t.fn();
        // Flush microtask queue so async TOCTOU chains complete deterministically
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    }
  };
}

const SAFE_NPM_TEST_PROMPT = [
  'Requesting permission for: run_command',
  '$ npm test',
  'Run this command?',
  '› 1. Yes, allow once (y)',
  '  2. Always allow in this workspace',
  '  3. No, cancel (esc)',
  '↑/↓ Navigate · Enter to confirm'
].join('\n');

const SAFE_LINT_PROMPT = [
  'Requesting permission for: run_command',
  '$ npm run lint',
  'Run this command?',
  '› 1. Yes, allow once (y)',
  '  2. Always allow in this workspace',
  '  3. No, cancel (esc)',
  '↑/↓ Navigate · Enter to confirm'
].join('\n');

const SAFE_STATUS_PROMPT = [
  'Requesting permission for: run_command',
  '$ git status',
  'Run this command?',
  '› 1. Yes, allow once (y)',
  '  2. Always allow in this workspace',
  '  3. No, cancel (esc)',
  '↑/↓ Navigate · Enter to confirm'
].join('\n');

const DRIFTED_GIT_PUSH_PROMPT = [
  'Requesting permission for: run_command',
  '$ git push origin main --force',
  'Run this command?',
  '› 1. Yes, allow once (y)',
  '  2. Always allow in this workspace',
  '  3. No, cancel (esc)',
  '↑/↓ Navigate · Enter to confirm'
].join('\n');

const DRIFTED_WATCH_PROMPT = [
  'Requesting permission for: run_command',
  '$ npm test -- --watch',
  'Run this command?',
  '› 1. Yes, allow once (y)',
  '  2. Always allow in this workspace',
  '  3. No, cancel (esc)',
  '↑/↓ Navigate · Enter to confirm'
].join('\n');

const IDLE_CLEARED_SCREEN = [
  'All 289 tests passed.',
  '› ',
  '? for shortcuts'
].join('\n');

test('computePromptHash produces stable sha256 digests resistant to ANSI noise and sensitive to drift', () => {
  const opts = [
    { badge: '1', keyStroke: '1 Enter', fullText: 'Yes, allow once (y)' },
    { badge: '3', keyStroke: '3 Enter', fullText: 'No, cancel (esc)' }
  ];
  const h1 = computePromptHash(SAFE_NPM_TEST_PROMPT, 'npm test', opts);
  const hAnsi = computePromptHash(`\x1b[32m${SAFE_NPM_TEST_PROMPT}\x1b[0m`, 'npm test', opts);
  const hDrift = computePromptHash(DRIFTED_WATCH_PROMPT, 'npm test -- --watch', opts);

  assert.match(h1, /^sha256:[a-f0-9]{64}$/);
  assert.equal(h1, hAnsi, 'ANSI color sequences must not alter promptHash');
  assert.notEqual(h1, hDrift, 'Any command or screen drift must produce a distinct sha256 promptHash');
});

test('AutoConsentEngine persists project/seat policies atomically (0600/0700) while keeping session grants strictly RAM-only', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-ac-persist-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nestedDir = path.join(tmpDir, 'state-dir');
  const cfgPath = path.join(nestedDir, 'auto-consent.json');

  const engine = new AutoConsentEngine({ configPath: cfgPath });
  const initState = engine.getState();
  assert.equal(initState.status, 'disabled');
  assert.equal(initState.config.enabled, false);
  assert.equal(initState.config.mode, 'dry_run');
  assert.equal(initState.config.graceWindowMs, 3000);
  assert.equal(initState.config.defaults.pauseOnCtxOverheat, true);
  assert.equal(initState.config.defaults.ctxPauseThresholdPct, 75);
  assert.equal(initState.config.defaults.allowPackageInstall, false);
  assert.equal(initState.config.defaults.allowReadOnlyNetwork, false);

  // Update global + project + seat policy
  assert.equal(engine.updatePolicy({ enabled: true, mode: 'armed', graceWindowMs: 3000 }).ok, true);
  assert.equal(engine.updatePolicy({ scope: 'project', targetId: 'sandbox', profile: 'trusted_dev' }).ok, true);
  assert.equal(engine.updatePolicy({ scope: 'seat', targetId: 'dev-owner@sandbox', profile: 'manual_only' }).ok, true);

  // Create RAM-only session grant
  const grantRes = await engine.createSessionGrant({
    scope: 'seat',
    targetId: 'dev-coder@sandbox',
    profile: 'sprint_all',
    ttlMin: 60,
    maxApprovals: 20,
    seatSessionEpoch: 'tmux:%1:4242'
  });
  assert.equal(grantRes.ok, true);
  assert.equal(engine.getState().sessionGrants.length, 1);

  // Verify 0700 dir + 0600 file + zero sessionGrants on disk
  assert.equal(fs.statSync(nestedDir).mode & 0o777, 0o700, 'Created state dir must be 0700');
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600, 'Persisted auto-consent.json must be 0600');
  const rawDisk = fs.readFileSync(cfgPath, 'utf8');
  assert.equal(rawDisk.includes('sessionGrants'), false, 'Session grants must NEVER be written to disk');
  assert.equal(rawDisk.includes(grantRes.grant.grantId), false, 'Session grant IDs must NEVER appear on disk');

  // Reload engine from disk -> policies restored, session grants strictly empty!
  const reloaded = new AutoConsentEngine({ configPath: cfgPath });
  assert.equal(reloaded.getState().config.enabled, true);
  assert.equal(reloaded.getState().config.mode, 'armed');
  assert.equal(reloaded.getState().config.projects.sandbox.profile, 'trusted_dev');
  assert.equal(reloaded.getState().config.seats['dev-owner@sandbox'].profile, 'manual_only');
  assert.equal(reloaded.getState().sessionGrants.length, 0, 'Session grants must NOT survive restart');
});

test('Dry-run mode previews with 0 tmux writes; armed mode enforces 3s grace window, dispatches strictly 1 Enter, and records redacted audit + ShiftHistory', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-ac-run-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const clock = makeManualClock();
  const dispatched = [];
  const sseEvents = [];
  let currentScreen = SAFE_NPM_TEST_PROMPT;

  const audit = new ActionAuditLog();
  const shift = new ShiftHistoryStore({ filePath: path.join(tmpDir, 'shift.jsonl') });

  const engine = new AutoConsentEngine({
    configPath: null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    captureSeatScreen: async () => currentScreen,
    dispatchOptionOne: async (arg) => {
      dispatched.push(arg);
      return { ok: true };
    },
    actionAudit: audit,
    shiftHistory: shift,
    onEvent: (name, data) => sseEvents.push({ name, data })
  });

  const seat = { canonicalSessionName: 'dev-coder@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 35 } };

  // 1. Dry-run mode -> preview only, 0 timers, 0 writes
  engine.updatePolicy({ enabled: true, mode: 'dry_run', projects: { sandbox: { profile: 'trusted_dev' } } });
  const dryRes = await engine.observeSeat({ seat, screenText: currentScreen });
  assert.equal(dryRes.action, 'dry_run');
  assert.equal(clock.activeTimerCount(), 0);
  assert.equal(dispatched.length, 0);

  // 2. Armed mode -> schedules 3000ms timer, emits auto_consent_pending, 0 writes before 3000ms
  engine.updatePolicy({ mode: 'armed', graceWindowMs: 3000 });
  const armedRes = await engine.observeSeat({ seat, screenText: currentScreen });
  assert.equal(armedRes.action, 'pending');
  assert.equal(armedRes.pending.graceWindowMs, 3000);
  assert.equal(engine.getState().pendingApprovals.length, 1);
  assert.ok(sseEvents.some((e) => e.name === 'auto_consent_pending' && e.data.seatId === 'dev-coder@sandbox'));

  // At t=2999ms -> still 0 tmux writes!
  await clock.advanceBy(2999);
  assert.equal(dispatched.length, 0, 'Must NOT dispatch before graceWindowMs elapses');

  // At t=3000ms -> fresh capture + sha256 verification + strictly "1 Enter"
  await clock.advanceBy(1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].keyStroke, '1 Enter');
  assert.equal(dispatched[0].seatId, 'dev-coder@sandbox');
  assert.equal(engine.getState().stats.approvedCount, 1);
  assert.equal(engine.getState().pendingApprovals.length, 0);
  assert.ok(sseEvents.some((e) => e.name === 'auto_consent_resolved' && e.data.status === 'approved'));

  // Audit log + ShiftHistory recorded
  const auditRecs = audit.list(10, 'dev-coder@sandbox');
  assert.equal(auditRecs.length, 1);
  assert.equal(auditRecs[0].actionId, 'answer_prompt_option');
  assert.match(auditRecs[0].payloadPreview, /^1 Enter/);
  assert.ok(shift.events.some((ev) => ev.kind === 'guardrail' && ev.seatId === 'dev-coder@sandbox' && ev.title.includes('Auto-Consent')));

  // Re-observing the SAME uncleared prompt -> blocked by VETO_RETRY_LOOP (0 double-sends!)
  const loopRes = await engine.observeSeat({ seat, screenText: currentScreen });
  assert.equal(loopRes.action, 'escalated');
  assert.equal(loopRes.evaluation.vetoCode, AUTO_CONSENT_VETO_CODES.RETRY_LOOP);
  await clock.advanceBy(5000);
  assert.equal(dispatched.length, 1, 'Uncleared prompt must NEVER double-fire');
});

test('TOCTOU drift aborts with VETO_PROMPT_DRIFT and 0 tmux writes on screen mutation, prompt clear, CTX overheat, breaker trip, worktree conflict, and mid-capture cancel', async () => {
  const scenarios = [
    {
      name: 'destructive screen mutation during 3s grace window',
      mutate: (ctx) => { ctx.screen = DRIFTED_GIT_PUSH_PROMPT; }
    },
    {
      name: 'subtle command argument drift during 3s grace window',
      mutate: (ctx) => { ctx.screen = DRIFTED_WATCH_PROMPT; }
    },
    {
      name: 'prompt cleared before timer expiry',
      mutate: (ctx) => { ctx.screen = IDLE_CLEARED_SCREEN; }
    },
    {
      name: 'context overheat (70% -> 76%) during 3s grace window',
      mutate: (ctx) => { ctx.seat = { ...ctx.seat, contextUsage: { usedPercentage: 76 } }; },
      expectedSubVeto: AUTO_CONSENT_VETO_CODES.CTX_OVERHEAT
    },
    {
      name: 'circuit-breaker trips during 3s grace window',
      mutate: (ctx) => { ctx.breakerState = { status: 'tripped', trippedSeats: ['dev-coder@sandbox'] }; },
      expectedSubVeto: AUTO_CONSENT_VETO_CODES.BREAKER_TRIPPED
    },
    {
      name: 'git worktree conflict appears during 3s grace window',
      mutate: (ctx) => { ctx.gitConflicts = [{ file: 'src/app.js', seats: ['dev-coder@sandbox'] }]; },
      expectedSubVeto: AUTO_CONSENT_VETO_CODES.WORKTREE_CONFLICT
    }
  ];

  for (const sc of scenarios) {
    const clock = makeManualClock();
    const dispatched = [];
    const ctx = {
      screen: SAFE_NPM_TEST_PROMPT,
      seat: { canonicalSessionName: 'dev-coder@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 70 } },
      breakerState: { status: 'ok', trippedSeats: [] },
      gitConflicts: []
    };

    const engine = new AutoConsentEngine({
      configPath: null,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      captureSeatScreen: async () => ctx.screen,
      getLiveContext: async () => ({
        seat: ctx.seat,
        breakerState: ctx.breakerState,
        gitConflicts: ctx.gitConflicts
      }),
      dispatchOptionOne: async (arg) => {
        dispatched.push(arg);
        return { ok: true };
      }
    });

    engine.updatePolicy({ enabled: true, mode: 'armed', graceWindowMs: 3000, projects: { sandbox: { profile: 'trusted_dev' } } });
    const res = await engine.observeSeat({ seat: ctx.seat, screenText: ctx.screen });
    assert.equal(res.action, 'pending', sc.name);

    // Mutate state halfway through the 3s grace window
    await clock.advanceBy(1500);
    sc.mutate(ctx);
    await clock.advanceBy(1600);

    assert.equal(dispatched.length, 0, `${sc.name}: MUST perform 0 tmux writes`);
    const latestRun = engine.getState().recentRuns[0];
    assert.equal(latestRun.status, 'drift_aborted', sc.name);
    assert.equal(latestRun.vetoCode, AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT, sc.name);
    if (sc.expectedSubVeto) {
      assert.equal(latestRun.subVetoCode, sc.expectedSubVeto, sc.name);
    }
  }

  // Mid-capture async cancel race: operator cancels while fresh captureSeatScreen is in-flight!
  const clock = makeManualClock();
  const dispatched = [];
  let releaseCapture;
  const engine = new AutoConsentEngine({
    configPath: null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    captureSeatScreen: () => new Promise((resolve) => { releaseCapture = () => resolve(SAFE_NPM_TEST_PROMPT); }),
    dispatchOptionOne: async (arg) => { dispatched.push(arg); return { ok: true }; }
  });
  engine.updatePolicy({ enabled: true, mode: 'armed', graceWindowMs: 3000, projects: { sandbox: { profile: 'trusted_dev' } } });
  const seat = { canonicalSessionName: 'dev-coder@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 25 } };
  const obs = await engine.observeSeat({ seat, screenText: SAFE_NPM_TEST_PROMPT });
  assert.equal(obs.action, 'pending');

  // Fire timer -> pauses inside captureSeatScreen
  const advancePromise = clock.advanceBy(3000);
  await new Promise((r) => setImmediate(r));
  // Operator hits master pause while capture is still pending!
  engine.pauseAll(true);
  releaseCapture();
  await advancePromise;
  assert.equal(dispatched.length, 0, 'Pause arriving mid-capture must execute 0 tmux writes');
});

test('Mid-countdown [Cancel] aborts timer (0 writes) and never re-arms canceled promptHash; pauseAll() cancels all timers immediately', async () => {
  const clock = makeManualClock();
  const dispatched = [];
  let screenA = SAFE_NPM_TEST_PROMPT;
  let screenB = SAFE_LINT_PROMPT;

  const engine = new AutoConsentEngine({
    configPath: null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    captureSeatScreen: async (sid) => (sid === 'dev-coder@sandbox' ? screenA : screenB),
    dispatchOptionOne: async (arg) => { dispatched.push(arg); return { ok: true }; }
  });

  engine.updatePolicy({ enabled: true, mode: 'armed', graceWindowMs: 3000, projects: { sandbox: { profile: 'trusted_dev' } } });
  const seatA = { canonicalSessionName: 'dev-coder@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 20 } };
  const seatB = { canonicalSessionName: 'dev-check@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 20 } };

  // 1. Arm seatA and cancel mid-countdown
  const obsA = await engine.observeSeat({ seat: seatA, screenText: screenA });
  assert.equal(obsA.action, 'pending');
  await clock.advanceBy(1200);
  const cancelRes = engine.cancelPending({ pendingId: obsA.pending.id });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.canceledCount, 1);
  assert.equal(engine.getState().pendingApprovals.length, 0);
  assert.equal(engine.getState().stats.canceledCount, 1);

  // Timer must NOT fire
  await clock.advanceBy(5000);
  assert.equal(dispatched.length, 0);

  // Re-observing the EXACT same promptHash on seatA must NEVER re-arm!
  const reObs = await engine.observeSeat({ seat: seatA, screenText: screenA });
  assert.equal(reObs.action, 'skipped_canceled');
  assert.equal(reObs.vetoCode, AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED);
  assert.equal(engine.getState().pendingApprovals.length, 0);

  // A genuinely DIFFERENT prompt on seatA CAN still arm
  screenA = SAFE_STATUS_PROMPT;
  const newObsA = await engine.observeSeat({ seat: seatA, screenText: screenA });
  const newObsB = await engine.observeSeat({ seat: seatB, screenText: screenB });
  assert.equal(newObsA.action, 'pending');
  assert.equal(newObsB.action, 'pending');
  assert.equal(engine.getState().pendingApprovals.length, 2);

  // 2. pauseAll(true) aborts ALL pending timers immediately
  const pauseRes = engine.pauseAll(true);
  assert.equal(pauseRes.ok, true);
  assert.equal(pauseRes.paused, true);
  assert.equal(pauseRes.canceledCount, 2);
  assert.equal(pauseRes.state.status, 'paused');
  assert.equal(pauseRes.state.pendingApprovals.length, 0);

  await clock.advanceBy(10_000);
  assert.equal(dispatched.length, 0, 'pauseAll must prevent all pending dispatches');

  // Cannot arm while masterPaused === true
  const blockedObs = await engine.observeSeat({ seat: seatB, screenText: screenB });
  assert.equal(blockedObs.action, 'inactive');
  assert.equal(blockedObs.vetoCode, AUTO_CONSENT_VETO_CODES.MASTER_PAUSED);

  // Unpause resumes cleanly
  const unpauseRes = engine.pauseAll(false);
  assert.equal(unpauseRes.ok, true);
  assert.equal(unpauseRes.state.status, 'armed');
});

test('Session grants enforce TTL expiry, maxApprovals exhaustion, seatSessionEpoch rotation, revocation, and over-cap rejection', async () => {
  const clock = makeManualClock();
  const dispatched = [];
  let liveEpoch = 'tmux:%7:1001';
  let currentScreen = SAFE_NPM_TEST_PROMPT;

  const engine = new AutoConsentEngine({
    configPath: null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    captureSeatScreen: async () => currentScreen,
    getSeatSessionEpoch: async () => liveEpoch,
    dispatchOptionOne: async (arg) => { dispatched.push(arg); return { ok: true }; }
  });
  engine.updatePolicy({ enabled: true, mode: 'armed', graceWindowMs: 3000 });

  const seat = { canonicalSessionName: 'dev-coder@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 20 } };

  // 1. Over-cap & invalid grant rejections
  assert.equal((await engine.createSessionGrant({ scope: 'rig', targetId: 'sandbox', profile: 'trusted_dev', ttlMin: 121 })).ok, false);
  assert.equal((await engine.createSessionGrant({ scope: 'rig', targetId: 'sandbox', profile: 'trusted_dev', ttlMs: 3 * 3_600_000 })).ok, false);
  assert.equal((await engine.createSessionGrant({ scope: 'rig', targetId: 'sandbox', profile: 'sprint_all', maxApprovals: 41 })).ok, false);
  assert.equal((await engine.createSessionGrant({ scope: 'rig', targetId: 'sandbox', profile: 'trusted_dev', maxApprovals: 101 })).ok, false);
  assert.equal((await engine.createSessionGrant({ scope: 'seat', targetId: 'dev-coder@sandbox', profile: 'trusted_dev', seatSessionEpoch: '' })).ok, false);

  // 2. maxApprovals = 2 exhaustion test
  const g1 = await engine.createSessionGrant({
    scope: 'seat',
    targetId: 'dev-coder@sandbox',
    profile: 'trusted_dev',
    ttlMin: 30,
    maxApprovals: 2
  });
  assert.equal(g1.ok, true);
  assert.equal(g1.grant.seatSessionEpoch, 'tmux:%7:1001');

  // Approval 1
  assert.equal((await engine.observeSeat({ seat, screenText: currentScreen })).action, 'pending');
  await clock.advanceBy(3000);
  assert.equal(dispatched.length, 1);
  assert.equal(engine.getState().sessionGrants[0].remainingApprovals, 1);

  // Approval 2 (distinct prompt)
  currentScreen = SAFE_LINT_PROMPT;
  assert.equal((await engine.observeSeat({ seat, screenText: currentScreen })).action, 'pending');
  await clock.advanceBy(3000);
  assert.equal(dispatched.length, 2);
  assert.equal(engine.getState().sessionGrants.length, 0, 'Exhausted grant must be pruned');

  // 3rd prompt -> inactive (0 tmux writes)
  currentScreen = SAFE_STATUS_PROMPT;
  const afterExhaust = await engine.observeSeat({ seat, screenText: currentScreen });
  assert.equal(afterExhaust.action, 'inactive');
  await clock.advanceBy(5000);
  assert.equal(dispatched.length, 2);

  // 3. seatSessionEpoch rotation mid-countdown invalidates grant before dispatch
  const g2 = await engine.createSessionGrant({
    scope: 'seat',
    targetId: 'dev-coder@sandbox',
    profile: 'trusted_dev',
    ttlMin: 15,
    maxApprovals: 5
  });
  assert.equal(g2.ok, true);
  assert.equal((await engine.observeSeat({ seat, screenText: currentScreen })).action, 'pending');

  // Simulate `rig seat launch --fresh` -> pane PID rotates!
  await clock.advanceBy(1000);
  liveEpoch = 'tmux:%19:9999';
  await clock.advanceBy(2500);
  assert.equal(dispatched.length, 2, 'Epoch rotation during grace window MUST abort with 0 tmux writes');
  assert.equal(engine.getState().recentRuns[0].vetoCode, AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT);
  assert.equal(engine.getState().recentRuns[0].subVetoCode, AUTO_CONSENT_VETO_CODES.SESSION_EPOCH_MISMATCH);

  // 4. TTL expiry test (grant with 1 min TTL expires after 60s)
  const g3 = await engine.createSessionGrant({
    scope: 'rig',
    targetId: 'sandbox',
    profile: 'safe_readonly',
    ttlMin: 1,
    maxApprovals: 10
  });
  assert.equal(g3.ok, true);
  assert.equal(engine.getState().sessionGrants.some((g) => g.grantId === g3.grant.grantId), true);
  await clock.advanceBy(60_000);
  assert.equal(engine.getState().sessionGrants.some((g) => g.grantId === g3.grant.grantId), false, 'Expired grant must auto-prune');
  const afterExp = await engine.observeSeat({ seat, screenText: SAFE_STATUS_PROMPT });
  assert.equal(afterExp.action, 'inactive');

  // 5. Explicit revocation mid-countdown aborts pending timer immediately
  const g4 = await engine.createSessionGrant({
    scope: 'rig',
    targetId: 'sandbox',
    profile: 'trusted_dev',
    ttlMin: 10,
    maxApprovals: 10
  });
  assert.equal(g4.ok, true);
  assert.equal((await engine.observeSeat({ seat, screenText: SAFE_STATUS_PROMPT })).action, 'pending');
  const revRes = engine.revokeSessionGrant({ grantId: g4.grant.grantId });
  assert.equal(revRes.ok, true);
  assert.equal(revRes.revoked, true);
  assert.equal(engine.getState().pendingApprovals.length, 0);
  await clock.advanceBy(5000);
  assert.equal(dispatched.length, 2, 'Revoked grant must never fire');
});

test('Telegram /pause_auto command invokes autoConsent.pauseAll() for authorized chat only and reports canceled count', async () => {
  const clock = makeManualClock();
  const dispatched = [];
  const sentMsgs = [];

  const engine = new AutoConsentEngine({
    configPath: null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    captureSeatScreen: async () => SAFE_NPM_TEST_PROMPT,
    dispatchOptionOne: async (arg) => { dispatched.push(arg); return { ok: true }; }
  });
  engine.updatePolicy({ enabled: true, mode: 'armed', graceWindowMs: 3000, projects: { sandbox: { profile: 'trusted_dev' } } });

  const seat1 = { canonicalSessionName: 'dev-coder@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 10 } };
  const seat2 = { canonicalSessionName: 'dev-check@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 10 } };
  await engine.observeSeat({ seat: seat1, screenText: SAFE_NPM_TEST_PROMPT });
  await engine.observeSeat({ seat: seat2, screenText: SAFE_LINT_PROMPT });
  assert.equal(engine.getState().pendingApprovals.length, 2);

  const bridge = new TelegramHitlBridge({
    botToken: '12345:TEST_TOKEN',
    chatId: '777888',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body || '{}');
      if (url.endsWith('/sendMessage')) sentMsgs.push(body.text);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    },
    onPauseAutoConsent: () => engine.pauseAll(true)
  });

  // 1. Unauthorized chat is blocked; pending timers remain untouched
  const unauth = await bridge.handleUpdate({ message: { text: '/pause_auto', chat: { id: 111222 } } });
  assert.equal(unauth.unauthorized, true);
  assert.equal(engine.getState().config.masterPaused, false);
  assert.equal(engine.getState().pendingApprovals.length, 2);

  // 2. Authorized chat triggers pauseAll(true) and confirms canceled count (2)
  const auth = await bridge.handleUpdate({ message: { text: '/pause_auto', chat: { id: 777888 } } });
  assert.equal(auth.handled, true);
  assert.equal(auth.ok, true);
  assert.equal(auth.canceledCount, 2);
  assert.equal(engine.getState().status, 'paused');
  assert.equal(engine.getState().pendingApprovals.length, 0);
  assert.match(sentMsgs[0], /Auto-Consent PAUSED/i);
  assert.match(sentMsgs[0], /\*2\*/);

  await clock.advanceBy(5000);
  assert.equal(dispatched.length, 0);
});

test('deriveSeatSessionEpoch extracts deterministic runtime session fingerprints and rotates on restart', () => {
  assert.equal(deriveSeatSessionEpoch({ seatSessionEpoch: 'custom-ep' }), 'custom-ep');
  assert.equal(deriveSeatSessionEpoch({ tmuxPanePid: 4321 }), 'pid:4321');
  const epA = deriveSeatSessionEpoch({ startedAt: '2026-11-26T10:00:00Z', contextUsage: { transcriptPath: '/tmp/a.jsonl' } });
  const epB = deriveSeatSessionEpoch({ startedAt: '2026-11-26T11:00:00Z', contextUsage: { transcriptPath: '/tmp/b.jsonl' } });
  assert.match(epA, /^ep:[a-f0-9]{16}$/);
  assert.notEqual(epA, epB);
  assert.equal(deriveSeatSessionEpoch(null), '');
});

test('Hourly rate cap transitions status to capped, policy downgrade aborts pending timers, and secrets/user paths are redacted in audit', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-ac-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const clock = makeManualClock();
  const dispatched = [];
  const sseEvents = [];
  const audit = new ActionAuditLog();
  const shift = new ShiftHistoryStore({ filePath: path.join(tmpDir, 'shift.jsonl') });

  const PROMPT_WITH_USER_PATH = [
    'Requesting permission for: run_command',
    '$ npm test -- /Users/alice/private-repo/foo.test.mjs',
    'Run this command?',
    '› 1. Yes, allow once (y)',
    '  2. Always allow in this workspace',
    '  3. No, cancel (esc)',
    '↑/↓ Navigate · Enter to confirm'
  ].join('\n');

  let currentScreen = PROMPT_WITH_USER_PATH;
  const engine = new AutoConsentEngine({
    configPath: null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    captureSeatScreen: async () => currentScreen,
    dispatchOptionOne: async (arg) => { dispatched.push(arg); return { ok: true }; },
    actionAudit: audit,
    shiftHistory: shift,
    onEvent: (name, data) => sseEvents.push({ name, data })
  });

  engine.updatePolicy({
    enabled: true,
    mode: 'armed',
    graceWindowMs: 3000,
    maxActionsPerHour: 2,
    projects: { sandbox: { profile: 'trusted_dev' } }
  });
  const seat = { canonicalSessionName: 'dev-coder@sandbox', rigId: 'sandbox', contextUsage: { usedPercentage: 25 } };

  // Concurrent observeSeat calls -> single-flight prevents duplicate pending timers
  const [c1, c2] = await Promise.all([
    engine.observeSeat({ seat, screenText: currentScreen }),
    engine.observeSeat({ seat, screenText: currentScreen })
  ]);
  assert.equal(c1.action, 'pending');
  assert.ok(c2.action === 'in_flight' || c2.action === 'already_pending');
  assert.equal(engine.getState().pendingApprovals.length, 1);

  // Check redaction of OS user path in pending toast, audit log, ShiftHistory, and SSE events
  assert.equal(engine.getState().pendingApprovals[0].commandPreview.includes('/Users/alice'), false);
  await clock.advanceBy(3000);
  assert.equal(dispatched.length, 1);
  assert.equal(audit.list(5)[0].payloadPreview.includes('/Users/alice'), false);
  assert.equal(JSON.stringify(shift.events).includes('/Users/alice'), false);
  assert.equal(JSON.stringify(sseEvents).includes('/Users/alice'), false);

  // Downgrade seat to manual_only mid-countdown -> immediately aborts pending timer (0 writes)
  currentScreen = SAFE_LINT_PROMPT;
  assert.equal((await engine.observeSeat({ seat, screenText: currentScreen })).action, 'pending');
  engine.updatePolicy({ scope: 'seat', targetId: 'dev-coder@sandbox', profile: 'manual_only' });
  assert.equal(engine.getState().pendingApprovals.length, 0);
  await clock.advanceBy(4000);
  assert.equal(dispatched.length, 1, 'Policy downgrade to manual_only must abort pending timer');

  // Restore seat to inherit -> 2nd approval hits maxActionsPerHour = 2 -> status === 'capped'
  engine.updatePolicy({ scope: 'seat', targetId: 'dev-coder@sandbox', profile: 'inherit' });
  assert.equal((await engine.observeSeat({ seat, screenText: currentScreen })).action, 'pending');
  await clock.advanceBy(3000);
  assert.equal(dispatched.length, 2);
  assert.equal(engine.getState().status, 'capped');
  assert.equal(engine.getState().stats.actionsLastHour, 2);
  assert.equal(engine.getState().stats.remainingHourlyQuota, 0);

  // 3rd prompt while capped -> escalated with VETO_RATE_CAP
  currentScreen = SAFE_STATUS_PROMPT;
  const cappedRes = await engine.observeSeat({ seat, screenText: currentScreen });
  assert.equal(cappedRes.action, 'escalated');
  assert.equal(cappedRes.evaluation.vetoCode, AUTO_CONSENT_VETO_CODES.RATE_CAP);

  // After 1 hour slides past -> quota restores and status returns to 'armed'
  await clock.advanceBy(3_600_001);
  assert.equal(engine.getState().status, 'armed');
  assert.equal(engine.getState().stats.remainingHourlyQuota, 2);
});
