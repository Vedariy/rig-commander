import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionFlightGuard,
  ServerIdempotencyCache,
  buildSeatScopeKey,
  buildSeatSendKey,
  buildEndpointScopeKey
} from '../openrig/assets/domain/action-guard.js';

test('ActionFlightGuard blocks concurrent double-clicks on same seat and isolates other seats', async () => {
  let now = 10_000;
  const guard = new ActionFlightGuard({ defaultCooldownMs: 1800, nowFn: () => now });
  const seatA = buildSeatScopeKey('dev-check@core-platform');
  const seatB = buildSeatScopeKey('dev-coder@core-platform');
  const fp1 = buildSeatSendKey('dev-check@core-platform', 'key', '1 Enter');
  const fp2 = buildSeatSendKey('dev-check@core-platform', 'key', '2 Enter');

  const acq1 = guard.tryAcquire({ scopeKey: seatA, fingerprint: fp1, cooldownMs: 2000 });
  assert.equal(acq1.allowed, true);
  assert.equal(guard.isLocked(seatA, fp1), true);

  // Concurrent click on SAME seat (even a different option!) MUST be blocked while in flight
  const dupInFlight = guard.tryAcquire({ scopeKey: seatA, fingerprint: fp2, cooldownMs: 2000 });
  assert.equal(dupInFlight.allowed, false);
  assert.equal(dupInFlight.reason, 'in_flight');

  // Different seat B is completely unaffected
  const acqB = guard.tryAcquire({ scopeKey: seatB, fingerprint: buildSeatSendKey('dev-coder@core-platform', 'key', 'Enter') });
  assert.equal(acqB.allowed, true);
  acqB.release({ applyCooldown: true });

  // Release A -> exact same command stays in cooldown for 2000ms (double-click protection)
  acq1.release({ applyCooldown: true });
  now += 500;
  const dupCooldown = guard.tryAcquire({ scopeKey: seatA, fingerprint: fp1, cooldownMs: 2000 });
  assert.equal(dupCooldown.allowed, false);
  assert.equal(dupCooldown.reason, 'cooldown');
  assert.equal(dupCooldown.remainingMs, 1500);

  // After cooldown expires, same command is allowed again
  now += 1500;
  const afterCooldown = guard.tryAcquire({ scopeKey: seatA, fingerprint: fp1, cooldownMs: 2000 });
  assert.equal(afterCooldown.allowed, true);
  afterCooldown.release({ applyCooldown: true });
});

test('ActionFlightGuard.runGuarded releases without cooldown on failure so operator can retry immediately', async () => {
  let now = 20_000;
  let calls = 0;
  const guard = new ActionFlightGuard({ defaultCooldownMs: 1800, nowFn: () => now });
  const opts = {
    scopeKey: buildEndpointScopeKey('/api/guardrails/config'),
    fingerprint: 'cfg-save',
    cooldownMs: 2000
  };

  await assert.rejects(
    () => guard.runGuarded(opts, async () => {
      calls += 1;
      throw new Error('network error');
    }),
    /network error/
  );
  assert.equal(calls, 1);
  assert.equal(guard.isLocked(opts.scopeKey, opts.fingerprint), false);

  // Immediate retry succeeds
  const retry = await guard.runGuarded(opts, async ({ idempotencyKey }) => {
    calls += 1;
    assert.ok(idempotencyKey.startsWith('req-'));
    return 'saved';
  });
  assert.equal(retry.skipped, false);
  assert.equal(retry.value, 'saved');
  assert.equal(calls, 2);

  // Immediate duplicate click right after success is suppressed
  let blockedReason = '';
  const dup = await guard.runGuarded({ ...opts, onBlocked: r => { blockedReason = r.reason; } }, async () => {
    calls += 1;
    return 'should-not-run';
  });
  assert.equal(dup.skipped, true);
  assert.equal(blockedReason, 'cooldown');
  assert.equal(calls, 2);
});

test('ServerIdempotencyCache replays exact idempotencyKey and rejects rapid semantic double-sends', () => {
  let now = 50_000;
  const cache = new ServerIdempotencyCache({
    keyTtlMs: 30_000,
    semanticTtlMs: 1500,
    nowFn: () => now
  });
  const semanticKey = buildSeatSendKey('dev-check@core-platform', 'key', '1 Enter');

  const tx1 = cache.begin({ idempotencyKey: 'req-abc', seatId: 'dev-check@core-platform', semanticKey });
  assert.equal(tx1.action, 'proceed');

  // While tx1 is in-flight, another request to the same seat is rejected with 409
  const concurrent = cache.begin({ idempotencyKey: 'req-xyz', seatId: 'dev-check@core-platform', semanticKey: 'other' });
  assert.equal(concurrent.action, 'reject');
  assert.equal(concurrent.status, 409);

  tx1.complete(200, { ok: true, execId: 'exec-1' });

  // Network retry with the EXACT same idempotencyKey replays cached 200 without re-executing tmux!
  const replay = cache.begin({ idempotencyKey: 'req-abc', seatId: 'dev-check@core-platform', semanticKey });
  assert.equal(replay.action, 'replay');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.deduplicated, true);
  assert.equal(replay.body.execId, 'exec-1');

  // Different key sending the EXACT same command within 1.5s semantic window is rejected with 409!
  now += 400;
  const semDup = cache.begin({ idempotencyKey: 'req-second-click', seatId: 'dev-check@core-platform', semanticKey });
  assert.equal(semDup.action, 'reject');
  assert.equal(semDup.status, 409);

  // After semantic window expires (1500ms), a deliberate new command proceeds
  now += 1200;
  const tx2 = cache.begin({ idempotencyKey: 'req-deliberate', seatId: 'dev-check@core-platform', semanticKey });
  assert.equal(tx2.action, 'proceed');
  tx2.abort();
  assert.equal(cache.inFlightSeats.size, 0);
});
