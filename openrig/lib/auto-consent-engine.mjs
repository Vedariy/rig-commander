/**
 * AutoConsentEngine — Zero-dependency, fail-closed Scoped Opt-In Auto-Consent Runtime (ADR-0019).
 *
 * - Persists Global/Project/Agent policies atomically (0600 file, 0700 dir) in
 *   `--state-dir` / `RIGCOMMANDER_STATE_DIR` or `~/.config/rig-commander/auto-consent.json`.
 * - Keeps Ephemeral Session Grants strictly RAM-only (never written to disk, auto-pruned on expiry).
 * - Computes cryptographic SHA-256 `promptHash` over normalized screen tail + command preview + options.
 * - Schedules cancellable Grace-Window timers (default 3000ms) with single-flight dispatch guards.
 * - Performs fresh TOCTOU pre-dispatch screen re-capture & classifier re-verification right before
 *   any tmux write; aborts with `VETO_PROMPT_DRIFT` (0 tmux writes) on any drift, clear, pause,
 *   breaker trip, worktree conflict, epoch change, or context overheat.
 * - Dispatches strictly `1 Enter` (Option 1 / Allow Once — NEVER Option 2/3 "Always allow").
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_CONSENT_LIMITS,
  AUTO_CONSENT_MODES,
  AUTO_CONSENT_PROFILES,
  AUTO_CONSENT_VETO_CODES,
  DEFAULT_AUTO_CONSENT_CONFIG,
  sanitizeAutoConsentConfig,
  createSessionGrant as buildDomainSessionGrant,
  isSessionGrantValid,
  resolveEffectiveConsentPolicy,
  evaluateAutoConsentPrompt,
  normalizeCommandText,
  summarizeActiveAutoConsentScopes
} from '../assets/domain/auto-consent-model.js';
import { detectLiveHitlPrompt, getLiveHitlOptions } from '../assets/domain/prompt-parser.js';
import { SAFE_RIG_NAME_RE, SAFE_SEAT_ID_RE } from '../assets/domain/resilience-model.js';
import { stripAnsiAndRedact } from './ai-evaluator/redactor.mjs';

const MAX_RECENT_RUNS = 40;
const MAX_CANCELED_HASHES = 500;
const MAX_OBSERVED_KEYS = 400;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROJECT_PROFILES = new Set(['off', 'manual_only', 'safe_readonly', 'trusted_dev']);
const SEAT_PROFILES = new Set(['inherit', 'off', 'manual_only', 'safe_readonly', 'trusted_dev']);
const SESSION_PROFILES = new Set(['safe_readonly', 'trusted_dev', 'sprint_all']);
const SAFE_GRANT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_PENDING_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function parseStrictFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stripAnsiAndControls(text) {
  return String(text || '')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

function redactSafe(str, maxLen = 200) {
  const raw = String(str || '').trim();
  if (!raw) return '';
  const { text } = stripAnsiAndRedact(raw, { redactPaths: true });
  const clean = text.replace(/[\r\n]+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > maxLen ? chars.slice(0, maxLen - 1).join('') + '…' : clean;
}

function inferRigIdFromSeat(seatId) {
  const s = String(seatId || '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at >= s.length - 1) return '';
  const rig = s.slice(at + 1);
  return SAFE_RIG_NAME_RE.test(rig) ? rig : '';
}

function boundedSet(map, key, val, maxSize) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, val);
}

export function resolveDefaultAutoConsentPath(stateDir = '') {
  const explicitDir = String(stateDir || process.env.RIGCOMMANDER_STATE_DIR || '').trim();
  if (explicitDir) {
    return path.join(path.resolve(explicitDir), 'auto-consent.json');
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.config', 'rig-commander', 'auto-consent.json');
}

/**
 * Derives a deterministic runtime session epoch from a live telemetry seat node.
 */
export function deriveSeatSessionEpoch(seat) {
  if (!seat || typeof seat !== 'object') return '';
  if (seat.seatSessionEpoch !== undefined && seat.seatSessionEpoch !== null && String(seat.seatSessionEpoch).trim()) {
    return String(seat.seatSessionEpoch).trim();
  }
  if (seat.sessionEpoch !== undefined && seat.sessionEpoch !== null && String(seat.sessionEpoch).trim()) {
    return String(seat.sessionEpoch).trim();
  }
  if (seat.sessionId !== undefined && seat.sessionId !== null && String(seat.sessionId).trim()) {
    return `sid:${String(seat.sessionId).trim()}`;
  }
  const pid = seat.tmuxPanePid ?? seat.panePid ?? seat.pid;
  if (pid !== undefined && pid !== null && String(pid).trim()) {
    return `pid:${String(pid).trim()}`;
  }
  const parts = [];
  if (seat.startedAt) parts.push(`start:${seat.startedAt}`);
  else if (seat.createdAt) parts.push(`created:${seat.createdAt}`);
  else if (seat.firstActivityAt) parts.push(`first:${seat.firstActivityAt}`);
  if (seat.contextUsage?.transcriptPath) parts.push(`tr:${seat.contextUsage.transcriptPath}`);
  if (parts.length > 0) {
    return 'ep:' + crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  }
  return '';
}

/**
 * Computes a cryptographic SHA-256 `promptHash` over normalized screen tail,
 * command preview, and parsed HITL options (TOCTOU verification anchor).
 */
export function computePromptHash(screenText = '', commandPreview = '', parsedOptions = []) {
  const cleanLines = stripAnsiAndControls(screenText)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-64);
  const normTail = cleanLines.join('\n');
  const normCmd = normalizeCommandText(commandPreview);
  const opts = Array.isArray(parsedOptions) ? parsedOptions : [];
  const normOpts = opts
    .map((o) => {
      if (!o || typeof o !== 'object') return '';
      const badge = String(o.badge ?? '').trim();
      const keyStroke = String(o.keyStroke ?? '').trim();
      const label = normalizeCommandText(o.fullText || o.shortLabel || '');
      return `${badge}:${keyStroke}:${label}`;
    })
    .filter(Boolean)
    .join('|');

  const payload = `tail=${normTail}\n---\ncmd=${normCmd}\n---\nopts=${normOpts}`;
  return 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
}

function validateOverridesObject(overrides, label = 'overrides') {
  if (overrides === undefined || overrides === null) return { ok: true };
  if (!isPlainObject(overrides)) return { ok: false, error: `${label} must be an object` };
  if (overrides.pauseOnCtxOverheat !== undefined && typeof overrides.pauseOnCtxOverheat !== 'boolean') {
    return { ok: false, error: `${label}.pauseOnCtxOverheat must be a boolean` };
  }
  if (overrides.allowPackageInstall !== undefined && typeof overrides.allowPackageInstall !== 'boolean') {
    return { ok: false, error: `${label}.allowPackageInstall must be a boolean` };
  }
  if (overrides.allowReadOnlyNetwork !== undefined && typeof overrides.allowReadOnlyNetwork !== 'boolean') {
    return { ok: false, error: `${label}.allowReadOnlyNetwork must be a boolean` };
  }
  if (overrides.ctxPauseThresholdPct !== undefined) {
    const n = parseStrictFiniteNumber(overrides.ctxPauseThresholdPct);
    if (n === null || n <= 0) {
      return { ok: false, error: `${label}.ctxPauseThresholdPct must be a positive number` };
    }
  }
  return { ok: true };
}

function validatePolicyPayload(rawBody) {
  if (!isPlainObject(rawBody)) {
    return { ok: false, error: 'Policy payload must be a JSON object' };
  }

  // Convenience scoped patch: { scope: 'project'|'seat', targetId, profile, overrides? }
  if (rawBody.scope !== undefined) {
    const scope = rawBody.scope;
    if (scope !== 'project' && scope !== 'seat') {
      return { ok: false, error: 'scope must be "project" or "seat"' };
    }
    if (typeof rawBody.targetId !== 'string') {
      return { ok: false, error: 'targetId must be a string' };
    }
    const targetId = rawBody.targetId.trim();
    const keyRe = scope === 'project' ? SAFE_RIG_NAME_RE : SAFE_SEAT_ID_RE;
    if (!targetId || FORBIDDEN_KEYS.has(targetId) || !keyRe.test(targetId)) {
      return { ok: false, error: `Invalid ${scope} targetId` };
    }
    const allowedProfiles = scope === 'project' ? PROJECT_PROFILES : SEAT_PROFILES;
    const hasProfile = rawBody.profile !== undefined;
    const hasOverrides = rawBody.overrides !== undefined;
    if (!hasProfile && !hasOverrides) {
      return { ok: false, error: `Missing profile or overrides for ${scope} scope` };
    }
    if (hasProfile && rawBody.profile !== null && (typeof rawBody.profile !== 'string' || !allowedProfiles.has(rawBody.profile))) {
      return { ok: false, error: `Invalid profile for ${scope} scope` };
    }
    const ovCheck = validateOverridesObject(rawBody.overrides, 'overrides');
    if (!ovCheck.ok) return ovCheck;

    const entry = rawBody.profile === null
      ? null
      : {
          ...(hasProfile ? { profile: rawBody.profile } : {}),
          ...(hasOverrides ? { overrides: rawBody.overrides } : {})
        };
    const patch = scope === 'project'
      ? { projects: { [targetId]: entry } }
      : { seats: { [targetId]: entry } };
    return { ok: true, patch };
  }

  // Unwrap optional `{ patch: { ... } }` envelope while also supporting direct config patch
  let patch = rawBody;
  if (Object.prototype.hasOwnProperty.call(rawBody, 'patch')) {
    if (!isPlainObject(rawBody.patch)) {
      return { ok: false, error: 'patch must be a JSON object' };
    }
    patch = rawBody.patch;
  }

  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' };
  }
  if (patch.masterPaused !== undefined && typeof patch.masterPaused !== 'boolean') {
    return { ok: false, error: 'masterPaused must be a boolean' };
  }
  if (patch.mode !== undefined && patch.mode !== AUTO_CONSENT_MODES.DRY_RUN && patch.mode !== AUTO_CONSENT_MODES.ARMED) {
    return { ok: false, error: 'mode must be "dry_run" or "armed"' };
  }
  for (const numField of ['graceWindowMs', 'maxActionsPerHour', 'maxPerSeatPer10m']) {
    if (patch[numField] !== undefined) {
      const n = parseStrictFiniteNumber(patch[numField]);
      if (n === null || n <= 0) {
        return { ok: false, error: `${numField} must be a positive number` };
      }
    }
  }
  if (patch.defaults !== undefined) {
    if (!isPlainObject(patch.defaults)) {
      return { ok: false, error: 'defaults must be an object' };
    }
    const defCheck = validateOverridesObject(patch.defaults, 'defaults');
    if (!defCheck.ok) return defCheck;
  }
  if (patch.projects !== undefined) {
    if (!isPlainObject(patch.projects)) {
      return { ok: false, error: 'projects must be an object map' };
    }
    for (const [k, v] of Object.entries(patch.projects)) {
      if (FORBIDDEN_KEYS.has(k) || !SAFE_RIG_NAME_RE.test(k)) {
        return { ok: false, error: `Invalid project key: ${k}` };
      }
      if (v === null) continue;
      if (!isPlainObject(v)) return { ok: false, error: `Invalid project entry for ${k}` };
      if (v.profile !== undefined && (typeof v.profile !== 'string' || !PROJECT_PROFILES.has(v.profile))) {
        return { ok: false, error: `Invalid project profile for ${k}` };
      }
      const ovCheck = validateOverridesObject(v.overrides, `projects.${k}.overrides`);
      if (!ovCheck.ok) return ovCheck;
    }
  }
  if (patch.seats !== undefined) {
    if (!isPlainObject(patch.seats)) {
      return { ok: false, error: 'seats must be an object map' };
    }
    for (const [k, v] of Object.entries(patch.seats)) {
      if (FORBIDDEN_KEYS.has(k) || !SAFE_SEAT_ID_RE.test(k)) {
        return { ok: false, error: `Invalid seat key: ${k}` };
      }
      if (v === null) continue;
      if (!isPlainObject(v)) return { ok: false, error: `Invalid seat entry for ${k}` };
      if (v.profile !== undefined && (typeof v.profile !== 'string' || !SEAT_PROFILES.has(v.profile))) {
        return { ok: false, error: `Invalid seat profile for ${k}` };
      }
      const ovCheck = validateOverridesObject(v.overrides, `seats.${k}.overrides`);
      if (!ovCheck.ok) return ovCheck;
    }
  }

  return { ok: true, patch };
}

export class AutoConsentEngine {
  constructor(options = {}) {
    this.configPath = options.configPath === null
      ? null
      : (options.configPath || resolveDefaultAutoConsentPath(options.stateDir));

    this.captureSeatScreen = typeof options.captureSeatScreen === 'function' ? options.captureSeatScreen : null;
    this.dispatchOptionOne = typeof options.dispatchOptionOne === 'function' ? options.dispatchOptionOne : null;
    this.getLiveContext = typeof options.getLiveContext === 'function' ? options.getLiveContext : null;
    this.getSeatSessionEpoch = typeof options.getSeatSessionEpoch === 'function' ? options.getSeatSessionEpoch : null;
    this.actionAudit = options.actionAudit || null;
    this.shiftHistory = options.shiftHistory || null;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
    this.clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : (id) => clearTimeout(id);

    this.config = this._loadConfig(options.initialConfig);
    this.sessionGrants = new Map(); // RAM-only! Never persisted to disk.
    this.pendingBySeat = new Map(); // seatId -> PendingApproval internal record (timer armed)
    this.inFlightPendingBySeat = new Map(); // seatId -> PendingApproval currently in TOCTOU capture/dispatch
    this.inFlightSeats = new Set(); // single-flight dispatch lock per seat
    this.observingSeats = new Set(); // single-flight observe lock per seat
    this.reservedFleetDispatches = 0; // atomic synchronous reservation count during async dispatch
    this.reservedByGrantId = new Map(); // grantId -> in-flight dispatch reservation count
    this.canceledPromptHashes = new Map(); // `${seatId}::${promptHash}` -> tsMs
    this.observedOutcomeKeys = new Map(); // dedup key for escalations / dry_run
    this.approvalHistory = []; // sliding 1h history of actual approved dispatches
    this.recentRuns = []; // newest first, bounded MAX_RECENT_RUNS
    this.stats = {
      approvedCount: 0,
      escalatedCount: 0,
      canceledCount: 0
    };
  }

  _loadConfig(initialConfig) {
    let base = sanitizeAutoConsentConfig(initialConfig || {}, DEFAULT_AUTO_CONSENT_CONFIG);
    if (!this.configPath) return base;
    try {
      if (fs.existsSync(this.configPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        // Never hydrate sessionGrants from disk even if file was tampered with externally
        if (parsed && typeof parsed === 'object') {
          const { sessionGrants: _ignored, ...safeDisk } = parsed;
          base = sanitizeAutoConsentConfig(safeDisk, base);
        }
      }
    } catch {
      // Fail-closed: corrupt config falls back to safe defaults
    }
    return base;
  }

  _persistConfig() {
    if (!this.configPath) return;
    try {
      const dir = path.dirname(this.configPath);
      const dirExisted = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!dirExisted) {
        try { fs.chmodSync(dir, 0o700); } catch {}
      }
      const sanitized = sanitizeAutoConsentConfig({}, this.config);
      const tmp = `${this.configPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2) + '\n', { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, this.configPath);
      try { fs.chmodSync(this.configPath, 0o600); } catch {}
    } catch {
      // Non-fatal persistence failure (e.g. read-only FS)
    }
  }

  _emit(eventName, payload, rigId = 'all') {
    if (!this.onEvent) return;
    try {
      this.onEvent(eventName, payload, rigId);
    } catch {
      // Non-fatal subscriber error
    }
  }

  _pruneApprovalHistory(nowMs = this.now()) {
    const cutoff = nowMs - AUTO_CONSENT_LIMITS.HOURLY_WINDOW_MS;
    while (this.approvalHistory.length > 0 && this.approvalHistory[0].timestampMs < cutoff) {
      this.approvalHistory.shift();
    }
  }

  _pruneSessionGrants(nowMs = this.now()) {
    for (const [grantId, grant] of this.sessionGrants.entries()) {
      if (!grant || grant.revoked === true) {
        this.sessionGrants.delete(grantId);
        continue;
      }
      const createdAtMs = Number(grant.createdAtMs);
      const rawExp = Number(grant.expiresAtMs);
      if (!Number.isFinite(createdAtMs) || !Number.isFinite(rawExp) || rawExp <= createdAtMs) {
        this.sessionGrants.delete(grantId);
        continue;
      }
      const effExp = Math.min(rawExp, createdAtMs + AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS);
      if (nowMs >= effExp) {
        this.sessionGrants.delete(grantId);
        continue;
      }
      const hardCap = grant.profile === AUTO_CONSENT_PROFILES.SPRINT_ALL
        ? AUTO_CONSENT_LIMITS.MAX_SPRINT_APPROVALS
        : AUTO_CONSENT_LIMITS.MAX_SESSION_APPROVALS;
      const effMax = Math.min(Math.floor(Number(grant.maxApprovals) || 0), hardCap);
      const used = Math.floor(Number(grant.usedApprovals) || 0);
      const reserved = this.reservedByGrantId.get(grantId) || 0;
      if (effMax <= 0 || (used >= effMax && reserved === 0)) {
        this.sessionGrants.delete(grantId);
      }
    }
  }

  _recordRun(entry) {
    this.recentRuns.unshift(entry);
    if (this.recentRuns.length > MAX_RECENT_RUNS) {
      this.recentRuns.length = MAX_RECENT_RUNS;
    }
  }

  _serializeGrant(grant, nowMs = this.now()) {
    const effExp = Math.min(
      Number(grant.expiresAtMs),
      Number(grant.createdAtMs) + AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS
    );
    const remainingMs = Math.max(0, effExp - nowMs);
    const hardCap = grant.profile === AUTO_CONSENT_PROFILES.SPRINT_ALL
      ? AUTO_CONSENT_LIMITS.MAX_SPRINT_APPROVALS
      : AUTO_CONSENT_LIMITS.MAX_SESSION_APPROVALS;
    const effectiveMax = Math.min(Math.floor(Number(grant.maxApprovals) || 0), hardCap);
    const usedApprovals = Math.max(0, Math.floor(Number(grant.usedApprovals) || 0));
    const reserved = this.reservedByGrantId.get(grant.grantId) || 0;
    const remainingApprovals = Math.max(0, effectiveMax - usedApprovals - reserved);
    const out = {
      grantId: grant.grantId,
      scope: grant.scope,
      targetId: grant.targetId,
      profile: grant.profile,
      createdAtMs: grant.createdAtMs,
      expiresAtMs: effExp,
      remainingMs,
      remainingMin: Math.max(1, Math.ceil(remainingMs / 60_000)),
      maxApprovals: effectiveMax,
      usedApprovals,
      remainingApprovals,
      seatSessionEpoch: grant.seatSessionEpoch || null
    };
    if (grant.overrides) out.overrides = { ...grant.overrides };
    return out;
  }

  _serializePending(pending) {
    return {
      id: pending.id,
      seatId: pending.seatId,
      rigId: pending.rigId,
      promptHash: pending.promptHash,
      commandPreview: pending.commandPreview,
      matchedProfile: pending.matchedProfile,
      sourceScope: pending.sourceScope,
      createdAtMs: pending.createdAtMs,
      fireAtMs: pending.fireAtMs,
      graceWindowMs: pending.graceWindowMs
    };
  }

  async _resolveSeatEpoch(seatId, seatNode = null, opts = {}) {
    const direct = deriveSeatSessionEpoch(seatNode);
    if (this.getSeatSessionEpoch) {
      try {
        const res = await this.getSeatSessionEpoch(seatId, seatNode, opts);
        if (res !== undefined && res !== null && String(res).trim()) {
          return String(res).trim();
        }
      } catch {
        // fallback to derived node epoch
      }
    }
    return direct;
  }

  isObservingActive(nowMs = this.now()) {
    if (this.config.masterPaused || !this.config.enabled) return false;
    this._pruneSessionGrants(nowMs);
    const summary = summarizeActiveAutoConsentScopes(this.config, this.sessionGrants, nowMs);
    return summary.hasActiveScopes || this.pendingBySeat.size > 0 || this.inFlightPendingBySeat.size > 0;
  }

  getConfig() {
    return sanitizeAutoConsentConfig({}, this.config);
  }

  getState(nowMs = this.now()) {
    this._pruneApprovalHistory(nowMs);
    this._pruneSessionGrants(nowMs);

    const activeGrants = Array.from(this.sessionGrants.values())
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((g) => this._serializeGrant(g, nowMs));

    const pendingApprovals = Array.from(this.pendingBySeat.values())
      .sort((a, b) => a.fireAtMs - b.fireAtMs)
      .map((p) => this._serializePending(p));

    const actionsLastHour = this.approvalHistory.length;
    const remainingHourlyQuota = Math.max(0, this.config.maxActionsPerHour - (actionsLastHour + this.reservedFleetDispatches));

    let status;
    if (this.config.masterPaused) {
      status = 'paused';
    } else if (!this.config.enabled) {
      status = 'disabled';
    } else if (this.config.mode === AUTO_CONSENT_MODES.DRY_RUN) {
      status = 'dry_run';
    } else if (remainingHourlyQuota === 0) {
      status = 'capped';
    } else {
      status = 'armed';
    }

    const activeSummary = summarizeActiveAutoConsentScopes(this.config, this.sessionGrants, nowMs);

    return {
      status,
      config: this.getConfig(),
      sessionGrants: activeGrants,
      pendingApprovals,
      recentRuns: this.recentRuns.slice(0, 25),
      stats: {
        approvedCount: this.stats.approvedCount,
        escalatedCount: this.stats.escalatedCount,
        canceledCount: this.stats.canceledCount,
        actionsLastHour,
        remainingHourlyQuota
      },
      activeSummary
    };
  }

  _abortPendingInternal(pending, {
    status = 'canceled',
    vetoCode = AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED,
    subVetoCode = null,
    reason = 'Canceled',
    recordCanceledHash = false,
    incrementCanceledStat = true,
    nowMs = this.now()
  } = {}) {
    pending.aborted = true;
    if (pending.timer) {
      this.clearTimeoutFn(pending.timer);
      pending.timer = null;
    }
    if (this.pendingBySeat.get(pending.seatId) === pending) {
      this.pendingBySeat.delete(pending.seatId);
    }
    if (this.inFlightPendingBySeat.get(pending.seatId) === pending) {
      this.inFlightPendingBySeat.delete(pending.seatId);
    }
    if (recordCanceledHash && pending.seatId && pending.promptHash) {
      boundedSet(this.canceledPromptHashes, `${pending.seatId}::${pending.promptHash}`, nowMs, MAX_CANCELED_HASHES);
    }
    if (incrementCanceledStat) {
      this.stats.canceledCount += 1;
    }

    const safeReason = redactSafe(reason, 220);
    const runEntry = {
      id: `ac-${nowMs.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      pendingId: pending.id,
      seatId: pending.seatId,
      rigId: pending.rigId,
      status,
      decision: 'escalate',
      vetoCode,
      ...(subVetoCode ? { subVetoCode } : {}),
      reason: safeReason,
      commandPreview: pending.commandPreview,
      promptHash: pending.promptHash,
      matchedProfile: pending.matchedProfile,
      sourceScope: pending.sourceScope,
      grantId: pending.grantId || null,
      keyStroke: null,
      execId: null,
      at: new Date(nowMs).toISOString(),
      tsMs: nowMs
    };
    this._recordRun(runEntry);
    this._emit('auto_consent_resolved', runEntry, pending.rigId || 'all');
    return runEntry;
  }

  _recheckPendingAgainstPolicy(nowMs = this.now()) {
    let aborted = 0;
    const allActive = new Set([
      ...this.pendingBySeat.values(),
      ...this.inFlightPendingBySeat.values()
    ]);
    for (const pending of allActive) {
      if (this.config.masterPaused || !this.config.enabled || this.config.mode !== AUTO_CONSENT_MODES.ARMED) {
        const veto = this.config.masterPaused
          ? AUTO_CONSENT_VETO_CODES.MASTER_PAUSED
          : AUTO_CONSENT_VETO_CODES.POLICY_OFF;
        this._abortPendingInternal(pending, {
          status: 'canceled',
          vetoCode: veto,
          reason: this.config.masterPaused
            ? 'Aborted because master pause was activated'
            : 'Aborted because auto-consent policy was disabled or switched to dry_run',
          recordCanceledHash: false,
          incrementCanceledStat: true,
          nowMs
        });
        aborted += 1;
        continue;
      }
      const eff = resolveEffectiveConsentPolicy(this.config, this.sessionGrants, {
        rigId: pending.rigId,
        seatId: pending.seatId,
        seatSessionEpoch: pending.expectedSeatSessionEpoch,
        nowMs
      });
      const grantLost = Boolean(pending.grantId && eff.grantId !== pending.grantId);
      const profileChanged = eff.profile !== pending.matchedProfile;
      if (!eff.active || grantLost || profileChanged) {
        this._abortPendingInternal(pending, {
          status: 'canceled',
          vetoCode: eff.vetoReason || AUTO_CONSENT_VETO_CODES.POLICY_OFF,
          reason: 'Aborted because scope policy or session grant was revoked/downgraded',
          recordCanceledHash: false,
          incrementCanceledStat: true,
          nowMs
        });
        aborted += 1;
      }
    }
    return aborted;
  }

  updatePolicy(rawBody = {}) {
    const check = validatePolicyPayload(rawBody);
    if (!check.ok) {
      return { ok: false, error: check.error };
    }
    const now = this.now();
    this.config = sanitizeAutoConsentConfig(check.patch, this.config);
    this._recheckPendingAgainstPolicy(now);
    this._persistConfig();
    const state = this.getState(now);
    this._emit('auto_consent_state', state, 'all');
    return { ok: true, state };
  }

  async createSessionGrant(rawBody = {}) {
    if (!isPlainObject(rawBody)) {
      return { ok: false, error: 'Session grant payload must be a JSON object' };
    }
    const now = this.now();
    this._pruneSessionGrants(now);

    const scope = rawBody.scope;
    if (scope !== 'rig' && scope !== 'seat') {
      return { ok: false, error: 'Invalid session grant scope (must be "rig" or "seat")' };
    }
    if (typeof rawBody.targetId !== 'string') {
      return { ok: false, error: 'targetId must be a string' };
    }
    const targetId = rawBody.targetId.trim();
    const targetRe = scope === 'rig' ? SAFE_RIG_NAME_RE : SAFE_SEAT_ID_RE;
    if (!targetId || FORBIDDEN_KEYS.has(targetId) || !targetRe.test(targetId)) {
      return { ok: false, error: `Invalid ${scope} targetId` };
    }
    const profile = rawBody.profile;
    if (typeof profile !== 'string' || !SESSION_PROFILES.has(profile)) {
      return { ok: false, error: 'Invalid session grant profile (must be safe_readonly, trusted_dev, or sprint_all)' };
    }

    // Strict cap enforcement (return 400 on invalid/over-cap instead of silently clamping)
    let ttlMs = AUTO_CONSENT_LIMITS.DEFAULT_SESSION_TTL_MS;
    if (rawBody.ttlMin !== undefined) {
      const m = parseStrictFiniteNumber(rawBody.ttlMin);
      const maxMin = Math.floor(AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS / 60_000);
      if (m === null || m < 1 || m > maxMin) {
        return { ok: false, error: `ttlMin must be between 1 and ${maxMin} (<= 2h)` };
      }
      ttlMs = Math.round(m * 60_000);
    }
    if (rawBody.ttlMs !== undefined) {
      const n = parseStrictFiniteNumber(rawBody.ttlMs);
      if (n === null || n < AUTO_CONSENT_LIMITS.MIN_SESSION_TTL_MS || n > AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS) {
        return {
          ok: false,
          error: `ttlMs must be between ${AUTO_CONSENT_LIMITS.MIN_SESSION_TTL_MS} and ${AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS}`
        };
      }
      ttlMs = Math.round(n);
    }

    const maxCap = profile === AUTO_CONSENT_PROFILES.SPRINT_ALL
      ? AUTO_CONSENT_LIMITS.MAX_SPRINT_APPROVALS
      : AUTO_CONSENT_LIMITS.MAX_SESSION_APPROVALS;
    let maxApprovals;
    if (rawBody.maxApprovals !== undefined) {
      const n = parseStrictFiniteNumber(rawBody.maxApprovals);
      if (n === null || !Number.isInteger(n) || n < 1 || n > maxCap) {
        return { ok: false, error: `maxApprovals must be an integer between 1 and ${maxCap}` };
      }
      maxApprovals = n;
    }

    const ovCheck = validateOverridesObject(rawBody.overrides, 'overrides');
    if (!ovCheck.ok) return ovCheck;

    let grantId = '';
    if (rawBody.grantId !== undefined && rawBody.grantId !== null && rawBody.grantId !== '') {
      if (typeof rawBody.grantId !== 'string' || !SAFE_GRANT_ID_RE.test(rawBody.grantId.trim()) || FORBIDDEN_KEYS.has(rawBody.grantId.trim())) {
        return { ok: false, error: 'Invalid grantId' };
      }
      grantId = rawBody.grantId.trim();
    } else {
      grantId = `grant-${scope}-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    }

    let resolvedEpoch = null;
    if (scope === 'seat') {
      if (rawBody.seatSessionEpoch !== undefined && rawBody.seatSessionEpoch !== null) {
        const explicit = String(rawBody.seatSessionEpoch).trim();
        if (!explicit) {
          return { ok: false, error: 'Seat-scoped session grants require a non-empty seatSessionEpoch' };
        }
        resolvedEpoch = explicit;
      } else {
        const liveEpoch = await this._resolveSeatEpoch(targetId, null, { fresh: true });
        if (!liveEpoch) {
          return { ok: false, error: 'Seat-scoped session grants require a non-empty seatSessionEpoch' };
        }
        resolvedEpoch = liveEpoch;
      }
    }

    const built = buildDomainSessionGrant({
      grantId,
      scope,
      targetId,
      profile,
      ttlMs,
      maxApprovals,
      seatSessionEpoch: resolvedEpoch,
      overrides: rawBody.overrides,
      nowMs: now
    });
    if (!built.ok) {
      return { ok: false, error: built.error };
    }

    // Store strictly in RAM Map — NEVER persisted to disk
    this.sessionGrants.set(built.grant.grantId, built.grant);
    const state = this.getState(now);
    const grant = this._serializeGrant(built.grant, now);
    this._emit('auto_consent_state', state, 'all');
    return { ok: true, grant, state };
  }

  revokeSessionGrant(rawBody = {}) {
    if (!isPlainObject(rawBody)) {
      return { ok: false, error: 'Revoke payload must be a JSON object' };
    }
    const now = this.now();
    this._pruneSessionGrants(now);

    const hasGrantId = rawBody.grantId !== undefined && rawBody.grantId !== null && rawBody.grantId !== '';
    const hasTarget = rawBody.scope !== undefined && rawBody.targetId !== undefined;
    if (!hasGrantId && !hasTarget) {
      return { ok: false, error: 'Revoke requires grantId or scope + targetId' };
    }

    let revokedCount = 0;
    if (hasGrantId) {
      if (typeof rawBody.grantId !== 'string' || !SAFE_GRANT_ID_RE.test(rawBody.grantId.trim())) {
        return { ok: false, error: 'Invalid grantId' };
      }
      const id = rawBody.grantId.trim();
      if (this.sessionGrants.delete(id)) {
        revokedCount += 1;
      }
    } else {
      if (rawBody.scope !== 'rig' && rawBody.scope !== 'seat') {
        return { ok: false, error: 'Invalid scope (must be "rig" or "seat")' };
      }
      if (typeof rawBody.targetId !== 'string') {
        return { ok: false, error: 'Invalid targetId' };
      }
      const targetId = rawBody.targetId.trim();
      const targetRe = rawBody.scope === 'rig' ? SAFE_RIG_NAME_RE : SAFE_SEAT_ID_RE;
      if (!targetId || !targetRe.test(targetId)) {
        return { ok: false, error: `Invalid ${rawBody.scope} targetId` };
      }
      for (const [id, g] of Array.from(this.sessionGrants.entries())) {
        if (g.scope === rawBody.scope && g.targetId === targetId) {
          this.sessionGrants.delete(id);
          revokedCount += 1;
        }
      }
    }

    this._recheckPendingAgainstPolicy(now);
    const state = this.getState(now);
    this._emit('auto_consent_state', state, 'all');
    return { ok: true, revoked: revokedCount > 0, revokedCount, state };
  }

  cancelPending(rawBody = {}) {
    if (rawBody !== undefined && rawBody !== null && !isPlainObject(rawBody)) {
      return { ok: false, error: 'Cancel payload must be a JSON object' };
    }
    const body = rawBody || {};
    const now = this.now();

    let pendingId = '';
    if (body.pendingId !== undefined && body.pendingId !== null && body.pendingId !== '') {
      if (typeof body.pendingId !== 'string' || !SAFE_PENDING_ID_RE.test(body.pendingId.trim())) {
        return { ok: false, error: 'Invalid pendingId' };
      }
      pendingId = body.pendingId.trim();
    }

    let seatId = '';
    if (body.seatId !== undefined && body.seatId !== null && body.seatId !== '') {
      if (typeof body.seatId !== 'string' || !SAFE_SEAT_ID_RE.test(body.seatId.trim())) {
        return { ok: false, error: 'Invalid seatId' };
      }
      seatId = body.seatId.trim();
    }

    const recordOperatorCancel = body.recordOperatorCancel !== false;
    const matches = [];
    const seen = new Set();
    for (const pending of [...this.pendingBySeat.values(), ...this.inFlightPendingBySeat.values()]) {
      if (seen.has(pending)) continue;
      if (pendingId && pending.id !== pendingId) continue;
      if (seatId && pending.seatId !== seatId) continue;
      seen.add(pending);
      matches.push(pending);
    }

    for (const pending of matches) {
      this._abortPendingInternal(pending, {
        status: 'canceled',
        vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED,
        reason: 'Operator canceled pending auto-consent during grace window',
        recordCanceledHash: recordOperatorCancel,
        incrementCanceledStat: true,
        nowMs: now
      });
    }

    const state = this.getState(now);
    if (matches.length > 0) {
      this._emit('auto_consent_state', state, 'all');
    }
    return { ok: true, canceledCount: matches.length, state };
  }

  pauseAll(paused = true) {
    if (typeof paused !== 'boolean') {
      return { ok: false, error: 'paused must be a boolean' };
    }
    const now = this.now();
    this.config = sanitizeAutoConsentConfig({ masterPaused: paused }, this.config);

    let canceledCount = 0;
    if (paused) {
      const allActive = new Set([
        ...this.pendingBySeat.values(),
        ...this.inFlightPendingBySeat.values()
      ]);
      for (const pending of allActive) {
        this._abortPendingInternal(pending, {
          status: 'canceled',
          vetoCode: AUTO_CONSENT_VETO_CODES.MASTER_PAUSED,
          reason: 'Aborted immediately by master kill-switch pause',
          recordCanceledHash: false,
          incrementCanceledStat: true,
          nowMs: now
        });
        canceledCount += 1;
      }
    }

    this._persistConfig();
    const state = this.getState(now);
    this._emit('auto_consent_state', state, 'all');
    return { ok: true, paused, canceledCount, state };
  }

  /**
   * Reconciles active seat display states from telemetry:
   * - Marks prior approval history entries as cleared once seat leaves `needs-input`.
   * - Aborts stale pending timers if the seat is no longer waiting for input.
   */
  reconcileSeatStates(nodes = [], nowMs = this.now()) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    const stateBySeat = new Map();
    for (const n of nodes) {
      const sid = n && (n.canonicalSessionName || n.seatId || n.id);
      if (!sid) continue;
      const disp = (n.activityState && n.activityState.display) || '';
      const needsCount = (n.activityState && n.activityState.needsInput && n.activityState.needsInput.count) || 0;
      const isNeedsInput = disp === 'needs-input' || needsCount > 0;
      stateBySeat.set(sid, isNeedsInput);
    }

    for (const rec of this.approvalHistory) {
      if (!rec.cleared && stateBySeat.has(rec.seatId) && stateBySeat.get(rec.seatId) === false) {
        rec.cleared = true;
      }
    }

    let changed = false;
    for (const pending of Array.from(this.pendingBySeat.values())) {
      if (stateBySeat.has(pending.seatId) && stateBySeat.get(pending.seatId) === false) {
        this._abortPendingInternal(pending, {
          status: 'drift_aborted',
          vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT,
          reason: 'Prompt cleared before grace window expired',
          recordCanceledHash: false,
          incrementCanceledStat: false,
          nowMs
        });
        changed = true;
      }
    }
    if (changed) {
      this._emit('auto_consent_state', this.getState(nowMs), 'all');
    }
  }

  /**
   * Observes a single active `needs-input` seat and either:
   * - ignores (inactive policy / already pending / operator-canceled hash),
   * - records a dry-run preview (0 writes),
   * - records an escalation (0 writes), or
   * - schedules a cancellable Grace-Window approval timer with TOCTOU verification.
   */
  async observeSeat({
    seat = null,
    seatId = '',
    rigId = '',
    screenText = null,
    breakerState = null,
    gitConflicts = null,
    seatSessionEpoch = null,
    nowMs = null
  } = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : this.now();
    const cleanSeatId = String(seatId || seat?.canonicalSessionName || seat?.seatId || seat?.id || '').trim();
    if (!cleanSeatId || !SAFE_SEAT_ID_RE.test(cleanSeatId)) {
      return { action: 'ignored', reason: 'invalid_seat' };
    }
    const cleanRigId = String(rigId || seat?.rigName || seat?.rigId || inferRigIdFromSeat(cleanSeatId)).trim();

    this._pruneApprovalHistory(now);
    this._pruneSessionGrants(now);

    if (this.config.masterPaused) {
      return { action: 'inactive', vetoCode: AUTO_CONSENT_VETO_CODES.MASTER_PAUSED };
    }
    if (!this.config.enabled) {
      return { action: 'inactive', vetoCode: AUTO_CONSENT_VETO_CODES.POLICY_OFF };
    }
    if (this.inFlightSeats.has(cleanSeatId) || this.observingSeats.has(cleanSeatId)) {
      return { action: 'in_flight' };
    }

    this.observingSeats.add(cleanSeatId);
    try {
      const epoch = seatSessionEpoch !== null && seatSessionEpoch !== undefined
        ? String(seatSessionEpoch).trim()
        : await this._resolveSeatEpoch(cleanSeatId, seat);

      const effectivePolicy = resolveEffectiveConsentPolicy(this.config, this.sessionGrants, {
        rigId: cleanRigId,
        seatId: cleanSeatId,
        seatSessionEpoch: epoch,
        nowMs: now
      });

      if (!effectivePolicy.active) {
        return { action: 'inactive', vetoCode: effectivePolicy.vetoReason || AUTO_CONSENT_VETO_CODES.POLICY_OFF };
      }

      let rawScreen = screenText;
      if (rawScreen === null || rawScreen === undefined) {
        if (!this.captureSeatScreen) {
          return { action: 'ignored', reason: 'no_capture_fn' };
        }
        rawScreen = await this.captureSeatScreen(cleanSeatId, 64);
      }
      rawScreen = typeof rawScreen === 'string' ? rawScreen : '';

      // Re-check pause after async capture
      if (this.config.masterPaused || !this.config.enabled) {
        return { action: 'inactive', vetoCode: AUTO_CONSENT_VETO_CODES.MASTER_PAUSED };
      }

      const hitl = detectLiveHitlPrompt(rawScreen);
      if (!hitl.blocked) {
        for (const rec of this.approvalHistory) {
          if (rec.seatId === cleanSeatId && !rec.cleared) rec.cleared = true;
        }
        const existingPending = this.pendingBySeat.get(cleanSeatId);
        if (existingPending) {
          this._abortPendingInternal(existingPending, {
            status: 'drift_aborted',
            vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT,
            reason: 'Prompt cleared before grace window expired',
            recordCanceledHash: false,
            incrementCanceledStat: false,
            nowMs: now
          });
          this._emit('auto_consent_state', this.getState(now), 'all');
        }
        return { action: 'no_prompt' };
      }

      const parsedOptions = getLiveHitlOptions(rawScreen);
      const seatObj = seat || { canonicalSessionName: cleanSeatId, rigId: cleanRigId };
      const evalRes = evaluateAutoConsentPrompt({
        screenText: rawScreen,
        parsedOptions,
        seat: seatObj,
        effectivePolicy,
        recentApprovals: this.approvalHistory,
        breakerState,
        gitConflicts,
        nowMs: now,
        config: this.config
      });

      const promptHash = computePromptHash(rawScreen, evalRes.normalizedCommand || evalRes.commandPreview, parsedOptions);
      const safePreview = redactSafe(evalRes.commandPreview || evalRes.normalizedCommand || '', 180);
      const safeReason = redactSafe(evalRes.reason || '', 220);

      // Mark older approvals for this seat as cleared if a distinct prompt is now visible
      for (const rec of this.approvalHistory) {
        if (rec.seatId === cleanSeatId && !rec.cleared && rec.promptFingerprint && rec.promptFingerprint !== evalRes.promptFingerprint) {
          rec.cleared = true;
        }
      }

      // Never re-arm a promptHash explicitly canceled by the operator
      if (this.canceledPromptHashes.has(`${cleanSeatId}::${promptHash}`)) {
        return {
          action: 'skipped_canceled',
          vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED,
          promptHash
        };
      }

      // Check existing pending timer for this seat
      const existing = this.pendingBySeat.get(cleanSeatId);
      if (existing) {
        if (existing.promptHash === promptHash && evalRes.decision === 'approve_once') {
          return {
            action: 'already_pending',
            pending: this._serializePending(existing),
            evaluation: evalRes,
            promptHash
          };
        }
        // Prompt drifted or is now vetoed while pending -> abort old pending cleanly
        this._abortPendingInternal(existing, {
          status: 'drift_aborted',
          vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT,
          subVetoCode: evalRes.vetoCode || null,
          reason: existing.promptHash !== promptHash
            ? 'Prompt changed during grace window'
            : `Prompt became ineligible during grace window (${evalRes.vetoCode || evalRes.decision})`,
          recordCanceledHash: false,
          incrementCanceledStat: false,
          nowMs: now
        });
      }

      if (evalRes.decision === 'escalate') {
        const dedupKey = `esc:${cleanSeatId}:${promptHash}:${evalRes.vetoCode || ''}`;
        if (!this.observedOutcomeKeys.has(dedupKey)) {
          boundedSet(this.observedOutcomeKeys, dedupKey, now, MAX_OBSERVED_KEYS);
          this.stats.escalatedCount += 1;
          const runEntry = {
            id: `ac-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
            seatId: cleanSeatId,
            rigId: cleanRigId,
            status: 'escalated',
            decision: 'escalate',
            vetoCode: evalRes.vetoCode,
            reason: safeReason,
            commandPreview: safePreview,
            promptHash,
            matchedProfile: evalRes.matchedProfile,
            sourceScope: evalRes.sourceScope,
            grantId: effectivePolicy.grantId || null,
            keyStroke: null,
            execId: null,
            at: new Date(now).toISOString(),
            tsMs: now
          };
          this._recordRun(runEntry);
          if (this.shiftHistory && ((evalRes.hardVetoes && evalRes.hardVetoes.length > 0) ||
            evalRes.vetoCode === AUTO_CONSENT_VETO_CODES.CTX_OVERHEAT ||
            evalRes.vetoCode === AUTO_CONSENT_VETO_CODES.RETRY_LOOP)) {
            this.shiftHistory.recordGuardrailEvent({
              severity: evalRes.hardVetoes && evalRes.hardVetoes.length > 0 ? 'critical' : 'warn',
              rigId: cleanRigId || 'all',
              seatId: cleanSeatId,
              key: `auto_consent_veto:${cleanSeatId}:${promptHash.slice(0, 18)}`,
              title: `Auto-Consent Escalated (${evalRes.vetoCode}) → ${cleanSeatId}`,
              detail: `${safeReason}${safePreview ? ` · ${safePreview}` : ''}`,
              meta: { vetoCode: evalRes.vetoCode, profile: evalRes.matchedProfile, sourceScope: evalRes.sourceScope }
            });
          }
          this._emit('auto_consent_resolved', runEntry, cleanRigId || 'all');
          this._emit('auto_consent_state', this.getState(now), 'all');
        }
        return { action: 'escalated', evaluation: evalRes, promptHash };
      }

      if (evalRes.decision === 'dry_run') {
        const dedupKey = `dry:${cleanSeatId}:${promptHash}`;
        if (!this.observedOutcomeKeys.has(dedupKey)) {
          boundedSet(this.observedOutcomeKeys, dedupKey, now, MAX_OBSERVED_KEYS);
          const runEntry = {
            id: `ac-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
            seatId: cleanSeatId,
            rigId: cleanRigId,
            status: 'dry_run',
            decision: 'dry_run',
            vetoCode: null,
            reason: safeReason,
            commandPreview: safePreview,
            promptHash,
            matchedProfile: evalRes.matchedProfile,
            sourceScope: evalRes.sourceScope,
            grantId: effectivePolicy.grantId || null,
            keyStroke: null,
            execId: null,
            at: new Date(now).toISOString(),
            tsMs: now
          };
          this._recordRun(runEntry);
          this._emit('auto_consent_resolved', runEntry, cleanRigId || 'all');
          this._emit('auto_consent_state', this.getState(now), 'all');
        }
        return { action: 'dry_run', evaluation: evalRes, promptHash };
      }

      // Eligible & Armed: strictly verify Option-1-Only keyStroke before arming grace timer
      if (evalRes.decision !== 'approve_once' || evalRes.keyStroke !== '1 Enter' || this.config.mode !== AUTO_CONSENT_MODES.ARMED) {
        return { action: 'escalated', evaluation: evalRes, promptHash };
      }

      const graceWindowMs = effectivePolicy.graceWindowMs || this.config.graceWindowMs || AUTO_CONSENT_LIMITS.DEFAULT_GRACE_MS;
      const pendingId = `ac-pend-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const pending = {
        id: pendingId,
        seatId: cleanSeatId,
        rigId: cleanRigId,
        promptHash,
        promptFingerprint: evalRes.promptFingerprint,
        commandPreview: safePreview,
        normalizedCommand: evalRes.normalizedCommand,
        matchedProfile: evalRes.matchedProfile,
        sourceScope: evalRes.sourceScope,
        grantId: effectivePolicy.grantId || null,
        expectedSeatSessionEpoch: epoch || null,
        observedSeat: seatObj,
        createdAtMs: now,
        fireAtMs: now + graceWindowMs,
        graceWindowMs,
        aborted: false,
        timer: null
      };

      pending.timer = this.setTimeoutFn(() => {
        void this._onGraceTimerExpired(pending);
      }, graceWindowMs);
      if (pending.timer && typeof pending.timer.unref === 'function') {
        pending.timer.unref();
      }

      this.pendingBySeat.set(cleanSeatId, pending);
      const serialized = this._serializePending(pending);
      this._emit('auto_consent_pending', serialized, cleanRigId || 'all');
      this._emit('auto_consent_state', this.getState(now), 'all');
      return { action: 'pending', pending: serialized, evaluation: evalRes, promptHash };
    } finally {
      this.observingSeats.delete(cleanSeatId);
    }
  }

  /**
   * TOCTOU Pre-Dispatch Verification & Strictly Option-1 (`1 Enter`) Execution.
   * Re-captures live screen, recomputes SHA-256 `promptHash`, and re-runs `evaluateAutoConsentPrompt`.
   * Any drift, clear, master pause, breaker trip, worktree conflict, epoch change, or CTX overheat
   * aborts cleanly with `VETO_PROMPT_DRIFT` and ZERO tmux writes.
   */
  async _onGraceTimerExpired(pending) {
    if (!pending || pending.aborted) return { ok: false, aborted: true };
    if (this.pendingBySeat.get(pending.seatId) !== pending) return { ok: false, aborted: true };

    pending.timer = null;
    this.pendingBySeat.delete(pending.seatId);

    const now = this.now();
    if (this.inFlightSeats.has(pending.seatId)) {
      this._abortPendingInternal(pending, {
        status: 'drift_aborted',
        vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT,
        reason: 'Concurrent dispatch already in flight for seat — aborted (0 tmux writes)',
        recordCanceledHash: false,
        incrementCanceledStat: false,
        nowMs: now
      });
      this._emit('auto_consent_state', this.getState(now), 'all');
      return { ok: false, vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT };
    }

    this.inFlightSeats.add(pending.seatId);
    this.inFlightPendingBySeat.set(pending.seatId, pending);
    try {
      this._pruneApprovalHistory(now);
      this._pruneSessionGrants(now);

      const abortDrift = (reason, subVetoCode = null) => {
        const entry = this._abortPendingInternal(pending, {
          status: 'drift_aborted',
          vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT,
          subVetoCode,
          reason,
          recordCanceledHash: false,
          incrementCanceledStat: false,
          nowMs: this.now()
        });
        this._emit('auto_consent_state', this.getState(this.now()), 'all');
        return { ok: false, vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT, subVetoCode, entry };
      };

      if (pending.aborted || this.canceledPromptHashes.has(`${pending.seatId}::${pending.promptHash}`)) {
        return { ok: false, aborted: true, vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED };
      }

      if (this.config.masterPaused || !this.config.enabled || this.config.mode !== AUTO_CONSENT_MODES.ARMED) {
        return abortDrift(
          this.config.masterPaused
            ? 'TOCTOU abort: master pause active before dispatch (0 tmux writes)'
            : 'TOCTOU abort: auto-consent disabled or switched out of armed mode (0 tmux writes)',
          this.config.masterPaused ? AUTO_CONSENT_VETO_CODES.MASTER_PAUSED : AUTO_CONSENT_VETO_CODES.POLICY_OFF
        );
      }

      if (!this.captureSeatScreen) {
        return abortDrift('TOCTOU abort: screen capture unavailable (0 tmux writes)');
      }

      // 1. Perform fresh live screen capture & live telemetry context check
      let freshScreen = '';
      let liveCtx = {};
      try {
        const [scr, ctx] = await Promise.all([
          this.captureSeatScreen(pending.seatId, 64),
          this.getLiveContext ? this.getLiveContext(pending.seatId, pending.rigId) : Promise.resolve({})
        ]);
        freshScreen = typeof scr === 'string' ? scr : '';
        liveCtx = isPlainObject(ctx) ? ctx : {};
      } catch {
        return abortDrift('TOCTOU abort: fresh screen capture failed (0 tmux writes)');
      }

      // Re-check abort/cancel/pause immediately after awaits (guards cancel/pause mid-capture!)
      if (pending.aborted || this.canceledPromptHashes.has(`${pending.seatId}::${pending.promptHash}`)) {
        return { ok: false, aborted: true, vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED };
      }
      if (this.config.masterPaused || !this.config.enabled || this.config.mode !== AUTO_CONSENT_MODES.ARMED) {
        return abortDrift(
          'TOCTOU abort: master pause or policy disable occurred during fresh capture (0 tmux writes)',
          this.config.masterPaused ? AUTO_CONSENT_VETO_CODES.MASTER_PAUSED : AUTO_CONSENT_VETO_CODES.POLICY_OFF
        );
      }

      // 2. Verify live HITL prompt is still active
      const freshHitl = detectLiveHitlPrompt(freshScreen);
      if (!freshHitl.blocked) {
        return abortDrift('TOCTOU abort: HITL prompt cleared before dispatch (0 tmux writes)');
      }

      const freshOptions = getLiveHitlOptions(freshScreen);
      const liveSeat = liveCtx.seat || pending.observedSeat || { canonicalSessionName: pending.seatId, rigId: pending.rigId };
      let freshEpoch = '';
      if (liveCtx.seatSessionEpoch !== undefined) {
        freshEpoch = liveCtx.seatSessionEpoch ? String(liveCtx.seatSessionEpoch).trim() : '';
      } else if (this.getSeatSessionEpoch) {
        freshEpoch = await this._resolveSeatEpoch(pending.seatId, liveSeat, { fresh: true });
      } else if (liveCtx.seat) {
        freshEpoch = deriveSeatSessionEpoch(liveCtx.seat);
      } else {
        freshEpoch = pending.expectedSeatSessionEpoch || '';
      }

      // --- SYNCHRONOUS CRITICAL SECTION (zero awaits until quota reservation completes) ---
      if (pending.aborted || this.canceledPromptHashes.has(`${pending.seatId}::${pending.promptHash}`)) {
        return { ok: false, aborted: true, vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED };
      }

      const liveNow = this.now();
      this._pruneApprovalHistory(liveNow);
      this._pruneSessionGrants(liveNow);

      const freshPolicy = resolveEffectiveConsentPolicy(this.config, this.sessionGrants, {
        rigId: pending.rigId,
        seatId: pending.seatId,
        seatSessionEpoch: freshEpoch,
        nowMs: liveNow
      });

      const freshEval = evaluateAutoConsentPrompt({
        screenText: freshScreen,
        parsedOptions: freshOptions,
        seat: liveSeat,
        effectivePolicy: freshPolicy,
        recentApprovals: this.approvalHistory,
        breakerState: liveCtx.breakerState || null,
        gitConflicts: liveCtx.gitConflicts || null,
        nowMs: liveNow,
        config: this.config
      });

      const freshHash = computePromptHash(freshScreen, freshEval.normalizedCommand || freshEval.commandPreview, freshOptions);

      // 3. Enforce strict promptHash identity & re-classification verdict
      if (freshHash !== pending.promptHash) {
        return abortDrift('TOCTOU abort: live promptHash drifted during grace window (0 tmux writes)');
      }
      if (!freshPolicy.active || freshEval.decision !== 'approve_once' || freshEval.keyStroke !== '1 Enter') {
        return abortDrift(
          `TOCTOU abort: re-verification failed (${freshEval.vetoCode || freshPolicy.vetoReason || freshEval.decision}): ${freshEval.reason || ''}`,
          freshEval.vetoCode || freshPolicy.vetoReason || null
        );
      }

      // Final synchronous safety check right before quota reservation & tmux write
      if (pending.aborted || this.canceledPromptHashes.has(`${pending.seatId}::${pending.promptHash}`)) {
        return { ok: false, aborted: true, vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED };
      }
      if (this.config.masterPaused || !this.config.enabled || this.config.mode !== AUTO_CONSENT_MODES.ARMED) {
        return abortDrift('TOCTOU abort: paused before tmux write (0 tmux writes)', AUTO_CONSENT_VETO_CODES.MASTER_PAUSED);
      }

      if (!this.dispatchOptionOne) {
        return abortDrift('No Option-1 dispatcher bound (0 tmux writes)');
      }

      // Atomically check & reserve fleet hourly quota + session grant maxApprovals BEFORE async dispatch
      const fleetLimit = Number.isFinite(freshPolicy.maxActionsPerHour)
        ? freshPolicy.maxActionsPerHour
        : this.config.maxActionsPerHour;
      if (this.approvalHistory.length + this.reservedFleetDispatches >= fleetLimit) {
        return abortDrift(
          `TOCTOU abort: fleet hourly auto-consent cap (${fleetLimit}/h) reached (0 tmux writes)`,
          AUTO_CONSENT_VETO_CODES.RATE_CAP
        );
      }

      let reservedGrantId = null;
      if (freshPolicy.sourceScope === 'session' && freshPolicy.grantId) {
        const grant = this.sessionGrants.get(freshPolicy.grantId);
        const grantCheck = isSessionGrantValid(grant, {
          rigId: pending.rigId,
          seatId: pending.seatId,
          seatSessionEpoch: freshEpoch,
          nowMs: liveNow
        });
        const inFlightForGrant = grant ? (this.reservedByGrantId.get(grant.grantId) || 0) : 0;
        const availableForGrant = grantCheck.valid ? Math.max(0, grantCheck.remainingApprovals - inFlightForGrant) : 0;
        if (!grant || !grantCheck.valid || availableForGrant <= 0) {
          return abortDrift(
            `TOCTOU abort: session grant unavailable (${grantCheck.reason || AUTO_CONSENT_VETO_CODES.SESSION_EXHAUSTED}) (0 tmux writes)`,
            grantCheck.reason || AUTO_CONSENT_VETO_CODES.SESSION_EXHAUSTED
          );
        }
        this.reservedByGrantId.set(grant.grantId, inFlightForGrant + 1);
        reservedGrantId = grant.grantId;
      }

      this.reservedFleetDispatches += 1;
      // --- END SYNCHRONOUS CRITICAL SECTION ---

      // 4. Dispatch strictly `1 Enter` (Option 1 — NEVER Option 2/3 "Always allow")
      const safePreview = redactSafe(freshEval.commandPreview || pending.commandPreview || '', 180);
      let dispatchRes;
      let execOk = false;
      try {
        try {
          dispatchRes = await this.dispatchOptionOne({
            seatId: pending.seatId,
            rigId: pending.rigId,
            keyStroke: '1 Enter',
            actionId: 'answer_prompt_option',
            evalId: `auto_consent:${freshPolicy.profile}:${freshPolicy.sourceScope}`,
            pendingId: pending.id,
            commandPreview: safePreview,
            matchedProfile: freshPolicy.profile,
            sourceScope: freshPolicy.sourceScope,
            grantId: freshPolicy.grantId || null,
            promptHash: freshHash
          });
        } catch (err) {
          dispatchRes = { ok: false, error: err?.message || 'Dispatch error' };
        }

        execOk = Boolean(dispatchRes && dispatchRes.ok);
        const finishedMs = this.now();

        if (execOk) {
          this.stats.approvedCount += 1;
          this.approvalHistory.push({
            timestampMs: finishedMs,
            seatId: pending.seatId,
            promptFingerprint: freshEval.promptFingerprint,
            promptHash: freshHash,
            normalizedCommand: freshEval.normalizedCommand,
            commandPreview: safePreview,
            cleared: false
          });
          if (reservedGrantId) {
            const grant = this.sessionGrants.get(reservedGrantId);
            if (grant) {
              grant.usedApprovals = (Number(grant.usedApprovals) || 0) + 1;
            }
          }
        }
      } finally {
        if (reservedGrantId) {
          const nextRes = (this.reservedByGrantId.get(reservedGrantId) || 1) - 1;
          if (nextRes <= 0) this.reservedByGrantId.delete(reservedGrantId);
          else this.reservedByGrantId.set(reservedGrantId, nextRes);
        }
        this.reservedFleetDispatches = Math.max(0, this.reservedFleetDispatches - 1);
        if (execOk && reservedGrantId) {
          this._pruneSessionGrants(this.now());
        }
      }

      const finishedMs = this.now();
      let execId = dispatchRes?.execId || null;

      if (!execOk && dispatchRes?.deduplicated) {
        return abortDrift(
          `TOCTOU abort: ${redactSafe(dispatchRes.error || 'single-flight deduplicated', 160)} (0 tmux writes)`
        );
      }

      // Record redacted audit entry if dispatcher did not already record one
      if (this.actionAudit && !dispatchRes?.auditRecorded) {
        const rec = this.actionAudit.record({
          actionId: 'answer_prompt_option',
          evalId: `auto_consent:${freshPolicy.profile}:${freshPolicy.sourceScope}`,
          seatId: pending.seatId,
          type: 'auto_consent',
          payload: redactSafe(`1 Enter (${safePreview || 'permission'})`, 120),
          httpStatus: execOk ? 200 : 502,
          ok: execOk,
          nowMs: finishedMs
        });
        execId = execId || rec.execId;
      }

      if (this.shiftHistory && !dispatchRes?.shiftRecorded) {
        this.shiftHistory.recordGuardrailEvent({
          severity: execOk ? 'info' : 'warn',
          rigId: pending.rigId || 'all',
          seatId: pending.seatId,
          key: `auto_consent:${pending.seatId}:${freshHash.slice(0, 18)}:${finishedMs}`,
          title: `Auto-Consent (${freshPolicy.profile}/${freshPolicy.sourceScope}) → ${pending.seatId}`,
          detail: execOk
            ? `Dispatched 1 Enter: ${safePreview || 'permission prompt'}`
            : `Dispatch failed: ${redactSafe(dispatchRes?.error || 'error', 140)}`,
          meta: {
            profile: freshPolicy.profile,
            sourceScope: freshPolicy.sourceScope,
            grantId: freshPolicy.grantId || null,
            promptHash: freshHash.slice(0, 23),
            keyStroke: '1 Enter',
            execId
          }
        });
      }

      const runEntry = {
        id: `ac-${finishedMs.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
        pendingId: pending.id,
        seatId: pending.seatId,
        rigId: pending.rigId,
        status: execOk ? 'approved' : 'failed',
        decision: 'approve_once',
        vetoCode: null,
        reason: execOk
          ? redactSafe(freshEval.reason || `Approved Option 1 via ${freshPolicy.profile} (${freshPolicy.sourceScope})`, 220)
          : redactSafe(dispatchRes?.error || 'Dispatch failed', 220),
        commandPreview: safePreview,
        promptHash: freshHash,
        matchedProfile: freshPolicy.profile,
        sourceScope: freshPolicy.sourceScope,
        grantId: freshPolicy.grantId || null,
        keyStroke: execOk ? '1 Enter' : null,
        execId,
        at: new Date(finishedMs).toISOString(),
        tsMs: finishedMs
      };
      this._recordRun(runEntry);
      this._emit('auto_consent_resolved', runEntry, pending.rigId || 'all');
      this._emit('auto_consent_state', this.getState(finishedMs), 'all');
      return { ok: execOk, entry: runEntry };
    } finally {
      if (this.inFlightPendingBySeat.get(pending.seatId) === pending) {
        this.inFlightPendingBySeat.delete(pending.seatId);
      }
      this.inFlightSeats.delete(pending.seatId);
    }
  }

  dispose() {
    for (const pending of [...this.pendingBySeat.values(), ...this.inFlightPendingBySeat.values()]) {
      pending.aborted = true;
      if (pending.timer) {
        this.clearTimeoutFn(pending.timer);
        pending.timer = null;
      }
    }
    this.pendingBySeat.clear();
    this.inFlightPendingBySeat.clear();
  }
}
