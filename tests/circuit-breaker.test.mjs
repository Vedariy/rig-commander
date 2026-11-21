import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetCircuitBreaker } from '../openrig/lib/circuit-breaker.mjs';

test('BudgetCircuitBreaker trips on seat spend cap and triggers auto-stop C-c when armed', async () => {
  const interrupted = [];
  const notified = [];
  const cb = new BudgetCircuitBreaker(
    { mode: 'auto_stop', maxSeatUsd: 4.0, maxSessionUsd: 20.0, cooldownMs: 60_000 },
    {
      onAutoInterrupt: async (seatId, trip) => {
        interrupted.push({ seatId, rule: trip.rule });
        return true;
      },
      onTrip: async (trip) => {
        notified.push(trip);
      }
    }
  );

  const now = 1_700_000_000_000;
  const trips = await cb.evaluate({
    nodes: [{ canonicalSessionName: 'dev-coder4@rig', activityState: { display: 'working' } }],
    seatUsage: { 'dev-coder4@rig': { estUsd: 4.55, model: 'gpt-6.2-sol', cachedPct: 72 } },
    fleetUsageSummary: { totalEstUsd: 4.55 },
    nowMs: now
  });

  assert.equal(trips.length, 1);
  assert.equal(trips[0].rule, 'seat_spend_cap');
  assert.equal(trips[0].actionTaken, 'interrupted_cc');
  assert.deepEqual(interrupted, [{ seatId: 'dev-coder4@rig', rule: 'seat_spend_cap' }]);
  assert.equal(notified.length, 1);
  assert.equal(cb.getState().status, 'tripped');

  // Cooldown suppresses immediate duplicate trip
  const dup = await cb.evaluate({
    nodes: [{ canonicalSessionName: 'dev-coder4@rig', activityState: { display: 'working' } }],
    seatUsage: { 'dev-coder4@rig': { estUsd: 4.65, model: 'gpt-6.2-sol', cachedPct: 72 } },
    fleetUsageSummary: { totalEstUsd: 4.65 },
    nowMs: now + 5_000
  });
  assert.equal(dup.length, 0);

  // Reset restores armed state
  const afterReset = cb.reset();
  assert.equal(afterReset.status, 'armed');
  assert.equal(afterReset.trippedSeats.length, 0);
});

test('BudgetCircuitBreaker detects burn-rate spike ($/h) and QA bounce-back loop in alert_only mode', async () => {
  const interrupted = [];
  const cb = new BudgetCircuitBreaker(
    { mode: 'alert_only', maxSessionUsd: 50, maxSeatUsd: 50, maxUsdPerHour: 10, maxQaRounds: 3 },
    { onAutoInterrupt: async (s) => interrupted.push(s) }
  );

  const t0 = 1_700_000_000_000;
  await cb.evaluate({
    nodes: [{ canonicalSessionName: 'dev-coder4@rig', activityState: { display: 'working' } }],
    seatUsage: { 'dev-coder4@rig': { estUsd: 1.0 } },
    fleetUsageSummary: { totalEstUsd: 1.0 },
    nowMs: t0
  });

  // +15 minutes, spend jumped by $3.50 -> $14.00/h >= $10/h threshold, plus QA rounds = 3
  const trips = await cb.evaluate({
    nodes: [{ canonicalSessionName: 'dev-coder4@rig', activityState: { display: 'working' } }],
    seatUsage: { 'dev-coder4@rig': { estUsd: 4.5 } },
    fleetUsageSummary: { totalEstUsd: 4.5 },
    sliceStats: {
      'auth-flow': { slice: 'auth-flow', checkRounds: 3, coders: ['dev-coder4@rig'] }
    },
    nowMs: t0 + 15 * 60_000
  });

  assert.equal(interrupted.length, 0, 'alert_only mode must never auto-interrupt');
  assert.equal(cb.getState().burnUsdPerHour, 14);
  assert.deepEqual(trips.map(t => t.rule).sort(), ['burn_rate_spike', 'qa_loop_cap']);
});

test('BudgetCircuitBreaker clamps invalid config values and respects disabled state', async () => {
  const cb = new BudgetCircuitBreaker({ enabled: false, maxSeatUsd: -5, maxQaRounds: 1 });
  assert.equal(cb.getState().status, 'disabled');
  assert.equal(cb.getConfig().maxSeatUsd, 5.0);
  assert.equal(cb.getConfig().maxQaRounds, 3);

  const trips = await cb.evaluate({
    seatUsage: { 'a@rig': { estUsd: 999 } },
    fleetUsageSummary: { totalEstUsd: 999 }
  });
  assert.deepEqual(trips, []);
});

test('BudgetCircuitBreaker enforces fleet-level cooldown even when active top-spender rotates', async () => {
  const cb = new BudgetCircuitBreaker({
    mode: 'alert_only',
    maxSessionUsd: 10,
    maxSeatUsd: 100,
    cooldownMs: 300_000
  });
  const t0 = 1_700_000_000_000;
  const first = await cb.evaluate({
    nodes: [{ canonicalSessionName: 'seat-a@rig', activityState: { display: 'working' } }],
    seatUsage: { 'seat-a@rig': { estUsd: 7 }, 'seat-b@rig': { estUsd: 6 } },
    fleetUsageSummary: { totalEstUsd: 13 },
    nowMs: t0
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].rule, 'fleet_spend_cap');

  // 2 seconds later, seat-b becomes the only working seat: fleet cooldown must still suppress duplicate alert
  const second = await cb.evaluate({
    nodes: [{ canonicalSessionName: 'seat-b@rig', activityState: { display: 'working' } }],
    seatUsage: { 'seat-a@rig': { estUsd: 7 }, 'seat-b@rig': { estUsd: 6 } },
    fleetUsageSummary: { totalEstUsd: 13 },
    nowMs: t0 + 2_000
  });
  assert.equal(second.length, 0);
});
