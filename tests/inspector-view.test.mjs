import assert from 'node:assert/strict';
import test from 'node:test';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import {
  dedupeRadarItemsByAgent, renderActionAuditHtml, renderContextBadgesHtml, renderContextLineageHtml, renderCurrentTaskHtml, renderHarnessQuickKeys,
  renderInteractivePromptOptionsHtml, renderSeatDiagnosisHtml, renderSeatGitWorktreeHtml
} from '../openrig/assets/ui/inspector-view.js';

const seat = 'coder@example';
const agent = { id: seat, state: 'idle', harness: 'codex' };
const special = '<file & "branch">';
const escaped = '&lt;file &amp; &quot;branch&quot;&gt;';
const entities = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
const context = (lang = 'en') => ({
  deckLang: lang,
  td: (key, values) => tDeck(lang, key, values),
  escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]),
  shortSeat: id => id.split('@')[0],
  getControlLockAttrs: () => '',
  renderEvaluatorVerdictCardHtml: () => '',
  isEvalRunning: () => false,
  lastScreenBySeat: {},
  queueItems: [],
  openQueue: [],
  resolveSeatIdByShort: () => null,
  CMD_COPY_LABEL_HTML: 'Cmd'
});

test('empty diagnosis keeps evaluator controls and only disables the running tier', () => {
  const ctx = context();
  ctx.isEvalRunning = (scope, id, tier) => id === seat && tier === 'system2';
  const html = renderSeatDiagnosisHtml(ctx, agent);
  assert.match(html, /id="inspEvalMiniBar"/);
  assert.doesNotMatch(html, /seat-diagnosis-card/);
  assert.match(html, /is-s2" data-eval-seat="coder@example" disabled/);
});

test('urgent seat has a localized P0 and a terminal action even before findings arrive', () => {
  for (const lang of ['ru', 'en']) {
    const ctx = context(lang);
    const html = renderSeatDiagnosisHtml(ctx, { ...agent, state: 'urgent', needsInputReason: special });
    assert.match(html, /is-p0/);
    assert.match(html, /data-transport="modal_terminal"/);
    assert.ok(html.includes(ctx.td('diag.resolveHitlBtn')));
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(special));
  }
});

test('P1 shows only the affected seat’s active queue samples and brackets extra findings', () => {
  const ctx = context();
  ctx.intelligence = { allFindings: [
    { severity: 'p0_urgent', actionPlan: { seatTarget: 'other' }, title: 'Unrelated' },
    { severity: 'p1_high', detectorId: 'topology.bottleneck', metrics: { affectedSeats: [seat] }, title: 'Waiting for QA' },
    { severity: 'p2_warn', actionPlan: { seatTarget: seat }, title: 'Secondary' }
  ] };
  ctx.openQueue = [
    { destinationSession: seat, sourceSession: 'owner@example', summary: special, tags: ['slice:qa'] },
    { destinationSession: seat, sourceSession: 'change-detector', summary: 'Internal wake' }
  ];
  const html = renderSeatDiagnosisHtml(ctx, agent);
  assert.match(html, /is-p1/);
  assert.match(html, /Waiting for QA/);
  assert.match(html, /Secondary/);
  assert.match(html, /diag-queue-row/);
  assert.ok(html.includes(escaped));
  assert.doesNotMatch(html, /Unrelated|Internal wake/);
  assert.match(html, /data-transport="gantt_slice"/);
});

test('real HITL options and manual quick keys propagate the current lock and modal status target', () => {
  const ctx = context();
  let busy = true;
  ctx.getControlLockAttrs = (scope, fp) => {
    assert.equal(scope, 'seat:' + seat);
    assert.ok(fp.startsWith('send:' + seat + ':'));
    return busy ? ' disabled aria-busy="true"' : '';
  };
  const screen = ['Run this command?', '> 1. Yes, run ' + special, '  2. No, cancel', 'esc to cancel'].join('\n');
  const options = () => renderInteractivePromptOptionsHtml(ctx, seat, screen, 'modalCmdStatus');
  assert.match(options(), /data-key="1 Enter" data-status="modalCmdStatus" disabled/);
  assert.ok(options().includes(escaped));
  assert.match(renderHarnessQuickKeys(ctx, agent, 'modalCmdStatus'), /data-status="modalCmdStatus"[^>]* disabled/);
  busy = false;
  assert.doesNotMatch(options(), / disabled/);
  assert.equal(renderInteractivePromptOptionsHtml(ctx, seat, 'Notes:\n1. Read logs\n2. Review logs\nDone.\n>'), '');
});

test('terminal text and queue summaries stay escaped in current task', () => {
  const ctx = context();
  ctx.lastScreenBySeat[seat] = 'building\n' + special;
  const working = { ...agent, state: 'working' };
  for (const queueItems of [[], [{ to: seat, summary: special, state: 'pending' }]]) {
    const html = renderCurrentTaskHtml({ ...ctx, queueItems }, working);
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(special));
  }
});

test('action audit filters by seat, caps at five records, and escapes operator text', () => {
  const ctx = context();
  assert.equal(renderActionAuditHtml(ctx, seat), '');
  const records = Array.from({ length: 6 }, (_, i) => ({
    targetSeatId: seat, actionId: 'action-' + i, postconditionStatus: 'verified',
    payloadPreview: special, postconditionDetail: special
  }));
  ctx.ontologySnapshot = { actionRecords: [{ ...records[0], targetSeatId: 'other', actionId: 'elsewhere' }, ...records] };
  const html = renderActionAuditHtml(ctx, seat);
  assert.match(html, /action-4/);
  assert.doesNotMatch(html, /elsewhere|action-5/);
  assert.ok(html.includes(escaped));
  assert.ok(!html.includes(special));
});

test('lineage keeps queue IDs in data attributes and escapes body, decisions and artifacts', () => {
  const ctx = context();
  const id = "qitem-'example";
  const html = renderContextLineageHtml(ctx, {
    item: { id, from: seat, body: special, summary: special, project: special },
    lineage: { ancestors: [{ id, summary: special }] },
    artifacts: { docs: [special], adrs: [], commits: [], linkedQitems: [id] },
    relatedDecisions: [{ decision: special }]
  });
  assert.match(html, /ctx-lineage-node is-current/);
  assert.match(html, /data-qitem="qitem-&#39;example"/);
  assert.doesNotMatch(html, /onclick="[^"]*qitem-&#39;example/);
  assert.match(html, /ctx-body-pre/);
  assert.ok(html.includes(escaped));
  assert.ok(!html.includes(special));
});

test('worktree keeps conflicted files first and carries the full escaped path to the diff button', () => {
  const html = renderSeatGitWorktreeHtml(context(), { ...agent, git: {
    branch: 'main', dirtyCount: 2, conflictFilesCount: 1,
    conflictFiles: [special], files: ['ordinary', { path: special }]
  } });
  assert.match(html, /has-conflict/);
  assert.ok(html.indexOf('data-file="' + escaped + '"') < html.indexOf('data-file="ordinary"'));
  assert.match(html, /openGitDiffModal\(this.getAttribute\('data-seat'\), this.getAttribute\('data-file'\)\)/);
});

test('preview immediately precedes approval controls, with full escaped tooltip and bounded text', () => {
  for (const lang of ['en', 'ru']) {
    const ctx = context(lang);
    const command = 'echo ' + special + ' ' + 'long '.repeat(45) + 'tail';
    const html = renderInteractivePromptOptionsHtml(ctx, seat, 'Requesting permission for:\n  ' + command +
      '\nRun this command?\n> 1. Yes, run\n  2. No, cancel', 'modalCmdStatus');
    assert.ok(html.indexOf('hitl-command-preview') < html.indexOf('triggerPromptOption(this)'));
    assert.ok(html.includes('title="' + ctx.escapeHtml(command) + '"'));
    assert.ok(html.includes(ctx.td('insp.hitlCmdLabel')));
    assert.match(html, /…<\/code>/);
    assert.ok(!html.includes(special));
  }
});

test('preview-only yes/no prompts and repeated credentials in option labels have no raw credential sinks', () => {
  const ctx = context();
  const question = 'Continue with --api-key fixture-only? [Y/n]';
  const yesNo = renderInteractivePromptOptionsHtml(ctx, seat, question);
  assert.match(yesNo, /hitl-command-preview/);
  assert.doesNotMatch(yesNo, /fixture-only|triggerPromptOption/);
  const numbered = renderInteractivePromptOptionsHtml(ctx, seat,
    'Requesting permission for:\n  tool --password fixture-only\nRun this command?\n1. Yes, run with --password fixture-only\n2. No, cancel');
  assert.match(numbered, /triggerPromptOption/);
  assert.doesNotMatch(numbered, /fixture-only/);
});

test('handoff chips dispatch full queue and seat IDs in either direction', () => {
  const ctx = { ...context(), shortSeat: id => id }; // All Rigs can retain the rig suffix.
  const seatId = 'dev-check@rig-commander';
  const queueIds = ['qitem-20261125224306-8f3c8035', 'QITEM-demo@source-8f3c8035'];
  for (const [field, arrow] of [['handedOffFrom', '↖'], ['handedOffTo', '↘']]) {
    const seatChip = renderContextBadgesHtml(ctx, { [field]: seatId });
    assert.ok(seatChip.includes(`title="${field}: ${seatId}" data-seat="${seatId}"`));
    assert.ok(seatChip.includes(`selectAgent(this.dataset.seat)">${arrow} dev-check</button>`));
    for (const qitemId of queueIds) {
      const queueChip = renderContextBadgesHtml(ctx, { [field]: qitemId });
      assert.ok(queueChip.includes(`title="${field}: ${qitemId}" data-qitem="${qitemId}"`));
      assert.ok(queueChip.includes(`openQueueItemContext(this.dataset.qitem)">${arrow} 8f3c8035</button>`));
    }
  }
});

test('untyped handoff labels are trimmed, limited to 24 characters and inert', () => {
  const ref = 'First review of the 🚀 launch checklist';
  const html = renderContextBadgesHtml(context(), { handedOffFrom: '   ', handedOffTo: '  ' + ref + '  ' });
  assert.ok(html.includes(`title="handedOffTo: ${ref}">↘ First review of the 🚀 l…</span>`));
  assert.doesNotMatch(html, /handedOffFrom|onclick|<button|data-seat|data-qitem/);
  const exact = 'a'.repeat(24);
  assert.ok(renderContextBadgesHtml(context(), { handedOffFrom: exact }).includes(`↖ ${exact}</span>`));
});

test('handoff titles, labels and routing attributes escape markup in both directions', () => {
  const ctx = context();
  for (const field of ['handedOffFrom', 'handedOffTo']) {
    for (const ref of [special, special + '@rig', 'qitem-' + special]) {
      const html = renderContextBadgesHtml(ctx, { [field]: ref });
      assert.ok(html.includes(`title="${field}: ${ctx.escapeHtml(ref)}"`));
      assert.ok(!html.includes('<file'));
      if (ref.includes('@')) assert.ok(html.includes(`data-seat="${ctx.escapeHtml(ref)}"`));
      if (ref.startsWith('qitem-')) assert.ok(html.includes(`data-qitem="${ctx.escapeHtml(ref)}"`));
    }
  }
});

test('v3.9.0 inline HITL command preview and Option 1/2/3 buttons render directly inside Inspector P0 diagnosis card (EN & RU)', () => {
  const demoScreens = {
    en: '[dev-check@core-platform] core-platform (codex • gpt-5-codex)\n12 passed; 2 boundary checks need a negative control.\nPERMISSION PROMPT (HITL):\n● Bash(npx playwright test e2e/boundaries.spec.ts)\nRun this command?\n\n› 1. Yes, allow once (y)\n  2. Yes, always allow in this worktree\n  3. No, cancel and tell agent (esc)',
    ru: '[dev-check@core-platform] core-platform (codex • gpt-5-codex)\n12 тестов пройдены; 2 проверки границ требуют негативного контроля.\nЗАПРОС РАЗРЕШЕНИЯ (HITL):\n● Bash(npx playwright test e2e/boundaries.spec.ts)\nВыполнить эту команду?\n\n› 1. Да, разрешить один раз (y)\n  2. Да, всегда разрешать в этом рабочем дереве\n  3. Нет, отменить и сообщить агенту (esc)'
  };
  for (const lang of ['en', 'ru']) {
    const ctx = context(lang);
    const qaId = 'dev-check@core-platform';
    ctx.selectedAgentId = qaId;
    ctx.lastScreenBySeat[qaId] = demoScreens[lang];
    const html = renderSeatDiagnosisHtml(ctx, { id: qaId, state: 'urgent', harness: 'codex', needsInputReason: 'permission_prompt' });
    assert.match(html, /id="inspDiagInlineHitl"/);
    assert.match(html, /hitl-command-preview/);
    assert.ok(html.includes('npx playwright test e2e/boundaries.spec.ts'), `${lang}: parsed command preview must appear inline inside P0 card`);
    assert.match(html, /data-key="1 Enter"[^>]*onclick="triggerPromptOption\(this\)"/);
    assert.match(html, /data-key="2 Enter"[^>]*onclick="triggerPromptOption\(this\)"/);
    assert.match(html, /data-key="3 Enter"[^>]*onclick="triggerPromptOption\(this\)"/);
    assert.ok(html.indexOf('hitl-command-preview') < html.indexOf('data-transport="modal_terminal"'), 'Inline HITL decision must precede modal fallback button');
    // v3.10.0: zero contradiction — no red diag-hitl-primary button when inline Option 1/2/3 buttons are rendered
    assert.doesNotMatch(html, /diag-hitl-primary/);
    assert.ok(!html.includes(ctx.td('diag.resolveHitlBtn')), `${lang}: contradictory red resolveHitlBtn must not render alongside inline HITL options`);
    assert.match(html, /diag-tmux-secondary-link/);
    assert.ok(html.includes(ctx.td('diag.openTmux80Btn')), `${lang}: muted 80-line TMUX secondary link must render`);
    // v3.10.0: S1/S2 tucked inside expandable details; distinct key-neutral class on Option 2
    assert.match(html, /class="diag-ai-details"/);
    assert.match(html, /key-neutral/);
  }
});

test('v3.10.0 Universal tmux preset, FinOps pill, zero scattered widget-hints & modal inert isolation', async () => {
  const fs = await import('node:fs/promises');
  const vm = await import('node:vm');
  const indexHtml = await fs.readFile(new URL('../openrig/index.html', import.meta.url), 'utf8');

  // 1. Scattered 16x16 .widget-hint micro-buttons removed; single clean ? keyboard help trigger exists
  assert.doesNotMatch(indexHtml, /class="widget-hint"/);
  assert.match(indexHtml, /id="btnKeyboardHelp"/);

  // 2. Compact FinOps pill + popover reservoirs + Universal/OpenRig preset switcher + 3-tab mobile nav
  assert.match(indexHtml, /id="btnFinopsPill"/);
  assert.match(indexHtml, /id="reservoirsPopover"/);
  assert.match(indexHtml, /id="demoPresetSwitch"/);
  const mobileBtns = [...indexHtml.matchAll(/class="mobile-nav-btn[^"]*"/g)];
  assert.equal(mobileBtns.length, 3, 'Mobile bottom nav must have exactly 3 clean tabs (Triage, Map, Inspector)');

  // 3. Test setDemoPreset('universal') and syncModalBackgroundInert() in VM
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const makeEl = (id) => ({
    id,
    inert: false,
    attrs: new Map(),
    classes: new Set(),
    hidden: false,
    textContent: '',
    title: '',
    classList: {
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : Boolean(f); if (on) this._s.add(c); else this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.get(k) || null; },
    removeAttribute(k) { this.attrs.delete(k); }
  });
  const els = {
    triageStrip: makeEl('triageStrip'),
    hudHeader: makeEl('hudHeader'),
    mainLayout: makeEl('mainLayout'),
    mobileBottomNav: makeEl('mobileBottomNav'),
    guardrailsModal: makeEl('guardrailsModal')
  };
  for (const el of Object.values(els)) el.classList._s = el.classes;
  const bodyClasses = new Set();
  const sandbox = {
    console,
    location: { pathname: '/demo', search: '', protocol: 'http:', port: '7440', hostname: '127.0.0.1' },
    navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      addEventListener() {},
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => {
        if (sel === '.hud-header') return els.hudHeader;
        if (sel === '.modal-overlay.open, .palette-overlay.open') return els.guardrailsModal.classes.has('open') ? els.guardrailsModal : null;
        return null;
      },
      querySelectorAll: () => [],
      body: { classList: { toggle: (c, f) => (f ? bodyClasses.add(c) : bodyClasses.delete(c)), contains: (c) => bodyClasses.has(c) } }
    },
    addEventListener() {},
    requestAnimationFrame() {},
    setTimeout() {},
    clearTimeout() {},
    CONTEXT_WARN_PCT: 65,
    CONTEXT_CRIT_PCT: 75,
    tDeck
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  // Switch to Universal tmux preset: 4 sessions, codex-tests HITL npm test, claude-refactor CTX 78%, zero OpenRig slices
  vm.runInContext("deckLang='en'; setDemoPreset('universal', true)", sandbox);
  const uniAgents = JSON.parse(vm.runInContext('JSON.stringify(AGENTS)', sandbox));
  assert.deepEqual(uniAgents.map(a => a.id), ['claude-api', 'codex-tests', 'gemini-docs', 'claude-refactor']);
  assert.equal(uniAgents.find(a => a.id === 'codex-tests').state, 'urgent');
  assert.equal(uniAgents.find(a => a.id === 'claude-refactor').ctxPct, 78);
  assert.equal(vm.runInContext('SLICES_LANES.length', sandbox), 0);
  assert.equal(vm.runInContext('RECENT_DECISIONS.length', sandbox), 0);
  assert.match(vm.runInContext("getDemoTerminalCapture('codex-tests')", sandbox), /Bash\(npm test\)/);
  assert.doesNotMatch(vm.runInContext("getDemoTerminalCapture('codex-tests')", sandbox), /rig capture|decisions\/\*\.tsv|parked: no live wake/i);
  assert.equal(bodyClasses.has('demo-preset-universal'), true);

  // Switch back to OpenRig Pod losslessly
  vm.runInContext("setDemoPreset('openrig', true)", sandbox);
  assert.equal(vm.runInContext('selectedAgentId', sandbox), 'dev-check@core-platform');
  assert.ok(vm.runInContext('SLICES_LANES.length', sandbox) >= 6);
  assert.equal(bodyClasses.has('demo-preset-universal'), false);

  // Modal inert isolation: openGuardrailsModal sets inert & aria-hidden on background chrome, close clears them
  vm.runInContext('setGuardrailsTab = () => {}; openGuardrailsModal("auto-consent")', sandbox);
  for (const k of ['triageStrip', 'hudHeader', 'mainLayout', 'mobileBottomNav']) {
    assert.equal(els[k].inert, true, `${k} must be inert while #guardrailsModal is open`);
    assert.equal(els[k].getAttribute('aria-hidden'), 'true', `${k} must have aria-hidden="true" while modal is open`);
  }
  vm.runInContext('closeGuardrailsModal()', sandbox);
  for (const k of ['triageStrip', 'hudHeader', 'mainLayout', 'mobileBottomNav']) {
    assert.equal(els[k].inert, false, `${k} inert must clear when #guardrailsModal closes`);
    assert.equal(els[k].getAttribute('aria-hidden'), null, `${k} aria-hidden must clear on close`);
  }
});

test('v3.9.0 index.html enforces #autoConsentInspectorRoot below #nodeInspector, zero Google Fonts, readOnlyMode badge, collapsed demo quest & concise P1 context copy', async () => {
  const fs = await import('node:fs/promises');
  const vm = await import('node:vm');
  const indexHtml = await fs.readFile(new URL('../openrig/index.html', import.meta.url), 'utf8');

  // 1. Zero external Google Fonts <link>
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com/i);

  // 2. #autoConsentInspectorRoot placed strictly BELOW #nodeInspector
  const nodeIdx = indexHtml.indexOf('<div id="nodeInspector"></div>');
  const acIdx = indexHtml.indexOf('<div id="autoConsentInspectorRoot"></div>');
  assert.ok(nodeIdx > 0 && acIdx > nodeIdx, '#autoConsentInspectorRoot must sit below #nodeInspector');

  // 3. #readOnlyModeBadge present in top HUD, hidden by default, toggled cleanly by syncReadOnlyModeUi
  assert.match(indexHtml, /id="readOnlyModeBadge"[^>]*hidden/);
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const badgeEl = { hidden: true, textContent: '', title: '' };
  const bodyClasses = new Set();
  const sandbox = {
    console,
    location: { pathname: '/demo', search: '', protocol: 'http:', port: '7440', hostname: '127.0.0.1' },
    navigator: { language: 'ru' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      addEventListener() {},
      getElementById: (id) => (id === 'readOnlyModeBadge' ? badgeEl : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { classList: { toggle: (c, f) => (f ? bodyClasses.add(c) : bodyClasses.delete(c)), contains: (c) => bodyClasses.has(c) } }
    },
    addEventListener() {},
    requestAnimationFrame() {},
    setTimeout() {},
    clearTimeout() {},
    CONTEXT_WARN_PCT: 65,
    CONTEXT_CRIT_PCT: 75,
    tDeck
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  // Undefined / false readOnlyMode -> stays hidden with zero errors
  vm.runInContext('syncReadOnlyModeUi(undefined)', sandbox);
  assert.equal(badgeEl.hidden, true);
  assert.equal(bodyClasses.has('read-only-mode'), false);

  // True readOnlyMode -> surfaces 🔒 READ-ONLY badge cleanly
  vm.runInContext('syncReadOnlyModeUi(true)', sandbox);
  assert.equal(badgeEl.hidden, false);
  assert.equal(badgeEl.textContent, '🔒 READ-ONLY');
  assert.equal(bodyClasses.has('read-only-mode'), true);

  // Initial /demo load keeps inline mission dock collapsed by default (only opens on ?track=quest)
  vm.runInContext("initDemoQuest('')", sandbox);
  assert.equal(vm.runInContext('demoQuestOpen', sandbox), false);
  vm.runInContext("initDemoQuest('quest')", sandbox);
  assert.equal(vm.runInContext('demoQuestOpen', sandbox), true);
});

test('v3.11.0 HITL fat-finger safety: destination+scope line, sole full-width primary CTA, 2-col [Cancel | Always] & 2-step confirmation guard on Option 2', async () => {
  const fs = await import('node:fs/promises');
  const vm = await import('node:vm');
  const indexHtml = await fs.readFile(new URL('../openrig/index.html', import.meta.url), 'utf8');

  for (const lang of ['en', 'ru']) {
    const ctx = context(lang);
    ctx.agents = [{ id: 'codex-tests', shortName: 'codex-tests', cwd: '~/projects/payments-api', state: 'urgent', harness: 'codex' }];
    const screen = lang === 'en'
      ? '[tmux: codex-tests] ~/projects/payments-api\nPERMISSION PROMPT (HITL):\n● Bash(npm test)\nRun this command?\n› 1. Yes, allow once (y)\n  2. Yes, always allow in this directory\n  3. No, cancel and tell agent (esc)'
      : '[tmux: codex-tests] ~/projects/payments-api\nЗАПРОС РАЗРЕШЕНИЯ (HITL):\n● Bash(npm test)\nВыполнить эту команду?\n› 1. Да, разрешить один раз (y)\n  2. Да, всегда разрешать в этом каталоге\n  3. Нет, отменить и сообщить агенту (esc)';
    const html = renderInteractivePromptOptionsHtml(ctx, 'codex-tests', screen);

    // 1. Target + scope line above command preview
    assert.match(html, /class="hitl-target-scope"/);
    assert.ok(html.includes('codex-tests'));
    assert.ok(html.includes('~/projects/payments-api'));
    assert.ok(html.includes(ctx.td('insp.hitlScopeSingle')));
    assert.ok(html.indexOf('hitl-target-scope') < html.indexOf('hitl-command-preview'));

    // 2. Primary full-width CTA precedes 2-column secondary row with Cancel LEFT and Always RIGHT
    assert.match(html, /class="action-pill key-pill key-proceed hitl-btn-primary"/);
    assert.match(html, /class="hitl-secondary-row"/);
    const cancelIdx = html.indexOf('key-cancel hitl-btn-secondary');
    const alwaysIdx = html.indexOf('key-neutral hitl-btn-secondary');
    assert.ok(cancelIdx > 0 && alwaysIdx > cancelIdx, `${lang}: Cancel must sit left of Always in 2-col secondary row`);
    assert.match(html, /data-key="2 Enter"[^>]*data-confirm-always="true"/);
  }

  // 3. Test 2-step confirmation guard in VM: 1st click arms for 4s (0 dispatches), 2nd click dispatches Option 2
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sent = [];
  const timers = [];
  const sandbox = {
    console,
    location: { pathname: '/demo', search: '', protocol: 'http:', port: '7440', hostname: '127.0.0.1' },
    navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { classList: { toggle() {}, contains: () => false } } },
    addEventListener() {},
    requestAnimationFrame() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    CONTEXT_WARN_PCT: 65,
    CONTEXT_CRIT_PCT: 75,
    tDeck
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  sandbox.sendTerminalKey = (seatId, key) => sent.push({ seatId, key });

  const attrs = new Map([
    ['data-seat', 'codex-tests'],
    ['data-key', '2 Enter'],
    ['data-status', 'cmdSendStatus'],
    ['data-confirm-always', 'true'],
    ['data-confirm-label', '⚠️ Confirm Always?']
  ]);
  const cls = new Set();
  const alwaysBtn = {
    disabled: false,
    innerHTML: '🔹 Always in repo...',
    textContent: '🔹 Always in repo...',
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    getAttribute: k => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: k => attrs.delete(k)
  };
  sandbox.__btn = alwaysBtn;
  vm.runInContext('triggerPromptOption(__btn)', sandbox);
  assert.equal(sent.length, 0, 'First click on Always must NOT dispatch Option 2');
  assert.equal(attrs.get('data-confirm-armed'), 'true');
  assert.equal(cls.has('is-confirm-armed'), true);
  assert.equal(alwaysBtn.textContent, '⚠️ Confirm Always?');
  assert.equal(timers.at(-1).ms, 4000);

  // Second click while armed dispatches Option 2 and disarms
  vm.runInContext('triggerPromptOption(__btn)', sandbox);
  assert.deepEqual(sent, [{ seatId: 'codex-tests', key: '2 Enter' }]);
  assert.equal(attrs.get('data-confirm-armed'), undefined);
  assert.equal(cls.has('is-confirm-armed'), false);
});

test('v3.11.0 Wait Radar deduplication merges multiple alerts per agent into ONE card with inline CTX chip & single-row topbar structure', async () => {
  const fs = await import('node:fs/promises');
  const indexHtml = await fs.readFile(new URL('../openrig/index.html', import.meta.url), 'utf8');

  // 1. dedupeRadarItemsByAgent merges P0 + P1 CTX for same agent into 1 card with inline chip
  const merged = dedupeRadarItemsByAgent([
    { prio: 0, seatId: 'dev-check@core-platform', slice: 'terminal gate', state: 'P0 • NEEDS HUMAN', category: 'blocker' },
    { prio: 0.8, seatId: 'dev-check@core-platform', slice: 'CTX 79%', state: '75% THRESHOLD PASSED', category: 'blocker' },
    { prio: 1.1, seatId: 'dev-coder3@core-platform', slice: 'parked', state: 'PARKED', category: 'blocker' },
    { prio: 3, seatId: 'dev-coder3@core-platform', slice: 'active', state: 'WORKING', category: 'task' }
  ]);
  assert.equal(merged.length, 2, 'Each agent must appear at most once in Wait Radar');
  assert.equal(merged[0].seatId, 'dev-check@core-platform');
  assert.deepEqual(merged[0].secondaryChips, [{ label: '⚠️ CTX 79%', tone: 'amber' }]);
  assert.equal(merged[1].seatId, 'dev-coder3@core-platform');

  // 2. Single-row unified topbar + default Universal preset active + unified Guardrails dialog title
  assert.match(indexHtml, /class="triage-strip unified-topbar"/);
  assert.match(indexHtml, /id="btnPresetUniversal"[^>]*active|class="hud-segment-btn active" id="btnPresetUniversal"/);
  assert.match(indexHtml, /data-i18n="guard\.dialogTitle"/);
});
