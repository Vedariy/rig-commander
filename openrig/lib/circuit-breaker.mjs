/**
 * Budget & Loop Circuit-Breaker (Zero-dependency, local-first).
 * Monitors session spend, per-seat spend, burn rate ($/h), and QA bounce-back loops.
 * Can run in `alert_only` or `auto_stop` (sends allowlisted C-c through ActionAuditLog).
 */

export const DEFAULT_BREAKER_CONFIG = Object.freeze({
  enabled: true,
  mode: 'alert_only', // 'alert_only' | 'auto_stop'
  maxSessionUsd: 15.0,
  maxSeatUsd: 5.0,
  maxUsdPerHour: 8.0,
  maxQaRounds: 3,
  cooldownMs: 300_000
});

function clampPositiveNumber(val, fallback, min = 0.01, max = 100_000) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.round(n * 100) / 100);
}

export class BudgetCircuitBreaker {
  constructor(initialConfig = {}, hooks = {}) {
    this.config = { ...DEFAULT_BREAKER_CONFIG };
    this.updateConfig(initialConfig);
    this.onAutoInterrupt = typeof hooks.onAutoInterrupt === 'function' ? hooks.onAutoInterrupt : null;
    this.onTrip = typeof hooks.onTrip === 'function' ? hooks.onTrip : null;

    this.spendSamples = []; // [{ t, totalUsd }]
    this.lastTripAtByKey = new Map(); // rule:seatId -> ts
    this.trippedSeats = new Map(); // seatId -> tripEvent
    this.recentTrips = []; // newest first, max 30
    this.burnUsdPerHour = 0;
    this.lastSessionUsd = 0;
  }

  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object') return this.getConfig();
    if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled;
    if (patch.mode === 'alert_only' || patch.mode === 'auto_stop') this.config.mode = patch.mode;
    if (patch.maxSessionUsd !== undefined) {
      this.config.maxSessionUsd = clampPositiveNumber(patch.maxSessionUsd, this.config.maxSessionUsd, 0.1, 10_000);
    }
    if (patch.maxSeatUsd !== undefined) {
      this.config.maxSeatUsd = clampPositiveNumber(patch.maxSeatUsd, this.config.maxSeatUsd, 0.1, 5_000);
    }
    if (patch.maxUsdPerHour !== undefined) {
      this.config.maxUsdPerHour = clampPositiveNumber(patch.maxUsdPerHour, this.config.maxUsdPerHour, 0.1, 5_000);
    }
    if (patch.maxQaRounds !== undefined) {
      const r = Math.round(Number(patch.maxQaRounds));
      if (Number.isFinite(r) && r >= 2 && r <= 20) this.config.maxQaRounds = r;
    }
    if (patch.cooldownMs !== undefined) {
      const c = Math.round(Number(patch.cooldownMs));
      if (Number.isFinite(c) && c >= 0 && c <= 3_600_000) this.config.cooldownMs = c;
    }
    return this.getConfig();
  }

  getConfig() {
    return { ...this.config };
  }

  recordSpendSample(totalUsd, nowMs = Date.now()) {
    if (typeof totalUsd !== 'number' || !Number.isFinite(totalUsd) || totalUsd < 0) return;
    this.lastSessionUsd = Math.round(totalUsd * 100) / 100;
    const last = this.spendSamples[this.spendSamples.length - 1];
    if (last && totalUsd < last.totalUsd - 0.5) {
      // Session reset / new day
      this.spendSamples = [{ t: nowMs, totalUsd }];
      this.burnUsdPerHour = 0;
      return;
    }
    if (!last || nowMs - last.t >= 10_000 || Math.abs(totalUsd - last.totalUsd) >= 0.01) {
      this.spendSamples.push({ t: nowMs, totalUsd });
      if (this.spendSamples.length > 180) this.spendSamples.shift();
    }
    // Keep last 30 minutes window for burn rate
    const cutoff = nowMs - 30 * 60_000;
    while (this.spendSamples.length > 2 && this.spendSamples[0].t < cutoff) {
      this.spendSamples.shift();
    }
    const first = this.spendSamples[0];
    const dtMs = nowMs - first.t;
    const dUsd = totalUsd - first.totalUsd;
    if (dtMs >= 60_000 && dUsd > 0) {
      this.burnUsdPerHour = Math.round(((dUsd / dtMs) * 3_600_000) * 100) / 100;
    } else if (dUsd <= 0) {
      this.burnUsdPerHour = 0;
    }
  }

  async _triggerTrip({ rule, seatId, cooldownKey = null, severity, title, detail, nowMs }) {
    const key = cooldownKey || `${rule}:${seatId || 'fleet'}`;
    const lastTs = this.lastTripAtByKey.get(key) || 0;
    if (nowMs - lastTs < this.config.cooldownMs) return null;
    this.lastTripAtByKey.set(key, nowMs);

    let actionTaken = 'alerted';
    if (this.config.mode === 'auto_stop' && seatId && this.onAutoInterrupt) {
      try {
        const res = await this.onAutoInterrupt(seatId, { rule, title, detail });
        if (res !== false) actionTaken = 'interrupted_cc';
      } catch {
        actionTaken = 'interrupt_failed';
      }
    }

    const trip = {
      id: `trip-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
      rule,
      seatId: seatId || 'fleet',
      severity,
      title,
      detail,
      mode: this.config.mode,
      actionTaken,
      at: new Date(nowMs).toISOString()
    };

    if (seatId) this.trippedSeats.set(seatId, trip);
    else this.trippedSeats.set('fleet', trip);

    this.recentTrips.unshift(trip);
    if (this.recentTrips.length > 30) this.recentTrips.pop();

    if (this.onTrip) {
      try {
        await this.onTrip(trip);
      } catch {
        // non-blocking notification failure
      }
    }
    return trip;
  }

  async evaluate({ nodes = [], seatUsage = {}, fleetUsageSummary = null, sliceStats = {}, nowMs = Date.now() } = {}) {
    const totalUsd = Number(fleetUsageSummary && fleetUsageSummary.totalEstUsd) || 0;
    this.recordSpendSample(totalUsd, nowMs);
    if (!this.config.enabled) return [];

    const workingIds = new Set(
      (Array.isArray(nodes) ? nodes : [])
        .filter(n => {
          const disp = (n && n.activityState && n.activityState.display) || '';
          return disp === 'working' || disp === 'running' || disp === 'needs-input';
        })
        .map(n => n.canonicalSessionName)
        .filter(Boolean)
    );

    const newTrips = [];

    // 1. Per-seat spend cap
    const sortedUsage = Object.entries(seatUsage || {})
      .filter(([, u]) => u && typeof u.estUsd === 'number')
      .sort((a, b) => b[1].estUsd - a[1].estUsd);

    for (const [seatId, u] of sortedUsage) {
      if (u.estUsd >= this.config.maxSeatUsd) {
        const trip = await this._triggerTrip({
          rule: 'seat_spend_cap',
          seatId,
          severity: 'P0',
          title: `Seat spend cap hit: ${seatId} ($${u.estUsd.toFixed(2)} >= $${this.config.maxSeatUsd.toFixed(2)})`,
          detail: `Model ${u.model || 'unknown'} consumed ~$${u.estUsd.toFixed(2)} (${u.cachedPct || 0}% cache).`,
          nowMs
        });
        if (trip) newTrips.push(trip);
      }
    }

    // 2. Fleet session spend cap
    if (totalUsd >= this.config.maxSessionUsd) {
      const topSeat = (sortedUsage.find(([id]) => workingIds.has(id)) || sortedUsage[0] || [])[0] || '';
      const trip = await this._triggerTrip({
        rule: 'fleet_spend_cap',
        seatId: topSeat,
        cooldownKey: 'fleet_spend_cap:fleet',
        severity: 'P0',
        title: `Fleet budget cap hit: $${totalUsd.toFixed(2)} >= $${this.config.maxSessionUsd.toFixed(2)}`,
        detail: topSeat ? `Top spender targeted: ${topSeat}.` : 'Total session estimate exceeded budget guardrail.',
        nowMs
      });
      if (trip) newTrips.push(trip);
    }

    // 3. Burn-rate spike ($/hour)
    if (this.burnUsdPerHour >= this.config.maxUsdPerHour) {
      const topWorking = (sortedUsage.find(([id]) => workingIds.has(id)) || sortedUsage[0] || [])[0] || '';
      const trip = await this._triggerTrip({
        rule: 'burn_rate_spike',
        seatId: topWorking,
        cooldownKey: 'burn_rate_spike:fleet',
        severity: 'P1',
        title: `Burn-rate spike: $${this.burnUsdPerHour.toFixed(2)}/h >= $${this.config.maxUsdPerHour.toFixed(2)}/h`,
        detail: topWorking ? `Highest active spend seat: ${topWorking}.` : 'Fleet spend velocity exceeded threshold.',
        nowMs
      });
      if (trip) newTrips.push(trip);
    }

    // 4. QA Bounce-Back Loop cap
    for (const s of Object.values(sliceStats || {})) {
      if (!s || typeof s.checkRounds !== 'number') continue;
      if (s.checkRounds >= this.config.maxQaRounds) {
        const targetSeat = (Array.isArray(s.coders) && s.coders[0]) || '';
        const trip = await this._triggerTrip({
          rule: 'qa_loop_cap',
          seatId: targetSeat,
          cooldownKey: `qa_loop_cap:${s.slice || targetSeat || 'fleet'}`,
          severity: 'P1',
          title: `QA bounce-back loop: ${s.slice || 'slice'} (${s.checkRounds} rounds >= ${this.config.maxQaRounds})`,
          detail: targetSeat ? `Repeated rework detected on ${targetSeat}.` : 'Repeated QA rejections detected.',
          nowMs
        });
        if (trip) newTrips.push(trip);
      }
    }

    return newTrips;
  }

  reset(seatId = null) {
    if (seatId) {
      this.trippedSeats.delete(seatId);
      for (const k of Array.from(this.lastTripAtByKey.keys())) {
        if (k.endsWith(`:${seatId}`)) this.lastTripAtByKey.delete(k);
      }
    } else {
      this.trippedSeats.clear();
      this.lastTripAtByKey.clear();
    }
    return this.getState();
  }

  getState() {
    const status = !this.config.enabled
      ? 'disabled'
      : this.trippedSeats.size > 0
        ? 'tripped'
        : 'armed';
    return {
      status,
      config: this.getConfig(),
      lastSessionUsd: this.lastSessionUsd,
      burnUsdPerHour: this.burnUsdPerHour,
      trippedSeats: Array.from(this.trippedSeats.values()),
      recentTrips: this.recentTrips.slice(0, 15)
    };
  }
}
