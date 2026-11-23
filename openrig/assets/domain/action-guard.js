/**
 * Shared Control-Primitive Double-Click & Idempotency Guard (0 deps).
 * Used symmetrically on BOTH:
 *  - Client UI controls (openrig/index.html): prevents double-clicks, rapid repeat sends,
 *    concurrent conflicting actions on the same seat, and survives DOM re-renders!
 *  - Node server (openrig/server.mjs): server-side idempotency & semantic dedupe on /api/send.
 */

export const DEFAULT_ACTION_COOLDOWN_MS = 1800;
export const DEFAULT_DESTRUCTIVE_COOLDOWN_MS = 2200;
export const DEFAULT_SERVER_IDEMPOTENCY_TTL_MS = 30_000;
export const DEFAULT_SERVER_SEMANTIC_DEDUPE_MS = 1500;

export function buildSeatScopeKey(seatId) {
  return `seat:${String(seatId || '').trim()}`;
}

export function buildSeatSendKey(seatId, type, text) {
  const normText = String(text || '').trim().replace(/\s+/g, ' ');
  return `send:${String(seatId || '').trim()}:${String(type || 'msg').trim()}:${normText}`;
}

export function buildEndpointScopeKey(endpoint) {
  return `endpoint:${String(endpoint || '').trim()}`;
}

export function createIdempotencyKey(prefix = 'act') {
  const ts = Date.now().toString(36);
  let rand = '';
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    const arr = new Uint8Array(6);
    globalThis.crypto.getRandomValues(arr);
    rand = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  } else {
    rand = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  }
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Logical flight + cooldown lock manager for UI controls.
 * Because locks live in memory by logical scope/fingerprint (NOT only on a DOM button),
 * polling re-renders (innerHTML replacements) can NEVER accidentally re-enable an in-flight
 * or cooling-down control.
 */
export class ActionFlightGuard {
  constructor(options = {}) {
    this.defaultCooldownMs = Number(options.defaultCooldownMs ?? DEFAULT_ACTION_COOLDOWN_MS);
    this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
    this.inFlight = new Map(); // scopeKey -> { token, startedAt, fingerprint }
    this.cooldowns = new Map(); // key -> expiresAt
    this.listeners = new Set();
  }

  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) {
      try { fn(); } catch {}
    }
  }

  _prune(now = this.nowFn()) {
    for (const [k, exp] of this.cooldowns.entries()) {
      if (exp <= now) this.cooldowns.delete(k);
    }
  }

  isScopeInFlight(scopeKey) {
    return Boolean(scopeKey && this.inFlight.has(scopeKey));
  }

  getCooldownRemainingMs(key) {
    if (!key) return 0;
    const now = this.nowFn();
    this._prune(now);
    const exp = this.cooldowns.get(key);
    return exp && exp > now ? (exp - now) : 0;
  }

  isLocked(scopeKey, fingerprint = '') {
    if (this.isScopeInFlight(scopeKey)) return true;
    if (scopeKey && this.getCooldownRemainingMs(scopeKey) > 0) return true;
    if (fingerprint && this.getCooldownRemainingMs(fingerprint) > 0) return true;
    return false;
  }

  /**
   * Atomically acquires an execution lock for a control action.
   * - `scopeKey`: exclusive concurrent flight lock (e.g. "seat:dev-check@core-platform")
   * - `fingerprint`: duplicate-command cooldown key (e.g. "send:dev-check:key:1 Enter")
   * - `scopeCooldownMs`: optional short cooldown on the whole scope (default 0 or small anti-bounce)
   * - `cooldownMs`: cooldown on the exact fingerprint after completion (default 1800ms)
   */
  tryAcquire({ scopeKey, fingerprint = '', cooldownMs, scopeCooldownMs = 0 } = {}) {
    const now = this.nowFn();
    this._prune(now);

    if (scopeKey && this.inFlight.has(scopeKey)) {
      return { allowed: false, reason: 'in_flight', remainingMs: 0 };
    }
    if (scopeKey) {
      const scopeRem = this.getCooldownRemainingMs(scopeKey);
      if (scopeRem > 0) {
        return { allowed: false, reason: 'cooldown', remainingMs: scopeRem };
      }
    }
    if (fingerprint) {
      const fpRem = this.getCooldownRemainingMs(fingerprint);
      if (fpRem > 0) {
        return { allowed: false, reason: 'cooldown', remainingMs: fpRem };
      }
    }

    const token = createIdempotencyKey('req');
    const effCooldown = cooldownMs !== undefined ? Number(cooldownMs) : this.defaultCooldownMs;
    if (scopeKey) {
      this.inFlight.set(scopeKey, { token, startedAt: now, fingerprint });
    }
    this._notify();

    let released = false;
    const release = ({ applyCooldown = true } = {}) => {
      if (released) return;
      released = true;
      const cur = scopeKey ? this.inFlight.get(scopeKey) : null;
      if (scopeKey && cur && cur.token === token) {
        this.inFlight.delete(scopeKey);
      }
      if (applyCooldown) {
        const doneAt = this.nowFn();
        if (fingerprint && effCooldown > 0) {
          this.cooldowns.set(fingerprint, doneAt + effCooldown);
        }
        if (scopeKey && scopeCooldownMs > 0) {
          this.cooldowns.set(scopeKey, doneAt + scopeCooldownMs);
        }
      }
      this._notify();
    };

    return {
      allowed: true,
      token,
      idempotencyKey: token,
      release
    };
  }

  async runGuarded(opts, asyncFn) {
    const acq = this.tryAcquire(opts);
    if (!acq.allowed) {
      if (opts && typeof opts.onBlocked === 'function') {
        opts.onBlocked(acq);
      }
      return { skipped: true, reason: acq.reason, remainingMs: acq.remainingMs };
    }
    let applyCooldown = true;
    try {
      const value = await asyncFn({ idempotencyKey: acq.idempotencyKey });
      if (value && value.__skipCooldown === true) applyCooldown = false;
      return { skipped: false, value };
    } catch (err) {
      applyCooldown = false;
      throw err;
    } finally {
      acq.release({ applyCooldown });
    }
  }
}

/**
 * Server-side idempotency & rapid duplicate-command deduplicator for write-back endpoints (/api/send).
 * Protects against double-clicks, proxy retries, or duplicate tabs sending the exact same tmux command twice.
 */
export class ServerIdempotencyCache {
  constructor(options = {}) {
    this.keyTtlMs = Number(options.keyTtlMs ?? DEFAULT_SERVER_IDEMPOTENCY_TTL_MS);
    this.semanticTtlMs = Number(options.semanticTtlMs ?? DEFAULT_SERVER_SEMANTIC_DEDUPE_MS);
    this.maxEntries = Number(options.maxEntries ?? 500);
    this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
    this.byKey = new Map(); // idempotencyKey -> { status, body, expiresAt }
    this.bySemantic = new Map(); // semanticFingerprint -> { expiresAt, execId }
    this.inFlightKeys = new Set();
    this.inFlightSeats = new Set();
  }

  _prune(now = this.nowFn()) {
    for (const [k, v] of this.byKey.entries()) {
      if (v.expiresAt <= now) this.byKey.delete(k);
    }
    for (const [k, v] of this.bySemantic.entries()) {
      if (v.expiresAt <= now) this.bySemantic.delete(k);
    }
  }

  _boundedSet(map, key, val) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  /**
   * Checks whether an incoming write-back request should proceed or be deduplicated.
   * Returns:
   *  - `{ action: 'replay', status, body }` if exact X-Idempotency-Key already completed
   *  - `{ action: 'reject', status: 409, reason }` if same key/seat is currently in-flight or exact same command was just sent
   *  - `{ action: 'proceed', complete(status, body), abort() }` if allowed to execute
   */
  begin({ idempotencyKey = '', seatId = '', semanticKey = '' } = {}) {
    const now = this.nowFn();
    this._prune(now);

    const cleanKey = String(idempotencyKey || '').trim().slice(0, 128);
    const cleanSeat = String(seatId || '').trim();
    const cleanSemantic = String(semanticKey || '').trim();

    if (cleanKey) {
      const cached = this.byKey.get(cleanKey);
      if (cached) {
        return {
          action: 'replay',
          status: cached.status,
          body: { ...cached.body, deduplicated: true }
        };
      }
      if (this.inFlightKeys.has(cleanKey)) {
        return { action: 'reject', status: 409, reason: 'Identical command is already executing' };
      }
    }

    if (cleanSeat && this.inFlightSeats.has(cleanSeat)) {
      return { action: 'reject', status: 409, reason: `Another command to ${cleanSeat} is already in flight` };
    }

    if (cleanSemantic) {
      const recent = this.bySemantic.get(cleanSemantic);
      if (recent && recent.expiresAt > now) {
        return {
          action: 'reject',
          status: 409,
          reason: 'Duplicate command suppressed (identical command was just sent)'
        };
      }
    }

    if (cleanKey) this.inFlightKeys.add(cleanKey);
    if (cleanSeat) this.inFlightSeats.add(cleanSeat);

    let finished = false;
    const finishCleanup = () => {
      if (cleanKey) this.inFlightKeys.delete(cleanKey);
      if (cleanSeat) this.inFlightSeats.delete(cleanSeat);
    };

    return {
      action: 'proceed',
      complete: (status, body) => {
        if (finished) return;
        finished = true;
        finishCleanup();
        const doneAt = this.nowFn();
        if (cleanKey) {
          this._boundedSet(this.byKey, cleanKey, { status, body, expiresAt: doneAt + this.keyTtlMs });
        }
        if (cleanSemantic && status >= 200 && status < 300) {
          this._boundedSet(this.bySemantic, cleanSemantic, {
            expiresAt: doneAt + this.semanticTtlMs,
            execId: (body && body.execId) || ''
          });
        }
      },
      abort: () => {
        if (finished) return;
        finished = true;
        finishCleanup();
      }
    };
  }
}
