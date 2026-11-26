import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import { getContextThermal, computeBurn, buildThermalCurveSvgHtml } from '../openrig/assets/domain/thermal.js';
import { extractItemContextMeta } from '../openrig/assets/domain/context-lineage.js';
import {
  intersectNodeBorder, computeEdgeFallbackAnchor, positionEdgeXrayDrawer,
  getNodeThermalFillGrad, getNodeCtxValText, getNodeCtxValClass, renderDormantFlagHtml,
  renderStateIndicatorHtml, renderNodeMetaRowHtml, renderNodeSpecMetaHtml, renderNodeCardHtml,
  renderTopologyEdgesHtml, renderSwimlanes, renderSwimlanesSummaryChips, renderQuietClustersPillHtml, renderEdgeXray, renderRigClustersHtml
} from '../openrig/assets/ui/topology-view.js';

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const agents = [
  { id: 'owner@rig', shortName: 'Owner', role: 'Owner', state: 'working', x: 20, y: 25, icon: '🏛️', ctxPct: 68, ctxWindowSize: 200000, callsIn: 3, callsOut: 2, harness: 'codex', model: 'test-model', assignedWorkCount: 2 },
  { id: 'qa@rig', shortName: 'QA', role: 'Verifier', state: 'urgent', x: 80, y: 75, icon: '🛡️', ctxPct: 80, ctxWindowSize: 200000, callsIn: 1, callsOut: 4 }
];
const edge = { from: 'owner@rig', to: 'qa@rig', slice: 'test-slice', calls: 4, queueStatus: 'live', color: '#38bdf8', marker: 'arr-cyan', speed: '2s' };
const deps = (deckLang = 'en', extra = {}) => ({
  deckLang, td: (key, vars) => tDeck(deckLang, key, vars), escapeHtml, shortSeat: s => String(s || '?').split('@')[0],
  getContextThermal, computeBurn, buildThermalCurveSvgHtml, getNodeDisplayTitle: a => a.shortName,
  selectedAgentId: 'qa@rig', currentRigFilter: 'all', hoveredAgentId: null,
  collapsedIdleIds: new Set(), connectedNodeIds: new Set(), layoutResult: { tiers: {}, benchEdgeById: {} },
  pairEnvelopes: {}, openQueue: [], expandedXrayEnvelopes: new Set(), extractItemContextMeta,
  formatEnvelopeClock: () => '12:30', ageLabel: () => '2m', CMD_COPY_LABEL_HTML: '<span>copy</span>',
  renderContextBadgesHtml: m => `<div class="context-fixture">${escapeHtml(m.project || '')}</div>`, ...extra
});
const includes = (html, text) => assert.ok(html.includes(text), `Missing ${text}`);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

// Rays in every quadrant must touch the padded box and keep center-to-center direction.
test('intersectNodeBorder respects padded borders, ray direction, symmetry and scale', () => {
  for (const [hw, hh, pad] of [[100, 30, 0], [60, 60, 2], [12, 90, 4]]) {
    for (let angle = 0; angle < 360; angle += 15) {
      const vx = Math.cos(angle * Math.PI / 180), vy = Math.sin(angle * Math.PI / 180);
      const p = intersectNodeBorder(17, 29, hw, hh, vx, vy, pad);
      const dx = p.x - 17, dy = p.y - 29;
      assert.ok(Math.abs(dx) <= hw + pad + 1e-7);
      assert.ok(Math.abs(dy) <= hh + pad + 1e-7);
      near(Math.max(Math.abs(dx) / (hw + pad), Math.abs(dy) / (hh + pad)), 1);
      near(dx * vy - dy * vx, 0);
      assert.ok(dx * vx + dy * vy > 0);
      const scaled = intersectNodeBorder(17, 29, hw, hh, vx * 9, vy * 9, pad);
      near(scaled.x, p.x); near(scaled.y, p.y);
      const reverse = intersectNodeBorder(17, 29, hw, hh, -vx, -vy, pad);
      near(reverse.x + p.x, 34); near(reverse.y + p.y, 58);
    }
  }
  assert.deepEqual(intersectNodeBorder(5, 8, 100, 30, 0, 0, 2), { x: 5, y: 8 });
  assert.deepEqual(intersectNodeBorder(0, 0, 100, 30, 1, 0, 4), { x: 104, y: 0 });
});

test('Fallback anchors use midpoint/center, clamp out-of-canvas positions and reject absent geometry', () => {
  const wrap = { clientWidth: 800, clientHeight: 400 };
  assert.deepEqual(computeEdgeFallbackAnchor(edge, wrap, agents), { x: 400, y: 200 });
  assert.deepEqual(computeEdgeFallbackAnchor({ from: 'missing', to: 'qa@rig' }, wrap, agents), { x: 400, y: 200 });
  assert.deepEqual(computeEdgeFallbackAnchor(edge, wrap, agents.map(a => ({ ...a, x: -300, y: 400 }))), { x: 0, y: 400 });
  assert.deepEqual(computeEdgeFallbackAnchor(edge, wrap, agents.map(a => ({ ...a, x: NaN }))), { x: 400, y: 200 });
  assert.equal(computeEdgeFallbackAnchor(edge, { clientWidth: 0, clientHeight: 400 }, agents), null);
  assert.equal(computeEdgeFallbackAnchor(null, wrap, agents), null);
  assert.equal(computeEdgeFallbackAnchor(edge, null, agents), null);
});

test('Injected X-Ray placement stays within desktop/mobile canvas bounds at every edge', () => {
  for (const [cw, ch, pw, ph] of [[900, 550, 340, 220], [366, 470, 342, 300]]) {
    for (const anchor of [{ x: 0, y: 0 }, { x: cw, y: ch }, { x: cw / 2, y: ch / 2 }, { x: -1000, y: 1000 }]) {
      const drawer = { style: { display: 'block' }, parentElement: { clientWidth: cw, clientHeight: ch }, offsetWidth: pw, offsetHeight: ph,
        setAttribute(k, v) { this[k] = v; } };
      positionEdgeXrayDrawer(drawer, { edge, anchor, agents });
      const x = Number.parseInt(drawer.style.left), y = Number.parseInt(drawer.style.top);
      assert.ok(x >= 12 && x + pw <= cw - 12);
      assert.ok(y >= 12 && y + ph <= ch - 12);
      assert.ok(['above', 'below', 'clamped'].includes(drawer['data-placement']));
      assert.equal(drawer.style.right, 'auto');
    }
  }
  positionEdgeXrayDrawer(null, { edge, agents });
});

for (const lang of ['en', 'ru']) {
  test(`Node thermal/meta/status/card renderers preserve heat, queue/git metrics, measured ETA and LED hooks (${lang})`, () => {
    const d = deps(lang), agent = agents[0], hot = getContextThermal(80, 200000), warm = getContextThermal(68, 200000);
    includes(getNodeThermalFillGrad(80), '245, 158, 11');
    assert.ok(!getNodeThermalFillGrad(80).includes('255, 0, 85'), 'P1 CTX overheat fill must use calm amber, not crimson');
    assert.equal(getNodeThermalFillGrad(NaN), 'transparent');
    assert.equal(getNodeCtxValText({ ctxPct: 121 }, hot), '100%!');
    assert.equal(getNodeCtxValText({ ctxPct: null }, hot), '');
    assert.equal(getNodeCtxValClass(hot), 'node-ctx-val pill-crit');
    assert.equal(getNodeCtxValClass(warm), 'node-ctx-val pill-warn');
    const meta = renderNodeMetaRowHtml({ ...agent, git: { conflictFilesCount: 2, conflictPeers: ['qa@rig'] } }, warm, d);
    includes(meta, '↓3 ↑2'); includes(meta, 'node-meta-git-conflict'); includes(meta, escapeHtml(warm.tokensShort));
    assert.equal(renderNodeMetaRowHtml({}, {}, d), '');
    const spec = renderNodeSpecMetaHtml({ ...agent, reworkBadge: '🪃 QA: 2', reworkClass: 'warn' }, { perHour: 7, label: 'measured' }, d);
    for (const value of ['codex', 'test-model', 'QA: 2', lang === 'en' ? '~60m to 75%' : '~60м до 75%']) includes(spec, value);
    assert.ok(!renderNodeSpecMetaHtml(agent, { perHour: 0 }, d).includes('spec-eta'));
    includes(renderStateIndicatorHtml(agent, d), 'heart-anim');
    includes(renderStateIndicatorHtml({ state: 'idle' }, d), 'zzz-anim');
    includes(renderStateIndicatorHtml({ state: 'waiting', shellExited: true }, d), 'SHELL');
    includes(renderStateIndicatorHtml(agents[1], d), lang === 'en' ? 'NEEDS INPUT' : 'ЖДЁТ ВВОДА');
    assert.equal(renderDormantFlagHtml({ state: 'waiting', assignedWorkCount: 3 }), '🟠 3');
    const card = renderNodeCardHtml(agents[1], d);
    for (const value of ['pill-crit', 'data-agent-id="qa@rig"', 'data-thermal-tier="crit"', 'selected', 'role="button"', 'handleNodeLedMouseDown(event, this)',
      'handleNodeLedClick(event, this)', 'setHoverAgent(', 'selectAgent(', 'node-thermal-svg']) includes(card, value);
    includes(card, escapeHtml(d.td('node.urgentBadgeTip')));
  });

  test(`Topology SVG preserves border endpoints, statuses, badges, hit paths and filters (${lang})`, () => {
    const d = { ...deps(lang), edges: [edge], nodeMap: Object.fromEntries(agents.map(a => [a.id, a])), cw: 1000, ch: 500,
      boxSizes: { 'owner@rig': { hw: 100, hh: 30 }, 'qa@rig': { hw: 100, hh: 30 } }, hasSliceMatch: false, isEdgeInSlice: () => true };
    const html = renderTopologyEdgesHtml(d);
    for (const value of ['is-live', 'edge-stream live-active', 'stroke="transparent" stroke-width="18"', 'onclick="selectEdge(0, event)"', 'test-slice']) includes(html, value);
    const path = html.match(/d="M ([\d.-]+) ([\d.-]+) (?:C [\d.-]+ [\d.-]+, [\d.-]+ [\d.-]+, [\d.-]+ [\d.-]+(?: L )?|L )([\d.-]+) ([\d.-]+)"/);
    assert.ok(path, `Expected valid SVG edge path in ${html}`);
    assert.ok(Number(path[1]) >= 200 && Number(path[3]) <= 800);
    // Live diagonal edge renders as smooth cubic Bezier, while ghost diagonal stays straight/quiet
    assert.match(html, /d="M [\d.-]+ [\d.-]+ C /);
    for (const status of ['blocked', 'parked', 'held', 'pending', 'ghost']) {
      const h = renderTopologyEdgesHtml({ ...d, edges: [{ ...edge, queueStatus: status }] });
      includes(h, `is-${status}`); assert.ok(!h.includes('edge-stream live-active'));
      if (status === 'ghost') assert.match(h, /d="M [\d.-]+ [\d.-]+ L /);
    }
    assert.equal(renderTopologyEdgesHtml({ ...d, collapsedIdleIds: new Set(['qa@rig']) }), '');
    assert.equal(renderTopologyEdgesHtml({ ...d, currentRigFilter: 'other' }), '');
    includes(renderTopologyEdgesHtml({ ...d, hasSliceMatch: true, isEdgeInSlice: () => false }), 'dimmed');
  });

  test(`Swimlanes preserve progress stages, selection and toggle handler (${lang})`, () => {
    const html = renderSwimlanes({ visibleLanes: [{ id: 's1', name: 'Lane', coder: 'Coder', turns: 3, qaRounds: 2, currentStage: 1,
      color: '#38bdf8', padPx: '5px', barPx: '2px' }], stageNames: lang === 'en' ? ['Spec', 'Code', 'QA'] : ['Спека', 'Код', 'QA'],
      currentSliceFilter: 's1', escapeHtml });
    includes(html, 'stage-cell done'); includes(html, 'stage-cell current'); includes(html, 'data-slice="all"');
    includes(html, "onclick=\"setSliceFilter(this.getAttribute('data-slice'))\"");
    includes(html, 'QA: 2');
    assert.equal(renderSwimlanes({ visibleLanes: [], stageNames: [], currentSliceFilter: 'all', escapeHtml }), '');
  });

  test(`Route X-Ray merges/deduplicates live/history and expands envelope timelines (${lang})`, () => {
    const old = { id: 'q-same', from: edge.from, to: edge.to, slice: edge.slice, state: 'done', summary: 'Stale summary', updatedAt: '2026-11-25T10:00:00Z' };
    const d = deps(lang, { pairEnvelopes: { 'owner@rig <-> qa@rig': [old, { ...old, id: 'q-previous', summary: 'Prior event' }] },
      openQueue: [{ qitemId: 'q-same', sourceSession: edge.from, destinationSession: edge.to, state: 'in-progress', summary: 'Live summary',
        tsUpdated: '2026-11-25T12:00:00Z', tags: ['slice:test-slice', 'project:fixture'] }],
      expandedXrayEnvelopes: new Set(['slice:test-slice']) });
    const html = renderEdgeXray(edge, d);
    includes(html, d.td('xray.title')); includes(html, 'Live summary'); includes(html, 'Prior event');
    includes(html, 'env-history-timeline'); includes(html, 'env-history-toggle open'); includes(html, 'fixture');
    includes(html, 'rig queue show q-same --full'); includes(html, 'data-qid="q-same"');
    assert.ok(!html.includes('Stale summary'));
    assert.equal((html.match(/class="env-history-row"/g) || []).length, 2);
    includes(renderEdgeXray(edge, deps(lang)), d.td('xray.noHistory'));
    assert.equal(renderEdgeXray(null, d), '');
  });

  test(`Untrusted node labels and X-Ray IDs/summaries stay escaped and out of inline JS (${lang})`, () => {
    const bad = `evil'\"><img src=x onerror=alert(1)>&`, d = deps(lang);
    const agent = { ...agents[0], id: bad, shortName: bad, role: bad, icon: bad, activityLabel: bad, model: bad, harness: bad, state: 'unknown' };
    const key = [edge.from, edge.to].sort().join(' <-> ');
    const xray = renderEdgeXray(edge, { ...d, pairEnvelopes: { [key]: [
      { id: bad, from: edge.from, to: edge.to, slice: bad, summary: bad, state: 'done' },
      { id: 'second', from: edge.from, to: edge.to, slice: bad, summary: bad, state: 'done' }
    ] }, expandedXrayEnvelopes: new Set(['slice:' + bad]) });
    const swim = renderSwimlanes({ visibleLanes: [{ id: bad, name: bad, coder: bad, currentStage: 0 }], stageNames: [bad], currentSliceFilter: 'all', escapeHtml });
    for (const html of [renderStateIndicatorHtml(agent, d), renderNodeCardHtml(agent, d), renderNodeSpecMetaHtml(agent, {}, d),
      renderNodeMetaRowHtml(agent, { tokensShort: bad }, d), xray, swim]) {
      includes(html, escapeHtml(bad)); assert.ok(!html.includes('<img')); assert.ok(!html.includes(bad));
      for (const [, handler] of html.matchAll(/on(?:click|mousedown|mouseenter|mouseleave)="([^"]*)"/g)) assert.ok(!handler.includes('alert(1)'));
    }
    const handler = xray.match(/data-qid="[^"]*" onclick="([^"]*)"/)[1];
    let received;
    vm.runInNewContext(`(function(){${handler}}).call(button)`, { button: { getAttribute: () => bad }, event: { stopPropagation() {} }, openQueueItemContext: id => { received = id; } });
    assert.equal(received, bad);
  });
}

test('X-Ray positions in content coordinates but clamps to scrolled visible viewport', () => {
  const parent = { clientWidth: 390, clientHeight: 440, scrollWidth: 1200, scrollHeight: 1000, scrollLeft: 460, scrollTop: 180 };
  const drawer = { style: { display: 'block' }, parentElement: parent, offsetWidth: 340, offsetHeight: 220, setAttribute() {} };
  positionEdgeXrayDrawer(drawer, { edge, anchor: { x: 650, y: 300 }, agents });
  assert.equal(drawer.style.left, '480px');
  assert.equal(drawer.style.top, '316px');
  const fallback = computeEdgeFallbackAnchor(edge, parent, agents);
  assert.deepEqual(fallback, { x: 600, y: 500 });
});


test('Rig cluster backdrops appear only for multiple zones and escape rig identifiers', () => {
  const bad = 'rig-<img src=x onerror=alert(1)>';
  const clusters = [{ rigId: bad, xPct: 1, yPct: 2, wPct: 45, hPct: 96, count: 5 },
    { rigId: 'rig-b', xPct: 52, yPct: 2, wPct: 47, hPct: 96, count: 3 }];
  const d = { cw: 1000, ch: 600, escapeHtml };
  const html = renderRigClustersHtml(clusters, d);
  assert.equal((html.match(/class="rig-cluster-zone"/g) || []).length, 2);
  includes(html, escapeHtml('@' + bad + ' · 5'));
  assert.ok(!html.includes('<img'));
  assert.equal(renderRigClustersHtml([], d), '');
  assert.equal(renderRigClustersHtml(clusters.slice(0, 1), d), '');
});

test('Node cards inside multi-rig clusters strip @rig from both title and role while keeping full id tooltip', () => {
  const clusterAgent = {
    id: 'dev-coder3@rig-commander',
    icon: '🔧',
    role: 'Кодер (dev-coder3@rig-commander)',
    state: 'idle',
    ctxPct: 18,
    ctxWindowSize: 258000,
    x: 50,
    y: 40,
    callsIn: 5,
    callsOut: 3,
    activityLabel: 'idle'
  };
  const html = renderNodeCardHtml(clusterAgent, {
    getContextThermal: () => ({ tier: 'cool', color: '#38bdf8', glow: 'none', pct: 18, label: '18%', tokensShort: '47K/258K' }),
    selectedAgentId: clusterAgent.id,
    currentRigFilter: 'all',
    collapsedIdleIds: new Set(),
    hoveredAgentId: null,
    connectedNodeIds: new Set(),
    layoutResult: {
      tiers: { [clusterAgent.id]: 'active' },
      benchEdgeById: {},
      rigClusters: [
        { rigId: 'kernel', xPct: 1, yPct: 2, wPct: 24, hPct: 96, count: 1 },
        { rigId: 'rig-commander', xPct: 28, yPct: 2, wPct: 70, hPct: 96, count: 2 }
      ]
    },
    computeBurn: () => ({ label: '', perHour: 0 }),
    deckLang: 'ru',
    getNodeDisplayTitle: (a) => a.id,
    escapeHtml,
    td: (k) => k,
    buildThermalCurveSvgHtml: () => ''
  });
  includes(html, '<div class="node-name" title="dev-coder3@rig-commander">dev-coder3</div>');
  includes(html, '<div class="node-role">Кодер (dev-coder3)</div>');
  assert.ok(!html.includes('>dev-coder3@rig-commander<'));
  assert.ok(!html.includes('>Кодер (dev-coder3@rig-commander)<'));
});

test('renderSwimlanesSummaryChips builds escaped clickable inline progress chips for collapsed header bar', () => {
  const html = renderSwimlanesSummaryChips({
    visibleLanes: [
      { id: 'iter7-2', name: '📁 iter7-2', color: '#00ff9d', currentStage: 4, turns: 7, qaRounds: 2 },
      { id: 'xss"><img src=x>', name: '📁 bad<script>', color: '#38bdf8', currentStage: 2, turns: 3, qaRounds: 1 }
    ],
    stageNames: ['1. Spec', '2. Код', '3. QA', '4. Фикс', '5. Принят', '6. Push'],
    currentSliceFilter: 'iter7-2',
    escapeHtml
  });
  includes(html, 'class="swim-chip active"');
  includes(html, '>iter7-2<');
  includes(html, '>5/6<');
  includes(html, 'data-slice="all"');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
});

test('renderQuietClustersPillHtml renders escaped parked/idle chips and expand-all action in EN & RU', () => {
  for (const lang of ['en', 'ru']) {
    const td = (key, vars) => tDeck(lang, key, vars);
    const html = renderQuietClustersPillHtml([
      { rigId: 'kernel', count: 5, dormantCount: 4, parkedCount: 1, parkedWorkCount: 389 },
      { rigId: 'bad"><img src=x>', count: 1, dormantCount: 1, parkedCount: 0, parkedWorkCount: 0 }
    ], { td, escapeHtml });
    includes(html, 'data-quiet-rig="kernel"');
    includes(html, '🟠 389');
    includes(html, 'onclick="expandAllQuietRigs()"');
    assert.ok(!html.includes('<img'));
  }
  assert.equal(renderQuietClustersPillHtml([], { td: k => k, escapeHtml }), '');
});

  test('expanded quiet zone has a localized native collapse button and an escaped rig identifier', () => {
  const rigId = 'quiet" & <lab>';
  const clusters = [rigId, 'active'].map(rigId => ({ rigId, count: 1, xPct: 0, yPct: 5, wPct: 48, hPct: 80 }));
  for (const lang of ['en', 'ru']) {
    const td = (key, vars) => tDeck(lang, key, vars);
    const html = renderRigClustersHtml(clusters, { cw: 1000, ch: 600, escapeHtml, td, collapsibleRigIds: new Set([rigId]) });
    includes(html, 'data-quiet-rig="' + escapeHtml(rigId) + '"');
    includes(html, 'aria-label="' + escapeHtml(td('graph.collapseQuietTip', { rig: rigId })) + '"');
    includes(html, 'onclick="toggleQuietRigCluster(this.dataset.quietRig)"');
    assert.equal((html.match(/<button /g) || []).length, 1);
    assert.ok(!html.includes(rigId));
  }
});

test('Node thermal sparkline renders as an in-flow strip after the metrics row with zero overlay positioning', () => {
  const card = renderNodeCardHtml(agents[0], deps('en'));
  const metaIdx = card.indexOf('class="node-meta-row"');
  const ctxBoxIdx = card.indexOf('class="ctx-box"');
  const meterIdx = card.indexOf('class="node-bottom-meter"');
  assert.ok(metaIdx > 0, 'metrics row should exist');
  assert.ok(ctxBoxIdx > metaIdx, 'ctx-box should follow metrics row');
  assert.ok(meterIdx > ctxBoxIdx, 'sparkline strip must be placed after metrics row and ctx-box');
  const meterTag = card.slice(meterIdx, card.indexOf('>', meterIdx) + 1);
  includes(meterTag, 'data-meter-layout="strip"');
  includes(meterTag, 'position:relative');
  assert.ok(!meterTag.includes('position:absolute'), 'sparkline strip must not be absolutely positioned over metrics');
});

test('Routine active edges recolor crimson/magenta to calm cyan while P0 urgent/HITL edges stay crimson', () => {
  const workingNodes = {
    'owner@rig': { id: 'owner@rig', state: 'working', x: 20, y: 25 },
    'coder@rig': { id: 'coder@rig', state: 'working', x: 80, y: 25 },
    'qa@rig': { id: 'qa@rig', state: 'urgent', x: 50, y: 80 }
  };
  const baseDeps = {
    ...deps('ru'),
    nodeMap: workingNodes,
    cw: 1000,
    ch: 500,
    boxSizes: { 'owner@rig': { hw: 100, hh: 30 }, 'coder@rig': { hw: 100, hh: 30 }, 'qa@rig': { hw: 100, hh: 30 } },
    hasSliceMatch: false,
    isEdgeInSlice: () => true
  };

  // Routine active handoff with crimson/magenta input must be calmed to cyan (#38bdf8 / arr-cyan)
  const routineHtml = renderTopologyEdgesHtml({
    ...baseDeps,
    edges: [{ from: 'owner@rig', to: 'coder@rig', slice: 'all', calls: 12, liveActive: true, color: '#ff0055', marker: 'arr-crimson', speed: '1s' }]
  });
  includes(routineHtml, 'data-edge-severity="routine"');
  includes(routineHtml, '--edge-stroke:#38bdf8;');
  includes(routineHtml, 'stroke="#38bdf8"');
  includes(routineHtml, 'marker-end="url(#arr-cyan)"');
  includes(routineHtml, '📨 В работе');
  assert.ok(!routineHtml.includes('#ff0055'), 'routine active edge must not use crimson');
  assert.ok(!routineHtml.includes('arr-crimson'), 'routine active edge must not use crimson marker');

  // P0 urgent/HITL edge keeps crimson (#ff0055 / arr-crimson) and P0 badge
  const p0Html = renderTopologyEdgesHtml({
    ...baseDeps,
    edges: [{ from: 'qa@rig', to: 'owner@rig', slice: 'all', calls: 46, liveActive: true, color: '#ff0055', marker: 'arr-crimson', speed: '0.75s' }]
  });
  includes(p0Html, 'is-p0-anomaly');
  includes(p0Html, 'data-edge-severity="p0"');
  includes(p0Html, '--edge-stroke:#ff0055;');
  includes(p0Html, 'stroke="#ff0055"');
  includes(p0Html, 'marker-end="url(#arr-crimson)"');
  includes(p0Html, '🚨 HITL');
});
