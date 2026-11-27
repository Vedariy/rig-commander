import { SAFE_RIG_NAME_RE } from './resilience-model.js';

/** Pure, zero-DOM, zero-Node control-plane health and hygiene planning models. */

export const SAFE_HYGIENE_CUTOFFS_HOURS = Object.freeze([24, 72, 168]);
export const SAFE_QITEM_ID_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const SAFE_SEAT_TARGET_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

const MB = 1024 * 1024;
const HOUR_MS = 3_600_000;

export const CONTROL_PLANE_THRESHOLDS = Object.freeze({
  latencyP0Ms: 1000,
  consecutiveSlowProbesP0: 3,
  daemonLogBytesP0: 50 * MB,
  daemonLogGrowthBytesPerHourP0: 5 * MB,
  sqliteBytesP0: 100 * MB,
  stuckSweepConsecutiveFailuresP0: 5,
  opgateZombieCountP1: 20,
  opgateStaleHoursP1: 24,
  detachedSeatHoursP1: 6,
  staleRuntimeHookCountP1: 2,
  repeatedRoutingErrorsP1: 2,
  stuckSweepCrashLoopLinesP1: 3
});

export const CONTROL_PLANE_FINDING_CODES = Object.freeze({
  DAEMON_DEGRADED: 'DAEMON_DEGRADED',
  QUEUE_ZOMBIE_STORM: 'QUEUE_ZOMBIE_STORM',
  BROKEN_ESCALATION_ROUTE: 'BROKEN_ESCALATION_ROUTE'
});

const TERMINAL_QUEUE_STATES = new Set(['done', 'canceled', 'cancelled', 'handed-off', 'denied', 'failed', 'terminal', 'closed']);
const BLOCKED_QUEUE_STATES = new Set(['blocked', 'parked', 'held']);
const UNHEALTHY_STATUS_VALUES = new Set(['down', 'unhealthy', 'degraded', 'error', 'fail', 'failed', 'critical']);
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const MAX_PLAN_TARGET_IDS = 500;
const MAX_COMMAND_PREVIEWS = 25;

const list = value => (Array.isArray(value) ? value : []);
const numOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const nonNegNum = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
const text = value => (typeof value === 'string' ? value : '');

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseQueueItemTimestampMs(q = {}) {
  if (!q || typeof q !== 'object') return null;
  for (const raw of [q.tsCreated, q.createdAt, q.tsUpdated, q.updatedAt]) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return raw > 1e12 ? raw : raw * 1000;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const trimmed = raw.trim();
      const norm = SQLITE_UTC_RE.test(trimmed) ? trimmed.replace(' ', 'T') + 'Z' : trimmed;
      const ms = Date.parse(norm);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  const id = text(q.qitemId || q.id);
  const match = id.match(/^qitem-(?:[a-z]+-)?(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/i);
  if (match) {
    const ms = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

export function isOpgateQueueItem(q = {}) {
  if (!q || typeof q !== 'object') return false;
  const id = text(q.qitemId || q.id);
  if (id.startsWith('qitem-opgate-')) return true;
  const src = text(q.sourceSession || q.from).toLowerCase();
  return src.includes('opgate');
}

function resolveSeatId(node = {}) {
  return text(node?.canonicalSessionName || node?.seatId || node?.logicalId || node?.id);
}

function resolveRigFromItem(q = {}) {
  const explicit = text(q.rigId || q.rigName);
  if (SAFE_RIG_NAME_RE.test(explicit)) return explicit;
  const dest = text(q.destinationSession || q.to);
  const src = text(q.sourceSession || q.from);
  for (const ref of [dest, src]) {
    const atIdx = ref.lastIndexOf('@');
    if (atIdx > 0) {
      const candidate = ref.slice(atIdx + 1);
      if (candidate && candidate !== 'external' && candidate !== 'human') return candidate;
    }
  }
  return 'unknown';
}

function resolveSeatDetachedHours(node, itemAgeHours, nowMs) {
  if (typeof node?.detachedHours === 'number' && Number.isFinite(node.detachedHours)) {
    return Math.max(0, node.detachedHours);
  }
  for (const raw of [node?.detachedSince, node?.exitedAt, node?.lastActivityAt, node?.lastSeenAt]) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.max(0, (nowMs - raw) / HOUR_MS);
    }
    if (typeof raw === 'string' && raw.trim()) {
      const ms = Date.parse(raw.trim());
      if (Number.isFinite(ms) && ms > 0) return Math.max(0, (nowMs - ms) / HOUR_MS);
    }
  }
  return itemAgeHours;
}

function isNodeLiveAndIdleWithStaleHook(node = {}) {
  if (!node || typeof node !== 'object') return false;
  const hasStaleHook =
    node.staleRuntimeHook === true ||
    node.agentActivity?.reason === 'stale_runtime_hook' ||
    node.activityState?.reason === 'stale_runtime_hook' ||
    (Array.isArray(node.warnings) && node.warnings.includes('stale_runtime_hook'));
  if (!hasStaleHook) return false;

  const isDead =
    node.shellExited === true ||
    node.sessionStatus === 'stopped' ||
    node.sessionStatus === 'exited' ||
    node.lifecycleState === 'stopped';
  if (isDead) return false;

  const isLive =
    node.sessionStatus === 'running' ||
    node.lifecycleState === 'running' ||
    (node.sessionStatus == null && node.lifecycleState == null);
  if (!isLive) return false;

  const display = text(node.activityState?.display || node.state).toLowerCase();
  const activity = text(node.activityState?.activity).toLowerCase();
  const agentState = text(node.agentActivity?.state).toLowerCase();
  if (display === 'working' || display === 'running' || activity === 'working') return false;

  return (
    display === 'idle' ||
    activity === 'idle-at-prompt' ||
    agentState === 'idle' ||
    agentState === 'unknown' ||
    display === ''
  );
}

function isNodeDetachedOrDead(node = {}) {
  if (!node || typeof node !== 'object') return false;
  if (node.hasLivePane === false || node.tmuxAlive === false || node.tmuxAttached === false || node.paneAlive === false) {
    return true;
  }
  if (node.paneDead === true || node.detached === true || node.shellExited === true) {
    return true;
  }
  if (node.sessionStatus != null && node.sessionStatus !== 'running' && node.lifecycleState !== 'running') {
    return true;
  }
  return false;
}

function ensureRigBucket(byRig, rigId) {
  if (!byRig[rigId]) {
    byRig[rigId] = {
      rigId,
      opgateTotal: 0,
      opgateOlderThan24h: 0,
      opgateOlderThan72h: 0,
      opgateOlderThan168h: 0,
      detachedTargetCount: 0,
      oldBlockedCount: 0,
      detachedSeats: [],
      sampleQitemIds: []
    };
  }
  return byRig[rigId];
}

/**
 * Pure inspector for active queue rows and node roster.
 * Computes age buckets, per-rig breakdowns, detached target seats (> 6h),
 * old blocked rows (> 24h), and live idle seats carrying stale_runtime_hook.
 */
export function summarizeQueueAndSeats({ activeQueue = [], nodes = [], nowMs = Date.now(), cutoffHours = 24 } = {}) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const queueRows = list(activeQueue);
  const nodeRows = list(nodes);

  const nodeBySeat = new Map();
  const staleRuntimeHookSeats = [];
  const detachedSeats = [];

  for (const node of nodeRows) {
    const sid = resolveSeatId(node);
    if (!sid) continue;
    nodeBySeat.set(sid, node);
    if (isNodeLiveAndIdleWithStaleHook(node)) {
      staleRuntimeHookSeats.push(sid);
    }
    if (isNodeDetachedOrDead(node)) {
      const detachedHrs = resolveSeatDetachedHours(node, 0, safeNow);
      if (detachedHrs > CONTROL_PLANE_THRESHOLDS.detachedSeatHoursP1) {
        detachedSeats.push(sid);
      }
    }
  }

  const byRig = Object.create(null);
  const detachedTargetsBySeat = new Map();
  const seenIds = new Set();

  let totalActive = 0;
  let opgateTotal = 0;
  let opgateOlderThan24h = 0;
  let opgateOlderThan72h = 0;
  let opgateOlderThan168h = 0;
  let opgateOlderThanCutoff = 0;
  let detachedTargetCount = 0;
  let oldBlockedCount = 0;
  let oldBlockedOlderThan24h = 0;

  const items = [];

  for (const q of queueRows) {
    if (!q || typeof q !== 'object') continue;
    const id = text(q.qitemId || q.id);
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    const state = text(q.state || 'pending').toLowerCase();
    if (TERMINAL_QUEUE_STATES.has(state)) continue;

    totalActive++;
    const rigId = resolveRigFromItem(q);
    const bucket = ensureRigBucket(byRig, rigId);
    const createdMs = parseQueueItemTimestampMs(q);
    const ageMs = createdMs != null && safeNow >= createdMs ? safeNow - createdMs : 0;
    const ageHours = ageMs / HOUR_MS;
    const isOpgate = isOpgateQueueItem(q);
    const isBlocked = BLOCKED_QUEUE_STATES.has(state) || text(q.pickup?.state).toLowerCase() === 'parked';

    const dest = text(q.destinationSession || q.to);
    const isSyntheticTarget = !dest || dest.endsWith('@external') || dest.endsWith('@human');
    const destNode = dest ? nodeBySeat.get(dest) || null : null;

    let targetDetachedHours = 0;
    let isDetachedTarget = false;
    if (q.targetDetached === true || q.targetPaneAlive === false) {
      targetDetachedHours = typeof q.targetDetachedHours === 'number' ? q.targetDetachedHours : ageHours;
      isDetachedTarget = targetDetachedHours > CONTROL_PLANE_THRESHOLDS.detachedSeatHoursP1;
    } else if (!isSyntheticTarget) {
      if (destNode) {
        if (isNodeDetachedOrDead(destNode)) {
          targetDetachedHours = resolveSeatDetachedHours(destNode, ageHours, safeNow);
          isDetachedTarget = targetDetachedHours > CONTROL_PLANE_THRESHOLDS.detachedSeatHoursP1;
        }
      } else if (nodeRows.length > 0) {
        targetDetachedHours = ageHours;
        isDetachedTarget = ageHours > CONTROL_PLANE_THRESHOLDS.detachedSeatHoursP1;
      }
    }

    if (isOpgate) {
      opgateTotal++;
      bucket.opgateTotal++;
      if (ageHours > 24) {
        opgateOlderThan24h++;
        bucket.opgateOlderThan24h++;
      }
      if (ageHours > 72) {
        opgateOlderThan72h++;
        bucket.opgateOlderThan72h++;
      }
      if (ageHours > 168) {
        opgateOlderThan168h++;
        bucket.opgateOlderThan168h++;
      }
      if (ageHours > cutoffHours) {
        opgateOlderThanCutoff++;
      }
      if (id && bucket.sampleQitemIds.length < 10) {
        bucket.sampleQitemIds.push(id);
      }
    }

    if (isDetachedTarget) {
      detachedTargetCount++;
      bucket.detachedTargetCount++;
      if (dest && !bucket.detachedSeats.includes(dest)) bucket.detachedSeats.push(dest);
      if (dest) {
        const prev = detachedTargetsBySeat.get(dest) || {
          seatId: dest,
          rigId,
          count: 0,
          oldestHours: 0,
          maxDetachedHours: 0
        };
        prev.count++;
        prev.oldestHours = Math.max(prev.oldestHours, Number(ageHours.toFixed(1)));
        prev.maxDetachedHours = Math.max(prev.maxDetachedHours, Number(targetDetachedHours.toFixed(1)));
        detachedTargetsBySeat.set(dest, prev);
      }
    }

    if (isBlocked && ageHours > 24) {
      oldBlockedCount++;
      oldBlockedOlderThan24h++;
      bucket.oldBlockedCount++;
    }

    items.push({
      qitemId: id,
      rigId,
      destinationSession: dest,
      state,
      ageHours,
      isOpgate,
      isDetachedTarget,
      isOldBlocked: isBlocked && ageHours > 24
    });
  }

  for (const bucket of Object.values(byRig)) {
    bucket.detachedSeats.sort(cmp);
  }

  return {
    queue: {
      totalActive,
      opgateTotal,
      opgateOlderThan24h,
      opgateOlderThan72h,
      opgateOlderThan168h,
      opgateOlderThanCutoff,
      detachedTargetCount,
      detachedTargets: [...detachedTargetsBySeat.values()].sort((a, b) => b.count - a.count || cmp(a.seatId, b.seatId)),
      oldBlockedCount,
      oldBlockedOlderThan24h,
      byRig,
      items
    },
    seats: {
      staleRuntimeHookCount: staleRuntimeHookSeats.length,
      staleRuntimeHookSeats: staleRuntimeHookSeats.sort(cmp),
      detachedSeatCount: detachedSeats.length,
      detachedSeats: detachedSeats.sort(cmp)
    }
  };
}

function normalizeControlPlaneInput(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const lat = input.latency && typeof input.latency === 'object' ? input.latency : {};
  const hz = input.healthz && typeof input.healthz === 'object' ? input.healthz : {};
  const files = input.files && typeof input.files === 'object' ? input.files : {};
  const logFile = files.daemonLog && typeof files.daemonLog === 'object' ? files.daemonLog : {};
  const dbFile = files.sqliteDb && typeof files.sqliteDb === 'object' ? files.sqliteDb : {};
  const tail = input.logTail && typeof input.logTail === 'object' ? input.logTail : {};
  const q = input.queue && typeof input.queue === 'object' ? input.queue : {};
  const s = input.seats && typeof input.seats === 'object' ? input.seats : {};

  const avgLatencyMs = numOrNull(lat.avgMs ?? input.avgLatencyMs ?? input.rollingLatencyMs);
  const p95LatencyMs = numOrNull(lat.p95Ms ?? input.p95LatencyMs);
  const lastLatencyMs = numOrNull(lat.lastMs ?? input.lastLatencyMs);
  const consecutiveSlowCount = nonNegNum(lat.consecutiveSlowCount ?? input.consecutiveSlowCount, 0);

  const daemonLogBytes = nonNegNum(logFile.bytes ?? input.daemonLogBytes, 0);
  const daemonLogGrowthBytesPerHour = numOrNull(logFile.growthBytesPerHour ?? input.daemonLogGrowthBytesPerHour);
  const sqliteBytes = nonNegNum(dbFile.bytes ?? input.sqliteBytes ?? input.openrigSqliteBytes, 0);

  const healthzStatus = text(hz.status ?? input.healthzStatus).toLowerCase();
  const healthzOk = typeof hz.ok === 'boolean' ? hz.ok : (typeof input.healthzOk === 'boolean' ? input.healthzOk : null);
  const healthzUnhealthy =
    hz.unhealthy === true ||
    input.healthzUnhealthy === true ||
    healthzOk === false ||
    UNHEALTHY_STATUS_VALUES.has(healthzStatus);

  const stuckSweepConsecutiveFailures = Math.max(
    nonNegNum(hz.stuckSweepConsecutiveFailures ?? input.stuckSweepConsecutiveFailures, 0),
    nonNegNum(tail.consecutiveFailures ?? tail.stuckSweepFailures, 0)
  );
  const findingsRouted = numOrNull(hz.findingsRouted ?? tail.findingsRoutedLast ?? input.findingsRouted);

  const opgateTotal = nonNegNum(q.opgateTotal ?? input.opgateTotal, 0);
  const opgateOlderThan24h = nonNegNum(q.opgateOlderThan24h ?? input.opgateOlderThan24h, 0);
  const opgateOlderThan72h = nonNegNum(q.opgateOlderThan72h ?? input.opgateOlderThan72h, 0);
  const opgateOlderThan168h = nonNegNum(q.opgateOlderThan168h ?? input.opgateOlderThan168h, 0);
  const detachedTargetCount = nonNegNum(q.detachedTargetCount ?? input.detachedTargetCount, 0);
  const detachedTargets = list(q.detachedTargets ?? input.detachedTargets);
  const oldBlockedCount = nonNegNum(q.oldBlockedCount ?? input.oldBlockedCount, 0);
  const byRig = q.byRig && typeof q.byRig === 'object' ? q.byRig : {};

  const staleRuntimeHookSeats = list(s.staleRuntimeHookSeats ?? input.staleRuntimeHookSeats);
  const staleRuntimeHookCount = Math.max(
    nonNegNum(s.staleRuntimeHookCount ?? input.staleRuntimeHookCount, 0),
    staleRuntimeHookSeats.length
  );

  const noHumanRegisteredCount = nonNegNum(tail.noHumanRegisteredCount ?? input.noHumanRegisteredCount, 0);
  const permanentRoutingErrorCount = Math.max(
    noHumanRegisteredCount,
    nonNegNum(tail.permanentRoutingErrorCount ?? input.permanentRoutingErrorCount, 0)
  );
  const stuckSweepCrashLoop =
    tail.stuckSweepCrashLoop === true ||
    input.stuckSweepCrashLoop === true ||
    nonNegNum(tail.stuckSweepCrashLoopLines, 0) >= CONTROL_PLANE_THRESHOLDS.stuckSweepCrashLoopLinesP1;

  const sampleError = text(tail.sampleError ?? hz.error ?? input.sampleError);
  const parkedBacklogCount = nonNegNum(input.parkedBacklogCount, opgateTotal);

  return {
    avgLatencyMs,
    p95LatencyMs,
    lastLatencyMs,
    consecutiveSlowCount,
    daemonLogBytes,
    daemonLogGrowthBytesPerHour,
    sqliteBytes,
    healthzOk,
    healthzStatus: healthzStatus || (healthzOk === false ? 'unhealthy' : healthzOk === true ? 'ok' : 'unknown'),
    healthzUnhealthy,
    stuckSweepConsecutiveFailures,
    findingsRouted,
    opgateTotal,
    opgateOlderThan24h,
    opgateOlderThan72h,
    opgateOlderThan168h,
    detachedTargetCount,
    detachedTargets,
    oldBlockedCount,
    byRig,
    staleRuntimeHookCount,
    staleRuntimeHookSeats,
    noHumanRegisteredCount,
    permanentRoutingErrorCount,
    stuckSweepCrashLoop,
    sampleError,
    parkedBacklogCount
  };
}

/**
 * Classifies control-plane health into deterministic P0/P1 findings:
 * - P0 DAEMON_DEGRADED
 * - P1 QUEUE_ZOMBIE_STORM
 * - P1 BROKEN_ESCALATION_ROUTE
 */
export function evaluateControlPlaneHealth(controlPlaneInput) {
  const m = normalizeControlPlaneInput(controlPlaneInput);
  const findings = [];

  // 1. P0 DAEMON_DEGRADED
  const p0Reasons = [];
  if (m.avgLatencyMs !== null && m.avgLatencyMs > CONTROL_PLANE_THRESHOLDS.latencyP0Ms) {
    p0Reasons.push(`rolling API latency ${Math.round(m.avgLatencyMs)} ms (> ${CONTROL_PLANE_THRESHOLDS.latencyP0Ms} ms)`);
  }
  if (m.consecutiveSlowCount >= CONTROL_PLANE_THRESHOLDS.consecutiveSlowProbesP0) {
    p0Reasons.push(`${m.consecutiveSlowCount} consecutive slow probes`);
  }
  if (m.daemonLogBytes > CONTROL_PLANE_THRESHOLDS.daemonLogBytesP0) {
    p0Reasons.push(`daemon.log ${(m.daemonLogBytes / MB).toFixed(1)} MB (> 50 MB)`);
  }
  if (
    m.daemonLogGrowthBytesPerHour !== null &&
    m.daemonLogGrowthBytesPerHour > CONTROL_PLANE_THRESHOLDS.daemonLogGrowthBytesPerHourP0
  ) {
    p0Reasons.push(`daemon.log growth ${(m.daemonLogGrowthBytesPerHour / MB).toFixed(1)} MB/h (> 5 MB/h)`);
  }
  if (m.sqliteBytes > CONTROL_PLANE_THRESHOLDS.sqliteBytesP0) {
    p0Reasons.push(`openrig.sqlite ${(m.sqliteBytes / MB).toFixed(1)} MB (> 100 MB)`);
  }
  if (m.stuckSweepConsecutiveFailures >= CONTROL_PLANE_THRESHOLDS.stuckSweepConsecutiveFailuresP0) {
    p0Reasons.push(`stuckSweep consecutive failures ${m.stuckSweepConsecutiveFailures} (>= 5)`);
  }
  if (m.healthzUnhealthy) {
    p0Reasons.push(`daemon /healthz ${m.healthzStatus}`);
  }

  if (p0Reasons.length > 0) {
    findings.push({
      code: CONTROL_PLANE_FINDING_CODES.DAEMON_DEGRADED,
      severity: 'p0_urgent',
      confidence: 0.98,
      riskScore: 97,
      shortTitle: 'OpenRig daemon degraded',
      title: `🚨 OpenRig control-plane degraded (${p0Reasons[0]})`,
      summary: `Control-plane degradation detected: ${p0Reasons.join('; ')}.`,
      remediation: 'Open Control-Plane Hygiene Crash-Cart to inspect stale queue drivers, run safe rig queue cleanup, or copy-and-truncate daemon.log.',
      reasons: p0Reasons,
      metrics: {
        avgLatencyMs: m.avgLatencyMs,
        p95LatencyMs: m.p95LatencyMs,
        consecutiveSlowCount: m.consecutiveSlowCount,
        daemonLogBytes: m.daemonLogBytes,
        daemonLogGrowthBytesPerHour: m.daemonLogGrowthBytesPerHour,
        sqliteBytes: m.sqliteBytes,
        stuckSweepConsecutiveFailures: m.stuckSweepConsecutiveFailures,
        findingsRouted: m.findingsRouted,
        healthzStatus: m.healthzStatus
      },
      actionPlan: {
        actionId: 'hygiene-plan-daemon',
        kind: 'open_hygiene_crash_cart',
        label: '🩺 Hygiene Crash-Cart',
        commandPreview: 'rig queue list -A --json',
        reversibility: 'confirmed_2step',
        safetyLevel: 'requires_operator_ack'
      }
    });
  }

  // 2. P1 QUEUE_ZOMBIE_STORM
  const p1ZombieReasons = [];
  if (m.opgateOlderThan24h >= CONTROL_PLANE_THRESHOLDS.opgateZombieCountP1) {
    p1ZombieReasons.push(`${m.opgateOlderThan24h} stale qitem-opgate-* items > 24h`);
  }
  if (m.detachedTargetCount > 0) {
    p1ZombieReasons.push(`${m.detachedTargetCount} queue item(s) targeting detached/non-existent seats (> 6h)`);
  }
  if (m.staleRuntimeHookCount >= CONTROL_PLANE_THRESHOLDS.staleRuntimeHookCountP1) {
    p1ZombieReasons.push(`${m.staleRuntimeHookCount} live idle seats with stale_runtime_hook`);
  }

  if (p1ZombieReasons.length > 0) {
    const affectedRigs = Object.keys(m.byRig).filter(r => r && r !== 'unknown').sort(cmp);
    const affectedSeats = [
      ...new Set([
        ...m.detachedTargets.map(t => text(t?.seatId)).filter(Boolean),
        ...m.staleRuntimeHookSeats
      ])
    ].sort(cmp);

    findings.push({
      code: CONTROL_PLANE_FINDING_CODES.QUEUE_ZOMBIE_STORM,
      severity: 'p1_high',
      confidence: 0.95,
      riskScore: 90,
      shortTitle: `Queue storm (${m.opgateOlderThan24h} opgate)`,
      title: `🧟 Queue zombie storm: ${p1ZombieReasons[0]}`,
      summary: `Control-plane queue hygiene backlog detected: ${p1ZombieReasons.join('; ')}.`,
      remediation: 'Preview and confirm fleet-wide qitem-opgate-* cleanup via 2-step Hygiene Crash-Cart (rig queue update --state done --closure-reason canceled).',
      reasons: p1ZombieReasons,
      metrics: {
        opgateTotal: m.opgateTotal,
        opgateOlderThan24h: m.opgateOlderThan24h,
        opgateOlderThan72h: m.opgateOlderThan72h,
        opgateOlderThan168h: m.opgateOlderThan168h,
        detachedTargetCount: m.detachedTargetCount,
        oldBlockedCount: m.oldBlockedCount,
        staleRuntimeHookCount: m.staleRuntimeHookCount,
        affectedRigs,
        affectedSeats,
        byRig: m.byRig
      },
      actionPlan: {
        actionId: 'hygiene-plan-queue',
        kind: 'open_hygiene_crash_cart',
        label: '🧹 Clean Zombie Queue',
        commandPreview: 'rig queue list -A --json',
        reversibility: 'confirmed_2step',
        safetyLevel: 'requires_operator_ack'
      }
    });
  }

  // 3. P1 BROKEN_ESCALATION_ROUTE (single root-cause finding instead of hiding behind PARKED (N))
  const routeReasons = [];
  if (m.noHumanRegisteredCount >= CONTROL_PLANE_THRESHOLDS.repeatedRoutingErrorsP1) {
    routeReasons.push(`${m.noHumanRegisteredCount}× "cannot be admitted because no human is registered yet"`);
  } else if (m.permanentRoutingErrorCount >= CONTROL_PLANE_THRESHOLDS.repeatedRoutingErrorsP1) {
    routeReasons.push(`${m.permanentRoutingErrorCount}× repeated permanent routing errors`);
  }
  if (m.stuckSweepCrashLoop) {
    routeReasons.push(`stuckSweep crash loop in daemon.log${m.stuckSweepConsecutiveFailures ? ` (${m.stuckSweepConsecutiveFailures} consecutive failures)` : ''}`);
  }

  if (routeReasons.length > 0) {
    const parkedNote = m.parkedBacklogCount > 0 ? ` (masking ${m.parkedBacklogCount} queued/parked items)` : '';
    findings.push({
      code: CONTROL_PLANE_FINDING_CODES.BROKEN_ESCALATION_ROUTE,
      severity: 'p1_high',
      confidence: 0.94,
      riskScore: 88,
      shortTitle: 'Broken escalation route',
      title: `🔀 Broken escalation route in OpenRig daemon${parkedNote}`,
      summary: `Permanent routing failure in daemon.log tail (${routeReasons.join('; ')})${m.sampleError ? ` — ${m.sampleError}` : ''}.`,
      remediation: 'Register human/operator escalation target or clear dead-letter opgate backlog via Hygiene Crash-Cart instead of retrying permanently unroutable alerts.',
      reasons: routeReasons,
      metrics: {
        noHumanRegisteredCount: m.noHumanRegisteredCount,
        permanentRoutingErrorCount: m.permanentRoutingErrorCount,
        stuckSweepCrashLoop: m.stuckSweepCrashLoop,
        stuckSweepConsecutiveFailures: m.stuckSweepConsecutiveFailures,
        findingsRouted: m.findingsRouted,
        parkedBacklogCount: m.parkedBacklogCount,
        sampleError: m.sampleError
      },
      actionPlan: {
        actionId: 'hygiene-plan-escalation',
        kind: 'open_hygiene_crash_cart',
        label: '🩺 Fix Escalation Route',
        commandPreview: 'rig doctor',
        reversibility: 'confirmed_2step',
        safetyLevel: 'requires_operator_ack'
      }
    });
  }

  const hasP0 = findings.some(f => f.severity === 'p0_urgent');
  const hasP1 = findings.some(f => f.severity === 'p1_high');

  return {
    healthy: findings.length === 0,
    status: hasP0 ? 'degraded' : hasP1 ? 'warning' : 'healthy',
    highestSeverity: hasP0 ? 'p0_urgent' : hasP1 ? 'p1_high' : null,
    findings,
    metrics: m
  };
}

export function buildOfficialCancelCommand(qitemId) {
  if (!SAFE_QITEM_ID_RE.test(text(qitemId))) {
    throw new TypeError(`Unsafe qitemId: ${String(qitemId)}`);
  }
  return `rig queue update ${qitemId} --state done --closure-reason canceled --resolution "Control-plane hygiene cleanup via RigCommander Crash-Cart" --json`;
}

/**
 * Pure 2-step Hygiene Crash-Cart plan builder.
 * Generates official `rig queue update ...` previews (never raw SQLite mutations),
 * per-rig stale/detached/blocked counts, file sizes, optional daemon.log rotation metadata,
 * and an explicit `crossRigWarning` when 1-rig scoping leaves other rigs driving the storm.
 */
export function buildHygienePlan(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid hygiene plan input');
  }
  const scope = input.scope ?? 'fleet';
  if (scope !== 'fleet' && scope !== 'rig') {
    throw new TypeError('Invalid hygiene scope');
  }
  const rawTarget = input.targetRig ?? input.rigId ?? input.target ?? null;
  const targetRig = scope === 'rig' ? text(rawTarget) : null;
  if (scope === 'rig' && !SAFE_RIG_NAME_RE.test(targetRig)) {
    throw new TypeError('Invalid targetRig');
  }
  if (scope === 'fleet' && rawTarget != null && rawTarget !== '' && rawTarget !== 'all') {
    throw new TypeError('Fleet hygiene scope must not specify targetRig');
  }

  const cutoffHours = input.cutoffHours === undefined ? 24 : Number(input.cutoffHours);
  if (!SAFE_HYGIENE_CUTOFFS_HOURS.includes(cutoffHours)) {
    throw new TypeError('cutoffHours must be one of 24, 72, 168');
  }

  const includeDetachedTargets = input.includeDetachedTargets === undefined ? true : Boolean(input.includeDetachedTargets);
  const includeOldBlocked = input.includeOldBlocked === undefined ? false : Boolean(input.includeOldBlocked);
  const rotateDaemonLog = Boolean(input.rotateDaemonLog);
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();

  const cp = input.controlPlane && typeof input.controlPlane === 'object' ? input.controlPlane : null;
  const hasActiveQueue = Array.isArray(input.activeQueue);
  const summarized = hasActiveQueue
    ? summarizeQueueAndSeats({ activeQueue: input.activeQueue, nodes: input.nodes || [], nowMs, cutoffHours })
    : null;

  const queueSummary = summarized ? summarized.queue : (cp?.queue || {});
  const byRigRaw = queueSummary.byRig && typeof queueSummary.byRig === 'object' ? queueSummary.byRig : {};

  // Build normalized per-rig summary (always include full fleet breakdown for cross-rig transparency)
  const byRig = Object.create(null);
  const rigEntries = Object.entries(byRigRaw).sort(([a], [b]) => cmp(a, b));
  for (const [rigName, rawStats] of rigEntries) {
    const staleForCutoff =
      cutoffHours === 168
        ? nonNegNum(rawStats.opgateOlderThan168h, 0)
        : cutoffHours === 72
          ? nonNegNum(rawStats.opgateOlderThan72h, 0)
          : nonNegNum(rawStats.opgateOlderThan24h, 0);
    byRig[rigName] = {
      rigId: rigName,
      opgateTotal: nonNegNum(rawStats.opgateTotal, 0),
      staleOpgateCount: staleForCutoff,
      opgateOlderThan24h: nonNegNum(rawStats.opgateOlderThan24h, 0),
      opgateOlderThan72h: nonNegNum(rawStats.opgateOlderThan72h, 0),
      opgateOlderThan168h: nonNegNum(rawStats.opgateOlderThan168h, 0),
      detachedTargetCount: nonNegNum(rawStats.detachedTargetCount, 0),
      oldBlockedCount: nonNegNum(rawStats.oldBlockedCount, 0),
      detachedSeats: list(rawStats.detachedSeats).slice(0, 32)
    };
  }

  // Select target qitem IDs within scope
  const matchedIds = [];
  let scopedStaleOpgate = 0;
  let scopedDetachedTarget = 0;
  let scopedOldBlocked = 0;
  let scopedOpgateTotal = 0;
  let scoped24h = 0;
  let scoped72h = 0;
  let scoped168h = 0;

  if (summarized) {
    for (const item of summarized.queue.items) {
      if (scope === 'rig' && item.rigId !== targetRig) continue;
      if (item.isOpgate) {
        scopedOpgateTotal++;
        if (item.ageHours > 24) scoped24h++;
        if (item.ageHours > 72) scoped72h++;
        if (item.ageHours > 168) scoped168h++;
        if (item.ageHours > cutoffHours) scopedStaleOpgate++;
      }
      if (item.isDetachedTarget) scopedDetachedTarget++;
      if (item.isOldBlocked) scopedOldBlocked++;

      const shouldClean =
        (item.isOpgate && item.ageHours > cutoffHours) ||
        (includeDetachedTargets && item.isDetachedTarget) ||
        (includeOldBlocked && item.isOldBlocked);

      if (shouldClean && SAFE_QITEM_ID_RE.test(item.qitemId)) {
        matchedIds.push(item.qitemId);
      }
    }
  } else {
    for (const [rigName, stats] of Object.entries(byRig)) {
      if (scope === 'rig' && rigName !== targetRig) continue;
      scopedOpgateTotal += stats.opgateTotal;
      scoped24h += stats.opgateOlderThan24h;
      scoped72h += stats.opgateOlderThan72h;
      scoped168h += stats.opgateOlderThan168h;
      scopedStaleOpgate += stats.staleOpgateCount;
      scopedDetachedTarget += stats.detachedTargetCount;
      scopedOldBlocked += stats.oldBlockedCount;
      for (const sid of list(byRigRaw[rigName]?.sampleQitemIds)) {
        if (SAFE_QITEM_ID_RE.test(sid)) matchedIds.push(sid);
      }
    }
  }

  const uniqueMatchedIds = [...new Set(matchedIds)];
  const targetQitemIds = uniqueMatchedIds.slice(0, MAX_PLAN_TARGET_IDS);
  const truncatedTargetCount = Math.max(0, uniqueMatchedIds.length - targetQitemIds.length);

  const daemonLogBytes = nonNegNum(cp?.files?.daemonLog?.bytes ?? input.daemonLogBytes, 0);
  const sqliteBytes = nonNegNum(cp?.files?.sqliteDb?.bytes ?? input.sqliteBytes, 0);
  const daemonLogExists = Boolean(cp?.files?.daemonLog?.exists ?? daemonLogBytes > 0);

  // Cross-rig warning when scoping cleanup to 1 rig leaves other rigs' qitem-opgate-* driving daemon CPU storm
  const otherRigs = scope === 'rig'
    ? Object.values(byRig).filter(r => r.rigId !== targetRig && (r.staleOpgateCount > 0 || r.opgateTotal > 0))
    : [];
  const otherStaleOpgateCount = otherRigs.reduce((sum, r) => sum + r.staleOpgateCount, 0);
  const otherOpgateTotal = otherRigs.reduce((sum, r) => sum + r.opgateTotal, 0);
  const crossRigWarning = otherRigs.length > 0
    ? `Scoping cleanup to "${targetRig}" will leave ${otherOpgateTotal} qitem-opgate-* item(s) (${otherStaleOpgateCount} > ${cutoffHours}h) across ${otherRigs.length} other rig(s) (${otherRigs.map(r => `${r.rigId}: ${r.opgateTotal}`).join(', ')}) driving the same OpenRig daemon stuckSweep CPU storm.`
    : null;

  const warnings = [];
  if (crossRigWarning) warnings.push(crossRigWarning);
  if (truncatedTargetCount > 0) {
    warnings.push(`Batch capped at ${MAX_PLAN_TARGET_IDS} items (${truncatedTargetCount} additional items remain for a follow-up cleanup).`);
  }
  if (rotateDaemonLog) {
    warnings.push('daemon.log rotation copies current log to a timestamped .bak archive (0600) and truncates in place without touching openrig.sqlite.');
  }

  const commandPreviews = targetQitemIds.slice(0, MAX_COMMAND_PREVIEWS).map(buildOfficialCancelCommand);
  if (targetQitemIds.length > MAX_COMMAND_PREVIEWS) {
    commandPreviews.push(`# ... +${targetQitemIds.length - MAX_COMMAND_PREVIEWS} more rig queue update commands`);
  }
  if (rotateDaemonLog) {
    commandPreviews.push('# safe copy-and-truncate rotation of ~/.openrig/daemon.log (preserves open daemon FD; never mutates openrig.sqlite)');
  }

  const commandPreview = commandPreviews.length > 0
    ? commandPreviews.join('\n')
    : '# No stale queue items or log rotation selected';

  return {
    scope,
    targetRig,
    cutoffHours,
    includeDetachedTargets,
    includeOldBlocked,
    rotateDaemonLog,
    daemonLogBytes,
    sqliteBytes,
    totals: {
      opgateTotal: scopedOpgateTotal,
      staleOpgateCount: scopedStaleOpgate,
      opgateOlderThan24h: scoped24h,
      opgateOlderThan72h: scoped72h,
      opgateOlderThan168h: scoped168h,
      detachedTargetCount: scopedDetachedTarget,
      oldBlockedCount: scopedOldBlocked,
      targetCount: targetQitemIds.length
    },
    fleetTotals: {
      opgateTotal: nonNegNum(queueSummary.opgateTotal, scopedOpgateTotal),
      opgateOlderThan24h: nonNegNum(queueSummary.opgateOlderThan24h, scoped24h),
      opgateOlderThan72h: nonNegNum(queueSummary.opgateOlderThan72h, scoped72h),
      opgateOlderThan168h: nonNegNum(queueSummary.opgateOlderThan168h, scoped168h),
      detachedTargetCount: nonNegNum(queueSummary.detachedTargetCount, scopedDetachedTarget),
      oldBlockedCount: nonNegNum(queueSummary.oldBlockedCount, scopedOldBlocked)
    },
    byRig,
    crossRigWarning,
    crossRigBreakdown: {
      otherRigCount: otherRigs.length,
      otherStaleOpgateCount,
      otherOpgateTotal,
      otherRigs: otherRigs.map(r => ({
        rigId: r.rigId,
        staleOpgateCount: r.staleOpgateCount,
        opgateTotal: r.opgateTotal
      }))
    },
    warnings,
    targetQitemIds,
    truncatedTargetCount,
    commandPreviews,
    commandPreview,
    daemonLogRotation: {
      requested: rotateDaemonLog,
      eligible: daemonLogExists && daemonLogBytes > 0,
      currentBytes: daemonLogBytes,
      method: 'copy_and_truncate',
      backupNote: 'Copies daemon.log to a timestamped .bak archive (mode 0600) and truncates daemon.log in place so the running OpenRig daemon retains its file descriptor.'
    },
    requiresConfirmation: true
  };
}
