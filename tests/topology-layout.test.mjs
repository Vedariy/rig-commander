import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_LAYOUT_MODES,
  classifyNodeActivityTier,
  estimateNodeBox,
  evaluateClusterReadability,
  classifyQuietRigClusters,
  computeAdaptiveEdgePath,
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
    isAnomaly: Boolean(opts.isAnomaly),
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
    makeAgent('operator-agent@demo-rig', { state: 'working', ctxPct: 59, callsIn: 503, callsOut: 93 }),
    makeAgent('dev-owner@demo-rig', { state: 'working', ctxPct: 59, callsIn: 531, callsOut: 484 }),
    makeAgent('dev-senior-architector@demo-rig', { shortName: 'dev-senior-architect', displayTitle: 'dev-senior-architect', state: 'idle', ctxPct: 19, callsIn: 80, callsOut: 69 }),
    makeAgent('dev-check-argon@demo-rig', { state: 'working', callsIn: 33, callsOut: 15 }),
    makeAgent('dev-coder@demo-rig', { state: 'idle' }),
    makeAgent('dev-coder2@demo-rig', { state: 'idle' }),
    makeAgent('dev-coder3@demo-rig', { state: 'idle' }),
    makeAgent('dev-coder4@demo-rig', { state: 'idle' })
  ];
  const edges = [
    { from: 'operator-agent@demo-rig', to: 'dev-owner@demo-rig', queueStatus: 'pending', liveActive: false, slice: 'ops' },
    { from: 'dev-senior-architector@demo-rig', to: 'dev-owner@demo-rig', queueStatus: 'live', liveActive: true, slice: '0147-live' },
    { from: 'dev-owner@demo-rig', to: 'dev-check-argon@demo-rig', queueStatus: 'live', liveActive: true, slice: '0152-v15-rebase' }
  ];

  const cw = 1360;
  const ch = 520;
  const dyn = computeTopologyLayout({ agents, edges, mode: 'dynamic', canvasWidth: cw, canvasHeight: ch });
  assertNoRectOverlaps(agents, dyn, cw, ch);

  const top3Y = [
    (dyn.positions['operator-agent@demo-rig'].y / 100) * ch,
    (dyn.positions['dev-owner@demo-rig'].y / 100) * ch,
    (dyn.positions['dev-senior-architector@demo-rig'].y / 100) * ch
  ];
  const spreadPx = Math.max(...top3Y) - Math.min(...top3Y);
  assert.ok(spreadPx >= 45, `Top 3 command nodes must form a non-collinear arch (>=45px vertical spread), got ${Math.round(spreadPx)}px`);
  // Central hub dev-owner sits cleanly above its two lateral peers
  assert.ok(dyn.positions['dev-owner@demo-rig'].y < dyn.positions['operator-agent@demo-rig'].y);
  assert.ok(dyn.positions['dev-owner@demo-rig'].y < dyn.positions['dev-senior-architector@demo-rig'].y);

  // Fixed mode also avoids a flat 3-in-a-row line while staying invariant to state changes
  const fix1 = computeTopologyLayout({ agents, edges, mode: 'fixed', canvasWidth: cw, canvasHeight: ch });
  assertNoRectOverlaps(agents, fix1, cw, ch);
  const fixTop3Y = [
    (fix1.positions['operator-agent@demo-rig'].y / 100) * ch,
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

function segmentIntersectsRect(x1, y1, x2, y2, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const checks = [
    [-dx, x1 - rect.left],
    [dx, rect.right - x1],
    [-dy, y1 - rect.top],
    [dy, rect.bottom - y1]
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

test('anti-vertical-collinearity breaks 3-tier vertical pole (owner/coder/check) in idle dynamic, active dynamic & fixed modes', () => {
  const idleThree = [
    makeAgent('dev-owner@rig-commander', { state: 'idle', ctxPct: 8 }),
    makeAgent('dev-coder@rig-commander', { state: 'idle', ctxPct: 11 }),
    makeAgent('dev-check@rig-commander', { state: 'idle' })
  ];
  const activeThree = idleThree.map(a => ({ ...a, state: 'working' }));
  const edges = [
    { from: 'dev-owner@rig-commander', to: 'dev-coder@rig-commander', queueStatus: 'ghost', liveActive: false },
    { from: 'dev-owner@rig-commander', to: 'dev-check@rig-commander', queueStatus: 'ghost', liveActive: false },
    { from: 'dev-coder@rig-commander', to: 'dev-check@rig-commander', queueStatus: 'ghost', liveActive: false }
  ];

  for (const [label, agents, mode, cw, ch] of [
    ['dynamic-all-idle-desktop', idleThree, 'dynamic', 1000, 520],
    ['dynamic-all-active-desktop', activeThree, 'dynamic', 1000, 520],
    ['fixed-desktop', idleThree, 'fixed', 1000, 520],
    ['dynamic-all-idle-mobile', idleThree, 'dynamic', 360, 440]
  ]) {
    const res = computeTopologyLayout({ agents, edges, mode, canvasWidth: cw, canvasHeight: ch });
    assertNoRectOverlaps(agents, res, cw, ch);

    const pOwner = res.positions['dev-owner@rig-commander'];
    const pCoder = res.positions['dev-coder@rig-commander'];
    const pCheck = res.positions['dev-check@rig-commander'];

    // Preserve semantic top-to-bottom Command -> Builder -> QA hierarchy
    assert.ok(pOwner.y < pCoder.y && pCoder.y < pCheck.y, `${label}: expected y(owner) < y(coder) < y(check)`);

    // Must NOT collapse into a vertical line
    const xs = [pOwner.x, pCoder.x, pCheck.x];
    const spreadPct = Math.max(...xs) - Math.min(...xs);
    assert.ok(spreadPct >= 35, `${label}: expected wide horizontal spread >=35%, got ${spreadPct.toFixed(1)}%`);

    // Structural edge dev-owner -> dev-check must NOT slice through dev-coder card!
    const coderRect = getBoxRect(agents[1], pCoder, res.tiers['dev-coder@rig-commander'], cw, ch);
    const hitsCoder = segmentIntersectsRect(
      (pOwner.x / 100) * cw, (pOwner.y / 100) * ch,
      (pCheck.x / 100) * cw, (pCheck.y / 100) * ch,
      coderRect
    );
    assert.equal(hitsCoder, false, `${label}: owner->check edge must not pass through dev-coder box`);
  }

  // Fixed mode remains strictly invariant when states flip
  const fixIdle = computeTopologyLayout({ agents: idleThree, edges, mode: 'fixed', canvasWidth: 1000, canvasHeight: 520 });
  const fixActive = computeTopologyLayout({ agents: activeThree, edges, mode: 'fixed', canvasWidth: 1000, canvasHeight: 520 });
  assert.deepEqual(fixActive.positions, fixIdle.positions);

  // Mixed [1, 3, 1] topology (owner + 3 coders + check) also clears middle coder on owner->check route
  const fiveSeats = [
    makeAgent('dev-owner@rig-commander', { state: 'idle', ctxPct: 12 }),
    makeAgent('dev-coder@rig-commander', { state: 'idle', ctxPct: 10 }),
    makeAgent('dev-coder2@rig-commander', { state: 'idle', ctxPct: 15 }),
    makeAgent('dev-coder3@rig-commander', { state: 'idle', ctxPct: 20 }),
    makeAgent('dev-check@rig-commander', { state: 'idle' })
  ];
  const resFive = computeTopologyLayout({ agents: fiveSeats, edges: [], mode: 'fixed', canvasWidth: 1000, canvasHeight: 520 });
  assertNoRectOverlaps(fiveSeats, resFive, 1000, 520);
  const pO5 = resFive.positions['dev-owner@rig-commander'];
  const pC5 = resFive.positions['dev-check@rig-commander'];
  const midCoderRect = getBoxRect(fiveSeats[2], resFive.positions['dev-coder2@rig-commander'], 'active', 1000, 520);
  assert.equal(
    segmentIntersectsRect(
      (pO5.x / 100) * 1000, (pO5.y / 100) * 520,
      (pC5.x / 100) * 1000, (pC5.y / 100) * 520,
      midCoderRect
    ),
    false,
    '[1,3,1] owner->check edge must not slice through middle coder2'
  );
});

function fiveSeatRig(rigId) {
  const agents = ['dev-owner', 'dev-coder', 'dev-coder2', 'dev-coder3', 'dev-check'].map((seat, i) =>
    makeAgent(`${seat}@${rigId}`, { state: 'working', ctxPct: 45 + i * 5, ctxWindowSize: 200000, callsIn: 2, callsOut: 2 }));
  const edges = [[0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 4]].map(([a, b]) => ({
    from: agents[a].id, to: agents[b].id, queueStatus: 'live', slice: 'fixture-flow'
  }));
  return { agents, edges };
}

test('dynamic [1,3,1] keeps coder2 at upward middle apex after barycenter reorder and clears lower diagonal midpoint', () => {
  const { agents, edges } = fiveSeatRig('rig-a');
  for (const cw of [700, 1000, 1360]) {
    const ch = 520;
    const r = computeTopologyLayout({ agents, edges, mode: 'dynamic', canvasWidth: cw, canvasHeight: ch });
    const p = r.positions, c1 = p['dev-coder@rig-a'], c2 = p['dev-coder2@rig-a'], c3 = p['dev-coder3@rig-a'], qa = p['dev-check@rig-a'];
    assert.ok(c1.x < c2.x && c2.x < c3.x, 'Stable natural order of equally connected coders');
    assert.ok(c2.y < c1.y && c2.y < c3.y, `middle card must arch UP at ${cw}: ${JSON.stringify(p)}`);
    const rect = getBoxRect(agents[2], c2, 'active', cw, ch);
    const mx = (c1.x + qa.x) * cw / 200, my = (c1.y + qa.y) * ch / 200;
    assert.ok(mx < rect.left || mx > rect.right || my - 9 > rect.bottom || my + 9 < rect.top, 'Lower diagonal badge midpoint clears middle card');
    assertNoRectOverlaps(agents, r, cw, ch);
  }
});

test('multi-rig zones partition active cards including kernel without box/route collisions at narrow and wide widths', () => {
  const a = fiveSeatRig('rig-a'), b = fiveSeatRig('rig-b');
  for (const mode of ['dynamic', 'fixed']) for (const detailed of [false, true]) for (const cw of [680, 1000, 1440]) {
    for (const includeKernel of [false, true]) {
      const agents = [...a.agents, ...b.agents, ...(includeKernel ? [makeAgent('operator-agent@kernel', { state: 'working' })] : [])];
      const edges = [...a.edges, ...b.edges];
      const r = computeTopologyLayout({ agents, edges, mode, canvasWidth: cw, canvasHeight: 520, detailed });
      assert.equal(r.rigClusters.length, includeKernel ? 3 : 2);
      const w = r.canvasWidth, h = r.canvasHeight;
      assert.ok(w >= cw && h >= 520);
      const clusters = r.rigClusters.map(c => ({ ...c, left: c.xPct * w / 100, right: (c.xPct + c.wPct) * w / 100,
        top: c.yPct * h / 100, bottom: (c.yPct + c.hPct) * h / 100 }));
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
        const x = clusters[i], y = clusters[j];
        assert.ok(x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top);
      }
      for (const agent of agents) {
        const box = getBoxRect(agent, r.positions[agent.id], 'active', w, h, detailed);
        const zone = clusters.find(c => c.rigId === agent.id.split('@').at(-1));
        assert.ok(box.left > zone.left && box.right < zone.right && box.top > zone.top && box.bottom < zone.bottom,
          `${mode}/${detailed}/${cw}: ${agent.id} escaped zone: ${JSON.stringify({box, zone})}`);
        for (const e of edges.filter(e => !e.from.endsWith('@' + zone.rigId))) {
          const from = r.positions[e.from], to = r.positions[e.to];
          assert.equal(segmentIntersectsRect(from.x * w / 100, from.y * h / 100, to.x * w / 100, to.y * h / 100, box), false);
        }
      }
      assertNoRectOverlaps(agents, r, w, h, detailed);
      assert.deepEqual(computeTopologyLayout({ agents: [...agents].reverse(), edges, mode, canvasWidth: cw, canvasHeight: 520, detailed }), r, 'Deterministic independent of fleet order');
    }
  }
});

test('single active rig and empty fleet return no decorative clusters', () => {
  const { agents, edges } = fiveSeatRig('rig-a');
  for (const mode of GRAPH_LAYOUT_MODES) {
    assert.deepEqual(computeTopologyLayout({ agents, edges, mode }).rigClusters, []);
    assert.deepEqual(computeTopologyLayout({ agents: [], mode }).rigClusters, []);
  }
});

test('proportional multi-rig clusters give 4-seat pod side-by-side coders (no edge-through-card) and honor bottomReservePx', () => {
  const agents = [
    makeAgent('operator-agent@kernel', { state: 'working', ctxPct: 64, displayTitle: 'operator-agent' }),
    makeAgent('dev-coder2@rig-commander', { state: 'idle', ctxPct: 42, displayTitle: 'dev-coder2' }),
    makeAgent('dev-coder3@rig-commander', { state: 'idle', ctxPct: 80, displayTitle: 'dev-coder3' }),
    makeAgent('dev-check@rig-commander', { state: 'working', displayTitle: 'dev-check' }),
    makeAgent('dev-check2@rig-commander', { state: 'urgent', displayTitle: 'dev-check2' })
  ];
  const edges = [
    { from: 'dev-coder3@rig-commander', to: 'dev-check@rig-commander', queueStatus: 'live', liveActive: true, slice: 'iter7-2' },
    { from: 'dev-coder2@rig-commander', to: 'dev-check2@rig-commander', queueStatus: 'live', liveActive: true, slice: 'iter7-4' }
  ];
  const res = computeTopologyLayout({
    agents,
    edges,
    mode: 'dynamic',
    canvasWidth: 960,
    canvasHeight: 500,
    bottomReservePx: 48
  });
  assert.equal(res.rigClusters.length, 2);
  const kZone = res.rigClusters.find(c => c.rigId === 'kernel');
  const rcZone = res.rigClusters.find(c => c.rigId === 'rig-commander');
  assert.ok(rcZone.wPct > kZone.wPct * 1.4, `4-seat pod (${rcZone.wPct.toFixed(1)}%) must be substantially wider than 1-seat kernel (${kZone.wPct.toFixed(1)}%)`);

  // Both coders sit side-by-side (not stacked vertically) and neither live edge hits the other coder
  const w = res.canvasWidth, h = res.canvasHeight;
  const pC2 = res.positions['dev-coder2@rig-commander'];
  const pC3 = res.positions['dev-coder3@rig-commander'];
  const pQ2 = res.positions['dev-check2@rig-commander'];
  assert.ok(Math.abs(pC2.y - pC3.y) < 12, `coders should sit side-by-side, got y=${pC2.y} vs ${pC3.y}`);
  const c3Box = getBoxRect(agents[2], pC3, 'active', w, h);
  assert.equal(segmentIntersectsRect(pC2.x * w / 100, pC2.y * h / 100, pQ2.x * w / 100, pQ2.y * h / 100, c3Box), false);

  // Bottom cluster edge stays strictly above the 48px idleCollapsedPill reserve
  const rcBottomPx = (rcZone.yPct + rcZone.hPct) * h / 100;
  assert.ok(rcBottomPx <= h - 48 + 1, `Cluster bottom (${rcBottomPx.toFixed(1)}px) must clear bottomReservePx=48 inside h=${h}`);
  assertNoRectOverlaps(agents, res, w, h);
});

test('narrow multi-rig cluster stacks 2-node active pair vertically so edge badge and expanded selection never collide', () => {
  const agents = [
    makeAgent('operator-agent@kernel', { state: 'working', displayTitle: 'operator-agent' }),
    makeAgent('dev-coder3@rig-commander', { state: 'idle', ctxPct: 80, displayTitle: 'dev-coder3' }),
    makeAgent('dev-check@rig-commander', { state: 'working', displayTitle: 'dev-check' }),
    makeAgent('dev-owner@streamdonation-pwa', { state: 'working', displayTitle: 'dev-owner' }),
    makeAgent('dev-coder4@streamdonation-pwa', { state: 'working', displayTitle: 'dev-coder4' })
  ];
  const edges = [
    { from: 'dev-coder3@rig-commander', to: 'dev-check@rig-commander', queueStatus: 'live', liveActive: true, slice: 'iter7-2' },
    { from: 'dev-owner@streamdonation-pwa', to: 'dev-coder4@streamdonation-pwa', queueStatus: 'live', liveActive: true, slice: 'auth' }
  ];
  const res = computeTopologyLayout({
    agents,
    edges,
    mode: 'dynamic',
    canvasWidth: 1020,
    canvasHeight: 580
  });
  const w = res.canvasWidth, h = res.canvasHeight;
  const pC3 = res.positions['dev-coder3@rig-commander'];
  const pQ1 = res.positions['dev-check@rig-commander'];
  // Stacked vertically (source above target) with >= 140px vertical separation
  assert.ok((pQ1.y - pC3.y) * h / 100 >= 140, `Expected vertical stack >= 140px, got ${((pQ1.y - pC3.y) * h / 100).toFixed(1)}px`);
  assertNoRectOverlaps(agents, res, w, h);
});

test('variable-width shelf packing wraps dense wide cluster to its own full-width row while keeping compact neighbors side-by-side', () => {
  const agents = [
    makeAgent('operator-agent@kernel', { state: 'working', displayTitle: 'operator-agent' }),
    makeAgent('dev-coder3@rig-commander', { state: 'idle', ctxPct: 18, displayTitle: 'dev-coder3' }),
    makeAgent('dev-check@rig-commander', { state: 'working', displayTitle: 'dev-check' }),
    makeAgent('dev-owner@streamdonation-pwa', { state: 'working', ctxPct: 56, displayTitle: 'dev-owner' }),
    makeAgent('dev-senior-architect@streamdonation-pwa', { state: 'idle', ctxPct: 41, displayTitle: 'dev-senior-architect' }),
    makeAgent('dev-check-argon@streamdonation-pwa', { state: 'working', displayTitle: 'dev-check-argon' })
  ];
  const edges = [
    { from: 'dev-coder3@rig-commander', to: 'dev-check@rig-commander', queueStatus: 'live', liveActive: true, slice: 'iter7-2' },
    { from: 'dev-owner@streamdonation-pwa', to: 'dev-senior-architect@streamdonation-pwa', queueStatus: 'live', liveActive: true, slice: '0147-live' },
    { from: 'dev-owner@streamdonation-pwa', to: 'dev-check-argon@streamdonation-pwa', queueStatus: 'live', liveActive: true, slice: 'donation-v15-auth-fix' }
  ];

  // Medium desktop width (~980px): @kernel + @rig-commander share Row 0, wide @streamdonation-pwa wraps to full-width Row 1
  const res = computeTopologyLayout({ agents, edges, mode: 'dynamic', canvasWidth: 980, canvasHeight: 540 });
  assert.equal(res.rigClusters.length, 3);
  const kZone = res.rigClusters.find(c => c.rigId === 'kernel');
  const rcZone = res.rigClusters.find(c => c.rigId === 'rig-commander');
  const sdZone = res.rigClusters.find(c => c.rigId === 'streamdonation-pwa');

  assert.ok(Math.abs(kZone.yPct - rcZone.yPct) < 0.5, 'compact @kernel and @rig-commander should share Row 0');
  assert.ok(sdZone.yPct > kZone.yPct + kZone.hPct, 'wide @streamdonation-pwa must wrap onto Row 1 below Row 0');
  assert.ok(sdZone.wPct > 90, `wrapped @streamdonation-pwa should span full row width, got ${sdZone.wPct.toFixed(1)}%`);
  assert.equal(res.canvasWidth, 980, 'should wrap vertically instead of forcing horizontal scroll');

  // Every card stays strictly inside its zone with zero overlaps
  const w = res.canvasWidth, h = res.canvasHeight;
  for (const agent of agents) {
    const box = getBoxRect(agent, res.positions[agent.id], 'active', w, h);
    const zone = res.rigClusters.find(c => c.rigId === agent.id.split('@').at(-1));
    assert.ok(box.left > zone.xPct * w / 100 && box.right < (zone.xPct + zone.wPct) * w / 100,
      `${agent.id} escaped its cluster horizontally`);
  }
  assertNoRectOverlaps(agents, res, w, h);

  // Ultra-wide monitor (1600px): all 3 fit cleanly side-by-side in 1 single row
  const wide = computeTopologyLayout({ agents, edges, mode: 'dynamic', canvasWidth: 1600, canvasHeight: 540 });
  assert.ok(wide.rigClusters.every(c => Math.abs(c.yPct - wide.rigClusters[0].yPct) < 0.5), 'all 3 rigs fit on 1 row at 1600px');
});

test('evaluateClusterReadability detects border overflow, card overlap, and cramped edge badges cleanly', () => {
  const a1 = makeAgent('dev-owner@sd', { state: 'working', displayTitle: 'dev-owner' });
  const a2 = makeAgent('dev-senior-architect@sd', { state: 'working', displayTitle: 'dev-senior-architect' });
  const edges = [{ from: a1.id, to: a2.id, queueStatus: 'live', liveActive: true, slice: '0147-live' }];

  const cramped = evaluateClusterReadability(
    { positions: { [a1.id]: { x: 25, y: 50 }, [a2.id]: { x: 85, y: 50 } }, tiers: { [a1.id]: 'active', [a2.id]: 'active' } },
    [a1, a2],
    edges,
    300,
    300
  );
  assert.ok(cramped.overflowCount >= 1 && cramped.score >= 100, `expected overflow penalty, got ${JSON.stringify(cramped)}`);

  const spacious = evaluateClusterReadability(
    { positions: { [a1.id]: { x: 22, y: 50 }, [a2.id]: { x: 78, y: 50 } }, tiers: { [a1.id]: 'active', [a2.id]: 'active' } },
    [a1, a2],
    edges,
    720,
    340
  );
  assert.equal(spacious.score, 0, `expected zero penalties on spacious row, got ${JSON.stringify(spacious)}`);
});

test('computeAdaptiveEdgePath stays straight on clean axes, uses orthogonal S-curves on diagonals, detours around obstacles & splits A<->B lanes', () => {
  const sz = { hw: 90, hh: 26 };

  // 1. Clean horizontal and vertical unobstructed edges stay strictly straight (no unnecessary wiggle)
  const horiz = computeAdaptiveEdgePath({ cx1: 150, cy1: 200, sz1: sz, cx2: 550, cy2: 204, sz2: sz });
  assert.equal(horiz.curved, false);
  assert.equal(horiz.kind, 'straight');
  assert.match(horiz.pathD, /^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/);

  const vert = computeAdaptiveEdgePath({ cx1: 300, cy1: 100, sz1: sz, cx2: 306, cy2: 400, sz2: sz });
  assert.equal(vert.curved, false);
  assert.equal(vert.kind, 'straight');

  // 2. Unobstructed active diagonal -> vertical-tangent cubic S-curve with collinear arrow landing runway & exact B(0.5) anchor
  const diag = computeAdaptiveEdgePath({ cx1: 200, cy1: 120, sz1: sz, cx2: 520, cy2: 380, sz2: sz, isGhost: false });
  assert.equal(diag.curved, true);
  assert.equal(diag.kind, 's-vertical');
  assert.match(diag.pathD, /^M [\d.-]+ [\d.-]+ C [\d.-]+ [\d.-]+, [\d.-]+ [\d.-]+, [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/);
  assert.equal(diag.c1.x, diag.p1.x, 'vertical S-curve exits source orthogonally (90 deg)');
  assert.equal(diag.c2.x, diag.p2Lead.x, 'vertical S-curve arrives at landing runway orthogonally (90 deg)');
  assert.equal(diag.p2Lead.x, diag.p2.x, 'landing runway is strictly collinear with arrowhead axis');
  assert.ok(diag.p2.y - diag.p2Lead.y >= 9, 'landing runway gives >= 9px straight lead-in for arrowhead');
  assert.notEqual(diag.trunkPathD, diag.pathD, 'wide trunk trims short of arrowhead tip');
  const b05x = 0.125 * diag.p1.x + 0.375 * diag.c1.x + 0.375 * diag.c2.x + 0.125 * diag.p2Lead.x;
  const b05y = 0.125 * diag.p1.y + 0.375 * diag.c1.y + 0.375 * diag.c2.y + 0.125 * diag.p2Lead.y;
  assert.ok(Math.abs(diag.mx - b05x) < 1e-6 && Math.abs(diag.my - b05y) < 1e-6, 'label anchor lies strictly on B(0.5)');

  // 3. Unobstructed ghost diagonal stays quiet/straight (zero spaghetti)
  const ghostDiag = computeAdaptiveEdgePath({ cx1: 200, cy1: 120, sz1: sz, cx2: 520, cy2: 380, sz2: sz, isGhost: true });
  assert.equal(ghostDiag.curved, false);

  // 4. Third-party obstacle card right in the middle -> curve bows cleanly around it
  const midObstacle = { cx: 350, cy: 200, hw: 85, hh: 28 };
  const detour = computeAdaptiveEdgePath({ cx1: 100, cy1: 200, sz1: sz, cx2: 600, cy2: 200, sz2: sz, obstacles: [midObstacle] });
  assert.equal(detour.curved, true);
  assert.equal(detour.kind, 'avoid');
  assert.ok(Math.abs(detour.my - midObstacle.cy) > midObstacle.hh + 12, `curve midpoint y=${detour.my} must clear obstacle center=${midObstacle.cy}`);

  // 5. Bidirectional parallel pair A -> B and B -> A split symmetrically onto separate lanes
  const fwd = computeAdaptiveEdgePath({ cx1: 150, cy1: 200, sz1: sz, cx2: 550, cy2: 200, sz2: sz, parallelIndex: 1 });
  const rev = computeAdaptiveEdgePath({ cx1: 550, cy1: 200, sz1: sz, cx2: 150, cy2: 200, sz2: sz, parallelIndex: 1 });
  assert.equal(fwd.kind, 'parallel');
  assert.equal(rev.kind, 'parallel');
  assert.ok(Math.abs(fwd.my - rev.my) >= 40, `bidirectional badges must separate vertically, got ${fwd.my} vs ${rev.my}`);
});

test('classifyQuietRigClusters folds quiet & parked-only rigs in CALM: ON while protecting active/urgent/hot/shell/selected rigs and never blanking canvas', () => {
  const fleet = [
    makeAgent('dev-owner@rig-a', { state: 'working', ctxPct: 45 }),
    makeAgent('dev-coder@rig-a', { state: 'idle', ctxPct: 30 }),
    makeAgent('main-lead@stand-qwen', { state: 'idle', ctxPct: 12 }),
    makeAgent('operator-agent@kernel', { state: 'waiting', isAnomaly: true, assignedWorkCount: 389, ctxPct: 41 }),
    makeAgent('dev-hot@rig-hot', { state: 'idle', ctxPct: 78 }),
    makeAgent('dev-shell@rig-shell', { state: 'waiting', shellExited: true, assignedWorkCount: 1 })
  ];
  const edges = [{ from: 'dev-owner@rig-a', to: 'dev-coder@rig-a', queueStatus: 'live', liveActive: true }];

  // CALM: OFF -> zero minimization
  const off = classifyQuietRigClusters(fleet, edges, { calmMode: false });
  assert.equal(off.minimizedClusters.length, 0);
  assert.equal(off.visibleAgents.length, fleet.length);

  // CALM: ON (default includeParked: true) -> folds stand-qwen & kernel, preserves rig-a (working), rig-hot (ctx>=75%), rig-shell (shellExited)
  const on = classifyQuietRigClusters(fleet, edges, { calmMode: true });
  assert.deepEqual(on.minimizedClusters.map(c => c.rigId), ['kernel', 'stand-qwen']);
  const kChip = on.minimizedClusters.find(c => c.rigId === 'kernel');
  assert.equal(kChip.parkedCount, 1);
  assert.equal(kChip.parkedWorkCount, 389);
  assert.equal(on.minimizedAgentIds.has('operator-agent@kernel'), true);
  assert.equal(on.minimizedAgentIds.has('main-lead@stand-qwen'), true);
  assert.equal(on.visibleAgents.some(a => a.id === 'dev-hot@rig-hot'), true);
  assert.equal(on.visibleAgents.some(a => a.id === 'dev-shell@rig-shell'), true);

  // includeParked: false keeps kernel visible while folding pure-idle stand-qwen
  const keepParked = classifyQuietRigClusters(fleet, edges, { calmMode: true, includeParked: false });
  assert.deepEqual(keepParked.minimizedClusters.map(c => c.rigId), ['stand-qwen']);

  // selectedAgentId or expandedQuietRigs protects/expands a quiet rig
  const withSel = classifyQuietRigClusters(fleet, edges, { calmMode: true, selectedAgentId: 'main-lead@stand-qwen' });
  assert.deepEqual(withSel.minimizedClusters.map(c => c.rigId), ['kernel']);
  const withExp = classifyQuietRigClusters(fleet, edges, { calmMode: true, expandedQuietRigs: new Set(['kernel']) });
  assert.deepEqual(withExp.minimizedClusters.map(c => c.rigId), ['stand-qwen']);

  // 100% quiet fleet -> NEVER collapses into an empty canvas
  const allIdle = [makeAgent('a@r1', { state: 'idle' }), makeAgent('b@r2', { state: 'idle' })];
  const allQuiet = classifyQuietRigClusters(allIdle, [], { calmMode: true });
  assert.equal(allQuiet.minimizedClusters.length, 0);
  assert.equal(allQuiet.visibleAgents.length, 2);

  // Multi-rig top row clears the top-left HUD label (y >= 36px)
  const multi = computeTopologyLayout({
    agents: [makeAgent('dev-owner@rig-a', { state: 'working' }), makeAgent('dev-owner@rig-b', { state: 'working' })],
    edges: [],
    mode: 'dynamic',
    canvasWidth: 960,
    canvasHeight: 500
  });
  const topPx = Math.min(...multi.rigClusters.map(c => (c.yPct * multi.canvasHeight) / 100));
  assert.ok(topPx >= 35.5, `Top multi-rig row (${topPx.toFixed(1)}px) must clear top HUD label (>= 36px)`);
});

test('quiet minimization requires an explicit dormant tier and preserves current activity evidence', () => {
  const active = { id: 'lead@busy', state: 'working' };
  const idle = { id: 'review@quiet', state: 'idle' };
  const classify = (tiers, edges = [], extra = {}) => classifyQuietRigClusters(
    [active, idle], edges, { calmMode: true, tiers, ...extra });
  const dormant = { [idle.id]: 'dormant' };
  const edge = { from: active.id, to: idle.id, queueStatus: 'pending' };
  for (const tiers of [{}, Object.create(dormant), { [idle.id]: undefined }, { [idle.id]: null }, { [idle.id]: '' }]) {
    assert.equal(classify(tiers).minimizedClusters.length, 0);
  }
  assert.equal(classify(dormant, [edge]).minimizedClusters.length, 0);
  assert.equal(classify(dormant, [], { recentActiveIds: new Set([idle.id]) }).minimizedClusters.length, 0);
  assert.equal(classify(dormant).minimizedClusters[0].rigId, 'quiet');
  const expanded = new Set(['quiet', 'busy']);
  assert.deepEqual([...classify(dormant, [], { expandedQuietRigs: expanded }).collapsibleRigIds], ['quiet']);
});
