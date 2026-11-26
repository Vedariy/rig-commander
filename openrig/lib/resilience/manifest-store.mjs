import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { LocalFsVaultAdapter, assertValidStateVaultAdapter } from './vault-interface.mjs';
import { stripAnsiAndRedact } from '../ai-evaluator/redactor.mjs';
import { SAFE_RIG_NAME_RE, SAFE_SEAT_ID_RE, STATE_BUNDLE_SCHEMA_VERSION, isStateBundleEnvelope, mergeHostManifestEnvelopes, normalizeRestoreReceipt } from '../../assets/domain/resilience-model.js';

const hash = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const locks = new Map();
const adapterLocks = new WeakMap();
const secretKey = /secret|token|password|passwd|authorization|credential|api.?key|private.?key|\.env/i;
const cleanText = (value, max = 256) => stripAnsiAndRedact(typeof value === 'string' ? value : '', { redactPaths: true }).text.slice(0, max);
function scrub(value, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === 'string') return cleanText(value, 1024);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => scrub(item, depth + 1));
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 64).filter(([key]) => !secretKey.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, item]) => [cleanText(key, 64), scrub(item, depth + 1)]));
}
const bounded = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const idOf = rig => typeof rig === 'string' ? rig : rig?.rigId || rig?.rigName || rig?.name || rig?.id;
const validEnvelope = envelope => isStateBundleEnvelope(envelope) && envelope.contentSha256 === hash(envelope.payload);
const corruptRead = error => error instanceof SyntaxError || /vault file.*(size|large)|Vault file too large/.test(error.message);

/** Single process serializes read-modify-write per partition, including separate store instances.
 * One writer process per host partition; cross-process locking belongs to the owning service.
 */
export class FleetManifestStore {
  constructor({ vault = new LocalFsVaultAdapter(), hostId = `h-${createHash('sha256').update(hostname()).digest('hex').slice(0, 16)}`,
    hostLabel = hostname(), maxRigs = 64, maxSeatsPerRig = 64, maxHistory = 50, now = Date.now } = {}) {
    assertValidStateVaultAdapter(vault);
    if (typeof hostId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(hostId) || cleanText(hostId) !== hostId) throw new TypeError('Invalid host ID');
    if (typeof now !== 'function') throw new TypeError('Invalid clock');
    this.vault = vault; this.hostId = hostId; this.hostLabel = cleanText(hostLabel, 128); this.now = now;
    this.maxRigs = bounded(maxRigs, 64, 64); this.maxSeatsPerRig = bounded(maxSeatsPerRig, 64, 64); this.maxHistory = bounded(maxHistory, 50, 50);
    this.key = `hosts/${hostId}/fleet-manifest.v1.json`;
    this.lamportClock = 0; this.lastWarning = null;
    if (!adapterLocks.has(vault)) adapterLocks.set(vault, new Map());
    this.lockMap = vault instanceof LocalFsVaultAdapter ? locks : adapterLocks.get(vault);
    this.lockKey = vault instanceof LocalFsVaultAdapter ? `${vault.baseDir}/${this.key}` : this.key;
  }
  async read() {
    try {
      const envelope = await this.vault.read(this.key);
      if (envelope === null) return null;
      if (!validEnvelope(envelope) || envelope.hostId !== this.hostId) { this.lastWarning = 'invalid_manifest'; return null; }
      this.lamportClock = Math.max(this.lamportClock, envelope.lamportClock);
      return envelope;
    } catch (error) {
      if (corruptRead(error)) { this.lastWarning = 'corrupt_manifest'; return null; }
      throw error;
    }
  }
  _mutate(change) {
    const prior = this.lockMap.get(this.lockKey) || Promise.resolve();
    const operation = prior.catch(() => {}).then(async () => {
      const previous = await this.read();
      const payload = { rigs: [], history: [], ...(previous?.payload || {}) };
      const timestamp = this.now();
      if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) throw new RangeError('Invalid wall clock');
      const updatedAt = new Date(Math.max(timestamp, Date.parse(previous?.updatedAt) || 0)).toISOString();
      change(payload, updatedAt);
      payload.rigs = (Array.isArray(payload.rigs) ? payload.rigs : []).slice(0, this.maxRigs);
      payload.history = (Array.isArray(payload.history) ? payload.history : []).slice(-this.maxHistory);
      const sanitized = scrub(payload);
      const lamportClock = Math.max(this.lamportClock, previous?.lamportClock || 0) + 1;
      if (!Number.isSafeInteger(lamportClock)) throw new RangeError('Lamport clock exhausted');
      const envelope = { schemaVersion: STATE_BUNDLE_SCHEMA_VERSION, bundleType: 'fleet-manifest', hostId: this.hostId, hostLabel: this.hostLabel,
        lamportClock, updatedAt, contentSha256: hash(sanitized), encryption: { mode: 'none' }, payload: sanitized };
      await this.vault.write(this.key, envelope);
      this.lamportClock = lamportClock;
      return envelope;
    });
    this.lockMap.set(this.lockKey, operation);
    operation.finally(() => { if (this.lockMap.get(this.lockKey) === operation) this.lockMap.delete(this.lockKey); }).catch(() => {});
    return operation;
  }
  observeLiveFleet({ rigs = [], nodes = [] } = {}) {
    return this._mutate((payload, at) => {
      const known = new Map((Array.isArray(payload.rigs) ? payload.rigs : []).slice().reverse().filter(r => SAFE_RIG_NAME_RE.test(r?.rigId)).map(r => [r.rigId, r]));
      for (const rig of (Array.isArray(rigs) ? rigs : []).slice(0, this.maxRigs)) {
        const rigId = idOf(rig);
        if (typeof rigId !== 'string' || !SAFE_RIG_NAME_RE.test(rigId)) continue;
        const seats = (Array.isArray(rig?.seats) ? rig.seats : (Array.isArray(nodes) ? nodes : []).filter(n => (n.rigId || n.rigName || String(n.canonicalSessionName || n.id || '').split('@')[1]) === rigId))
          .slice(0, this.maxSeatsPerRig).map(s => ({ seatId: typeof s === 'string' ? s : s.canonicalSessionName || s.seatId || s.id,
            intentionallyStopped: s?.intentionallyStopped === true })).filter(s => typeof s.seatId === 'string' && SAFE_SEAT_ID_RE.test(s.seatId));
        const intentionallyStopped = rig?.intentionallyStopped === true || known.get(rigId)?.intentionallyStopped === true;
        known.delete(rigId);
        known.set(rigId, { rigId, rigName: cleanText(rig?.rigName || rig?.name || rigId, 64), seats, intentionallyStopped, lastSeenAt: at });
      }
      payload.rigs = [...known.values()].reverse();
    });
  }
  markIntentionalStop(rigId, stopped = true) {
    if (typeof rigId !== 'string' || !SAFE_RIG_NAME_RE.test(rigId) || typeof stopped !== 'boolean') return Promise.reject(new TypeError('Invalid intentional stop target'));
    return this._mutate((payload, at) => {
      const rigs = Array.isArray(payload.rigs) ? payload.rigs : [];
      const prior = rigs.find(r => r.rigId === rigId);
      payload.rigs = rigs.filter(r => r.rigId !== rigId);
      payload.rigs.unshift({ ...prior, rigId, intentionallyStopped: stopped, lastSeenAt: at, seats: prior?.seats || [] });
    });
  }
  recordRecoveryAttempt(raw) {
    return this._mutate((payload, at) => { payload.history = [...(Array.isArray(payload.history) ? payload.history : []), { ...normalizeRestoreReceipt(scrub(raw)), recordedAt: at }]; });
  }
  async listAllHostManifests() {
    const envelopes = [];
    for (const key of await this.vault.list('hosts/')) {
      try {
        const envelope = await this.vault.read(key);
        if (validEnvelope(envelope) && key === `hosts/${envelope.hostId}/fleet-manifest.v1.json`) envelopes.push(envelope);
      } catch (error) { if (!corruptRead(error)) throw error; }
    }
    return mergeHostManifestEnvelopes(envelopes);
  }
}
