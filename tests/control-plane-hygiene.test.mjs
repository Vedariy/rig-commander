import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SAFE_HYGIENE_CUTOFFS_HOURS,
  CONTROL_PLANE_THRESHOLDS,
  CONTROL_PLANE_FINDING_CODES,
  evaluateControlPlaneHealth,
  buildHygienePlan
} from '../openrig/assets/domain/control-plane-model.js';
import {
  ControlPlaneProbe,
  MAX_LOG_TAIL_BYTES,
  redactControlPlaneText
} from '../openrig/lib/control-plane-probe.mjs';
import { ControlPlaneHygieneDetector } from '../openrig/lib/fleet-intelligence/detectors/control-plane-hygiene.mjs';
import { FleetIntelligenceEngine } from '../openrig/lib/fleet-intelligence/index.mjs';
import { FleetResilienceService } from '../openrig/lib/resilience/index.mjs';
import { registerResilienceRoutes } from '../openrig/lib/routes/resilience.mjs';
import { ActionAuditLog } from '../openrig/lib/action-audit.mjs';
import { ShiftHistoryStore } from '../openrig/lib/shift-history.mjs';

const MB = 1024 * 1024;
const HOUR_MS = 3_600_000;
const BASE_NOW = Date.parse('2026-11-27T12:00:00Z');

let opgateSeq = 0;
function makeOpgateItems(count, { rig = 'pod-a', ageHours = 30, seat = 'dev-operator', prefix = 'qitem-opgate' } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    qitemId: `${prefix}-${rig}-${++opgateSeq}-${i}`,
    sourceSession: 'operator-change-detector@external',
    destinationSession: `${seat}@${rig}`,
    state: 'pending',
    tsCreated: new Date(BASE_NOW - ageHours * HOUR_MS).toISOString(),
    summary: 'stuck-sweep-finding'
  }));
}

function makeLiveNode(seatId, overrides = {}) {
  return {
    canonicalSessionName: seatId,
    sessionStatus: 'running',
    lifecycleState: 'running',
    activityState: { display: 'idle', activity: 'idle-at-prompt' },
    ...overrides
  };
}

function createResilienceRouteInvoker(service) {
  const routes = new Map();
  const register = method => (pathname, handler) => routes.set(`${method} ${pathname}`, handler);
  registerResilienceRoutes({ get: register('GET'), post: register('POST') }, service);

  return async (method, pathname, body = {}, headers = {}) => {
    const url = new URL(pathname, 'http://127.0.0.1');
    const handler = routes.get(`${method} ${url.pathname}`);
    if (!handler) return { status: 404, data: { ok: false, error: 'not_found' }, json: async () => ({ ok: false, error: 'not_found' }) };

    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    let responseStatus = 500;
    let responseData = null;
    await handler({
      req: { method, url: pathname, headers: normalizedHeaders },
      res: {},
      url,
      body,
      json: async (status, data) => {
        responseStatus = status;
        responseData = data;
      }
    });
    return {
      status: responseStatus,
      data: responseData,
      json: async () => responseData
    };
  };
}

test('control-plane-model stays pure zero-DOM/zero-Node and exports canonical cutoffs', async () => {
  const source = await fsp.readFile(new URL('../openrig/assets/domain/control-plane-model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:node:|\bwindow\b|\bdocument\b|\bfetch\s*\()/);
  assert.deepEqual(SAFE_HYGIENE_CUTOFFS_HOURS, [24, 72, 168]);
});

test('evaluateControlPlaneHealth enforces exact P0 DAEMON_DEGRADED, P1 QUEUE_ZOMBIE_STORM and P1 BROKEN_ESCALATION_ROUTE thresholds', () => {
  assert.equal(evaluateControlPlaneHealth(null).healthy, true);

  // Latency boundary: 1000ms healthy vs 1001ms P0
  assert.equal(evaluateControlPlaneHealth({ latency: { avgMs: 1000, consecutiveSlowCount: 2 } }).healthy, true);
  const latP0 = evaluateControlPlaneHealth({ latency: { avgMs: 1001, consecutiveSlowCount: 1 } });
  assert.equal(latP0.status, 'degraded');
  assert.equal(latP0.findings[0].code, CONTROL_PLANE_FINDING_CODES.DAEMON_DEGRADED);
  assert.equal(latP0.findings[0].severity, 'p0_urgent');

  // Consecutive slow probes >= 3
  const slowP0 = evaluateControlPlaneHealth({ latency: { avgMs: 420, consecutiveSlowCount: 3 } });
  assert.equal(slowP0.findings[0].code, CONTROL_PLANE_FINDING_CODES.DAEMON_DEGRADED);

  // daemon.log > 50 MB and growth > 5 MB/h
  assert.equal(evaluateControlPlaneHealth({ files: { daemonLog: { bytes: 50 * MB, growthBytesPerHour: 5 * MB } } }).healthy, true);
  assert.equal(evaluateControlPlaneHealth({ files: { daemonLog: { bytes: 50 * MB + 1 } } }).findings[0].code, 'DAEMON_DEGRADED');
  assert.equal(evaluateControlPlaneHealth({ files: { daemonLog: { bytes: 10 * MB, growthBytesPerHour: 5 * MB + 1 } } }).findings[0].code, 'DAEMON_DEGRADED');

  // openrig.sqlite > 512 MB
  assert.equal(evaluateControlPlaneHealth({ files: { sqliteDb: { bytes: 512 * MB } } }).healthy, true);
  assert.equal(evaluateControlPlaneHealth({ files: { sqliteDb: { bytes: 512 * MB + 1 } } }).findings[0].code, 'DAEMON_DEGRADED');

  // stuckSweep >= 5 failures or unhealthy /healthz
  assert.equal(evaluateControlPlaneHealth({ healthz: { ok: true, stuckSweepConsecutiveFailures: 4 } }).healthy, true);
  assert.equal(evaluateControlPlaneHealth({ healthz: { ok: true, stuckSweepConsecutiveFailures: 5 } }).findings[0].code, 'DAEMON_DEGRADED');
  assert.equal(evaluateControlPlaneHealth({ healthz: { ok: false, status: 'unhealthy' } }).findings[0].code, 'DAEMON_DEGRADED');

  // P1 QUEUE_ZOMBIE_STORM: >= 20 opgate >24h, detached targets >6h, >= 2 idle stale_runtime_hook
  assert.equal(evaluateControlPlaneHealth({ queue: { opgateOlderThan24h: 19 }, seats: { staleRuntimeHookCount: 1 } }).healthy, true);
  const zombieByCount = evaluateControlPlaneHealth({ queue: { opgateOlderThan24h: 20 } });
  assert.equal(zombieByCount.findings[0].code, CONTROL_PLANE_FINDING_CODES.QUEUE_ZOMBIE_STORM);
  assert.equal(zombieByCount.findings[0].severity, 'p1_high');

  const zombieByDetached = evaluateControlPlaneHealth({ queue: { detachedTargetCount: 1, detachedTargets: [{ seatId: 'dev-op@pod-a', count: 1 }] } });
  assert.equal(zombieByDetached.findings[0].code, CONTROL_PLANE_FINDING_CODES.QUEUE_ZOMBIE_STORM);

  const zombieByHooks = evaluateControlPlaneHealth({ seats: { staleRuntimeHookCount: 2, staleRuntimeHookSeats: ['a@r', 'b@r'] } });
  assert.equal(zombieByHooks.findings[0].code, CONTROL_PLANE_FINDING_CODES.QUEUE_ZOMBIE_STORM);

  // P1 BROKEN_ESCALATION_ROUTE emits one single root-cause finding
  assert.equal(evaluateControlPlaneHealth({ logTail: { noHumanRegisteredCount: 1 } }).healthy, true);
  const broken = evaluateControlPlaneHealth({
    logTail: {
      noHumanRegisteredCount: 12,
      stuckSweepCrashLoop: true,
      sampleError: 'cannot be admitted because no human is registered yet'
    },
    parkedBacklogCount: 389
  });
  assert.equal(broken.findings.length, 1);
  assert.equal(broken.findings[0].code, CONTROL_PLANE_FINDING_CODES.BROKEN_ESCALATION_ROUTE);
  assert.equal(broken.findings[0].severity, 'p1_high');
  assert.match(broken.findings[0].title, /389/);
});

test('probeControlPlane caches <=32KB tail by mtimeMs/size, tracks growth & rolling latency, and strictly redacts paths and secrets', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-probe-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const fakeHome = path.join(dir, 'home', 'alice');
  const openrigHome = path.join(fakeHome, '.openrig');
  await fsp.mkdir(openrigHome, { recursive: true });

  // Missing files handled gracefully
  const probe = new ControlPlaneProbe({ homeDir: fakeHome });
  const emptyRes = await probe.probeControlPlane({ openrigHome, nowMs: BASE_NOW });
  assert.equal(emptyRes.files.daemonLog.exists, false);
  assert.equal(emptyRes.files.sqliteDb.exists, false);
  assert.equal(emptyRes.openrigHomeLabel, '~/.openrig');

  // Create >64KB daemon.log where early prefix has an error (must NOT be scanned) and tail has repeated errors + paths + secrets
  const logPath = path.join(openrigHome, 'daemon.log');
  const dbPath = path.join(openrigHome, 'openrig.sqlite');
  const earlyNoise = `${JSON.stringify({ msg: 'stuckSweep failed early cannot be admitted because no human is registered yet' })}\n`.repeat(15);
  const padding = 'INFO heartbeat ok\n'.repeat(3000); // > 50 KB
  const secretSk = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
  const secretGhp = 'ghp_1234567890abcdefghij1234567890';
  const secretBearer = 'Bearer tok_secret_value_1234567890';
  const tailLines = [
    `ERROR stuckSweep failed: target=operator-change-detector@external cannot be admitted because no human is registered yet path=${fakeHome}/repo token=${secretSk}`,
    `ERROR stuckSweep failed: cannot be admitted because no human is registered yet API_KEY=${secretGhp} auth="${secretBearer}"`,
    `ERROR stuckSweep crash consecutiveFailures=345 findingsRouted=131759 caller=/Users/otherperson/work`
  ].join('\n') + '\n';

  await fsp.writeFile(logPath, earlyNoise + padding + tailLines);
  await fsp.writeFile(dbPath, Buffer.alloc(1024));

  // Record rolling API latency (40ms, 50ms, 1200ms, 1300ms, 1400ms -> 3 consecutive slow probes!)
  probe.recordProbeLatency({ endpoint: '/api/rigs/pod-a/nodes', durationMs: 40, ok: true, tsMs: BASE_NOW - 4000 });
  probe.recordProbeLatency({ endpoint: '/api/rigs/pod-a/nodes', durationMs: 50, ok: true, tsMs: BASE_NOW - 3000 });
  probe.recordProbeLatency({ endpoint: '/api/rigs/pod-a/nodes', durationMs: 1200, ok: true, tsMs: BASE_NOW - 2000 });
  probe.recordProbeLatency({ endpoint: '/api/rigs/pod-a/nodes', durationMs: 1300, ok: true, tsMs: BASE_NOW - 1000 });
  probe.recordProbeLatency({ endpoint: '/api/rigs/pod-a/nodes', durationMs: 1400, ok: true, tsMs: BASE_NOW });

  const activeQueue = [
    ...makeOpgateItems(12, { rig: 'pod-a', ageHours: 30, seat: 'dev-operator' }), // > 24h, detached (non-existent in nodes)
    ...makeOpgateItems(8, { rig: 'pod-b', ageHours: 80, seat: 'dev-coder' }), // > 72h, live pane
    ...makeOpgateItems(2, { rig: 'pod-b', ageHours: 200, seat: 'dev-coder' }), // > 168h
    {
      qitemId: 'qitem-blocked-old',
      sourceSession: 'dev-owner@pod-b',
      destinationSession: 'dev-coder@pod-b',
      state: 'blocked',
      tsCreated: new Date(BASE_NOW - 40 * HOUR_MS).toISOString()
    }
  ];
  const nodes = [
    makeLiveNode('dev-coder@pod-b', { agentActivity: { state: 'unknown', reason: 'stale_runtime_hook' } }),
    makeLiveNode('dev-check@pod-b', { agentActivity: { state: 'idle', reason: 'stale_runtime_hook' } }),
    makeLiveNode('dev-busy@pod-b', {
      activityState: { display: 'working', activity: 'working' },
      agentActivity: { state: 'running', reason: 'stale_runtime_hook' }
    })
  ];

  const first = await probe.probeControlPlane({ openrigHome, activeQueue, nodes, nowMs: BASE_NOW });
  assert.equal(first.logTail.cacheHit, false);
  assert.equal(first.logTail.truncatedToTail, true);
  assert.equal(first.logTail.scannedBytes, MAX_LOG_TAIL_BYTES);
  assert.equal(first.logTail.noHumanRegisteredCount, 2, 'Only tail lines inside <=32KB window should be scanned');
  assert.equal(first.logTail.stuckSweepCrashLoopLines, 3);
  assert.equal(first.logTail.consecutiveFailures, 345);
  assert.equal(first.logTail.findingsRoutedLast, 131759);

  // Strict redaction check: zero homedir paths or secrets anywhere in output
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, new RegExp(fakeHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, /\/Users\/otherperson/);
  assert.doesNotMatch(serialized, new RegExp(secretSk));
  assert.doesNotMatch(serialized, new RegExp(secretGhp));
  assert.doesNotMatch(serialized, /tok_secret_value_1234567890/);
  assert.match(first.files.daemonLog.displayPath, /^~\/\.openrig\/daemon\.log$/);

  // Verify queue buckets & detached targets & stale_runtime_hook (working seat ignored!)
  assert.equal(first.queue.opgateTotal, 22);
  assert.equal(first.queue.opgateOlderThan24h, 22);
  assert.equal(first.queue.opgateOlderThan72h, 10);
  assert.equal(first.queue.opgateOlderThan168h, 2);
  assert.equal(first.queue.detachedTargetCount, 12);
  assert.equal(first.queue.oldBlockedCount, 1);
  assert.equal(first.queue.byRig['pod-a'].opgateTotal, 12);
  assert.equal(first.queue.byRig['pod-b'].opgateTotal, 10);
  assert.equal(first.seats.staleRuntimeHookCount, 2);
  assert.deepEqual(first.seats.staleRuntimeHookSeats, ['dev-check@pod-b', 'dev-coder@pod-b']);
  assert.equal(first.latency.consecutiveSlowCount, 3);
  assert.equal(first.latency.p95Ms, 1400);

  // Second probe without file change -> cacheHit: true (0 reads)
  const second = await probe.probeControlPlane({ openrigHome, activeQueue, nodes, nowMs: BASE_NOW + 5000 });
  assert.equal(second.logTail.cacheHit, true);

  // Append 1.5 MB over 10 minutes -> triggers cache miss + >5 MB/h growth rate
  await fsp.appendFile(logPath, Buffer.alloc(1.5 * MB, 'a'));
  const third = await probe.probeControlPlane({ openrigHome, activeQueue, nodes, nowMs: BASE_NOW + 10 * 60_000 });
  assert.equal(third.logTail.cacheHit, false);
  assert.ok(third.files.daemonLog.growthBytesPerHour > 5 * MB);

  // Helper redaction check with real os.homedir()
  const osRedacted = redactControlPlaneText(`${os.homedir()}/secret-repo Bearer eyJhbGciOiJIUzI1NiJ9.abcdef12345.sig1234567890`);
  assert.ok(osRedacted.includes('~/secret-repo'));
  assert.ok(!osRedacted.includes(os.homedir()));
  assert.ok(!osRedacted.includes('eyJhbGciOiJIUzI1NiJ9'));
});

test('FleetIntelligenceEngine registers ControlPlaneHygieneDetector (#8) and prioritizes control-plane findings above parked noise', () => {
  const engine = new FleetIntelligenceEngine({ evalThrottleMs: 0 });
  assert.ok(engine.detectors.some(d => d instanceof ControlPlaneHygieneDetector && d.id === 'control-plane-hygiene'));

  const report = engine.evaluate({
    requestedRig: 'all',
    nodes: [
      makeLiveNode('operator-agent@kernel', { assignedWorkCount: 389 }),
      makeLiveNode('dev-coder@pod-a', { agentActivity: { state: 'unknown', reason: 'stale_runtime_hook' } }),
      makeLiveNode('dev-check@pod-a', { agentActivity: { state: 'idle', reason: 'stale_runtime_hook' } })
    ],
    parkedSeats: {
      'operator-agent@kernel': { parked: true, reason: 'idle-at-prompt' }
    },
    activeQueue: makeOpgateItems(25, { rig: 'pod-a', ageHours: 48 }),
    controlPlane: {
      latency: { avgMs: 1650, consecutiveSlowCount: 4 },
      healthz: { ok: false, status: 'degraded', stuckSweepConsecutiveFailures: 345, findingsRouted: 131759 },
      files: {
        daemonLog: { exists: true, bytes: 153 * MB },
        sqliteDb: { exists: true, bytes: 177 * MB }
      },
      logTail: {
        noHumanRegisteredCount: 18,
        stuckSweepCrashLoop: true,
        sampleError: 'cannot be admitted because no human is registered yet'
      },
      queue: {
        opgateTotal: 574,
        opgateOlderThan24h: 574,
        opgateOlderThan72h: 200,
        opgateOlderThan168h: 192,
        detachedTargetCount: 192,
        byRig: { 'pod-a': { opgateTotal: 574, opgateOlderThan24h: 574 } }
      },
      seats: {
        staleRuntimeHookCount: 2,
        staleRuntimeHookSeats: ['dev-check@pod-a', 'dev-coder@pod-a']
      }
    }
  });

  const cpFindings = report.allFindings.filter(f => f.detectorId === 'control-plane-hygiene');
  assert.equal(cpFindings.length, 3, 'All 3 distinct control-plane findings must survive advisory deduplication');
  assert.deepEqual(
    cpFindings.map(f => f.code).sort(),
    ['BROKEN_ESCALATION_ROUTE', 'DAEMON_DEGRADED', 'QUEUE_ZOMBIE_STORM']
  );
  assert.equal(report.topRecommendations[0].code, 'DAEMON_DEGRADED');
});

test('buildHygienePlan previews official rig commands only, validates targets/cutoffs, and warns on cross-rig daemon storm', () => {
  const queue = [
    ...makeOpgateItems(5, { rig: 'pod-a', ageHours: 30 }),
    ...makeOpgateItems(4, { rig: 'pod-a', ageHours: 96 }),
    ...makeOpgateItems(12, { rig: 'pod-b', ageHours: 48 }),
    {
      qitemId: 'qitem-blocked-1',
      sourceSession: 'dev-owner@pod-a',
      destinationSession: 'dev-coder@pod-a',
      state: 'blocked',
      tsCreated: new Date(BASE_NOW - 40 * HOUR_MS).toISOString()
    }
  ];
  const nodes = [makeLiveNode('dev-coder@pod-a')];

  for (const bad of [
    { scope: 'rig', targetRig: '../evil', cutoffHours: 24 },
    { scope: 'rig', targetRig: 'pod-a;rm', cutoffHours: 24 },
    { scope: 'fleet', cutoffHours: 12 },
    { scope: 'fleet', targetRig: 'pod-a', cutoffHours: 24 }
  ]) {
    assert.throws(() => buildHygienePlan(bad));
  }

  const rigPlan = buildHygienePlan({
    scope: 'rig',
    targetRig: 'pod-a',
    cutoffHours: 72,
    rotateDaemonLog: true,
    activeQueue: queue,
    nodes,
    nowMs: BASE_NOW,
    daemonLogBytes: 80 * MB,
    sqliteBytes: 120 * MB
  });

  assert.equal(rigPlan.totals.staleOpgateCount, 4);
  assert.equal(rigPlan.byRig['pod-a'].opgateTotal, 9);
  assert.equal(rigPlan.byRig['pod-b'].opgateTotal, 12);
  assert.equal(rigPlan.byRig['pod-a'].oldBlockedCount, 1);
  assert.ok(rigPlan.crossRigWarning && rigPlan.crossRigWarning.includes('pod-b'));
  assert.equal(rigPlan.daemonLogRotation.requested, true);
  assert.equal(rigPlan.daemonLogRotation.method, 'copy_and_truncate');
  for (const cmd of rigPlan.commandPreviews) {
    assert.doesNotMatch(cmd, /\bsqlite3\b|DELETE\s+FROM|UPDATE\s+qitems/i);
  }
  assert.match(rigPlan.commandPreviews[0], /^rig queue update qitem-opgate-.* --state done --closure-reason canceled/);

  const fleetPlan = buildHygienePlan({
    scope: 'fleet',
    cutoffHours: 24,
    activeQueue: queue,
    nodes,
    nowMs: BASE_NOW
  });
  assert.equal(fleetPlan.crossRigWarning, null);
  assert.equal(fleetPlan.totals.staleOpgateCount, 21);
});

test('2-step HTTP routes enforce confirmation, SHA-256 planHash TTL, idempotency, safe log rotation, audit & readOnly', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-hygiene-gate-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const openrigHome = path.join(dir, '.openrig');
  await fsp.mkdir(openrigHome, { recursive: true });
  const logPath = path.join(openrigHome, 'daemon.log');
  await fsp.writeFile(logPath, 'old-daemon-log-line\n'.repeat(100));

  let now = BASE_NOW;
  let liveQueue = [
    ...makeOpgateItems(3, { rig: 'pod-a', ageHours: 48, seat: 'dev-coder' }),
    ...makeOpgateItems(2, { rig: 'pod-b', ageHours: 48, seat: 'dev-coder' })
  ];
  const liveNodes = [makeLiveNode('dev-coder@pod-a'), makeLiveNode('dev-coder@pod-b')];
  const probe = new ControlPlaneProbe({ homeDir: dir });
  probe.recordProbeLatency({ endpoint: '/api/rigs', durationMs: 1450, ok: true, tsMs: now });

  const cliCalls = [];
  let mode = 'clean'; // 'clean' | 'partial' | 'fail' | 'timeout' | 'block'
  let blockedOnce = false;
  let partialFailId = '';
  let releaseBlocked = null;
  let enteredBlocked = null;

  const execCommand = async (bin, argv, opts) => {
    assert.equal(opts.shell, false);
    cliCalls.push([bin, ...argv]);
    const qitemId = argv[2];
    if (mode === 'block' && !blockedOnce) {
      blockedOnce = true;
      enteredBlocked();
      await new Promise(resolve => { releaseBlocked = resolve; });
    }
    if (mode === 'timeout') {
      const err = new Error('timed out');
      err.killed = true;
      throw err;
    }
    if (mode === 'fail' || (mode === 'partial' && qitemId === partialFailId)) {
      throw Object.assign(new Error('daemon rejected'), { stderr: 'locked' });
    }
    liveQueue = liveQueue.filter(q => q.qitemId !== qitemId);
    return { stdout: JSON.stringify({ ok: true, qitemId }) };
  };

  const actionAudit = new ActionAuditLog();
  const shiftHistory = new ShiftHistoryStore({ filePath: path.join(dir, 'shift.jsonl'), readOnly: true });
  const service = new FleetResilienceService({
    providers: [{
      id: 'openrig',
      capabilities: { daemonProbe: true, checkpoints: false, fleetRecover: false, unitRecover: false, planPreview: false, receiptPolling: false },
      probe: async () => ({ daemonUp: true, liveRigs: [], liveNodes }),
      listCheckpoints: async () => [], createCheckpoint: async () => ({}),
      planRecover: async () => ({}), executeRecover: async () => ({}), getReceipt: async () => ({})
    }],
    stateDir: path.join(dir, 'vault'),
    now: () => now,
    actionAudit,
    shiftHistory,
    openrigHome,
    rigBin: 'rig',
    controlPlaneProbe: probe,
    execCommand,
    getHygieneState: async () => ({ activeQueue: liveQueue, nodes: liveNodes })
  });

  const invoke = createResilienceRouteInvoker(service);
  const post = (route, body, headers = {}) => invoke('POST', `/api/resilience/hygiene/${route}`, body, {
    'content-type': 'application/json',
    ...headers
  });

  // 1. Plan validation + crossRigWarning
  assert.equal((await post('plan', { scope: 'rig', targetRig: '../bad', cutoffHours: 24 })).status, 400);
  assert.equal((await post('plan', { scope: 'fleet', cutoffHours: 10 })).status, 400);

  const rigPlanRes = await post('plan', { scope: 'rig', targetRig: 'pod-a', cutoffHours: 24, rotateDaemonLog: true });
  assert.equal(rigPlanRes.status, 200);
  const rigPlanBody = await rigPlanRes.json();
  assert.match(rigPlanBody.planHash, /^[a-f0-9]{64}$/);
  assert.ok(rigPlanBody.plan.crossRigWarning && rigPlanBody.plan.crossRigWarning.includes('pod-b'));
  assert.equal(rigPlanBody.plan.totals.targetCount, 3);

  // 2. Execution rejects missing idempotency key, unconfirmed, bad/mismatched planHash, and expired TTL (5 min)
  assert.equal((await post('execute', { scope: 'rig', targetRig: 'pod-a', cutoffHours: 24, rotateDaemonLog: true, confirmed: true, planHash: rigPlanBody.planHash })).status, 400);
  assert.equal((await post('execute', { scope: 'rig', targetRig: 'pod-a', cutoffHours: 24, rotateDaemonLog: true, confirmed: false, planHash: rigPlanBody.planHash }, { 'x-idempotency-key': 'k1' })).status, 400);
  assert.equal((await post('execute', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24, rotateDaemonLog: true, confirmed: true, planHash: rigPlanBody.planHash }, { 'x-idempotency-key': 'k2' })).status, 400);
  assert.equal((await post('execute', { scope: 'rig', targetRig: 'pod-a', cutoffHours: 72, rotateDaemonLog: true, confirmed: true, planHash: rigPlanBody.planHash }, { 'x-idempotency-key': 'k3' })).status, 400);
  assert.equal(cliCalls.length, 0);

  // Advance clock by 5 minutes (300_000 ms) -> TTL expired
  now += 300_000;
  assert.equal((await post('execute', { scope: 'rig', targetRig: 'pod-a', cutoffHours: 24, rotateDaemonLog: true, confirmed: true, planHash: rigPlanBody.planHash }, { 'x-idempotency-key': 'k4' })).status, 400);

  // 3. Valid plan + concurrent in-flight 409 + idempotent replay + conflict 409 + copy-and-truncate log rotation
  const freshPlan = await (await post('plan', { scope: 'rig', targetRig: 'pod-a', cutoffHours: 24, rotateDaemonLog: true })).json();
  const validPayload = { scope: 'rig', targetRig: 'pod-a', cutoffHours: 24, rotateDaemonLog: true, confirmed: true, planHash: freshPlan.planHash };

  mode = 'block';
  const blockedPromise = new Promise(resolve => { enteredBlocked = resolve; });
  const inFlightReq = post('execute', validPayload, { 'x-idempotency-key': 'exec-1' });
  await blockedPromise;
  const concurrentRes = await post('execute', validPayload, { 'x-idempotency-key': 'exec-concurrent' });
  assert.equal(concurrentRes.status, 409);
  mode = 'clean';
  releaseBlocked();

  const execRes = await inFlightReq;
  assert.equal(execRes.status, 200);
  const execBody = await execRes.json();
  assert.equal(execBody.receipt.status, 'cleaned');
  assert.equal(execBody.receipt.cleanedCount, 3);
  assert.equal(execBody.receipt.before.staleQueueCount, 5);
  assert.equal(execBody.receipt.after.remainingStaleQueueCount, 2);
  assert.equal(execBody.receipt.after.daemonLogBytes, 0);
  assert.ok(execBody.receipt.before.daemonLogBytes > 0);
  assert.equal(execBody.receipt.logRotation.status, 'rotated');

  // Verify backup file created with mode 0600 and live daemon.log truncated to 0
  const filesAfter = await fsp.readdir(openrigHome);
  const bakName = filesAfter.find(f => f.startsWith('daemon.log.') && f.endsWith('.bak'));
  assert.ok(bakName);
  assert.equal((await fsp.stat(path.join(openrigHome, bakName))).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(logPath)).size, 0);

  // Verify audit & shift history recorded
  assert.equal(actionAudit.list()[0].actionId, 'resilience_hygiene');
  assert.equal(actionAudit.list()[0].postconditionStatus, 'verified');
  assert.equal(shiftHistory.events.length, 1);

  // Idempotency replay returns cached receipt without re-executing CLI
  const callsBeforeReplay = cliCalls.length;
  const replayRes = await post('execute', validPayload, { 'x-idempotency-key': 'exec-1' });
  assert.equal(replayRes.status, 200);
  const replayBody = await replayRes.json();
  assert.equal(replayBody.deduplicated, true);
  assert.equal(replayBody.receipt.receiptId, execBody.receipt.receiptId);
  assert.equal(cliCalls.length, callsBeforeReplay);

  // Idempotency conflict (same key, different payload) -> 409
  const conflictRes = await post('execute', { ...validPayload, cutoffHours: 72 }, { 'x-idempotency-key': 'exec-1' });
  assert.equal(conflictRes.status, 409);

  // Consumed single-use planHash rejected with new idempotency key -> 400
  assert.equal((await post('execute', validPayload, { 'x-idempotency-key': 'exec-new-key' })).status, 400);

  // 4. Partial, failed (502), unknown, and unsafe symlink refusal
  liveQueue = makeOpgateItems(2, { rig: 'pod-b', ageHours: 48, seat: 'dev-coder' });
  const pPartial = await (await post('plan', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24 })).json();
  partialFailId = pPartial.plan.targetQitemIds[0];
  mode = 'partial';
  const partialRes = await post('execute', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24, confirmed: true, planHash: pPartial.planHash }, { 'x-idempotency-key': 'exec-partial' });
  assert.equal(partialRes.status, 200);
  assert.equal((await partialRes.json()).receipt.status, 'partial');

  const pFail = await (await post('plan', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24 })).json();
  mode = 'fail';
  const failRes = await post('execute', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24, confirmed: true, planHash: pFail.planHash }, { 'x-idempotency-key': 'exec-fail' });
  assert.equal(failRes.status, 502);
  assert.equal((await failRes.json()).receipt.status, 'failed');

  const pTimeout = await (await post('plan', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24 })).json();
  mode = 'timeout';
  const timeoutRes = await post('execute', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24, confirmed: true, planHash: pTimeout.planHash }, { 'x-idempotency-key': 'exec-timeout' });
  assert.equal(timeoutRes.status, 200);
  assert.equal((await timeoutRes.json()).receipt.status, 'unknown');

  // Symlink daemon.log refusal
  await fsp.unlink(logPath);
  await fsp.symlink(path.join(dir, 'outside-target'), logPath);
  const pSym = await (await post('plan', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24, rotateDaemonLog: true })).json();
  mode = 'clean';
  const symRes = await post('execute', { scope: 'rig', targetRig: 'pod-b', cutoffHours: 24, rotateDaemonLog: true, confirmed: true, planHash: pSym.planHash }, { 'x-idempotency-key': 'exec-symlink' });
  const symBody = await symRes.json();
  assert.equal(symBody.receipt.logRotation.status, 'failed');
  assert.equal(symBody.receipt.logRotation.error, 'unsafe_daemon_log_symlink');

  // 5. Read-only mode guard enforces 403
  const roService = new FleetResilienceService({
    stateDir: path.join(dir, 'ro-vault'),
    openrigHome,
    readOnly: true
  });
  const roInvoke = createResilienceRouteInvoker(roService);
  assert.equal((await roInvoke('POST', '/api/resilience/hygiene/plan', {}, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await roInvoke('POST', '/api/resilience/hygiene/execute', {}, { 'content-type': 'application/json', 'x-idempotency-key': 'ro-1' })).status, 403);
});
