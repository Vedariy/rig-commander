/**
 * Read-only OpenRig Control-Plane Watchdog Probe.
 *
 * - Tracks bounded rolling OpenRig API probe latencies (avg, p95, consecutive slow probes).
 * - Stats daemon.log and openrig.sqlite under configurable openrigHome (ENOENT-safe).
 * - Performs bounded <= 32 KB tail reads on daemon.log cached by (mtimeMs, size) for 0% idle CPU.
 * - Inspects activeQueue & nodes for opgate age buckets, detached target seats, old blocked rows, and stale_runtime_hook.
 * - Strictly redacts os.homedir() -> '~' and strips secrets via SecretRedactor before returning telemetry.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripAnsiAndRedact } from './ai-evaluator/redactor.mjs';
import { CONTROL_PLANE_THRESHOLDS, summarizeQueueAndSeats } from '../assets/domain/control-plane-model.js';

export const MAX_LOG_TAIL_BYTES = 32 * 1024;
const MAX_LATENCY_SAMPLES = 60;
const MAX_GROWTH_SAMPLES = 30;
const MIN_GROWTH_WINDOW_MS = 60_000;
const MAX_GROWTH_WINDOW_MS = 3_600_000;

const NO_HUMAN_REGISTERED_RE = /cannot be admitted because no human is registered yet/i;
const PERMANENT_ROUTING_ERR_RE = /(?:cannot be admitted because no human is registered yet|no human is registered yet|permanent routing error|undeliverable routing)/i;
const STUCK_SWEEP_ERR_RE = /(?:stuckSweep.*(?:fail|error|exception|crash|panic|trip|abort|retry)|(?:fail|error|exception|crash).*stuckSweep)/i;
const CONSECUTIVE_FAIL_RE = /(?:"consecutiveFailures"\s*:\s*(\d+)|consecutiveFailures\s*[=:]\s*(\d+)|(\d+)\s+consecutive\s+failures|consecutive\s+failures\s*[=:]\s*(\d+))/i;
const FINDINGS_ROUTED_RE = /(?:"findingsRouted"\s*:\s*([\d,]+)|findingsRouted\s*[=:]\s*([\d,]+)|([\d,]+)\s+findings\s+routed)/i;

export function redactControlPlaneText(rawText, homeDir = os.homedir()) {
  let value = String(rawText || '');
  if (!value) return '';
  if (homeDir && homeDir !== '/' && homeDir.length > 1) {
    const cleanHome = homeDir.replace(/[\\/]+$/, '');
    if (cleanHome) {
      value = value.split(cleanHome).join('~');
    }
  }
  return stripAnsiAndRedact(value, { redactPaths: true }).text;
}

export function resolveDefaultOpenrigHome() {
  if (process.env.OPENRIG_HOME) return path.resolve(process.env.OPENRIG_HOME);
  return path.join(os.homedir(), '.openrig');
}

function parseTailLines(rawText, homeDir) {
  const lines = String(rawText || '').split(/\r?\n/);
  let noHumanRegisteredCount = 0;
  let permanentRoutingErrorCount = 0;
  let stuckSweepCrashLoopLines = 0;
  let consecutiveFailures = 0;
  let findingsRoutedLast = null;
  let sampleError = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let matchedNotable = false;
    if (NO_HUMAN_REGISTERED_RE.test(trimmed)) {
      noHumanRegisteredCount++;
      permanentRoutingErrorCount++;
      matchedNotable = true;
    } else if (PERMANENT_ROUTING_ERR_RE.test(trimmed)) {
      permanentRoutingErrorCount++;
      matchedNotable = true;
    }

    if (STUCK_SWEEP_ERR_RE.test(trimmed)) {
      stuckSweepCrashLoopLines++;
      matchedNotable = true;
    }

    const failMatch = trimmed.match(CONSECUTIVE_FAIL_RE);
    if (failMatch) {
      const n = Number(failMatch[1] || failMatch[2] || failMatch[3] || failMatch[4]);
      if (Number.isFinite(n) && n >= 0) {
        consecutiveFailures = Math.max(consecutiveFailures, n);
        matchedNotable = true;
      }
    }

    const routedMatch = trimmed.match(FINDINGS_ROUTED_RE);
    if (routedMatch) {
      const rawRouted = routedMatch[1] || routedMatch[2] || routedMatch[3];
      if (rawRouted) {
        const n = Number(rawRouted.replaceAll(',', ''));
        if (Number.isFinite(n) && n >= 0) {
          findingsRoutedLast = n;
        }
      }
    }

    if (matchedNotable) {
      sampleError = redactControlPlaneText(trimmed, homeDir).replace(/[\r\n]+/g, ' ').slice(0, 220);
    }
  }

  return {
    noHumanRegisteredCount,
    permanentRoutingErrorCount,
    stuckSweepCrashLoopLines,
    stuckSweepCrashLoop:
      stuckSweepCrashLoopLines >= CONTROL_PLANE_THRESHOLDS.stuckSweepCrashLoopLinesP1 ||
      noHumanRegisteredCount >= CONTROL_PLANE_THRESHOLDS.repeatedRoutingErrorsP1,
    consecutiveFailures,
    findingsRoutedLast,
    sampleError
  };
}

async function statFirstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return { path: candidate, stat };
    } catch {
      // ignore missing/inaccessible candidate
    }
  }
  return { path: candidates[0], stat: null };
}

export class ControlPlaneProbe {
  constructor({ maxSamples = MAX_LATENCY_SAMPLES, slowThresholdMs = CONTROL_PLANE_THRESHOLDS.latencyP0Ms, homeDir = os.homedir() } = {}) {
    this.maxSamples = Math.max(5, Number(maxSamples) || MAX_LATENCY_SAMPLES);
    this.slowThresholdMs = Number(slowThresholdMs) || CONTROL_PLANE_THRESHOLDS.latencyP0Ms;
    this.homeDir = homeDir;
    this.latencySamples = [];
    this.consecutiveSlowCount = 0;
    this.tailCache = new Map(); // filePath -> { mtimeMs, size, parsed, scannedBytes, truncatedToTail }
    this.logGrowthHistory = new Map(); // filePath -> [{ tsMs, bytes }]
  }

  reset() {
    this.latencySamples = [];
    this.consecutiveSlowCount = 0;
    this.tailCache.clear();
    this.logGrowthHistory.clear();
  }

  recordProbeLatency({ endpoint = '/api/rigs', durationMs, ok = true, tsMs = Date.now() } = {}) {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      return this.getLatencyStats();
    }
    const cleanTs = Number.isFinite(tsMs) ? tsMs : Date.now();
    const cleanOk = Boolean(ok);
    const sample = {
      endpoint: redactControlPlaneText(String(endpoint || '/api/rigs').slice(0, 120), this.homeDir),
      durationMs: Math.round(durationMs * 100) / 100,
      ok: cleanOk,
      tsMs: cleanTs
    };
    this.latencySamples.push(sample);
    if (this.latencySamples.length > this.maxSamples) {
      this.latencySamples.shift();
    }
    if (!cleanOk || sample.durationMs > this.slowThresholdMs) {
      this.consecutiveSlowCount++;
    } else {
      this.consecutiveSlowCount = 0;
    }
    return this.getLatencyStats();
  }

  getLatencyStats() {
    if (this.latencySamples.length === 0) {
      return {
        avgMs: null,
        p95Ms: null,
        lastMs: null,
        maxMs: null,
        sampleCount: 0,
        errorCount: 0,
        consecutiveSlowCount: 0,
        slowThresholdMs: this.slowThresholdMs,
        lastEndpoint: null,
        lastTsMs: null
      };
    }
    const durations = this.latencySamples.map(s => s.durationMs);
    const sum = durations.reduce((acc, v) => acc + v, 0);
    const sorted = durations.slice().sort((a, b) => a - b);
    const p95Idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    const latest = this.latencySamples[this.latencySamples.length - 1];
    return {
      avgMs: Math.round((sum / durations.length) * 100) / 100,
      p95Ms: sorted[p95Idx],
      lastMs: latest.durationMs,
      maxMs: sorted[sorted.length - 1],
      sampleCount: durations.length,
      errorCount: this.latencySamples.filter(s => !s.ok).length,
      consecutiveSlowCount: this.consecutiveSlowCount,
      slowThresholdMs: this.slowThresholdMs,
      lastEndpoint: latest.endpoint,
      lastTsMs: latest.tsMs
    };
  }

  _trackGrowthRate(filePath, bytes, nowMs) {
    let series = this.logGrowthHistory.get(filePath);
    if (!series) {
      series = [];
      this.logGrowthHistory.set(filePath, series);
    }
    const prev = series[series.length - 1];
    if (prev && bytes < prev.bytes) {
      // Log was truncated or rotated; reset growth baseline cleanly.
      series.length = 0;
    }
    if (!prev || nowMs > prev.tsMs || bytes !== prev.bytes) {
      series.push({ tsMs: nowMs, bytes });
      while (series.length > MAX_GROWTH_SAMPLES) series.shift();
    }
    const cutoff = nowMs - MAX_GROWTH_WINDOW_MS;
    while (series.length > 2 && series[0].tsMs < cutoff) {
      series.shift();
    }
    const base = series.find(pt => nowMs - pt.tsMs >= MIN_GROWTH_WINDOW_MS);
    if (!base) return null;
    const elapsedMs = nowMs - base.tsMs;
    if (elapsedMs < MIN_GROWTH_WINDOW_MS || bytes < base.bytes) return null;
    return Math.round(((bytes - base.bytes) / (elapsedMs / 3_600_000)) * 100) / 100;
  }

  async _readBoundedLogTail(logPath, stat) {
    if (!stat) {
      this.tailCache.delete(logPath);
      return {
        exists: false,
        scannedBytes: 0,
        truncatedToTail: false,
        cacheHit: false,
        noHumanRegisteredCount: 0,
        permanentRoutingErrorCount: 0,
        stuckSweepCrashLoopLines: 0,
        stuckSweepCrashLoop: false,
        consecutiveFailures: 0,
        findingsRoutedLast: null,
        sampleError: ''
      };
    }

    const cached = this.tailCache.get(logPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return {
        exists: true,
        scannedBytes: cached.scannedBytes,
        truncatedToTail: cached.truncatedToTail,
        cacheHit: true,
        ...cached.parsed
      };
    }

    const readBytes = Math.min(stat.size, MAX_LOG_TAIL_BYTES);
    const startOffset = Math.max(0, stat.size - readBytes);
    let rawTail = '';
    if (readBytes > 0) {
      let fh = null;
      try {
        fh = await fsp.open(logPath, 'r');
        const buf = Buffer.allocUnsafe(readBytes);
        let offset = 0;
        while (offset < readBytes) {
          const { bytesRead } = await fh.read(buf, offset, readBytes - offset, startOffset + offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        rawTail = buf.subarray(0, offset).toString('utf8');
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    }

    if (startOffset > 0) {
      const firstNl = rawTail.indexOf('\n');
      if (firstNl !== -1) rawTail = rawTail.slice(firstNl + 1);
    }

    const parsed = parseTailLines(rawTail, this.homeDir);
    const entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      scannedBytes: readBytes,
      truncatedToTail: startOffset > 0,
      parsed
    };
    this.tailCache.set(logPath, entry);
    if (this.tailCache.size > 16) {
      this.tailCache.delete(this.tailCache.keys().next().value);
    }

    return {
      exists: true,
      scannedBytes: readBytes,
      truncatedToTail: startOffset > 0,
      cacheHit: false,
      ...parsed
    };
  }

  async _probeHealthz({ daemonUrl, fetchFn, nowMs }) {
    if (!daemonUrl || typeof fetchFn !== 'function') return null;
    const started = Date.now();
    try {
      const res = await fetchFn(`${daemonUrl.replace(/\/+$/, '')}/healthz`, {
        signal: AbortSignal.timeout(1500)
      });
      const durationMs = Date.now() - started;
      this.recordProbeLatency({ endpoint: '/healthz', durationMs, ok: res.ok, tsMs: nowMs });
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      const sweepFailures = Number(
        payload?.stuckSweep?.consecutiveFailures ??
        payload?.stuckSweepConsecutiveFailures ??
        payload?.stuckSweepFailures ??
        0
      );
      const routed = Number(payload?.stuckSweep?.findingsRouted ?? payload?.findingsRouted);
      const statusText = String(payload?.status || (res.ok ? 'ok' : `http_${res.status}`)).toLowerCase();
      return {
        ok: Boolean(res.ok) && payload?.ok !== false && statusText !== 'unhealthy' && statusText !== 'down',
        status: statusText,
        unhealthy: !res.ok || payload?.ok === false || statusText === 'unhealthy' || statusText === 'down' || statusText === 'degraded',
        stuckSweepConsecutiveFailures: Number.isFinite(sweepFailures) ? sweepFailures : 0,
        findingsRouted: Number.isFinite(routed) ? routed : null,
        error: res.ok ? null : redactControlPlaneText(payload?.error || `HTTP ${res.status}`, this.homeDir)
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      this.recordProbeLatency({ endpoint: '/healthz', durationMs, ok: false, tsMs: nowMs });
      return {
        ok: false,
        status: 'unreachable',
        unhealthy: true,
        stuckSweepConsecutiveFailures: 0,
        findingsRouted: null,
        error: redactControlPlaneText(err?.message || 'healthz_failed', this.homeDir)
      };
    }
  }

  async probeControlPlane({
    openrigHome = resolveDefaultOpenrigHome(),
    activeQueue = [],
    nodes = [],
    nowMs = Date.now(),
    healthz = null,
    daemonUrl = null,
    fetchFn = null,
    probeHealthz = false
  } = {}) {
    const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    const resolvedHome = path.resolve(openrigHome || resolveDefaultOpenrigHome());

    const [logLookup, dbLookup] = await Promise.all([
      statFirstExisting([
        path.join(resolvedHome, 'daemon.log'),
        path.join(resolvedHome, 'logs', 'daemon.log')
      ]),
      statFirstExisting([
        path.join(resolvedHome, 'openrig.sqlite'),
        path.join(resolvedHome, 'db', 'openrig.sqlite')
      ])
    ]);

    const daemonLogBytes = logLookup.stat ? logLookup.stat.size : 0;
    const sqliteBytes = dbLookup.stat ? dbLookup.stat.size : 0;
    const growthBytesPerHour = logLookup.stat
      ? this._trackGrowthRate(logLookup.path, daemonLogBytes, safeNow)
      : null;

    const [logTail, liveHealthz] = await Promise.all([
      this._readBoundedLogTail(logLookup.path, logLookup.stat),
      healthz ? Promise.resolve(healthz) : (probeHealthz ? this._probeHealthz({ daemonUrl, fetchFn, nowMs: safeNow }) : Promise.resolve(null))
    ]);

    const { queue, seats } = summarizeQueueAndSeats({ activeQueue, nodes, nowMs: safeNow });
    const latency = this.getLatencyStats();

    const sweepFailures = Math.max(
      Number(liveHealthz?.stuckSweepConsecutiveFailures ?? liveHealthz?.stuckSweep?.consecutiveFailures ?? 0) || 0,
      Number(logTail.consecutiveFailures || 0)
    );
    const healthzFindings = liveHealthz?.findingsRouted ?? liveHealthz?.stuckSweep?.findingsRouted ?? null;
    const rawHealthzError = liveHealthz?.error ? redactControlPlaneText(liveHealthz.error, this.homeDir) : null;
    const healthzStatus = liveHealthz
      ? String(liveHealthz.status || (liveHealthz.ok === false ? 'unhealthy' : 'ok')).toLowerCase()
      : 'unknown';

    return {
      measuredAtMs: safeNow,
      openrigHomeLabel: redactControlPlaneText(resolvedHome, this.homeDir),
      latency,
      healthz: {
        ok: typeof liveHealthz?.ok === 'boolean' ? liveHealthz.ok : null,
        status: healthzStatus,
        unhealthy: Boolean(liveHealthz && (liveHealthz.unhealthy === true || liveHealthz.ok === false)),
        stuckSweepConsecutiveFailures: sweepFailures,
        findingsRouted: Number.isFinite(healthzFindings) ? healthzFindings : logTail.findingsRoutedLast,
        error: rawHealthzError
      },
      files: {
        daemonLog: {
          exists: Boolean(logLookup.stat),
          displayPath: redactControlPlaneText(logLookup.path, this.homeDir),
          bytes: daemonLogBytes,
          mtimeMs: logLookup.stat ? logLookup.stat.mtimeMs : null,
          growthBytesPerHour
        },
        sqliteDb: {
          exists: Boolean(dbLookup.stat),
          displayPath: redactControlPlaneText(dbLookup.path, this.homeDir),
          bytes: sqliteBytes,
          mtimeMs: dbLookup.stat ? dbLookup.stat.mtimeMs : null
        }
      },
      logTail,
      queue,
      seats
    };
  }
}

const defaultProbe = new ControlPlaneProbe();

export function recordProbeLatency(sample) {
  return defaultProbe.recordProbeLatency(sample);
}

export function getProbeLatencyStats() {
  return defaultProbe.getLatencyStats();
}

export function resetControlPlaneProbe() {
  defaultProbe.reset();
}

export function probeControlPlane(options) {
  return defaultProbe.probeControlPlane(options);
}
