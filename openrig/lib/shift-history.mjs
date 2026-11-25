/**
 * Append-only persistent JSONL shift history store (ADR-0014).
 *
 * - Default path: ~/.config/rig-commander/shift-events.jsonl (mode 0600, dir 0700).
 * - Redacts secrets and OS paths before persisting via SecretRedactor.
 * - Non-blocking queued async writes (0 ms telemetry latency impact).
 * - Resilient to corrupt/partial trailing JSONL lines after sudden process crash.
 * - Bounded in-memory ring buffer + automatic safe atomic compaction.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diffTelemetrySnapshots } from '../assets/domain/shift-digest.js';
import { stripAnsiAndRedact } from './ai-evaluator/redactor.mjs';

const DEFAULT_MAX_MEMORY_EVENTS = 2500;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
const DEFAULT_RETENTION_DAYS = 14;
const COMPACT_KEEP_DAYS = 7;

export function resolveDefaultShiftHistoryPath() {
  if (process.env.RIGCOMMANDER_HISTORY_FILE) {
    return path.resolve(process.env.RIGCOMMANDER_HISTORY_FILE);
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.config', 'rig-commander', 'shift-events.jsonl');
}

function sanitizeText(str, maxLen = 220) {
  const raw = String(str || '').trim().slice(0, maxLen * 2);
  if (!raw) return '';
  const { text } = stripAnsiAndRedact(raw, { redactPaths: true });
  return text.replace(/[\r\n]+/g, ' ').slice(0, maxLen);
}

function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const tsMs = typeof ev.tsMs === 'number' && Number.isFinite(ev.tsMs)
    ? ev.tsMs
    : (Date.parse(String(ev.ts || '')) || Date.now());
  const cleanMeta = {};
  if (ev.meta && typeof ev.meta === 'object') {
    for (const [k, v] of Object.entries(ev.meta)) {
      if (typeof v === 'string') cleanMeta[k] = sanitizeText(v, 160);
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) cleanMeta[k] = v;
      else if (Array.isArray(v)) cleanMeta[k] = v.slice(0, 8).map(item => (typeof item === 'string' ? sanitizeText(item, 80) : item));
    }
  }
  return {
    ts: new Date(tsMs).toISOString(),
    tsMs,
    kind: String(ev.kind || 'info').slice(0, 32),
    severity: ['critical', 'warn', 'info', 'success'].includes(ev.severity) ? ev.severity : 'info',
    rigId: sanitizeText(ev.rigId || 'all', 64) || 'all',
    seatId: ev.seatId ? sanitizeText(ev.seatId, 120) : null,
    key: sanitizeText(ev.key || '', 120),
    title: sanitizeText(ev.title || '', 180),
    detail: sanitizeText(ev.detail || '', 240),
    meta: cleanMeta
  };
}

export class ShiftHistoryStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDefaultShiftHistoryPath();
    this.maxMemoryEvents = Math.max(100, Number(options.maxMemoryEvents) || DEFAULT_MAX_MEMORY_EVENTS);
    this.maxFileBytes = Math.max(64 * 1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES);
    this.retentionMs = Math.max(1, Number(options.retentionDays) || DEFAULT_RETENTION_DAYS) * 24 * 3600 * 1000;
    this.events = [];
    this.prevTelemetryState = null;
    this.rev = 0;
    this.writeQueue = [];
    this.flushing = false;
    this.flushPromise = null;
    this.compacting = false;
    this.loaded = false;
  }

  loadSync() {
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) return 0;
      const stat = fs.statSync(this.filePath);
      const readBytes = Math.min(stat.size, this.maxFileBytes);
      const startOffset = Math.max(0, stat.size - readBytes);
      const fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.alloc(readBytes);
      try {
        fs.readSync(fd, buf, 0, readBytes, startOffset);
      } finally {
        fs.closeSync(fd);
      }
      const rawText = buf.toString('utf8');
      const lines = rawText.split('\n');
      if (startOffset > 0 && lines.length > 0) lines.shift(); // Drop partial first line

      const cutoff = Date.now() - this.retentionMs;
      const parsed = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj === 'object' && obj.kind) {
            const tsMs = typeof obj.tsMs === 'number' ? obj.tsMs : (Date.parse(String(obj.ts || '')) || 0);
            if (tsMs >= cutoff) {
              parsed.push({ ...obj, tsMs, ts: obj.ts || new Date(tsMs).toISOString() });
            }
          }
        } catch {
          // Ignore corrupt or partially flushed JSONL line safely
        }
      }
      this.events = parsed.slice(-this.maxMemoryEvents);
      this.rev = this.events.length;
      return this.events.length;
    } catch {
      return 0;
    }
  }

  append(eventsOrEvent) {
    const list = Array.isArray(eventsOrEvent) ? eventsOrEvent : [eventsOrEvent];
    const added = [];
    for (const raw of list) {
      const clean = sanitizeEvent(raw);
      if (!clean) continue;
      this.events.push(clean);
      this.writeQueue.push(JSON.stringify(clean) + '\n');
      added.push(clean);
    }
    if (this.events.length > this.maxMemoryEvents) {
      this.events.splice(0, this.events.length - this.maxMemoryEvents);
    }
    if (added.length > 0) {
      this.rev += added.length;
      this._scheduleFlush();
    }
    return added;
  }

  ingestTelemetry(payload, nowMs = Date.now()) {
    const { events, nextState } = diffTelemetrySnapshots(this.prevTelemetryState, payload, nowMs);
    this.prevTelemetryState = nextState;
    if (events.length > 0) {
      this.append(events);
    }
    return events;
  }

  recordOperatorAction(entry) {
    if (!entry || !entry.targetSeatId) return null;
    const status = entry.postconditionStatus || 'pending';
    const sev = status === 'verified' ? 'success' : (status === 'failed' ? 'critical' : 'info');
    const at = entry.targetSeatId.indexOf('@');
    const rigId = at > 0 ? entry.targetSeatId.slice(at + 1) : 'all';
    const shortName = at > 0 ? entry.targetSeatId.slice(0, at) : entry.targetSeatId;
    const added = this.append({
      ts: entry.verifiedAt || entry.executedAt || new Date().toISOString(),
      tsMs: Date.parse(entry.verifiedAt || entry.executedAt || '') || Date.now(),
      kind: 'operator_action',
      severity: sev,
      rigId,
      seatId: entry.targetSeatId,
      key: `act:${entry.execId || ''}:${status}`,
      title: `${entry.actionId || 'action'} → ${shortName}`,
      detail: `${entry.payloadPreview || ''} (${status}: ${entry.postconditionDetail || ''})`.trim(),
      meta: {
        execId: entry.execId || null,
        actionId: entry.actionId || null,
        postconditionStatus: status,
        httpStatus: entry.httpStatus || 200
      }
    });
    return added[0] || null;
  }

  recordGuardrailEvent({ severity = 'critical', rigId = 'all', seatId = null, key = '', title = '', detail = '', meta = {} } = {}) {
    if (!title) return null;
    const added = this.append({
      ts: new Date().toISOString(),
      tsMs: Date.now(),
      kind: 'guardrail',
      severity,
      rigId,
      seatId,
      key: key || `guardrail:${Date.now()}`,
      title,
      detail,
      meta
    });
    return added[0] || null;
  }

  queryEvents({ sinceMs = 0, untilMs = Infinity, rigId = 'all', kinds = null, limit = 500 } = {}) {
    const kindSet = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null;
    const out = [];
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.tsMs < sinceMs || ev.tsMs > untilMs) continue;
      if (rigId && rigId !== 'all' && ev.rigId !== rigId && !(ev.seatId && ev.seatId.endsWith('@' + rigId))) {
        continue;
      }
      if (kindSet && !kindSet.has(ev.kind)) continue;
      out.push(ev);
    }
    const maxN = Math.max(1, Math.min(2500, Number(limit) || 500));
    return out.length > maxN ? out.slice(-maxN) : out;
  }

  getSummaryMeta() {
    const totalStored = this.events.length;
    const oldestTs = totalStored > 0 ? this.events[0].ts : null;
    const newestTs = totalStored > 0 ? this.events[totalStored - 1].ts : null;
    const cutoff1h = Date.now() - 3600 * 1000;
    let criticalLast1h = 0;
    for (let i = totalStored - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.tsMs < cutoff1h) break;
      if (ev.severity === 'critical') criticalLast1h++;
    }
    return {
      rev: `sh:${this.rev}`,
      totalStored,
      oldestTs,
      newestTs,
      criticalLast1h,
      fileName: path.basename(this.filePath)
    };
  }

  _scheduleFlush() {
    if (this.flushing) return this.flushPromise;
    this.flushing = true;
    this.flushPromise = this._drainQueue().finally(() => {
      this.flushing = false;
      if (this.writeQueue.length > 0) {
        this._scheduleFlush();
      }
    });
    return this.flushPromise;
  }

  async flush() {
    if (this.writeQueue.length > 0) {
      this._scheduleFlush();
    }
    if (this.flushPromise) {
      await this.flushPromise;
    }
  }

  async _drainQueue() {
    while (this.writeQueue.length > 0) {
      const batch = this.writeQueue.splice(0, this.writeQueue.length).join('');
      try {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fsp.appendFile(this.filePath, batch, { encoding: 'utf8', mode: 0o600 });
        await fsp.chmod(this.filePath, 0o600).catch(() => {});
        const stat = await fsp.stat(this.filePath).catch(() => null);
        if (stat && stat.size > this.maxFileBytes && !this.compacting) {
          await this._compactFile();
        }
      } catch {
        // Non-fatal persistence error (read-only sandbox or full disk): keep in-memory ring buffer alive
      }
    }
  }

  async _compactFile() {
    this.compacting = true;
    try {
      const keepCutoff = Date.now() - COMPACT_KEEP_DAYS * 24 * 3600 * 1000;
      const kept = this.events.filter(e => e.tsMs >= keepCutoff);
      const tmp = `${this.filePath}.tmp.${process.pid}`;
      const body = kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : '');
      await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, this.filePath);
      await fsp.chmod(this.filePath, 0o600).catch(() => {});
    } catch {
      // Ignore transient compaction failure
    } finally {
      this.compacting = false;
    }
  }
}
