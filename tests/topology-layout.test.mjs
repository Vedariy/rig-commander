import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_LAYOUT_MODES,
  classifyNodeActivityTier,
  estimateNodeBox,
  computeTopologyLayout,
  computeAnchoredPopoverRect
} from '../openrig/assets/domain/topology-layout.js';

function makeAgent(id, opts = {}) {
  const shortName = opts.shortName || id.split('@')[0];
  return {
    id,
    shortName,
    displayTitle: opts.displayTitle || shortName,
    state: opts.state || 'idle',
    ctxPct: opts.ctxPct ?? null,
    ctxWindowSize: opts.ctxWindowSize ?? (opts.ctxPct != null ? 475000 : null),
    callsIn: opts.callsIn ?? 0,
    callsOut: opts.callsOut ?? 0,
    assignedWorkCount: opts.assignedWorkCount ?? 0,
    shellExited: Boolean(opts.shellExited)
  };
}

function makeScreenshotFleet() {
  const agents = [
    makeAgent('dev-owner@demo-rig', { state: 'waiting', ctxPct: 69, callsIn: 513, callsOut: 467, assignedWorkCount: 37 }),
    makeAgent('dev-senior-architector@demo-rig', { shortName: 'dev-senior-architect', displayTitle: 'dev-senior-architect', state: 'idle', ctxPct: 65, callsIn: 76, callsOut: 65 }),
    makeAgent('dev-operator@demo-rig', { state: 'waiting', callsIn: 526, callsOut: 78, assignedWorkCount: 161, shellExited: true }),
    makeAgent('dev-coder@demo-rig', { state: 'waiting', ctxPct: 22, ctxWindowSize: 1000000, callsIn: 48, callsOut: 52, assignedWorkCount: 1 }),
    makeAgent('dev-coder2@demo-rig', { state: 'idle' }),
    makeAgent('dev-coder3@demo-rig', { state: 'idle', callsIn: 25, callsOut: 26 }),
    makeAgent('dev-coder4@demo-rig', { state: 'idle', ctxPct: 46, callsIn: 90, callsOut: 72 }),
    makeAgent('dev-coder5@demo-rig', { state: 'idle', callsIn: 3, callsOut: 2 }),
    makeAgent('dev-check@demo-rig', { state: 'idle', ctxPct: 5, ctxWindowSize: 1000000, callsIn: 94, callsOut: 86 }),
    makeAgent('dev-check-argon@demo-rig', { state: 'working', callsIn: 28, callsOut: 8, assignedWorkCount: 1 })
  ];
  const edges = [
    { from: 'dev-senior-architector@demo-rig', to: 'dev-owner@demo-rig', queueStatus: 'live', liveActive: true, slice: '0147-live' },
    { from: 'dev-check-argon@demo-rig', to: 'dev-owner@demo-rig', queueStatus: 'pending', liveActive: false, slice: 'track-l' },
    { from: 'dev-owner@demo-rig', to: 'dev-coder@demo-rig', queueStatus: 'ghost', liveActive: false, calls: 48 },
    { from: 'dev-owner@demo-rig', to: 'dev-coder4@demo-rig', queueStatus: 'ghost', liveActive: false, calls: 90 },
    { from: 'dev-owner@demo-rig', to: 'dev-operator@demo-rig', queueStatus: 'ghost', liveActive: false, calls: 78 }
  ];
  return { agents, edges };
}

function getBoxRect(agent, pos, tier, cw, ch, detailed = false) {
  const b = estimateNodeBox(agent, tier, { detailed });
  const cx = (pos.x / 100) * cw;
  const cy = (pos.y / 100) * ch;
  return {
    id: agent.id,
    cx,
    cy,
    left: cx - b.width / 2,
    right: cx + b.width / 2,
    top: cy - b.height / 2,
    bottom: cy + b.height / 2,
    width: b.width,
    height: b.height
  };
}

function assertNoRectOverlaps(agents, result, cw, ch, detailed = false) {
  const rects = agents.map(a => getBoxRect(a, result.positions[a.id], result.tiers[a.id], cw, ch, detailed));
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    assert.ok(r.left >= 0 && r.right <= cw, `${r.id} escaped horizontal bounds: [${r.left}, ${r.right}] vs 0..${cw}`);
    assert.ok(r.top >= 0 && r.bottom <= ch, `${r.id} escaped vertical bounds: [${r.top}, ${r.bottom}] vs 0..${ch}`);
    for (let j = i + 1; j < rects.length; j++) {
      const q = rects[j];
      const overlaps = r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top;
      assert.equal(overlaps, false, `Rect overlap between ${r.id} and ${q.id}`);
    }
  }
}

test('classifyNodeActivityTier promotes working, urgent, active-edge endpoints, and hysteresis nodes', () => {
  const { agents, edges } = makeScreenshotFleet();
  const res = classifyNodeActivityTier(agents, edges);
  assert.equal(res.tiers['dev-owner@demo-rig'], 'active');
  assert.equal(res.tiers['dev-senior-architector@demo-rig'], 'active');
  assert.equal(res.tiers['dev-check-argon@demo-rig'], 'active');
  assert.equal(res.tiers['dev-coder@demo-rig'], 'dormant');
  assert.equal(res.tiers['dev-operator@demo-rig'], 'dormant');
  assert.equal(res.tiers['dev-coder4@demo-rig'], 'dormant');
  assert.equal(res.activeNodes.length, 3);
  assert.equal(res.dormantNodes.length, 7);

  // Hysteresis keeps recently active node on stage in dynamic mode
  const held = classifyNodeActivityTier(agents, edges, {
    recentActiveIds: new Set(['dev-coder4@demo-rig']),
    useHysteresis: true
  });
  assert.equal(held.tiers['dev-coder4@demo-rig'], 'active');
  assert.equal(held.activeNodes.length, 4);
});

test('dynamic mode gives active pair spacious edge-badge clearance and docks 7 sleepers cleanly at bottom', () => {
  const { agents, edges } = makeScreenshotFleet();
  const cw = 860;
  const ch = 460;
  const res = computeTopologyLayout({ agents, edges, mode: 'dynamic', canvasWidth: cw, canvasHeight: ch });

  assert.equal(res.mode, 'dynamic');
  assert.equal(res.activeCount, 3);
  assert.equal(res.dormantCount, 7);
  assert.ok(typeof res.benchSeparatorY === 'number' && res.benchSeparatorY >= 60 && res.benchSeparatorY <= 86);

  assertNoRectOverlaps(agents, res, cw, ch);

  // Communicating pair dev-owner <-> dev-senior-architect must have generous border-to-border gap (>= 130px)
  const ownerR = getBoxRect(agents[0], res.positions['dev-owner@demo-rig'], 'active', cw, ch);
  const archR = getBoxRect(agents[1], res.positions['dev-senior-architector@demo-rig'], 'active', cw, ch);
  const horizClearGap = Math.max(archR.left - ownerR.right, ownerR.left - archR.right);
  assert.ok(horizClearGap >= 130, `Expected >= 130px clear gap between owner & architect, got ${Math.round(horizClearGap)}px`);

  // All 3 active nodes live strictly above the bench separator; all 7 dormant nodes live strictly below it
  for (const a of agents) {
    const y = res.positions[a.id].y;
    if (res.tiers[a.id] === 'active') {
      assert.ok(y < res.benchSeparatorY, `Active node ${a.id} (y=${y}) should be above bench separator (${res.benchSeparatorY})`);
    } else {
      assert.ok(y > res.benchSeparatorY, `Dormant node ${a.id} (y=${y}) should be below bench separator (${res.benchSeparatorY})`);
      assert.ok((res.benchEdgeById[a.id] || '').includes('bottom'), `Bottom bench node ${a.id} must be flagged for upward hover lift`);
    }
  }
});

test('fixed mode keeps coordinates invariant across working/idle changes and prevents owner-architect overlap', () => {
  const { agents, edges } = makeScreenshotFleet();
  const cw = 860;
  const ch = 460;
  const res1 = computeTopologyLayout({ agents, edges, mode: 'fixed', canvasWidth: cw, canvasHeight: ch });
  assert.equal(res1.mode, 'fixed');
  assert.equal(res1.benchSeparatorY, null);
  assertNoRectOverlaps(agents, res1, cw, ch);

  // Owner and senior-architect must still have clear spacing (>= 60px) in fixed mode
  const ownerR = getBoxRect(agents[0], res1.positions['dev-owner@demo-rig'], 'active', cw, ch);
  const archR = getBoxRect(agents[1], res1.positions['dev-senior-architector@demo-rig'], 'active', cw, ch);
  const gap = Math.max(archR.left - ownerR.right, ownerR.left - archR.right);
  assert.ok(gap >= 60, `Expected >= 60px gap in fixed mode between owner & architect, got ${Math.round(gap)}px`);

  // Mutate states & active edges (dev-coder4 wakes up, dev-check-argon goes idle): FIXED coordinates must NOT move!
  const mutatedAgents = agents.map(a => ({
    ...a,
    state: a.id === 'dev-coder4@demo-rig' ? 'working' : 'idle'
  }));
  const mutatedEdges = [
    { from: 'dev-owner@demo-rig', to: 'dev-coder4@demo-rig', queueStatus: 'live', liveActive: true, slice: 'new-slice' }
  ];
  const res2 = computeTopologyLayout({ agents: mutatedAgents, edges: mutatedEdges, mode: 'fixed', canvasWidth: cw, canvasHeight: ch });
  assert.deepEqual(res2.positions, res1.positions);
});

test('handles all edge counts cleanly: 0 active, 1 active, 2 active, all active, narrow viewport & 17-node multi-rig', () => {
  assert.deepEqual(GRAPH_LAYOUT_MODES, ['dynamic', 'fixed']);

  // 0 active (all sleeping): full canvas balanced layout, no separator
  const allIdle = [
    makeAgent('dev-owner@r1'),
    makeAgent('dev-senior-architector@r1'),
    makeAgent('dev-coder@r1'),
    makeAgent('dev-check@r1')
  ];
  const r0 = computeTopologyLayout({ agents: allIdle, edges: [], mode: 'dynamic', canvasWidth: 840, canvasHeight: 440 });
  assert.equal(r0.benchSeparatorY, null);
  assertNoRectOverlaps(allIdle, r0, 840, 440);

  // 1 active + 3 dormant
  const oneActive = allIdle.map(a => a.id === 'dev-coder@r1' ? { ...a, state: 'working' } : a);
  const r1 = computeTopologyLayout({ agents: oneActive, edges: [], mode: 'dynamic', canvasWidth: 840, canvasHeight: 440 });
  assert.ok(r1.benchSeparatorY != null);
  assert.equal(Math.round(r1.positions['dev-coder@r1'].x), 50);
  assertNoRectOverlaps(oneActive, r1, 840, 440);

  // 2 active communicating (0 dormant, e.g. hideIdleNodes ON): centered horizontally with wide gap
  const pair = [
    makeAgent('dev-owner@r1', { state: 'working', ctxPct: 50 }),
    makeAgent('dev-coder@r1', { state: 'working', ctxPct: 30 })
  ];
  const pairEdges = [{ from: 'dev-owner@r1', to: 'dev-coder@r1', queueStatus: 'live', liveActive: true, slice: 's1' }];
  const r2 = computeTopologyLayout({ agents: pair, edges: pairEdges, mode: 'dynamic', canvasWidth: 840, canvasHeight: 440 });
  assert.equal(r2.benchSeparatorY, null);
  assert.ok(Math.abs(r2.positions['dev-owner@r1'].x - r2.positions['dev-coder@r1'].x) >= 34);
  assertNoRectOverlaps(pair, r2, 840, 440);

  // Determinism check on 17-node multi-rig narrow viewport
  const multi = [];
  for (let i = 1; i <= 17; i++) {
    multi.push(makeAgent(i <= 2 ? `dev-owner-${i}@rig` : (i <= 4 ? `dev-check-${i}@rig` : `dev-coder-${i}@rig`), {
      state: i <= 3 ? 'working' : 'idle',
      ctxPct: i % 2 === 0 ? 40 : null
    }));
  }
  const rMultiA = computeTopologyLayout({ agents: multi, edges: [], mode: 'dynamic', canvasWidth: 700, canvasHeight: 440 });
  const rMultiB = computeTopologyLayout({ agents: multi, edges: [], mode: 'dynamic', canvasWidth: 700, canvasHeight: 440 });
  assert.deepEqual(rMultiA, rMultiB);
  assertNoRectOverlaps(multi, rMultiA, 700, 440);
});

test('computeAnchoredPopoverRect places popover near cursor with vertical flip and horizontal edge clamping', () => {
  // 1) Center click: opens directly below cursor, centered horizontally
  const center = computeAnchoredPopoverRect({
    anchorX: 500, anchorY: 180, containerW: 1200, containerH: 600, popoverW: 340, popoverH: 220, pad: 12, offset: 16
  });
  assert.equal(center.placement, 'below');
  assert.equal(center.left, 330);
  assert.equal(center.top, 196);

  // 2) Near bottom edge: flips cleanly above cursor so bottom never clips
  const bottom = computeAnchoredPopoverRect({
    anchorX: 500, anchorY: 500, containerW: 1200, containerH: 600, popoverW: 340, popoverH: 220, pad: 12, offset: 16
  });
  assert.equal(bottom.placement, 'above');
  assert.equal(bottom.top, 264);
  assert.ok(bottom.top >= 12 && bottom.top + 220 <= 588);

  // 3) Near right & left edges: clamped with 12px margin
  const right = computeAnchoredPopoverRect({
    anchorX: 1170, anchorY: 120, containerW: 1200, containerH: 600, popoverW: 340, popoverH: 220, pad: 12, offset: 16
  });
  assert.equal(right.left, 848);
  const left = computeAnchoredPopoverRect({
    anchorX: 40, anchorY: 120, containerW: 1200, containerH: 600, popoverW: 340, popoverH: 220, pad: 12, offset: 16
  });
  assert.equal(left.left, 12);

  // 4) Very tight vertical container: clamped safely without negative coords
  const tight = computeAnchoredPopoverRect({
    anchorX: 200, anchorY: 160, containerW: 400, containerH: 280, popoverW: 340, popoverH: 220, pad: 12, offset: 16
  });
  assert.equal(tight.placement, 'clamped');
  assert.ok(tight.left >= 12 && tight.left + 340 <= 388);
  assert.ok(tight.top >= 12 && tight.top + 220 <= 268);
});

test('anti-collinear arch breaks flat 3-in-a-row top tier (4 active nodes: 3 command + 1 QA) in dynamic & fixed modes', () => {
  const agents = [
    makeAgent('operator-agent@kernel', { state: 'working', ctxPct: 59, callsIn: 503, callsOut: 93 }),
    makeAgent('dev-owner@demo-rig', { state: 'working', ctxPct: 59, callsIn: 531, callsOut: 484 }),
    makeAgent('dev-senior-architector@demo-rig', { shortName: 'dev-senior-architect', displayTitle: 'dev-senior-architect', state: 'idle', ctxPct: 19, callsIn: 80, callsOut: 69 }),
    makeAgent('dev-check-argon@demo-rig', { state: 'working', callsIn: 33, callsOut: 15 }),
    makeAgent('dev-coder@demo-rig', { state: 'idle' }),
    makeAgent('dev-coder2@demo-rig', { state: 'idle' }),
    makeAgent('dev-coder3@demo-rig', { state: 'idle' }),
    makeAgent('dev-coder4@demo-rig', { state: 'idle' })
  ];
  const edges = [
    { from: 'operator-agent@kernel', to: 'dev-owner@demo-rig', queueStatus: 'pending', liveActive: false, slice: 'ops' },
    { from: 'dev-senior-architector@demo-rig', to: 'dev-owner@demo-rig', queueStatus: 'live', liveActive: true, slice: '0147-live' },
    { from: 'dev-owner@demo-rig', to: 'dev-check-argon@demo-rig', queueStatus: 'live', liveActive: true, slice: '0152-v15-rebase' }
  ];

  const cw = 1360;
  const ch = 520;
  const dyn = computeTopologyLayout({ agents, edges, mode: 'dynamic', canvasWidth: cw, canvasHeight: ch });
  assertNoRectOverlaps(agents, dyn, cw, ch);

  const top3Y = [
    (dyn.positions['operator-agent@kernel'].y / 100) * ch,
    (dyn.positions['dev-owner@demo-rig'].y / 100) * ch,
    (dyn.positions['dev-senior-architector@demo-rig'].y / 100) * ch
  ];
  const spreadPx = Math.max(...top3Y) - Math.min(...top3Y);
  assert.ok(spreadPx >= 45, `Top 3 command nodes must form a non-collinear arch (>=45px vertical spread), got ${Math.round(spreadPx)}px`);
  // Central hub dev-owner sits cleanly above its two lateral peers
  assert.ok(dyn.positions['dev-owner@demo-rig'].y < dyn.positions['operator-agent@kernel'].y);
  assert.ok(dyn.positions['dev-owner@demo-rig'].y < dyn.positions['dev-senior-architector@demo-rig'].y);

  // Fixed mode also avoids a flat 3-in-a-row line while staying invariant to state changes
  const fix1 = computeTopologyLayout({ agents, edges, mode: 'fixed', canvasWidth: cw, canvasHeight: ch });
  assertNoRectOverlaps(agents, fix1, cw, ch);
  const fixTop3Y = [
    (fix1.positions['operator-agent@kernel'].y / 100) * ch,
    (fix1.positions['dev-owner@demo-rig'].y / 100) * ch,
    (fix1.positions['dev-senior-architector@demo-rig'].y / 100) * ch
  ];
  assert.ok(Math.max(...fixTop3Y) - Math.min(...fixTop3Y) >= 16, 'Fixed mode 3-node row must also break collinearity');
  const fix2 = computeTopologyLayout({
    agents: agents.map(a => ({ ...a, state: 'idle' })),
    edges: [],
    mode: 'fixed',
    canvasWidth: cw,
    canvasHeight: ch
  });
  assert.deepEqual(fix2.positions, fix1.positions);
});
