import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGanttItemNoise,
  normalizeGanttSpans,
  packLaneIntervals,
  buildGanttLanes,
  buildHandoffSequenceModel,
  formatGanttDuration
} from '../openrig/assets/domain/gantt-model.js';

const NOW = Date.parse('2026-11-24T01:00:00.000Z');
const minAgo = (m) => new Date(NOW - m * 60_000).toISOString();

test('isGanttItemNoise catches Wake escalation, recovery-for, opgate and change-detector while keeping real slices', () => {
  assert.equal(isGanttItemNoise({
    id: 'qitem-20261123200340-a726047b',
    from: 'devin-orchestrator@external',
    to: 'dev-senior-architector@rig',
    chain: 'q:qitem-recovery-e2eeefc3707e2fae',
    slice: '',
    summary: 'Wake escalation: 1 baton(s) stuck at dev-senior-architector@rig'
  }), true);

  assert.equal(isGanttItemNoise({
    id: 'qitem-opgate-1',
    from: 'operator-change-detector@external',
    to: 'dev-operator@rig',
    summary: 'check'
  }), true);

  assert.equal(isGanttItemNoise({
    id: 'qitem-real-1',
    from: 'dev-owner@rig',
    to: 'dev-check-argon@rig',
    chain: 'slice:0147-merge',
    slice: '0147-merge',
    summary: 'QA: Track M merge candidate-v1'
  }), false);
});

test('packLaneIntervals assigns non-overlapping subRows to concurrent bars on the same lane', () => {
  const spans = [
    { id: 'a', created: NOW - 100 * 60_000, endT: NOW - 40 * 60_000 },
    { id: 'b', created: NOW - 90 * 60_000, endT: NOW - 60 * 60_000 },
    { id: 'c', created: NOW - 80 * 60_000, endT: NOW - 20 * 60_000 },
    { id: 'd', created: NOW - 55 * 60_000, endT: NOW - 10 * 60_000 } // fits cleanly after 'b' on subRow 1!
  ];
  const res = packLaneIntervals(spans, 60_000);
  assert.equal(res.trackCount, 3);

  // Verify zero pairwise overlap on any subRow
  const byRow = new Map();
  for (const sp of res.spans) {
    if (!byRow.has(sp.subRow)) byRow.set(sp.subRow, []);
    byRow.get(sp.subRow).push(sp);
  }
  for (const list of byRow.values()) {
    list.sort((x, y) => x.created - y.created);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].endT <= list[i].created, `Overlap detected on subRow ${list[i].subRow}`);
    }
  }
  // 'd' reused subRow 1 after 'b' ended
  const bRow = res.spans.find(s => s.id === 'b').subRow;
  const dRow = res.spans.find(s => s.id === 'd').subRow;
  assert.equal(bRow, dRow);
});

test('normalizeGanttSpans computes Wait vs Work KPIs, hides noise by default, and supports By-Agent vs By-Chain grouping', () => {
  const raw = [
    // Noise row (should be hidden when hideNoise=true)
    {
      id: 'q-noise',
      from: 'devin-orchestrator@external',
      to: 'dev-senior@rig',
      chain: 'q:qitem-recovery-123',
      slice: '',
      state: 'done',
      summary: 'Wake escalation: 1 baton(s) stuck',
      createdAt: minAgo(180),
      claimedAt: null,
      endAt: minAgo(90)
    },
    // Overlapping tasks on dev-owner + long wait on slice:0147-a4
    {
      id: 'q-1',
      from: 'dev-senior@rig',
      to: 'dev-owner@rig',
      chain: 'slice:0147-a4',
      slice: '0147-a4',
      state: 'handed-off',
      summary: 'Candidate C5 ready',
      createdAt: minAgo(120),
      claimedAt: minAgo(90), // 30m wait (>15m => longWait!)
      endAt: minAgo(80)      // 10m work
    },
    {
      id: 'q-overlap',
      from: 'dev-coder@rig',
      to: 'dev-owner@rig',
      chain: 'slice:viewer-chat',
      slice: 'viewer-chat',
      state: 'done',
      summary: 'Concurrent slice on dev-owner',
      createdAt: minAgo(115),
      claimedAt: minAgo(110),
      endAt: minAgo(85)
    },
    {
      id: 'q-2',
      from: 'dev-owner@rig',
      to: 'dev-check@rig',
      chain: 'slice:0147-a4',
      slice: '0147-a4',
      state: 'handed-off',
      summary: 'QA round 1',
      createdAt: minAgo(79),
      claimedAt: minAgo(77),
      endAt: minAgo(55)
    },
    {
      id: 'q-3',
      from: 'dev-check@rig',
      to: 'dev-owner@rig',
      chain: 'slice:0147-a4',
      slice: '0147-a4',
      state: 'handed-off',
      summary: 'QA bounce: P1 race found',
      createdAt: minAgo(54),
      claimedAt: minAgo(52),
      endAt: minAgo(45)
    },
    {
      id: 'q-4',
      from: 'dev-owner@rig',
      to: 'dev-check@rig',
      chain: 'slice:0147-a4',
      slice: '0147-a4',
      state: 'in-progress',
      summary: 'QA round 2 recheck',
      createdAt: minAgo(20),
      claimedAt: minAgo(18),
      endAt: null
    }
  ];

  const model = normalizeGanttSpans(raw, { nowMs: NOW, windowH: 6, rigFilter: 'rig', hideNoise: true });
  assert.equal(model.kpis.hiddenNoiseCount, 1);
  assert.equal(model.spans.length, 5);
  assert.equal(model.kpis.longWaitCount, 1);
  assert.equal(model.kpis.qaBounceCount, 1);
  assert.equal(model.kpis.topBottleneck.id, 'q-1');
  assert.equal(model.kpis.topBottleneck.waitMs, 30 * 60_000);
  assert.equal(model.kpis.waitPct + model.kpis.workPct, 100);

  // By-Agent lanes must pack overlapping dev-owner spans onto 2 sub-rows
  const agentLanes = buildGanttLanes(model.spans, { groupBy: 'agent', minGapMs: 60_000 });
  const ownerLane = agentLanes.find(l => l.key === 'dev-owner@rig');
  assert.ok(ownerLane);
  assert.equal(ownerLane.trackCount, 2);

  // By-Chain lanes must list slice:0147-a4 first (has open in-progress step)
  const chainLanes = buildGanttLanes(model.spans, { groupBy: 'chain', minGapMs: 60_000 });
  assert.equal(chainLanes.length, 2);
  assert.equal(chainLanes[0].key, 'slice:0147-a4');
  assert.equal(chainLanes[0].qaRounds, 2);

  // Handoff Sequence scopes strictly to slice:0147-a4 participants & annotates bounce-back
  const seq = buildHandoffSequenceModel(model.allWindowSpans, { focusChain: 'slice:0147-a4' });
  assert.equal(seq.activeChain, 'slice:0147-a4');
  assert.deepEqual(seq.participants, ['dev-owner@rig', 'dev-senior@rig', 'dev-check@rig']);
  assert.equal(seq.steps.length, 4);
  assert.equal(seq.steps[2].isBounceBack, true);
  assert.equal(seq.stats.qaRounds, 2);
  assert.equal(seq.stats.bounceCount, 1);

  assert.equal(formatGanttDuration(90_000, 'en'), '2m');
  assert.equal(formatGanttDuration(3_900_000, 'ru'), '1ч 5м');
});
