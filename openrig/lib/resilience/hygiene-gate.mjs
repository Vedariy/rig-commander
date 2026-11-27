import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PolicyError } from './policy-gate.mjs';
import { SAFE_RIG_NAME_RE } from '../../assets/domain/resilience-model.js';
import {
  buildHygienePlan,
  SAFE_HYGIENE_CUTOFFS_HOURS,
  SAFE_QITEM_ID_RE
} from '../../assets/domain/control-plane-model.js';
import {
  ControlPlaneProbe,
  redactControlPlaneText,
  resolveDefaultOpenrigHome
} from '../control-plane-probe.mjs';

const runFile = promisify(execFile);
const PLAN_TTL_MS = 300_000; // 5-minute TTL
const MAX_CACHED_PLANS = 64;
const CLEANUP_CONCURRENCY = 4;

const defaultExecCommand = (file, argv, options = {}) =>
  runFile(file, argv, { timeout: 15_000, maxBuffer: 5 * 1024 * 1024, ...options, shell: false });

async function runBounded(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: cap }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await worker(items[idx], idx);
      }
    })
  );
  return out;
}

async function resolveExistingDaemonLog(openrigHome) {
  const candidates = [
    path.join(openrigHome, 'daemon.log'),
    path.join(openrigHome, 'logs', 'daemon.log')
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fsp.lstat(candidate);
      return { path: candidate, stat };
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return { path: candidates[0], stat: null };
}

/**
 * Safe copy-and-truncate rotation (preserves open daemon FD without touching openrig.sqlite).
 */
async function rotateDaemonLogCopyAndTruncate({ openrigHome, nowMs, homeDir }) {
  try {
    const resolvedHome = path.resolve(openrigHome);
    const homeStat = await fsp.lstat(resolvedHome).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
    if (!homeStat) {
      return { attempted: true, status: 'skipped_missing', backupFile: null, beforeBytes: 0, afterBytes: 0 };
    }
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
      return { attempted: true, status: 'failed', error: 'unsafe_openrig_home', beforeBytes: 0, afterBytes: null };
    }

    const { path: logPath, stat } = await resolveExistingDaemonLog(resolvedHome);
    if (!stat) {
      return { attempted: true, status: 'skipped_missing', backupFile: null, beforeBytes: 0, afterBytes: 0 };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { attempted: true, status: 'failed', error: 'unsafe_daemon_log_symlink', beforeBytes: 0, afterBytes: null };
    }
    if (stat.size === 0) {
      return { attempted: true, status: 'skipped_empty', backupFile: null, beforeBytes: 0, afterBytes: 0 };
    }

    const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
    const suffix = randomUUID().slice(0, 6);
    const backupName = `daemon.log.${stamp}.${suffix}.bak`;
    const backupPath = path.join(path.dirname(logPath), backupName);

    await fsp.copyFile(logPath, backupPath, fsConstants.COPYFILE_EXCL);
    await fsp.chmod(backupPath, 0o600);

    const flags = fsConstants.O_RDWR | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);
    const fh = await fsp.open(logPath, flags);
    try {
      await fh.truncate(0);
      await fh.sync().catch(() => {});
    } finally {
      await fh.close();
    }

    return {
      attempted: true,
      status: 'rotated',
      backupFile: backupName,
      beforeBytes: stat.size,
      afterBytes: 0
    };
  } catch (err) {
    return {
      attempted: true,
      status: 'failed',
      error: redactControlPlaneText(err?.message || 'log_rotation_failed', homeDir).slice(0, 160),
      beforeBytes: null,
      afterBytes: null
    };
  }
}

export class HygienePolicyGate {
  constructor({
    now = Date.now,
    openrigHome = resolveDefaultOpenrigHome(),
    rigBin = 'rig',
    readOnly = false,
    probe = new ControlPlaneProbe(),
    getState = null,
    execCommand = defaultExecCommand,
    record = async () => {}
  } = {}) {
    this.now = now;
    this.openrigHome = path.resolve(openrigHome || resolveDefaultOpenrigHome());
    this.rigBin = rigBin;
    this.readOnly = Boolean(readOnly);
    this.probe = probe;
    this.getState = getState;
    this.execCommand = execCommand;
    this.record = record;
    this.plans = new Map();
    this.active = new Map();
  }

  resolveRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new PolicyError(400, 'invalid_hygiene_request');
    }
    const scope = input.scope === undefined ? 'fleet' : input.scope;
    if (scope !== 'fleet' && scope !== 'rig') {
      throw new PolicyError(400, 'invalid_target');
    }
    const rawTarget = input.targetRig ?? input.rigId ?? input.target ?? null;
    const targetRig = scope === 'rig' ? (typeof rawTarget === 'string' ? rawTarget : '') : null;
    if (scope === 'rig' && !SAFE_RIG_NAME_RE.test(targetRig)) {
      throw new PolicyError(400, 'invalid_target');
    }
    if (scope === 'fleet' && rawTarget != null && rawTarget !== '' && rawTarget !== 'all') {
      throw new PolicyError(400, 'invalid_target');
    }

    const cutoffHours = input.cutoffHours === undefined ? 24 : Number(input.cutoffHours);
    if (!SAFE_HYGIENE_CUTOFFS_HOURS.includes(cutoffHours)) {
      throw new PolicyError(400, 'invalid_cutoff_hours');
    }

    for (const flagName of ['rotateDaemonLog', 'includeDetachedTargets', 'includeOldBlocked']) {
      if (input[flagName] !== undefined && typeof input[flagName] !== 'boolean') {
        throw new PolicyError(400, 'invalid_hygiene_request');
      }
    }

    const rotateDaemonLog = Boolean(input.rotateDaemonLog ?? false);
    const includeDetachedTargets = Boolean(input.includeDetachedTargets ?? true);
    const includeOldBlocked = Boolean(input.includeOldBlocked ?? false);

    const request = {
      scope,
      targetRig,
      cutoffHours,
      rotateDaemonLog,
      includeDetachedTargets,
      includeOldBlocked
    };
    const key = JSON.stringify([
      scope,
      targetRig,
      cutoffHours,
      rotateDaemonLog,
      includeDetachedTargets,
      includeOldBlocked
    ]);
    return { request, key };
  }

  async _collectState({ fresh = false } = {}) {
    let raw = null;
    if (typeof this.getState === 'function') {
      raw = await this.getState({ fresh });
    }
    const activeQueue = Array.isArray(raw?.activeQueue) ? raw.activeQueue : [];
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const nowMs = this.now();
    const controlPlane = raw?.controlPlane && !fresh
      ? raw.controlPlane
      : await this.probe.probeControlPlane({
          openrigHome: this.openrigHome,
          activeQueue,
          nodes,
          nowMs,
          healthz: raw?.healthz || null
        });
    return { activeQueue, nodes, controlPlane, nowMs };
  }

  async createPlan(input = {}) {
    if (this.readOnly) throw new PolicyError(403, 'read_only_mode');
    const { request, key } = this.resolveRequest(input);
    const { activeQueue, nodes, controlPlane, nowMs } = await this._collectState({ fresh: true });
    const plan = buildHygienePlan({
      ...request,
      activeQueue,
      nodes,
      controlPlane,
      nowMs
    });
    const expires = nowMs + PLAN_TTL_MS;
    const planHash = createHash('sha256')
      .update(JSON.stringify([key, plan, expires, randomUUID()]))
      .digest('hex');

    this.plans.set(planHash, {
      key,
      plan,
      expires,
      beforeMeta: {
        latencyMs: controlPlane?.latency?.avgMs ?? null,
        daemonLogBytes: controlPlane?.files?.daemonLog?.bytes ?? plan.daemonLogBytes,
        sqliteBytes: controlPlane?.files?.sqliteDb?.bytes ?? plan.sqliteBytes,
        staleQueueCount: controlPlane?.queue?.opgateOlderThan24h ?? plan.totals?.opgateOlderThan24h ?? 0
      }
    });
    if (this.plans.size > MAX_CACHED_PLANS) {
      this.plans.delete(this.plans.keys().next().value);
    }
    return {
      plan,
      planHash,
      expiresAt: new Date(expires).toISOString()
    };
  }

  async executeHygiene(input = {}) {
    if (this.readOnly) throw new PolicyError(403, 'read_only_mode');
    const { request, key } = this.resolveRequest(input);
    if (input.confirmed !== true) {
      throw new PolicyError(400, 'plan_required_or_expired');
    }
    if (typeof input.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.planHash)) {
      throw new PolicyError(400, 'plan_required_or_expired');
    }

    const overlapsActive =
      this.active.has(key) ||
      (this.active.size > 0 && (
        request.scope === 'fleet' ||
        request.rotateDaemonLog ||
        [...this.active.values()].some(r => r.scope === 'fleet' || r.rotateDaemonLog)
      ));
    if (overlapsActive) {
      throw new PolicyError(409, 'in_progress');
    }

    const cached = this.plans.get(input.planHash);
    if (!cached || cached.key !== key || cached.expires <= this.now()) {
      throw new PolicyError(400, 'plan_required_or_expired');
    }

    // Consume single-use issuance immediately before executing side effects.
    this.plans.delete(input.planHash);
    this.active.set(key, request);

    try {
      let beforeState = null;
      try {
        beforeState = await this._collectState({ fresh: true });
      } catch {
        beforeState = null;
      }

      const before = {
        latencyMs: beforeState?.controlPlane?.latency?.avgMs ?? cached.beforeMeta.latencyMs ?? null,
        daemonLogBytes: beforeState?.controlPlane?.files?.daemonLog?.bytes ?? cached.beforeMeta.daemonLogBytes ?? 0,
        sqliteBytes: beforeState?.controlPlane?.files?.sqliteDb?.bytes ?? cached.beforeMeta.sqliteBytes ?? 0,
        staleQueueCount: beforeState?.controlPlane?.queue?.opgateOlderThan24h ?? cached.beforeMeta.staleQueueCount ?? 0
      };

      const targetIds = (cached.plan.targetQitemIds || []).filter(id => SAFE_QITEM_ID_RE.test(id));
      const cleanedIds = [];
      const failedItems = [];
      const unknownItems = [];

      await runBounded(targetIds, CLEANUP_CONCURRENCY, async qitemId => {
        const argv = [
          'queue',
          'update',
          qitemId,
          '--state',
          'done',
          '--closure-reason',
          'canceled',
          '--resolution',
          'Control-plane hygiene cleanup via RigCommander Crash-Cart',
          '--json'
        ];
        try {
          const result = await this.execCommand(this.rigBin, argv, {
            shell: false,
            timeout: 15_000,
            maxBuffer: 1024 * 1024
          });
          let parsed = null;
          if (typeof result?.stdout === 'string' && result.stdout.trim()) {
            try {
              parsed = JSON.parse(result.stdout);
            } catch {
              parsed = null;
            }
          }
          if (parsed && parsed.ok === false) {
            failedItems.push({
              qitemId,
              error: redactControlPlaneText(parsed.error || 'cli_rejected', this.probe?.homeDir).slice(0, 160)
            });
          } else {
            cleanedIds.push(qitemId);
          }
        } catch (err) {
          if (err?.killed || err?.signal || err?.code === 'ETIMEDOUT') {
            unknownItems.push({
              qitemId,
              error: redactControlPlaneText(err?.message || 'command_timed_out', this.probe?.homeDir).slice(0, 160)
            });
          } else {
            failedItems.push({
              qitemId,
              error: redactControlPlaneText(err?.stderr || err?.message || 'command_failed', this.probe?.homeDir).slice(0, 160)
            });
          }
        }
      });

      const rotateRequested = Boolean(cached.plan.daemonLogRotation?.requested);
      const logRotation = rotateRequested
        ? await rotateDaemonLogCopyAndTruncate({
            openrigHome: this.openrigHome,
            nowMs: this.now(),
            homeDir: this.probe?.homeDir
          })
        : { attempted: false, status: 'not_requested', backupFile: null };

      let afterState = null;
      try {
        afterState = await this._collectState({ fresh: true });
      } catch {
        afterState = null;
      }

      const after = {
        latencyMs: afterState?.controlPlane?.latency?.avgMs ?? null,
        daemonLogBytes: afterState?.controlPlane?.files?.daemonLog?.bytes ?? null,
        sqliteBytes: afterState?.controlPlane?.files?.sqliteDb?.bytes ?? null,
        remainingStaleQueueCount: afterState?.controlPlane?.queue?.opgateOlderThan24h ?? null
      };

      const targetCount = targetIds.length;
      const logFailed = rotateRequested && logRotation.status === 'failed';
      const logOk = !rotateRequested || !logFailed;
      let status;
      if (targetCount === 0 && !rotateRequested) {
        status = 'cleaned';
      } else if (unknownItems.length > 0 && cleanedIds.length === 0 && failedItems.length === 0) {
        status = 'unknown';
      } else if (
        (targetCount === 0 || (cleanedIds.length === targetCount && failedItems.length === 0 && unknownItems.length === 0)) &&
        logOk
      ) {
        status = 'cleaned';
      } else if (
        (targetCount === 0 || (cleanedIds.length === 0 && failedItems.length === targetCount)) &&
        (!rotateRequested || logFailed)
      ) {
        status = 'failed';
      } else {
        status = 'partial';
      }

      const receipt = {
        receiptId: `hyg-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        scope: request.scope,
        targetRig: request.targetRig,
        cutoffHours: request.cutoffHours,
        status,
        targetCount,
        cleanedCount: cleanedIds.length,
        failedCount: failedItems.length,
        unknownCount: unknownItems.length,
        cleanedIds: cleanedIds.slice(0, 100),
        failedItems: failedItems.slice(0, 25),
        unknownItems: unknownItems.slice(0, 25),
        logRotation,
        before,
        after,
        executedAt: new Date(this.now()).toISOString()
      };

      await this.record('hygiene', request, receipt);
      return receipt;
    } finally {
      this.active.delete(key);
    }
  }
}
