import test from 'node:test';
import assert from 'node:assert/strict';
import { getSeatTriageSignal } from '../openrig/assets/ontology/actions.js';
import { FleetIntelligenceEngine } from '../openrig/lib/fleet-intelligence/index.mjs';
import { compileAdvisoryReport, computeHealthScore } from '../openrig/lib/fleet-intelligence/advisory.mjs';
import { CeremonyAmplifierDetector } from '../openrig/lib/fleet-intelligence/detectors/ceremony.mjs';
import { LiveBlockerDetector } from '../openrig/lib/fleet-intelligence/detectors/live-blocker.mjs';
import { BottleneckDetector } from '../openrig/lib/fleet-intelligence/detectors/bottleneck.mjs';
import { ContextEntropyDetector } from '../openrig/lib/fleet-intelligence/detectors/context-entropy.mjs';
import { computeQueueKinetics, isQueueSystemNoise } from '../openrig/lib/fleet-intelligence/metrics.mjs';
import {
  parseInteractivePromptOptions,
  detectLiveHitlPrompt,
  getLiveHitlOptions,
  extractHitlCommandPreview,
  extractDetectedTerminalModel,
  detectTerminalIdleAtPrompt,
  classifyTerminalScreen,
  classifyEdgeQueueStatus,
  getContextThermal,
  evalThermalCurveHeightPct,
  buildThermalCurvePaths,
  buildThermalCurveSvgHtml,
  formatTokensShort,
  computeBurn,
  getAgentAudioProfile,
  ganttChainColor,
  ganttRoleRank,
  DECK_I18N,
  resolveDeckLang,
  tDeck
} from '../openrig/assets/domain/index.js';

test('FleetIntelligenceEngine passes recentQueue and isolates reports per rigId', () => {
  const engine = new FleetIntelligenceEngine({ evalThrottleMs: 0 });
  let capturedRecent = null;
  engine.registerDetector({
    id: 'test-probe',
    evaluate(ctx) {
      capturedRecent = ctx.recentQueue;
      return [];
    }
  });

  engine.ingestSnapshot({
    requestedRig: 'rig-alpha',
    nodes: [],
    activeQueue: [],
    history: { ganttItems: [{ id: 'qitem-1', chain: 'slice:x' }] }
  });
  assert.equal(Array.isArray(capturedRecent), true);
  assert.equal(capturedRecent.length, 1);

  engine.ingestSnapshot({
    requestedRig: 'rig-beta',
    nodes: [],
    activeQueue: [],
    history: { ganttItems: [] }
  });

  const repAlpha = engine.getLatestReport('rig-alpha');
  const repBeta = engine.getLatestReport('rig-beta');
  const repUnknown = engine.getLatestReport('rig-unknown');
  assert.equal(repAlpha.rigId, 'rig-alpha');
  assert.equal(repBeta.rigId, 'rig-beta');
  assert.equal(repUnknown.rigId, 'rig-unknown');
});

test('parseInteractivePromptOptions extracts Codex and inline options cleanly', () => {
  const codexSample = [
    'Would you like to run the following command?',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again (p)',
    '  3. No, and tell Codex what to do differently (esc)'
  ].join('\n');
  const parsed = parseInteractivePromptOptions(codexSample);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].keyStroke, '1 Enter');
  assert.equal(parsed[1].keyStroke, '2 Enter');
  assert.equal(parsed[2].isCancel, true);

  const inlineSample = 'Allow action?\n[1] Allow once   [2] Always allow   [n] Cancel\n› _';
  const inlineParsed = parseInteractivePromptOptions(inlineSample);
  assert.equal(inlineParsed.length, 3);
  assert.equal(inlineParsed[2].isCancel, true);
});

test('detectLiveHitlPrompt catches terminal/agy & Codex prompts while rejecting normal markdown lists and stale scrollback', () => {
  const agyCapture = [
    'Requesting permission for:',
    '  git -C /tmp/repo cat-file -t abc123',
    'Run this command?',
    '  1. Yes, run command',
    '  2. Yes, and always allow in this',
    'conversation for commands that start with git',
    '> 3. Yes, and always allow for',
    'commands (Persist to settings.json)',
    '  4. No, cancel',
    '  ↑/↓ Navigate · tab Amend · ctrl+g ed',
    'esc to cancel'
  ].join('\n');
  const resAgy = detectLiveHitlPrompt(agyCapture);
  assert.equal(resAgy.blocked, true);
  assert.equal(resAgy.reason, 'permission_prompt');
  assert.equal(resAgy.options.length, 4);

  const markdownSummary = [
    'Completed all changes:',
    '1. Updated node card padding',
    '2. Added unit tests for circuit breaker',
    '3. Synced public directory',
    'Waiting for next task.'
  ].join('\n');
  assert.equal(detectLiveHitlPrompt(markdownSummary).blocked, false);

  const staleScrolledMenu = [
    'Run this command?',
    '1. Yes, run command',
    '2. No, cancel',
    'line 1 after',
    'line 2 after',
    'line 3 after',
    'line 4 after',
    'line 5 after',
    'line 6 after',
    'line 7 after',
    'line 8 after',
    'line 9 after',
    'All 40 tests passed.'
  ].join('\n');
  assert.equal(detectLiveHitlPrompt(staleScrolledMenu).blocked, false);
});

test('getLiveHitlOptions rejects idle agy markdown numbered lists, detects agy running tasks & extracts model', () => {
  const idleAgyMarkdownReply = [
    'Готовность к приёму кандидатов Итерации 6',
    '',
    'На каждом candidate commit SHA буду выполнять:',
    '1. Обязательный verification gate (npm run sync:public, npm test, npm run audit:exposure).',
    '2. Независимые исполняемые проверки поведения, negative control, live/demo Chromium smoke.',
    '3. Возврат вердикта PASS / FAIL с доказательствами в dev-owner@rig-commander.',
    '',
    'Жду первый SHA кандидата и задание на проверку.',
    '────────────────────────────────────────────────────────────────────────────────',
    '>',
    '────────────────────────────────────────────────────────────────────────────────',
    '? for shortcuts                             accept-edits · Gemini 4 Neon · xhigh'
  ].join('\n');

  // Raw parser sees 3 numbered items, but getLiveHitlOptions MUST return [] so UI never shows bogus PROMPT OPTIONS
  assert.equal(parseInteractivePromptOptions(idleAgyMarkdownReply).length, 3);
  assert.deepEqual(getLiveHitlOptions(idleAgyMarkdownReply), []);
  const idleCls = classifyTerminalScreen(idleAgyMarkdownReply, 'terminal');
  assert.equal(idleCls.state, 'idle');
  assert.equal(idleCls.harness, 'antigravity');
  assert.equal(idleCls.detectedModel, 'Gemini 4 Neon (xhigh)');
  assert.equal(extractDetectedTerminalModel(idleAgyMarkdownReply), 'Gemini 4 Neon (xhigh)');

  // Antigravity CLI actively executing a command / background task MUST classify as working (not idle!)
  const runningAgyScreen = [
    '○ Running (node /tmp/qa-verify-iter6-1.mjs) (ctrl+o to expand)',
    '  Учёл 700ms cooldown ActionFlightGuard; повторно запущен полный прогон.',
    '────────────────────────────────────────────────────────────────────────────────',
    '>',
    '────────────────────────────────────────────────────────────────────────────────',
    '  ● [20:25:47] node /tmp/qa-verify-iter6-1.mjs running',
    '────────────────────────────────────────────────────────────────────────────────',
    '? for shortcuts        accept-edits · Gemini 4 Neon · xhigh · 1 task(s) · /tasks'
  ].join('\n');
  const runCls = classifyTerminalScreen(runningAgyScreen, 'terminal');
  assert.equal(runCls.state, 'working');
  assert.equal(runCls.working, true);
  assert.equal(runCls.idleAtPrompt, false);
  assert.equal(runCls.detectedModel, 'Gemini 4 Neon (xhigh)');

  // Genuine blocking agy permission prompt still returns all 4 actionable options
  const realAgyPrompt = [
    'Requesting permission for:',
    '  git ls-files .private-docs',
    'Run this command?',
    '> 1. Yes, run command',
    '  2. Yes, and always allow in this conversation',
    '  3. Yes, and always allow (Persist to settings.json)',
    '  4. No, cancel',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
    'esc to cancel                               accept-edits · Gemini 4 Neon · xhigh'
  ].join('\n');
  const liveOpts = getLiveHitlOptions(realAgyPrompt);
  assert.equal(liveOpts.length, 4);
  assert.equal(liveOpts[0].keyStroke, '1 Enter');
  assert.equal(liveOpts[3].isCancel, true);
});

test('classifyEdgeQueueStatus differentiates live, blocked, parked, held, pending and ghost highways', () => {
  // 1. Blocked + parked between sleeping seats -> static orange 🚧 blocked (NOT animated green!)
  const blk = classifyEdgeQueueStatus([
    {
      qitemId: 'q-1',
      sourceSession: 'dev-coder4@rig',
      destinationSession: 'dev-owner@rig',
      state: 'blocked',
      pickup: { state: 'parked' },
      tags: ['ultraplan', 'track-B'],
      summary: 'Waiting for QA GO'
    }
  ], { seatStatesById: { 'dev-coder4@rig': 'idle', 'dev-owner@rig': 'idle' } });
  assert.equal(blk.status, 'blocked');
  assert.equal(blk.icon, '🚧');
  assert.equal(blk.animated, false);
  assert.equal(blk.tag, 'ultraplan');

  // 2. Parked without hard block -> static amber 🅿️ parked
  const prk = classifyEdgeQueueStatus([
    { sourceSession: 'a@rig', destinationSession: 'b@rig', state: 'open', pickup: { state: 'parked' }, tags: ['slice:auth'] }
  ]);
  assert.equal(prk.status, 'parked');
  assert.equal(prk.icon, '🅿️');
  assert.equal(prk.animated, false);
  assert.equal(prk.tag, 'auth');

  // 3. Held with wake condition -> static purple ⏸️ held
  const hld = classifyEdgeQueueStatus([
    { sourceSession: 'a@rig', destinationSession: 'b@rig', state: 'held', pickup: { state: 'held' }, tags: ['slice:deploy'] }
  ]);
  assert.equal(hld.status, 'held');
  assert.equal(hld.icon, '⏸️');
  assert.equal(hld.animated, false);

  // 4. Pending on idle recipient -> static sky ⏳ pending; on working recipient -> animated emerald 📨 live
  const pendIdle = classifyEdgeQueueStatus([
    { sourceSession: 'dev-owner@rig', destinationSession: 'dev-check@rig', state: 'pending', tags: ['gate:qa'] }
  ], { seatStatesById: { 'dev-check@rig': 'idle' } });
  assert.equal(pendIdle.status, 'pending');
  assert.equal(pendIdle.icon, '⏳');
  assert.equal(pendIdle.animated, false);

  const pendWorking = classifyEdgeQueueStatus([
    { sourceSession: 'dev-owner@rig', destinationSession: 'dev-check@rig', state: 'pending', tags: ['gate:qa'] }
  ], { seatStatesById: { 'dev-check@rig': 'working' } });
  assert.equal(pendWorking.status, 'live');
  assert.equal(pendWorking.icon, '📨');
  assert.equal(pendWorking.animated, true);

  // 5. No rows -> ghost
  const ghost = classifyEdgeQueueStatus([]);
  assert.equal(ghost.status, 'ghost');
  assert.equal(ghost.animated, false);
});

test('domain thermal, audio and gantt helpers work deterministically', () => {
  const noneT = getContextThermal(null, 475000);
  assert.equal(noneT.label, '— (no reader)');
  assert.equal(noneT.tier, 'none');
  assert.equal(noneT.pct, 0);
  assert.equal(noneT.tokensShort, '');

  assert.equal(getContextThermal(5, 1000000).band, 'violet');
  assert.equal(getContextThermal(22, 1000000).band, 'blue');
  const skyT = getContextThermal(46, 475000);
  assert.equal(skyT.band, 'sky');
  assert.equal(skyT.tier, 'cool');
  assert.equal(skyT.tokensShort, '219K/475K');
  assert.equal(getContextThermal(58, 475000).band, 'yellow');
  assert.equal(getContextThermal(68, 475000).band, 'orange');
  assert.equal(getContextThermal(68, 475000).tier, 'warn');
  const critT = getContextThermal(80, 475000);
  assert.equal(critT.color, '#ff0055');
  assert.equal(critT.band, 'red');
  assert.equal(critT.tier, 'crit');

  // Exponential thermal wedge curve: flat baseline in optimal zone (<=35%), strictly convex flare past 35%
  assert.equal(evalThermalCurveHeightPct(0), 6);
  assert.equal(evalThermalCurveHeightPct(20), 6);
  assert.equal(evalThermalCurveHeightPct(35), 6);
  const h55 = evalThermalCurveHeightPct(55);
  const h75 = evalThermalCurveHeightPct(75);
  const h95 = evalThermalCurveHeightPct(95);
  assert.ok(h55 > 6 && h75 > h55 && h95 > h75 && evalThermalCurveHeightPct(100) === 96);
  assert.ok((h95 - h75) > (h55 - 6) * 2, `Expected exponential convexity: (${h95}-${h75}) > 2*(${h55}-6)`);
  const paths = buildThermalCurvePaths(2.5);
  assert.ok(paths.areaPath.startsWith('M 0 94') && paths.areaPath.endsWith('L 100 100 L 0 100 Z'));
  const svgHtml = buildThermalCurveSvgHtml();
  assert.match(svgHtml, /url\(#rigThermalWedgeGrad\)/);
  assert.match(svgHtml, /url\(#rigThermalRidgeGrad\)/);

  assert.equal(formatTokensShort(1_250_000), '1.25M');
  assert.equal(formatTokensShort(42_300), '42K');

  const burn = computeBurn({ ctxHistory: [{ t: 0, pct: 20 }, { t: 3600_000, pct: 45 }] });
  assert.equal(burn.perHour, 25);

  const p1 = getAgentAudioProfile('dev-check@rig');
  const p2 = getAgentAudioProfile('dev-check-argon@rig');
  const pDyn = getAgentAudioProfile('custom-agent-99@rig');
  assert.notDeepEqual(p1.freqs, p2.freqs);
  assert.equal(pDyn.freqs.length, 3);

  assert.equal(ganttChainColor('slice:abc'), ganttChainColor('slice:abc'));
  assert.ok(ganttRoleRank('dev-owner@rig') < ganttRoleRank('dev-coder@rig'));
  assert.ok(ganttRoleRank('dev-coder@rig') < ganttRoleRank('dev-check@rig'));
});

test('DECK_I18N maintains full EN/RU key parity and interpolation', () => {
  const enKeys = Object.keys(DECK_I18N.en).sort();
  const ruKeys = Object.keys(DECK_I18N.ru).sort();
  assert.deepEqual(enKeys, ruKeys);
  assert.equal(resolveDeckLang('?lang=en', 'ru', 'ru-RU'), 'en');
  assert.equal(resolveDeckLang('?lang=ru', 'en', 'en-US'), 'ru');
  assert.equal(resolveDeckLang('', 'en', 'ru-RU'), 'en');
  assert.equal(resolveDeckLang('', '', 'en-US'), 'en');
  assert.equal(resolveDeckLang('', '', 'ru-RU'), 'ru');
  assert.equal(tDeck('en', 'triage.ctxEta', { min: 12 }), '~12m to 75%');
  assert.equal(tDeck('ru', 'triage.ctxEta', { min: 12 }), '~12 мин до 75%');
});

test('detectTerminalIdleAtPrompt catches Antigravity/CLI empty prompt while rejecting active spinners and HITL menus', () => {
  const agyIdle = [
    ' ┃ Introducing Gemini 4',
    ' ┃ esc to dismiss',
    '───────────────────────────',
    '> Accept-edits mode: fi...',
    '───────────────────────────',
    '? for shortcuts'
  ].join('\n');
  assert.equal(detectTerminalIdleAtPrompt(agyIdle).idle, true);

  const activeWork = [
    '⠋ Thinking through auth refactor...',
    'Esc to interrupt',
    '> Accept-edits mode'
  ].join('\n');
  assert.equal(detectTerminalIdleAtPrompt(activeWork).idle, false);

  const hitlMenu = [
    'Requesting permission for: run_command',
    '› 1. Allow once',
    '  2. Always allow',
    '  3. Cancel',
    '↑/↓ navigate • Enter to confirm • Esc to cancel'
  ].join('\n');
  assert.equal(detectTerminalIdleAtPrompt(hitlMenu).idle, false);
});

test('compileAdvisoryReport caps P2/P3 penalties so retrospective findings never trigger false Critical Risk', () => {
  const manyP2 = Array.from({ length: 29 }, (_, i) => ({
    id: `ceremony-${i}`,
    detectorId: 'workflow.ceremony',
    category: 'ceremony',
    severity: 'p2_medium',
    confidence: 0.8,
    metrics: { riskScore: 55, affectedSeats: [], affectedSlices: [`slice-${i}`] }
  }));
  const repP2 = compileAdvisoryReport(manyP2, 'rig-a');
  assert.equal(repP2.healthScore, 85);
  assert.equal(repP2.scoreBreakdown.p2Penalty, 15);
  assert.equal(repP2.scoreBreakdown.p0Penalty, 0);

  const manyP3 = Array.from({ length: 29 }, (_, i) => ({
    id: `retro-${i}`,
    detectorId: 'workflow.ceremony',
    category: 'ceremony',
    severity: 'p3_info',
    confidence: 0.78,
    metrics: { riskScore: 30, affectedSeats: [], affectedSlices: [`hist-${i}`] }
  }));
  const repP3 = compileAdvisoryReport(manyP3, 'rig-a');
  assert.equal(repP3.healthScore, 95);
  assert.equal(repP3.scoreBreakdown.p3Penalty, 5);
  assert.equal(repP3.topRecommendations.length, 0);

  const critical = computeHealthScore({ p0: 1, p1: 2, p2: 2, p3: 1 });
  assert.equal(critical.healthScore, 51);
  assert.equal(critical.scoreBreakdown.p0Penalty, 22);
  assert.equal(critical.scoreBreakdown.p1Penalty, 20);
  assert.equal(critical.scoreBreakdown.p2Penalty, 6);
  assert.equal(critical.scoreBreakdown.p3Penalty, 1);
});

test('CeremonyAmplifierDetector caps to Top-5, separates active vs retro slices, and emits real Gantt actions (no fake CLI)', () => {
  const det = new CeremonyAmplifierDetector();
  const activeQueue = Array.from({ length: 10 }, (_, i) => ({
    qitemId: `act-${i}`,
    state: 'in-progress',
    tags: ['slice:active-hot']
  }));
  const recentQueue = [
    // Duplicate active items must NOT double-count
    ...activeQueue.map(x => ({ id: x.qitemId, slice: 'active-hot', state: 'in-progress' })),
    // 12 historical completed slices with 9..20 hops each
    ...Array.from({ length: 12 }, (_, s) =>
      Array.from({ length: 9 + s }, (_, j) => ({
        id: `hist-${s}-${j}`,
        slice: `done-slice-${s}`,
        state: 'done'
      }))
    ).flat()
  ];

  const findings = det.evaluate({ activeQueue, recentQueue, healthFindings: [] });
  assert.equal(findings.length, 5);
  // Active slice must come first as p2_medium; completed slices must be p3_info
  assert.equal(findings[0].metrics.affectedSlices[0], 'active-hot');
  assert.equal(findings[0].severity, 'p2_medium');
  assert.equal(findings[1].severity, 'p3_info');
  // Every action must open Task Gantt with zero fabricated CLI commands
  for (const f of findings) {
    assert.equal(f.actionPlan.kind, 'open_gantt_slice');
    assert.equal(f.actionPlan.commandPreview, '');
  }
});

test('LiveBlockerDetector surfaces real HITL P0 and parked-with-work P1 findings with direct actions', () => {
  const det = new LiveBlockerDetector();
  const findings = det.evaluate({
    nodes: [
      {
        canonicalSessionName: 'dev-check@demo',
        activityState: { display: 'needs-input', activity: 'waiting-human', needsInput: { count: 1, reason: 'Run tests?' } }
      },
      {
        canonicalSessionName: 'dev-coder3@demo',
        assignedWorkCount: 2,
        activityState: { display: 'idle' }
      }
    ],
    activeQueue: [],
    parkedSeats: {
      'dev-coder3@demo': { parked: true, reason: 'No live wake timer' }
    }
  });
  assert.equal(findings.length, 2);
  const hitl = findings.find(f => f.severity === 'p0_urgent');
  const parked = findings.find(f => f.severity === 'p1_high');
  assert.ok(hitl);
  assert.equal(hitl.actionPlan.kind, 'open_modal');
  assert.equal(hitl.actionPlan.seatTarget, 'dev-check@demo');
  assert.ok(parked);
  assert.equal(parked.actionPlan.kind, 'wake_seat');
  assert.equal(parked.actionPlan.seatTarget, 'dev-coder3@demo');
});

test('classifyTerminalScreen catches narrow-pane wrapped Antigravity HITL prompts when options 1-2 scrolled off top', () => {
  const narrowWrappedAgy = [
    'commands that start with',
    '\'rm -f /private/tmp/qa-a1-',
    'results/_host-*...\'',
    '  3. Yes, and always allow',
    'for commands that start',
    'with \'rm -f /private/tmp/',
    'qa-a1-results/_host-*...\'',
    '(Persist to settings.json)',
    '  4. No, cancel',
    '',
    '  ↑/↓ Navigate · tab Amend',
    'esc to cancel'
  ].join('\n');

  const res = classifyTerminalScreen(narrowWrappedAgy, 'terminal');
  assert.equal(res.state, 'needs-input');
  assert.equal(res.blocked, true);
  assert.equal(res.harness, 'antigravity');
  assert.equal(res.reason, 'permission_prompt');
  // Synthesizes [1] shortcut + parses [3] and [4]
  assert.deepEqual(res.options.map(o => o.badge), ['1', '3', '4']);
  assert.equal(res.options[2].isCancel, true);
});

test('classifyTerminalScreen treats Antigravity active braille spinner + bare esc to cancel as working, never HITL', () => {
  const agyWorking = [
    '○ Thought for 36.7s',
    '● Ran (rm -f...) (ctrl+o to expand)',
    '⣟  The backup confirms the candidate state...',
    '└ Tip: Press ? to see keyboard shortcuts',
    '───────────────────────────',
    '>',
    '───────────────────────────',
    'esc to cancel'
  ].join('\n');

  const res = classifyTerminalScreen(agyWorking, 'terminal');
  assert.equal(res.blocked, false);
  assert.equal(res.state, 'working');
  assert.equal(res.working, true);
  assert.equal(res.idleAtPrompt, false);
});

test('classifyTerminalScreen detects bare OS shell prompt (shellExited) without false-triggering on AI prompts', () => {
  const bareZsh = [
    'Agent pid 22228',
    'user@workstation project.pwa %',
    'user@workstation project.pwa %'
  ].join('\n');
  const resZsh = classifyTerminalScreen(bareZsh, 'terminal');
  assert.equal(resZsh.shellExited, true);
  assert.equal(resZsh.state, 'shell-exited');
  assert.equal(resZsh.blocked, false);

  const bareSh = 'sh-3.2$';
  assert.equal(classifyTerminalScreen(bareSh, 'terminal').shellExited, true);

  // Active Codex idle prompt must NOT trigger shellExited
  const codexIdle = '› Ask Codex to do anything\nGPT-6.2-Sol high';
  assert.equal(classifyTerminalScreen(codexIdle, 'codex').shellExited, false);
});

test('BottleneckDetector filters stuck-sweep noise, deduplicates queue rows, exposes pendingSamples & remediation, and diversifies topRecommendations', () => {
  const det = new BottleneckDetector();
  const now = Date.now();
  const realRow1 = { qitemId: 'q-real-1', sourceSession: 'dev-senior@rig', destinationSession: 'dev-owner@rig', state: 'pending', tags: ['slice:track-L'], summary: 'Review live wiring', tsCreated: new Date(now - 25 * 60000).toISOString() };
  const realRow2 = { qitemId: 'q-real-2', sourceSession: 'dev-check@rig', destinationSession: 'dev-owner@rig', state: 'pending', tags: ['slice:auth'], summary: 'Approve QA verdict', tsCreated: new Date(now - 15 * 60000).toISOString() };
  const noiseRows = [1, 2, 3, 4].map(i => ({
    qitemId: `q-noise-${i}`,
    sourceSession: 'context-guardian-observer@external',
    destinationSession: 'dev-operator@rig',
    state: 'pending',
    tags: ['stuck-sweep-finding'],
    summary: 'undelivered-wake'
  }));

  assert.equal(isQueueSystemNoise(noiseRows[0]), true);
  assert.equal(isQueueSystemNoise(realRow1), false);

  // Duplicate realRow1 in recentQueue must NOT double-count!
  const kinetics = computeQueueKinetics([realRow1, realRow2, ...noiseRows, { ...realRow1 }], now);
  assert.equal(kinetics['dev-owner@rig'].pendingCount, 2);
  assert.equal(kinetics['dev-owner@rig'].pendingSamples.length, 2);
  assert.equal(kinetics['dev-operator@rig'].pendingCount, 0);
  assert.equal(kinetics['dev-operator@rig'].noisePendingCount, 4);

  const findings = det.evaluate({
    nodes: [
      { canonicalSessionName: 'dev-owner@rig', activityState: { display: 'idle' } },
      { canonicalSessionName: 'dev-operator@rig', activityState: { display: 'idle' } }
    ],
    activeQueue: [realRow1, realRow2, ...noiseRows],
    recentQueue: [{ ...realRow1 }]
  });

  const ownerFinding = findings.find(f => f.id === 'bottleneck-dev-owner@rig');
  assert.ok(ownerFinding);
  assert.equal(ownerFinding.severity, 'p1_high');
  assert.equal(ownerFinding.shortTitle, 'dev-owner: очередь (2)');
  assert.ok(!ownerFinding.summary.includes('в 1 раза'), 'Must not emit nonsensical WWR=1 copy');
  assert.ok(ownerFinding.remediation && ownerFinding.remediation.includes('Разобрать очередь'));
  assert.equal(ownerFinding.metrics.pendingSamples.length, 2);

  // Pure stuck-sweep noise must downgrade to p2_medium cleanup (never a red P0 bottleneck alarm)
  const opNoiseFinding = findings.find(f => f.id === 'queue-noise-dev-operator@rig');
  assert.ok(opNoiseFinding);
  assert.equal(opNoiseFinding.severity, 'p2_medium');

  // compileAdvisoryReport must prefer seat diversity in topRecommendations
  const extraOwnerParked = {
    id: 'parked-work-dev-owner@rig',
    detectorId: 'topology.live_blocker',
    category: 'topology',
    severity: 'p1_high',
    confidence: 0.9,
    metrics: { riskScore: 80, affectedSeats: ['dev-owner@rig'] },
    actionPlan: { kind: 'wake_seat', seatTarget: 'dev-owner@rig' }
  };
  const thirdSeatFinding = {
    id: 'parked-work-dev-coder@rig',
    detectorId: 'topology.live_blocker',
    category: 'topology',
    severity: 'p1_high',
    confidence: 0.9,
    metrics: { riskScore: 70, affectedSeats: ['dev-coder@rig'] },
    actionPlan: { kind: 'wake_seat', seatTarget: 'dev-coder@rig' }
  };
  const rep = compileAdvisoryReport([ownerFinding, extraOwnerParked, opNoiseFinding, thirdSeatFinding], 'rig');
  const topSeats = rep.topRecommendations.map(r => r.actionPlan.seatTarget);
  assert.equal(new Set(topSeats).size, 3, `Expected 3 distinct seats in topRecommendations, got ${topSeats}`);
});

test('TelemetryRingBuffer stores bounded slim snapshots without retaining giant history/guidance blobs', () => {
  const engine = new FleetIntelligenceEngine({ evalThrottleMs: 999999 });
  const giantHistory = { ganttItems: Array.from({ length: 500 }, (_, i) => ({ id: `q-${i}`, summary: 'x'.repeat(200) })) };
  for (let i = 0; i < 60; i++) {
    engine.ingestSnapshot({
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      requestedRig: 'all',
      nodes: [{ canonicalSessionName: 'dev-owner@rig', activityState: { display: 'idle' } }],
      activeQueue: [{ qitemId: `q-${i}`, state: 'pending', body: 'huge'.repeat(1000) }],
      history: giantHistory,
      seatGuidance: { 'dev-owner@rig': { duties: ['heavy'] } },
      seatCompactions: { 'dev-owner@rig': { recapText: 'R'.repeat(2400) } },
      intelligence: { allFindings: [{ id: 'f1' }] }
    });
  }
  assert.equal(engine.buffer.size(), 30);
  const latest = engine.buffer.getLatest();
  assert.equal(latest.history, undefined);
  assert.equal(latest.seatGuidance, undefined);
  assert.equal(latest.seatCompactions, undefined);
  assert.equal(latest.intelligence, undefined);
  assert.equal(latest.activeQueue[0].body, undefined);
  assert.equal(latest.nodes[0].canonicalSessionName, 'dev-owner@rig');
});

test('triage ranks live input, exited shell, critical context and moderate context', () => {
  const signals = [
    { ctxPct: 65 }, { ctxPct: 74 }, { ctxPct: 75 }, { shellExited: true, ctxPct: 94 },
    { state: 'urgent', shellExited: true }
  ].map(getSeatTriageSignal).sort((a, b) => a.priority - b.priority);
  assert.deepEqual(signals.map(s => [s.kind, s.priority]), [
    ['input', 0], ['shell', 0.4], ['context', 0.9], ['context', 1.4], ['context', 1.4]
  ]);
  assert.equal(getSeatTriageSignal({ ctxPct: 64 }), null);
  assert.equal(getSeatTriageSignal({}), null);
});

test('per-rig health counts each deduplicated finding once per affected rig', () => {
  const crossRig = { detectorId: 'one', severity: 'p0_urgent', metrics: {
    affectedSeats: ['a@north', 'b@north'], affectedSlices: ['s@south', 't@north']
  } };
  const south = { detectorId: 'two', severity: 'p1_high', metrics: { affectedSeats: ['b@south'] } };
  const retro = { detectorId: 'three', severity: 'p3_info', metrics: { affectedSlices: ['s@north'] } };
  const unscoped = { detectorId: 'four', severity: 'p2_medium', metrics: { affectedSlices: ['s'] } };
  const report = compileAdvisoryReport([crossRig, crossRig, south, retro, unscoped]);
  assert.deepEqual(report.rigHealthById, {
    north: { healthScore: 77, p0: 1, p1: 0, p2: 0 },
    south: { healthScore: 68, p0: 1, p1: 1, p2: 0 }
  });
  assert.deepEqual(report.counts, { total: 4, p0: 1, p1: 1, p2: 1, p3: 1 });
  assert.equal(report.healthScore, 64);
  assert.equal(report.scoreBreakdown.totalPenalty, 36);
  assert.deepEqual(compileAdvisoryReport([unscoped], 'south').rigHealthById,
    { south: { healthScore: 97, p0: 0, p1: 0, p2: 1 } });
  assert.deepEqual(compileAdvisoryReport([]).rigHealthById, {});
});

test('ContextEntropyDetector emits compact_seat for codex dev-coder3 and rotate_seat only for Pi harness', () => {
  const detector = new ContextEntropyDetector();
  const findings = detector.evaluate({
    nodes: [
      {
        canonicalSessionName: 'dev-coder3@rig-commander',
        runtime: 'codex',
        model: 'gpt-6.2-astra',
        contextUsage: { usedPercentage: 80 }
      },
      {
        canonicalSessionName: 'dev-coder3@legacy-rig',
        runtime: 'pi',
        model: 'deepseek-flash',
        contextUsage: { usedPercentage: 80 }
      }
    ],
    activeQueue: []
  });
  const codexFinding = findings.find(f => f.actionPlan.seatTarget === 'dev-coder3@rig-commander');
  const piFinding = findings.find(f => f.actionPlan.seatTarget === 'dev-coder3@legacy-rig');
  assert.equal(codexFinding?.actionPlan.kind, 'compact_seat');
  assert.equal(codexFinding?.actionPlan.params.isPi, false);
  assert.equal(piFinding?.actionPlan.kind, 'rotate_seat');
  assert.equal(piFinding?.actionPlan.params.isPi, true);
});

const approvalMenu = '\n› 1. Yes, run command\n  2. Yes, always allow in this\n     conversation\n  3. No, cancel\n↑/↓ Navigate';

test('command preview identifies the current Antigravity, Codex, Claude and yes/no requests', () => {
  for (const [screen, expected] of [
    ['Requesting permission for:\n  git status --short\nRun this command?' + approvalMenu, 'git status --short'],
    ['Would you like to run the following command?\nReason: inspect changes\n  $ git diff\n    --stat' + approvalMenu, 'git diff --stat'],
    ['⏺ Bash(git log -1)\nDo you want to proceed?' + approvalMenu, 'git log -1'],
    ['Bash(echo ok)\nAllow this action?' + approvalMenu, 'echo ok'],
    ['Allow running ls -l?' + approvalMenu, 'Allow running ls -l?'],
    ['Proceed with offline indexing? [Y/n]', 'Proceed with offline indexing? [Y/n]'],
    ['Requesting permission for:\nwrong' + approvalMenu + '\nRequesting permission for:\nright\nRun this command?' + approvalMenu, 'right']
  ]) assert.equal(extractHitlCommandPreview(screen), expected);
});

test('preview strips terminal formatting, truncates to 180 Unicode characters, and rejects idle lists', () => {
  const command = 'echo ' + '😀'.repeat(180);
  const screen = '\x1b[32mRequesting permission for:\x1b[0m\n  ' + command + approvalMenu;
  assert.equal(extractHitlCommandPreview(screen), 'echo ' + '😀'.repeat(174) + '…');
  assert.equal(extractHitlCommandPreview('Completed steps:\n1. Read notes\n2. Updated notes\n>\n? for shortcuts'), '');
  const idle = 'Requesting permission for:\n  previous command' + approvalMenu + '\n>\n? for shortcuts';
  assert.equal(detectLiveHitlPrompt(idle).blocked, false);
  assert.equal(extractHitlCommandPreview(idle), '');
  assert.equal(extractHitlCommandPreview('Running tests\nesc to cancel'), '');
});

test('preview masks synthetic credentials before shortening, including quoted and wrapped values', () => {
  for (const command of [
    'tool API_TOKEN="fixture phrase\ncontinued"',
    'tool --password fixture-only',
    "curl -H 'Authorization: Bearer fixture-only'",
    'git fetch https://user:fixture-only@example.invalid/'
  ]) {
    const preview = extractHitlCommandPreview('Requesting permission for:\n  ' + command + approvalMenu);
    assert.match(preview, /\[REDACTED\]/);
    assert.doesNotMatch(preview, /fixture|continued/);
  }
});
