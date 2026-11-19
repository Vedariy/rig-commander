import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionAuditLog, inferActionId, extractSeatBaseline } from '../openrig/lib/action-audit.mjs';
import { buildOntologySnapshot, getActionRecordsForSeat } from '../openrig/assets/ontology/index.js';

test('inferActionId maps raw and key payloads to canonical action IDs', () => {
  assert.equal(inferActionId('raw', '/compact'), 'compact_context');
  assert.equal(inferActionId('key', 'C-c'), 'interrupt_execution');
  assert.equal(inferActionId('key', 'Escape'), 'cancel_prompt');
  assert.equal(inferActionId('key', 'Enter'), 'wake_parked_seat');
  assert.equal(inferActionId('key', '2 Enter'), 'answer_prompt_option');
  assert.equal(inferActionId('msg', 'hello'), 'send_message');
});

test('ActionAuditLog verifies compact_context when context drops by >= 10%', () => {
  const log = new ActionAuditLog({ maxRecords: 10, timeoutMs: 45_000 });
  const t0 = 1_700_000_000_000;
  const baseline = extractSeatBaseline({
    canonicalSessionName: 'dev-owner@rig',
    contextUsage: { usedPercentage: 78 },
    activityState: { display: 'idle' }
  }, null);

  const rec = log.record({
    actionId: 'compact_context',
    seatId: 'dev-owner@rig',
    type: 'raw',
    payload: '/compact',
    httpStatus: 200,
    ok: true,
    baseline,
    nowMs: t0
  });
  assert.equal(rec.postconditionStatus, 'pending');

  // Tick 1: still 78% -> remains pending
  log.reconcileWithTelemetry([
    { canonicalSessionName: 'dev-owner@rig', contextUsage: { usedPercentage: 78 }, activityState: { display: 'working' } }
  ], {}, t0 + 4000);
  assert.equal(log.list(5)[0].postconditionStatus, 'pending');

  // Tick 2: compacted down to 16% -> verified
  log.reconcileWithTelemetry([
    { canonicalSessionName: 'dev-owner@rig', contextUsage: { usedPercentage: 16 }, activityState: { display: 'idle' } }
  ], {}, t0 + 12_000);
  const latest = log.list(5)[0];
  assert.equal(latest.postconditionStatus, 'verified');
  assert.match(latest.postconditionDetail, /78% → 16%/);
});

test('ActionAuditLog verifies prompt answer, wake and interrupt, and marks unchanged after timeout', () => {
  const log = new ActionAuditLog({ maxRecords: 5, timeoutMs: 30_000 });
  const t0 = 1_700_000_000_000;

  log.record({
    actionId: 'answer_prompt_option',
    seatId: 'dev-coder@rig',
    type: 'key',
    payload: '2 Enter',
    httpStatus: 200,
    ok: true,
    baseline: { displayState: 'needs-input', needsInputCount: 1 },
    nowMs: t0
  });

  log.record({
    actionId: 'wake_parked_seat',
    seatId: 'dev-check@rig',
    type: 'key',
    payload: 'Enter',
    httpStatus: 200,
    ok: true,
    baseline: { parked: true, lastActivityAt: '2026-11-19T10:00:00Z' },
    nowMs: t0
  });

  log.record({
    actionId: 'interrupt_execution',
    seatId: 'dev-stuck@rig',
    type: 'key',
    payload: 'C-c',
    httpStatus: 200,
    ok: true,
    baseline: { displayState: 'working' },
    nowMs: t0
  });

  // dev-coder leaves needs-input, dev-check unparks, dev-stuck stays working past timeout
  log.reconcileWithTelemetry([
    { canonicalSessionName: 'dev-coder@rig', activityState: { display: 'working', needsInput: { count: 0 } } },
    { canonicalSessionName: 'dev-check@rig', activityState: { display: 'working' }, lastActivityAt: '2026-11-19T10:01:00Z' },
    { canonicalSessionName: 'dev-stuck@rig', activityState: { display: 'working' } }
  ], {
    'dev-check@rig': { parked: false }
  }, t0 + 35_000);

  const bySeat = Object.fromEntries(log.list(10).map(r => [r.targetSeatId, r]));
  assert.equal(bySeat['dev-coder@rig'].postconditionStatus, 'verified');
  assert.equal(bySeat['dev-check@rig'].postconditionStatus, 'verified');
  assert.equal(bySeat['dev-stuck@rig'].postconditionStatus, 'unchanged');

  // Verify snapshot selector exposes actionRecords per seat
  const snap = buildOntologySnapshot({ actionAudit: log.list(10), nodes: [], availableRigs: [] });
  const coderRecords = getActionRecordsForSeat(snap, 'dev-coder@rig');
  assert.equal(coderRecords.length, 1);
  assert.equal(coderRecords[0].actionId, 'answer_prompt_option');
});

test('ActionAuditLog enforces ring buffer capacity and records failed actions immediately as failed', () => {
  const log = new ActionAuditLog({ maxRecords: 2 });
  log.record({ seatId: 's1', type: 'key', payload: '-X', httpStatus: 400, ok: false, nowMs: 1000 });
  log.record({ seatId: 's2', type: 'key', payload: 'Enter', httpStatus: 200, ok: true, nowMs: 2000 });
  log.record({ seatId: 's3', type: 'key', payload: 'C-c', httpStatus: 200, ok: true, nowMs: 3000 });

  const all = log.list(10);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(r => r.targetSeatId), ['s3', 's2']);

  const failedLog = new ActionAuditLog({ maxRecords: 5 });
  const f = failedLog.record({ seatId: 's1', type: 'key', payload: '-X', httpStatus: 400, ok: false });
  assert.equal(f.postconditionStatus, 'failed');
});
