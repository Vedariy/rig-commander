/**
 * Zero-dependency Server-Sent Events (SSE) Push Hub & Deduplicated Live TMUX Streamer (ADR-0016).
 *
 * - Fleet Event Stream (`/api/events`): pushes telemetry change notifications and instant
 *   shift/guardrail events so clients react in <150ms instead of waiting for a 4s poll.
 * - Live TMUX Capture Stream (`/api/capture/stream`): deduplicates captures per `(seatId, lines)`,
 *   pushes `event: screen` ONLY when SHA-1 screen hash changes, backs off from 650ms -> 1500ms
 *   when screen is idle, and immediately re-samples after `/api/send` via `triggerSeatCaptureNow`.
 * - Zero idle CPU: all timers stop automatically when the last client disconnects.
 */

import crypto from 'node:crypto';

export const DEFAULT_MAX_SSE_CLIENTS = 32;
export const DEFAULT_HEARTBEAT_MS = 18_000;
export const TMUX_STREAM_FAST_MS = 650;
export const TMUX_STREAM_IDLE_MS = 1500;
export const TMUX_IDLE_TICKS_FOR_BACKOFF = 5;

export function formatSseFrame(eventName, payload, id = '') {
  let out = '';
  if (id) out += `id: ${String(id).replace(/[\r\n]/g, '')}\n`;
  if (eventName) out += `event: ${String(eventName).replace(/[\r\n]/g, '')}\n`;
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const line of serialized.split(/\r?\n/)) {
    out += `data: ${line}\n`;
  }
  return out + '\n';
}

export function computeTelemetrySignature(payload) {
  if (!payload || typeof payload !== 'object') return 'empty';
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const nodeBits = nodes
    .map(n => {
      const id = n.canonicalSessionName || n.logicalId || '';
      const disp = (n.activityState && n.activityState.display) || '';
      const ni = (n.activityState && n.activityState.needsInput && n.activityState.needsInput.count) || 0;
      const sh = n.activityState && n.activityState.shellExited ? 1 : 0;
      const pct = n.contextUsage && typeof n.contextUsage.usedPercentage === 'number'
        ? Math.round(n.contextUsage.usedPercentage)
        : -1;
      return `${id}:${disp}:${ni}:${sh}:${pct}`;
    })
    .sort()
    .join('|');
  const qLen = Array.isArray(payload.activeQueue) ? payload.activeQueue.length : 0;
  const topAudit = Array.isArray(payload.actionAudit) && payload.actionAudit[0]
    ? `${payload.actionAudit[0].execId}:${payload.actionAudit[0].postconditionStatus}`
    : '';
  const parked = payload.parkedSeats ? Object.keys(payload.parkedSeats).filter(k => payload.parkedSeats[k]?.parked).sort().join(',') : '';
  const raw = [
    payload.requestedRig || 'all',
    payload.discoveryMode || '',
    payload.historyRev || '',
    payload.guidanceRev || '',
    payload.gitRadarRev || '',
    payload.shiftHistoryMeta?.rev || '',
    qLen,
    topAudit,
    parked,
    nodeBits
  ].join('#');
  return 'sig:' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 14);
}

function writeSafe(res, chunk) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export class SsePushHub {
  constructor({
    maxClients = DEFAULT_MAX_SSE_CLIENTS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    fastCaptureMs = TMUX_STREAM_FAST_MS,
    idleCaptureMs = TMUX_STREAM_IDLE_MS,
    captureFn = null
  } = {}) {
    this.maxClients = Math.max(2, Number(maxClients) || DEFAULT_MAX_SSE_CLIENTS);
    this.heartbeatMs = Math.max(1000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.fastCaptureMs = Math.max(100, Number(fastCaptureMs) || TMUX_STREAM_FAST_MS);
    this.idleCaptureMs = Math.max(this.fastCaptureMs, Number(idleCaptureMs) || TMUX_STREAM_IDLE_MS);
    this.captureFn = typeof captureFn === 'function' ? captureFn : null;

    this.eventClients = new Set(); // { id, rigKey, res, req }
    this.lastSigByRig = new Map(); // rigKey -> sig
    this.tmuxWatchers = new Map(); // `${seatId}:${lines}` -> { seatId, lines, clients: Set, lastHash, lastScreen, unchangedTicks, timer, inFlight }
    this.eventSeq = 0;
    this.heartbeatTimer = null;
    this.nextClientId = 1;
  }

  get totalClients() {
    let tmuxCount = 0;
    for (const w of this.tmuxWatchers.values()) tmuxCount += w.clients.size;
    return this.eventClients.size + tmuxCount;
  }

  hasActiveSubscribers() {
    return this.totalClients > 0;
  }

  getStats() {
    return {
      eventClients: this.eventClients.size,
      tmuxWatchers: this.tmuxWatchers.size,
      totalClients: this.totalClients,
      eventSeq: this.eventSeq
    };
  }

  _ensureHeartbeat() {
    if (this.heartbeatTimer || this.totalClients === 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.totalClients === 0) {
        this._stopHeartbeat();
        return;
      }
      const ping = `: ping ${Date.now()}\n\n`;
      for (const c of Array.from(this.eventClients)) {
        if (!writeSafe(c.res, ping)) this._removeEventClient(c);
      }
      for (const w of Array.from(this.tmuxWatchers.values())) {
        for (const c of Array.from(w.clients)) {
          if (!writeSafe(c.res, ping)) this._removeTmuxClient(w, c);
        }
      }
    }, this.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _openSseResponse(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') {
      try { res.flushHeaders(); } catch {}
    }
  }

  /**
   * Attaches a client to the Fleet Event Stream (`/api/events?rig=...`).
   */
  subscribeEvents(req, res, { rigKey = 'all' } = {}) {
    if (this.totalClients >= this.maxClients) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Too many SSE subscribers' }));
      return null;
    }
    this._openSseResponse(res);
    const client = { id: this.nextClientId++, rigKey: rigKey || 'all', req, res };
    this.eventClients.add(client);
    this._ensureHeartbeat();

    const cleanup = () => this._removeEventClient(client);
    req.on('close', cleanup);
    res.on('error', cleanup);

    writeSafe(res, 'retry: 2500\n');
    writeSafe(res, formatSseFrame('ready', {
      transport: 'sse',
      rig: client.rigKey,
      sig: this.lastSigByRig.get(client.rigKey) || '',
      ts: new Date().toISOString()
    }, String(++this.eventSeq)));
    return client;
  }

  _removeEventClient(client) {
    this.eventClients.delete(client);
    try { if (!client.res.writableEnded) client.res.end(); } catch {}
    if (this.totalClients === 0) this._stopHeartbeat();
  }

  /**
   * Broadcasts a telemetry change notification whenever a bundle's signature changes.
   */
  publishTelemetryBundle(rigKey, payload, { force = false } = {}) {
    const key = rigKey || 'all';
    const sig = computeTelemetrySignature(payload);
    const prev = this.lastSigByRig.get(key);
    this.lastSigByRig.set(key, sig);
    if (!force && prev === sig) return 0;
    if (this.eventClients.size === 0) return 0;

    const frame = formatSseFrame('telemetry', {
      rig: key,
      sig,
      historyRev: payload?.historyRev || '',
      guidanceRev: payload?.guidanceRev || '',
      gitRadarRev: payload?.gitRadarRev || '',
      shiftRev: payload?.shiftHistoryMeta?.rev || '',
      ts: payload?.timestamp || new Date().toISOString()
    }, String(++this.eventSeq));

    let sent = 0;
    for (const c of Array.from(this.eventClients)) {
      if (c.rigKey === key || c.rigKey === 'all' || key === 'all') {
        if (writeSafe(c.res, frame)) sent++;
        else this._removeEventClient(c);
      }
    }
    return sent;
  }

  /**
   * Broadcasts an instant domain event (shift transition, action audit update, guardrail trip).
   */
  publishShiftEvent(ev) {
    if (!ev || this.eventClients.size === 0) return 0;
    const frame = formatSseFrame('shift_event', ev, String(++this.eventSeq));
    let sent = 0;
    for (const c of Array.from(this.eventClients)) {
      if (c.rigKey === 'all' || !ev.rigId || ev.rigId === 'all' || ev.rigId === c.rigKey) {
        if (writeSafe(c.res, frame)) sent++;
        else this._removeEventClient(c);
      }
    }
    return sent;
  }

  /**
   * Signals all fleet subscribers that state was mutated (e.g. after `/api/send`) so they refresh immediately.
   */
  notifyInvalidated(reason = 'action', seatId = '') {
    if (this.eventClients.size === 0) return 0;
    const frame = formatSseFrame('invalidate', {
      reason,
      seatId: seatId || null,
      ts: new Date().toISOString()
    }, String(++this.eventSeq));
    let sent = 0;
    for (const c of Array.from(this.eventClients)) {
      if (writeSafe(c.res, frame)) sent++;
      else this._removeEventClient(c);
    }
    return sent;
  }

  /**
   * Attaches a client to the deduplicated Live TMUX Capture Stream (`/api/capture/stream`).
   */
  subscribeTmux(req, res, { seatId, lines = 80 } = {}) {
    if (!seatId || !/^[a-zA-Z0-9._@-]{1,140}$/.test(String(seatId))) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid seat identifier' }));
      return null;
    }
    if (this.totalClients >= this.maxClients) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Too many SSE subscribers' }));
      return null;
    }

    const lineCount = Math.min(200, Math.max(10, Number(lines) || 80));
    const watchKey = `${seatId}:${lineCount}`;
    this._openSseResponse(res);

    let watcher = this.tmuxWatchers.get(watchKey);
    const isNewWatcher = !watcher;
    if (!watcher) {
      watcher = {
        watchKey,
        seatId,
        lines: lineCount,
        clients: new Set(),
        lastHash: '',
        lastScreen: null,
        unchangedTicks: 0,
        timer: null,
        inFlight: false
      };
      this.tmuxWatchers.set(watchKey, watcher);
    }

    const client = { id: this.nextClientId++, req, res };
    watcher.clients.add(client);
    this._ensureHeartbeat();

    const cleanup = () => this._removeTmuxClient(watcher, client);
    req.on('close', cleanup);
    res.on('error', cleanup);

    writeSafe(res, 'retry: 2000\n');
    writeSafe(res, formatSseFrame('ready', { transport: 'sse', seat: seatId, lines: lineCount }, String(++this.eventSeq)));

    if (watcher.lastScreen !== null) {
      writeSafe(res, formatSseFrame('screen', {
        seat: seatId,
        lines: lineCount,
        hash: watcher.lastHash,
        screen: watcher.lastScreen,
        ts: new Date().toISOString()
      }, String(++this.eventSeq)));
    }

    if (isNewWatcher) {
      void this._pollTmuxWatcher(watcher, { forceSend: true });
    }
    return client;
  }

  _removeTmuxClient(watcher, client) {
    watcher.clients.delete(client);
    try { if (!client.res.writableEnded) client.res.end(); } catch {}
    if (watcher.clients.size === 0) {
      if (watcher.timer) {
        clearTimeout(watcher.timer);
        watcher.timer = null;
      }
      this.tmuxWatchers.delete(watcher.watchKey);
    }
    if (this.totalClients === 0) this._stopHeartbeat();
  }

  async _pollTmuxWatcher(watcher, { forceSend = false } = {}) {
    if (!this.tmuxWatchers.has(watcher.watchKey) || watcher.clients.size === 0) return;
    if (watcher.inFlight) return;
    watcher.inFlight = true;
    try {
      const raw = this.captureFn ? await this.captureFn(watcher.seatId, watcher.lines) : '';
      const screen = typeof raw === 'string' ? raw : '';
      const hash = crypto.createHash('sha1').update(screen).digest('hex').slice(0, 12);
      const changed = hash !== watcher.lastHash;
      if (changed) {
        watcher.lastHash = hash;
        watcher.lastScreen = screen;
        watcher.unchangedTicks = 0;
      } else {
        watcher.unchangedTicks += 1;
      }
      if ((changed || forceSend) && watcher.clients.size > 0) {
        const frame = formatSseFrame('screen', {
          seat: watcher.seatId,
          lines: watcher.lines,
          hash,
          screen,
          ts: new Date().toISOString()
        }, String(++this.eventSeq));
        for (const c of Array.from(watcher.clients)) {
          if (!writeSafe(c.res, frame)) this._removeTmuxClient(watcher, c);
        }
      }
    } catch {
      // Transient capture failure: keep watcher alive for next tick
    } finally {
      watcher.inFlight = false;
      if (this.tmuxWatchers.has(watcher.watchKey) && watcher.clients.size > 0) {
        const delay = watcher.unchangedTicks >= TMUX_IDLE_TICKS_FOR_BACKOFF
          ? this.idleCaptureMs
          : this.fastCaptureMs;
        if (watcher.timer) clearTimeout(watcher.timer);
        watcher.timer = setTimeout(() => {
          watcher.timer = null;
          void this._pollTmuxWatcher(watcher);
        }, delay);
        if (typeof watcher.timer.unref === 'function') watcher.timer.unref();
      }
    }
  }

  /**
   * Immediately re-captures any active TMUX stream watching `seatId` (e.g. right after `/api/send`).
   */
  triggerSeatCaptureNow(seatId) {
    if (!seatId) return 0;
    let triggered = 0;
    for (const watcher of this.tmuxWatchers.values()) {
      if (watcher.seatId === seatId && watcher.clients.size > 0) {
        watcher.unchangedTicks = 0;
        if (watcher.timer) {
          clearTimeout(watcher.timer);
          watcher.timer = null;
        }
        void this._pollTmuxWatcher(watcher, { forceSend: false });
        triggered++;
      }
    }
    return triggered;
  }

  closeAll() {
    this._stopHeartbeat();
    for (const c of Array.from(this.eventClients)) this._removeEventClient(c);
    for (const w of Array.from(this.tmuxWatchers.values())) {
      if (w.timer) clearTimeout(w.timer);
      for (const c of Array.from(w.clients)) this._removeTmuxClient(w, c);
    }
    this.tmuxWatchers.clear();
  }
}
