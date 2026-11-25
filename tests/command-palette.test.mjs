import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePaletteQuery,
  fuzzyScore,
  rankPaletteItems,
  pushRecentPaletteId,
  triageQueueItems,
  buildPaletteIndex,
  QUEUE_STALE_PENDING_MS
} from '../openrig/assets/domain/command-palette.js';

test('parsePaletteQuery splits scope prefixes and fuzzyScore ranks prefix/boundary/subsequence deterministically', () => {
  assert.deepEqual(parsePaletteQuery('> compact'), { scope: 'action', text: 'compact' });
  assert.deepEqual(parsePaletteQuery('@coder4'), { scope: 'seat', text: 'coder4' });
  assert.deepEqual(parsePaletteQuery('#stale'), { scope: 'queue', text: 'stale' });
  assert.deepEqual(parsePaletteQuery('  gantt '), { scope: 'all', text: 'gantt' });

  const prefix = fuzzyScore('dev', 'dev-coder@core');
  const mid = fuzzyScore('coder', 'dev-coder@core');
  const subseq = fuzzyScore('dc4', 'dev-coder4@core');
  const miss = fuzzyScore('zzz', 'dev-coder@core');
  assert.ok(prefix.score > mid.score, 'prefix match must outrank mid-string match');
  assert.ok(mid.score > subseq.score, 'substring must outrank sparse subsequence');
  assert.ok(subseq.score > 0);
  assert.deepEqual(subseq.indices.length, 3);
  assert.equal(miss.score, -1);
});

test('rankPaletteItems supports multi-token AND, scope filtering, MRU boost and stable order', () => {
  const items = [
    { id: 'a', kind: 'seat', title: 'dev-coder@core', keywords: ['codex'] },
    { id: 'b', kind: 'seat', title: 'dev-coder4@core', keywords: ['claude'] },
    { id: 'c', kind: 'nav', title: 'Gantt: auth-refresh', keywords: ['gantt'] },
    { id: 'd', kind: 'action', title: 'Compact context: dev-coder4', keywords: ['compact'] }
  ];
  const seatsOnly = rankPaletteItems(items, '@coder');
  assert.deepEqual(seatsOnly.map(i => i.id), ['a', 'b']);

  const multi = rankPaletteItems(items, 'coder4 claude');
  assert.equal(multi.length, 1);
  assert.equal(multi[0].id, 'b');

  const withRecent = rankPaletteItems(items, '', { recentIds: ['c'], groupOrder: [] });
  assert.equal(withRecent[0].id, 'c', 'MRU item must surface first on empty query within the same group tier');

  let mru = [];
  mru = pushRecentPaletteId(mru, 'x');
  mru = pushRecentPaletteId(mru, 'y');
  mru = pushRecentPaletteId(mru, 'x');
  assert.deepEqual(mru, ['x', 'y']);
});

test('triageQueueItems classifies stalled handoffs safely and dedups write remediation per destination seat', () => {
  const nowMs = Date.parse('2026-11-25T12:00:00.000Z');
  const old = new Date(nowMs - QUEUE_STALE_PENDING_MS - 60_000).toISOString();
  const veryOld = new Date(nowMs - 3 * 3600 * 1000).toISOString();
  const fresh = new Date(nowMs - 2 * 60_000).toISOString();
  const openQueue = [
    { qitemId: 'qitem-a1', state: 'pending', sourceSession: 'dev-owner@core', destinationSession: 'dev-coder3@core', tsCreated: old, summary: 'Implement A' },
    { qitemId: 'qitem-a2', state: 'pending', sourceSession: 'dev-owner@core', destinationSession: 'dev-coder3@core', tsCreated: veryOld, summary: 'Implement B' },
    { qitemId: 'qitem-b1', state: 'pending', sourceSession: 'dev-coder@core', destinationSession: 'dev-check@core', tsCreated: fresh, summary: 'QA review' },
    { qitemId: 'qitem-c1', state: 'pending', sourceSession: 'dev-owner@core', destinationSession: 'dev-ghost@core', tsCreated: fresh, summary: 'Lost' },
    { qitemId: 'qitem-d1', state: 'in-progress', sourceSession: 'dev-owner@core', destinationSession: 'dev-coder@core', tsCreated: veryOld, tsUpdated: veryOld, summary: 'Long running' },
    { qitemId: 'qitem-e1', state: 'pending', sourceSession: 'dev-owner@core', destinationSession: 'dev-coder@core', tsCreated: fresh, summary: 'Healthy fresh item' },
    { qitemId: 'qitem-e1', state: 'pending', sourceSession: 'dev-owner@core', destinationSession: 'dev-coder@core', tsCreated: fresh, summary: 'Duplicate row' }
  ];
  const seats = [
    { id: 'dev-coder3@core', state: 'waiting', parked: true },
    { id: 'dev-check@core', state: 'urgent', needsInputCount: 1 },
    { id: 'dev-coder@core', state: 'working' }
  ];
  const tri = triageQueueItems({ openQueue, seats, nowMs, lang: 'en' });

  // Healthy fresh item & duplicate excluded
  assert.equal(tri.items.some(i => i.qitemId === 'qitem-e1'), false);
  assert.equal(tri.total, 5);
  const byId = Object.fromEntries(tri.items.map(i => [i.qitemId, i]));
  assert.equal(byId['qitem-b1'].reason, 'destination_hitl');
  assert.equal(byId['qitem-b1'].severity, 'p0');
  assert.equal(byId['qitem-c1'].reason, 'orphan_destination');
  assert.equal(byId['qitem-a1'].reason, 'destination_parked');
  assert.equal(byId['qitem-d1'].reason, 'stuck_in_progress');
  assert.equal(tri.items[0].severity, 'p0', 'P0 sorted first');

  const remBySeat = Object.fromEntries(tri.seatRemediations.map(r => [r.seatId, r]));
  assert.equal(remBySeat['dev-coder3@core'].count, 2, 'two items, ONE seat remediation');
  assert.equal(remBySeat['dev-coder3@core'].recommended, 'nudge_queue');
  assert.equal(remBySeat['dev-coder3@core'].risk, 'write');
  assert.equal(remBySeat['dev-check@core'].recommended, 'open_screen', 'never nudge a seat stuck on HITL');
  assert.equal(remBySeat['dev-ghost@core'].recommended, 'inspect_only', 'never write to orphan destination');

  // Palette index: triage actions declare risk; no destructive queue mutation types exist
  const idx = buildPaletteIndex({ seats: seats.map(s => ({ ...s })), triage: tri, slices: ['slice:auth'], findings: [], lang: 'ru', isLive: true });
  const nudges = idx.filter(i => i.action.type === 'nudge_queue');
  assert.deepEqual(nudges.map(n => n.action.seatId).sort(), ['dev-coder3@core', 'dev-coder@core'], 'exactly one nudge per eligible seat');
  assert.ok(nudges.every(n => n.risk === 'write'));
  const allowedTypes = new Set(['nudge_queue', 'open_screen', 'clipboard', 'open_context', 'focus_seat', 'compact_context', 'gantt_slice', 'open_view']);
  for (const it of idx) {
    assert.ok(allowedTypes.has(it.action.type), `unexpected action type ${it.action.type}`);
    assert.ok(it.risk === 'read' || it.risk === 'write');
    if (['nudge_queue', 'compact_context'].includes(it.action.type)) assert.equal(it.risk, 'write');
  }
  const ranked = rankPaletteItems(idx, '');
  assert.equal(ranked[0].group, 'triage', 'triage remediation surfaces first on empty query');
  // Groups must be contiguous on empty query (no interleaved headers)
  const seenGroups = [];
  for (const it of ranked) {
    if (seenGroups[seenGroups.length - 1] !== it.group) {
      assert.equal(seenGroups.includes(it.group), false, `group ${it.group} must not reappear after another group`);
      seenGroups.push(it.group);
    }
  }
  // Inside triage group, P0 HITL unblock outranks P1/P2 nudges
  assert.equal(ranked[0].action.type, 'open_screen');
  assert.equal(ranked[0].action.seatId, 'dev-check@core');
});

test('triageQueueItems on real-world shapes: hides daemon noise, knows hidden infra seats, ignores PARKED flag on working seats', () => {
  const nowMs = Date.parse('2026-11-25T12:00:00.000Z');
  const old = new Date(nowMs - 3 * 3600 * 1000).toISOString();
  const openQueue = [
    // Daemon housekeeping noise (opgate id / undelivered-wake summary) — must be hidden, not P1
    { qitemId: 'qitem-opgate-8cbf4ca90af9d9', state: 'pending', pickup: { state: 'unclaimed' }, sourceSession: 'stuck-sweep@kernel', destinationSession: 'advisor-lead@kernel', tsCreated: old, summary: 'Stuck sweep: undelivered-wake on qitem-opgate-x' },
    { qitemId: 'qitem-20261125-noise2', state: 'pending', pickup: { state: 'unclaimed' }, sourceSession: 'dev-owner@pwa', destinationSession: 'dev-owner@pwa', tsCreated: old, summary: 'Wake escalation: 2 baton(s) stuck' },
    // Hidden infra seat that is running → NOT orphan; work is stale but seat is working → P2, not P1
    { qitemId: 'qitem-20261125-guard1', state: 'pending', pickup: { state: 'unclaimed' }, sourceSession: 'operator-agent@kernel', destinationSession: 'operator-context-guardian@kernel', tsCreated: old, summary: 'Context pack refresh' },
    // Hidden infra seat with exited session (not intentional) → destination_offline P1, remediation copy_restart
    { qitemId: 'qitem-20261125-adv1', state: 'pending', pickup: { state: 'unclaimed' }, sourceSession: 'operator-agent@kernel', destinationSession: 'advisor-lead@kernel', tsCreated: old, summary: 'Review advisory' },
    // Seat flagged parked but actively working → stale (P2), never "parked" P1, pickup=working counts as in-progress
    { qitemId: 'qitem-20261125-own1', state: 'pending', pickup: { state: 'unclaimed' }, sourceSession: 'dev-coder@pwa', destinationSession: 'dev-owner@pwa', tsCreated: old, summary: 'Accept slice' },
    { qitemId: 'qitem-20261125-own2', state: 'pending', pickup: { state: 'working' }, sourceSession: 'dev-coder@pwa', destinationSession: 'dev-owner@pwa', tsCreated: old, tsUpdated: new Date(nowMs - 10 * 60000).toISOString(), summary: 'Active pickup' }
  ];
  const seats = [
    { id: 'operator-context-guardian@kernel', state: 'working', sessionStatus: 'running' },
    { id: 'advisor-lead@kernel', state: 'idle', sessionStatus: 'exited', intentionallyStopped: false },
    { id: 'dev-owner@pwa', state: 'working', parked: true, sessionStatus: 'running' }
  ];
  const tri = triageQueueItems({ openQueue, seats, nowMs, lang: 'ru' });
  const byId = Object.fromEntries(tri.items.map(i => [i.qitemId, i]));

  assert.equal(tri.noiseCount, 2, 'daemon sweep/wake rows counted as noise');
  assert.equal(byId['qitem-opgate-8cbf4ca90af9d9'], undefined);
  assert.equal(tri.items.some(i => i.reason === 'orphan_destination'), false, 'hidden infra seats are known, not orphans');
  assert.equal(byId['qitem-20261125-guard1'].reason, 'stale_pending');
  assert.equal(byId['qitem-20261125-guard1'].severity, 'p2', 'working destination lowers stale severity');
  assert.equal(byId['qitem-20261125-adv1'].reason, 'destination_offline');
  assert.equal(byId['qitem-20261125-adv1'].severity, 'p1');
  assert.equal(byId['qitem-20261125-own1'].reason, 'stale_pending', 'PARKED flag ignored while seat is working');
  assert.equal(byId['qitem-20261125-own2'], undefined, 'pickup=working with recent update is healthy in-progress');

  const rem = Object.fromEntries(tri.seatRemediations.map(r => [r.seatId, r]));
  assert.equal(rem['advisor-lead@kernel'].recommended, 'copy_restart');
  assert.equal(rem['advisor-lead@kernel'].risk, 'read', 'offline seat never receives terminal writes');

  // Intentionally stopped seat → inspect only, P2
  const tri2 = triageQueueItems({
    openQueue: [openQueue[3]],
    seats: [{ id: 'advisor-lead@kernel', state: 'idle', sessionStatus: 'exited', intentionallyStopped: true }],
    nowMs,
    lang: 'en'
  });
  assert.equal(tri2.items[0].reason, 'destination_stopped');
  assert.equal(tri2.seatRemediations[0].recommended, 'inspect_only');
});
