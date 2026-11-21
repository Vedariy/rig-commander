import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldIncludeLiveNode,
  updateContextHistory,
  buildOntologySnapshot,
  getSeatActiveObligation,
  getSituationsForSeat,
  getFleetBudgetRows,
  classifyModelPool,
  computeModelPools
} from '../openrig/assets/ontology/index.js';

test('shouldIncludeLiveNode filters internal workers but preserves dynamic terminal agent seats', () => {
  assert.equal(shouldIncludeLiveNode({ canonicalSessionName: 'operator-human@kernel', nodeKind: 'infrastructure' }), false);
  assert.equal(shouldIncludeLiveNode({ canonicalSessionName: 'queue-worker@kernel', nodeKind: 'agent' }), false);
  assert.equal(shouldIncludeLiveNode({ canonicalSessionName: 'advisor-lead@kernel', nodeKind: 'agent' }), false);
  assert.equal(shouldIncludeLiveNode({ canonicalSessionName: 'operator-agent@kernel', nodeKind: 'agent' }), true);
  assert.equal(shouldIncludeLiveNode({ canonicalSessionName: 'random-daemon@rig', nodeKind: 'infrastructure' }), false);
  assert.equal(shouldIncludeLiveNode({ canonicalSessionName: 'dev-check-argon@rig', nodeKind: 'infrastructure', runtime: 'terminal' }), true);
});

test('updateContextHistory tracks progression and resets on compaction drop (>5%)', () => {
  const h1 = updateContextHistory([], 20, 1000);
  const h2 = updateContextHistory(h1, 35, 62_000);
  assert.equal(h2.length, 2);
  const h3 = updateContextHistory(h2, 10, 120_000);
  assert.equal(h3.length, 1);
  assert.equal(h3[0].pct, 10);
});

test('buildOntologySnapshot normalizes rigs, seats, sessions, chains, obligations and situations', () => {
  const raw = {
    timestamp: '2026-11-19T20:00:00.000Z',
    requestedRig: 'core-platform',
    availableRigs: [
      { id: 'rig-1', name: 'core-platform', status: 'running', nodeCount: 3, runningCount: 3 }
    ],
    nodes: [
      {
        canonicalSessionName: 'dev-owner@core-platform',
        rigId: 'rig-1',
        runtime: 'codex',
        modelObservation: { model: 'gpt-6.1-sol' },
        effort: 'high',
        contextUsage: { usedPercentage: 78, contextWindowSize: 475000, totalInputTokens: 370000 },
        activityState: { display: 'idle' },
        assignedWorkCount: 1
      },
      {
        canonicalSessionName: 'dev-coder@core-platform',
        rigId: 'rig-1',
        runtime: 'claude-code',
        modelObservation: { model: 'glm-5.3-flash' },
        contextUsage: { usedPercentage: 15, contextWindowSize: 1000000 },
        activityState: { display: 'needs-input', needsInput: { count: 1, reason: 'Approve command' } },
        assignedWorkCount: 2
      },
      {
        canonicalSessionName: 'dev-check-argon@core-platform',
        rigId: 'rig-1',
        nodeKind: 'infrastructure',
        runtime: 'terminal',
        activityState: { display: 'working' },
        assignedWorkCount: 1
      }
    ],
    activeQueue: [
      { qitemId: 'q-pend', sourceSession: 'dev-owner@core-platform', destinationSession: 'dev-coder@core-platform', state: 'pending', tags: ['slice:auth'], summary: 'Queued follow-up' },
      { qitemId: 'q-prog', sourceSession: 'dev-owner@core-platform', destinationSession: 'dev-coder@core-platform', state: 'in-progress', tags: ['slice:auth'], summary: 'Active work' }
    ],
    history: {
      nodeTraffic: { 'dev-owner@core-platform': { in: 10, out: 12 } },
      ganttItems: [
        { id: 'g1', from: 'dev-owner@core-platform', to: 'dev-check-argon@core-platform', chain: 'slice:auth', slice: 'auth', state: 'done' },
        { id: 'g2', from: 'dev-coder@core-platform', to: 'dev-check-argon@core-platform', chain: 'slice:auth', slice: 'auth', state: 'done' },
        { id: 'g3', from: 'dev-coder@core-platform', to: 'dev-check-argon@core-platform', chain: 'slice:auth', slice: 'auth', state: 'in-progress', endAt: null }
      ]
    },
    parkedSeats: {
      'dev-owner@core-platform': { parked: true, reason: 'Open obligation without wake', openCount: 1, heldCount: 0 }
    },
    seatUsage: {
      'dev-owner@core-platform': { model: 'gpt-6.1-sol', tier: 'Tier 3', totalTokens: 500000, estUsd: 12.5, cachedPct: 90 },
      'dev-coder@core-platform': { model: 'glm-5.3-flash', tier: 'Tier 1', totalTokens: 200000, estUsd: 0.4, cachedPct: 80 }
    },
    fleetUsageSummary: { totalTokens: 700000, totalEstUsd: 12.9, cachedPct: 87 }
  };

  const snap = buildOntologySnapshot(raw, null, 1_700_000_000_000);
  assert.equal(snap.hasLiveDaemonData, true);
  assert.equal(snap.seats.length, 3);
  assert.equal(snap.seatsById['dev-owner@core-platform'].operationalState, 'parked');
  assert.equal(snap.seatsById['dev-coder@core-platform'].operationalState, 'urgent');
  assert.equal(snap.seatsById['dev-check-argon@core-platform'].operationalState, 'working');
  assert.equal(snap.sessionsBySeatId['dev-owner@core-platform'].model, 'gpt-6.1-sol (high*)');

  // Chain rework calculation (3 QA passes -> hasExcessiveRework = true)
  assert.equal(snap.chainsById['slice:auth'].qaRounds, 3);
  assert.equal(snap.chainsById['slice:auth'].hasExcessiveRework, true);

  // Active obligation selector prefers in-progress over pending
  const activeOb = getSeatActiveObligation(snap, 'dev-coder@core-platform');
  assert.equal(activeOb.primary.qitemId, 'q-prog');
  assert.equal(activeOb.totalCount, 2);

  // Situations sorted P0 -> P1
  assert.equal(snap.situations[0].severity, 'P0');
  assert.equal(snap.situations[0].targetSeatId, 'dev-coder@core-platform');
  const ownerSits = getSituationsForSeat(snap, 'dev-owner@core-platform');
  assert.equal(ownerSits.length, 2); // parked + ctx >= 75

  // Budget rows sorted by estUsd descending
  const budgetRows = getFleetBudgetRows(snap);
  assert.deepEqual(budgetRows.map(r => r.seatId), ['dev-owner@core-platform', 'dev-coder@core-platform']);

  // Second tick preserves and extends ctxHistory
  const raw2 = structuredClone(raw);
  raw2.nodes[0].contextUsage.usedPercentage = 81;
  const snap2 = buildOntologySnapshot(raw2, snap, 1_700_000_065_000);
  assert.equal(snap2.sessionsBySeatId['dev-owner@core-platform'].ctxHistory.length, 2);
});

test('computeModelPools classifies seats exclusively (model-first), respects rigFilter and aggregates usage', () => {
  const agents = [
    { id: 'dev-owner@rig-a', shortName: 'dev-owner', harness: 'codex', model: 'gpt-6.2-sol', state: 'idle', ctxPct: 56, usage: { totalTokens: 500_000, estUsd: 12.5 } },
    { id: 'dev-coder@rig-a', shortName: 'dev-coder', harness: 'claude-code', model: 'glm-5.3-flash', state: 'idle', ctxPct: 22, usage: { totalTokens: 300_000, estUsd: 0.9 } },
    { id: 'dev-operator@rig-a', shortName: 'dev-operator', harness: 'terminal', model: 'terminal', state: 'working', ctxPct: null },
    { id: 'dev-coder@rig-b', shortName: 'dev-coder-b', harness: 'claude-code', model: 'claude-sonnet-4', state: 'working', ctxPct: 40 }
  ];

  assert.equal(classifyModelPool(agents[1]), 'fast-open');
  assert.equal(classifyModelPool(agents[2]), 'terminal-agy');

  const allPools = computeModelPools(agents, 'all');
  const totalSeats = allPools.reduce((sum, p) => sum + p.seatCount, 0);
  assert.equal(totalSeats, agents.length);

  const rigAPools = computeModelPools(agents, 'rig-a');
  assert.equal(rigAPools.reduce((sum, p) => sum + p.seatCount, 0), 3);
  assert.equal(rigAPools.some(p => p.id === 'claude'), false);

  const codex = rigAPools.find(p => p.id === 'codex-gpt');
  assert.equal(codex.activeCount, 0);
  assert.equal(codex.peakCtx, 56);
  assert.equal(codex.totalEstUsd, 12.5);

  const term = rigAPools.find(p => p.id === 'terminal-agy');
  assert.equal(term.activeCount, 1);
  assert.equal(term.hasValidCtx, false);
  assert.equal(term.peakCtx, null);
  assert.equal(term.statusLabel, '1/1 ACTIVE');
});
