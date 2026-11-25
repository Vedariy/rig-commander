import test from 'node:test';
import assert from 'node:assert/strict';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import { normalizeGanttSpans } from '../openrig/assets/domain/gantt-model.js';
import {
  renderGantt, renderHandoffSequenceView, renderGanttKpiStrip, renderGanttSpanDetail,
  renderGanttTooltipHtml, syncGanttControlsUi, applyGanttFocus, positionGanttTooltip,
  buildDemoGanttItems
} from '../openrig/assets/ui/gantt-view.js';

const NOW = Date.parse('2026-11-25T18:00:00Z');
const at = minutes => new Date(NOW - minutes * 60_000).toISOString();
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
const rows = [
  { id: 'q-1', from: 'owner@rig', to: 'coder@rig', chain: 'slice:alpha', slice: 'alpha', state: 'done', summary: 'Implementation', createdAt: at(120), claimedAt: at(90), endAt: at(80) },
  { id: 'q-2', from: 'coder@rig', to: 'qa@rig', chain: 'slice:alpha', slice: 'alpha', state: 'done', summary: 'Review', createdAt: at(79), claimedAt: at(77), endAt: at(55) },
  { id: 'q-3', from: 'qa@rig', to: 'coder@rig', chain: 'slice:alpha', slice: 'alpha', state: 'in-progress', summary: 'QA bounce: repair', createdAt: at(54), claimedAt: at(52), endAt: null },
  { id: 'q-side', from: 'coder@rig', to: 'coder@rig', chain: 'slice:beta', slice: 'beta', state: 'done', summary: 'Self handoff', createdAt: at(40), claimedAt: at(39), endAt: at(5) }
];
const agents = ['owner@rig', 'coder@rig', 'qa@rig'].map(id => ({ id, shortName: id.split('@')[0] }));
const model = (items = rows, opts = {}) => normalizeGanttSpans(items, { nowMs: NOW, windowH: 6, ...opts });
const deps = (deckLang = 'en', extra = {}) => ({
  deckLang, td: (key, vars) => tDeck(deckLang, key, vars), escapeHtml,
  shortSeat: s => String(s || '?').split('@')[0], getNodeDisplayTitle: a => a.shortName,
  agents, selectedAgentId: 'coder@rig', ganttFocusChain: null, ganttSelectedSpanId: 'q-3',
  ganttMode: 'timeline', ganttGroupBy: 'agent', ganttWindowH: 6, ganttZoom: 1, clientWidth: 900,
  ganttHideNoise: true, ganttOnlyBottlenecks: false, ganttHoverChain: null,
  CMD_COPY_LABEL_HTML: '<span>copy</span>',
  renderContextBadgesHtml: () => '<div class="context-fixture">context badge</div>',
  renderEvaluatorVerdictCardHtml: () => '<div class="evaluator-fixture">verdict card</div>',
  ...extra
});
const includes = (html, text) => assert.ok(html.includes(text), `Missing ${text}`);

for (const lang of ['en', 'ru']) {
  test(`KPI strip preserves counts, wait/work ratio, bounce and bottleneck jump (${lang})`, () => {
    const d = deps(lang), m = model(), html = renderGanttKpiStrip(m.kpis, d);
    includes(html, `${d.td('gantt.kpiTasks')} <b>4</b>`);
    includes(html, '(2)');
    includes(html, `width:${m.kpis.waitPct}%`);
    includes(html, `width:${m.kpis.workPct}%`);
    includes(html, `${d.td('gantt.kpiBounces')} <b>1</b>`);
    includes(html, 'onclick="jumpToGanttBottleneck()"');
    includes(html, lang === 'en' ? '30m' : '30м');
    assert.equal(m.kpis.topBottleneck.id, 'q-1');
    const empty = renderGanttKpiStrip(model([]).kpis, d);
    assert.ok(!empty.includes('jumpToGanttBottleneck()'));
    assert.ok(!empty.includes('undefined'));
  });

  test(`Timeline preserves agent/chain grouping, selected span, zoom and inline hover/click hooks (${lang})`, () => {
    const m = model(), before = structuredClone(m), d = deps(lang);
    const html = renderGantt(m, d);
    assert.equal((html.match(/class="g-chain /g) || []).length, 4);
    includes(html, 'class="g-chain is-selected" data-span-id="q-3"');
    includes(html, 'class="g-handoff-link"');
    includes(html, 'onclick="ganttClick(this, event)"');
    includes(html, "onmouseenter=\"ganttHover(this.getAttribute('data-chain'), this.getAttribute('data-span-id'), event)\"");
    includes(html, 'onmousemove="ganttMoveTip(event)"');
    includes(html, "onmouseleave=\"ganttHover(null, '')\"");
    includes(html, d.td('gantt.now'));
    const grouped = renderGantt(m, { ...d, ganttGroupBy: 'chain', ganttFocusChain: 'slice:alpha' });
    includes(grouped, "onclick=\"setGanttFocus(ganttFocusChain === this.getAttribute('data-chain') ? null : this.getAttribute('data-chain'))\"");
    assert.ok(!grouped.includes('class="g-handoff-link"'));
    const width = s => Number(s.match(/<svg width="([\d.]+)"/)[1]);
    assert.ok(width(renderGantt(m, { ...d, ganttZoom: 4 })) > width(html));
    assert.deepEqual(m, before, 'Rendering must not mutate model or its spans');
  });

  test(`Empty/noise-filtered/bottleneck-only states render without stale spans (${lang})`, () => {
    const d = deps(lang), noise = { ...rows[0], id: 'qitem-opgate-hidden', summary: 'Noise sentinel' };
    const hidden = model([noise]);
    const html = renderGantt(hidden, d);
    includes(html, 'class="gantt-empty"');
    includes(html, `${d.td('gantt.noiseHidden')}: 1`);
    assert.ok(!html.includes('Noise sentinel'));
    includes(renderGantt(model([noise], { hideNoise: false }), d), 'data-span-id="qitem-opgate-hidden"');
    includes(renderGantt(model([]), d), escapeHtml(d.td('gantt.empty', { h: '6ч' })));
    const noBottlenecks = model([rows[3]], { onlyBottlenecks: true });
    includes(renderGantt(noBottlenecks, d), lang === 'en' ? 'fleet flow is smooth' : 'поток идёт ровно');
    includes(renderGantt(noBottlenecks, { ...d, ganttMode: 'sequence' }), 'data-span-id="q-side"');
    includes(renderHandoffSequenceView([], d), 'class="gantt-empty"');
    includes(renderGantt(model(rows, { rigFilter: 'other-rig' }), d), 'class="gantt-empty"');
    assert.equal((renderGantt(model(rows, { windowH: 0.5 }), { ...d, ganttWindowH: 0.5 }).match(/class="g-chain /g) || []).length, 2);
  });

  test(`Sequence scopes steps to focused chain, preserves pills, QA bounce, live and self arrows (${lang})`, () => {
    const m = model(), d = deps(lang, { ganttMode: 'sequence', ganttFocusChain: 'slice:alpha' });
    const html = renderGantt(m, d);
    includes(html, 'class="gantt-seq-shell"');
    includes(html, escapeHtml(d.td('gantt.seqTitle')));
    assert.equal((html.match(/class="gantt-seq-step /g) || []).length, 3);
    includes(html, 'class="gantt-seq-step is-selected" data-span-id="q-3"');
    includes(html, 'data-chain="slice:beta"'); // Other chain remains selectable, not in active steps.
    assert.ok(!html.includes('data-span-id="q-side"'));
    includes(html, 'marker-end="url(#seqArrWarn)"');
    includes(html, 'onclick="selectGanttSpan(');
    const self = renderHandoffSequenceView(m.allWindowSpans, { ...d, ganttFocusChain: 'slice:beta' });
    assert.equal((self.match(/class="gantt-seq-step /g) || []).length, 1);
    includes(self, 'Self handoff');
    assert.match(self, /<path d="M [^"]+ C /);
    const live = renderHandoffSequenceView(m.allWindowSpans.map(s => ({ ...s, isBounceBack: false })), d);
    includes(live, 'marker-end="url(#seqArrLive)"');
  });

  test(`Span drawer and tooltip preserve context, verdict, actions and localized durations (${lang})`, () => {
    const sp = model().spans[0], d = deps(lang, { ganttFocusChain: 'slice:alpha' });
    const html = renderGanttSpanDetail(sp, d);
    for (const text of ['context badge', 'verdict card', 'rig queue show q-1', 'openChainInSequence(',
      'setGanttFocus(', 'focusSeatDiagnosis(', 'openTerminalModal(', 'runAiEvaluation(', 'openQueueItemContext(', 'copyCmd(', 'selectGanttSpan(null)']) includes(html, text);
    includes(html, escapeHtml(d.td('gantt.spanClearChain')));
    includes(html, lang === 'en' ? '30m' : '30м');
    assert.ok(!renderGanttSpanDetail(sp, { ...d, ganttMode: 'sequence' }).includes('openChainInSequence('));
    assert.ok(!renderGanttSpanDetail({ ...sp, id: 'demo-example' }, d).includes('rig queue show'));
    assert.ok(!renderGanttSpanDetail({ ...sp, to: 'absent@rig' }, d).includes('openTerminalModal('));
    const tip = renderGanttTooltipHtml({ ...sp, isOpen: true, isBounceBack: true }, d);
    includes(tip, d.td('gantt.legLong'));
    includes(tip, d.td('gantt.seqBounceBadge'));
    includes(tip, 'LIVE');
    includes(tip, 'Implementation');
    assert.equal(renderGanttSpanDetail(null, d), '');
    assert.equal(renderGanttTooltipHtml(null, d), '');
  });

  test(`Untrusted labels, summaries and identifiers are escaped in every view (${lang})`, () => {
    const bad = `evil'\"><img src=x onerror=alert(1)>&`;
    const m = model([{ ...rows[0], id: bad, chain: bad, slice: bad, from: bad, to: bad, summary: bad, state: bad }]);
    const d = deps(lang, { agents: [{ id: bad, shortName: bad }], ganttSelectedSpanId: bad });
    for (const html of [renderGantt(m, d), renderGantt(m, { ...d, ganttGroupBy: 'chain' }),
      renderHandoffSequenceView(m.allWindowSpans, d), renderGanttKpiStrip(m.kpis, d),
      renderGanttSpanDetail(m.spans[0], d), renderGanttTooltipHtml(m.spans[0], d)]) {
      includes(html, escapeHtml(bad));
      assert.ok(!html.includes('<img'));
      assert.ok(!html.includes(bad));
      for (const [, handler] of html.matchAll(/on(?:click|mouseenter|mousemove|mouseleave)="([^"]*)"/g)) assert.ok(!handler.includes('alert(1)'));
    }
  });
}

function element(attrs = {}) {
  const classes = new Set();
  return { style: {}, textContent: '', offsetWidth: 280, offsetHeight: 90,
    getAttribute: key => attrs[key],
    classList: { contains: c => classes.has(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) }
  };
}

test('Injected controls adapter preserves active windows/modes/grouping, noise count and focus visibility', () => {
  const ids = ['btnGanttModeTimeline', 'btnGanttModeSequence', 'ganttGroupSwitch', 'ganttZoomGroup', 'btnGanttGroupAgent',
    'btnGanttGroupChain', 'btnGanttHideNoise', 'btnGanttBottlenecks', 'ganttZoomLabel', 'btnGanttClearFocus'];
  const nodes = Object.fromEntries(ids.map(id => [id, element()]));
  const windows = [0.5, 1, 6, 24].map(h => element({ 'data-gantt-window': String(h) }));
  const doc = { getElementById: id => nodes[id], querySelectorAll: () => windows };
  syncGanttControlsUi(doc, deps('en', { ganttMode: 'sequence', ganttFocusChain: 'slice:alpha', ganttWindowH: 1, ganttZoom: 4 }), 3);
  assert.equal(nodes.btnGanttModeSequence.classList.contains('active'), true);
  assert.equal(windows[1].classList.contains('active'), true);
  assert.equal(windows[2].classList.contains('active'), false);
  assert.equal(nodes.ganttGroupSwitch.style.display, 'none');
  assert.equal(nodes.btnGanttHideNoise.textContent, 'Noise: OFF (3)');
  assert.equal(nodes.btnGanttClearFocus.style.display, '');
  assert.equal(nodes.ganttZoomLabel.textContent, '4×');
  syncGanttControlsUi(doc, deps('ru', { ganttHideNoise: false, ganttGroupBy: 'chain' }));
  assert.equal(nodes.btnGanttGroupChain.classList.contains('active'), true);
  assert.equal(nodes.btnGanttHideNoise.textContent, 'Шум: ВИДЕН');
  assert.equal(nodes.ganttGroupSwitch.style.display, '');
  assert.equal(nodes.btnGanttClearFocus.style.display, 'none');
  syncGanttControlsUi({ getElementById: () => null, querySelectorAll: () => [] }, deps());
});

test('Injected focus/tooltip adapters retain hover precedence and viewport bounds', () => {
  const spans = ['alpha', 'beta'].map(chain => element({ 'data-chain': chain }));
  const links = ['alpha', 'beta'].map(chain => element({ 'data-chain': chain }));
  const tip = element(); tip.classList.toggle('visible', true);
  const doc = { getElementById: id => id === 'ganttTooltip' ? tip : {
    querySelectorAll: sel => sel === '.g-chain' ? spans : links
  } };
  applyGanttFocus(doc, { ganttFocusChain: 'alpha', ganttHoverChain: null });
  assert.equal(spans[0].style.opacity, '1');
  assert.equal(spans[1].style.opacity, '0.32');
  assert.equal(links[1].style.opacity, '0.06');
  applyGanttFocus(doc, { ganttFocusChain: 'alpha', ganttHoverChain: 'beta' });
  assert.equal(spans[0].style.opacity, '0.52');
  assert.equal(spans[1].style.opacity, '1');
  positionGanttTooltip(doc, { clientX: 790, clientY: 590 }, { innerWidth: 800, innerHeight: 600 });
  assert.deepEqual(tip.style, { left: '496px', top: '486px' });
  positionGanttTooltip(doc, null, { innerWidth: 800, innerHeight: 600 });
  applyGanttFocus({ getElementById: () => null }, deps());
});

test('Offline Gantt fixture uses injected clock/fleet and localized summaries', () => {
  const fleet = [{ id: 'custom-owner@rig' }, { id: 'custom-dev-coder@rig' }];
  const en = buildDemoGanttItems({ agents: fleet, deckLang: 'en', nowMs: NOW });
  const ru = buildDemoGanttItems({ agents: fleet, deckLang: 'ru', nowMs: NOW });
  assert.equal(en.length, 12);
  assert.equal(en[0].from, 'custom-owner@rig');
  assert.equal(en[0].createdAt, at(330));
  assert.notEqual(en[0].summary, ru[0].summary);
  assert.equal(model(en).allWindowSpans.length, 12);
});
