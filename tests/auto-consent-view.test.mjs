import test from 'node:test';
import assert from 'node:assert/strict';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import {
  AUTO_CONSENT_MODES,
  AUTO_CONSENT_PROFILES,
  AUTO_CONSENT_VETO_CODES,
  DEFAULT_AUTO_CONSENT_CONFIG,
  createSessionGrant,
  sanitizeAutoConsentConfig
} from '../openrig/assets/domain/auto-consent-model.js';
import {
  AUTO_CONSENT_SWITCH_COOLDOWN_MS,
  buildDemoAutoConsentInitialState,
  createAutoConsentController,
  escapeHtml,
  getAutoConsentModalBadge,
  getAutoConsentTopButtonState,
  readAutoConsentSettingsForm,
  renderAutoConsentDemoBarHtml,
  renderAutoConsentHudPillHtml,
  renderAutoConsentTabHtml,
  renderHitlTrustSessionBtnHtml,
  renderPendingConsentToastHtml,
  renderSeatAutoConsentPickerHtml
} from '../openrig/assets/ui/auto-consent-view.js';

const tdFor = (lang) => (key, vars) => tDeck(lang, key, vars);
const NOW = Date.UTC(2026, 10, 26, 16, 0, 0);

function makeSurface() {
  const listeners = new Map();
  return {
    innerHTML: '',
    ownerDocument: null,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    async click(action, dataset = {}) {
      const el = { disabled: false, dataset: { autoConsentAction: action, ...dataset }, ownerDocument: this.ownerDocument };
      return listeners.get('click')?.({ target: { closest: () => el } });
    },
    async change(action, value, dataset = {}) {
      const el = { disabled: false, value, dataset: { autoConsentAction: action, ...dataset } };
      return listeners.get('change')?.({ target: { closest: () => el } });
    },
    hasListener(type) {
      return listeners.has(type);
    }
  };
}

function makeActiveState(nowMs = NOW) {
  const cfg = sanitizeAutoConsentConfig({
    enabled: true,
    mode: AUTO_CONSENT_MODES.ARMED,
    masterPaused: false,
    graceWindowMs: 3000,
    projects: { 'core-platform': { profile: AUTO_CONSENT_PROFILES.TRUSTED_DEV } },
    seats: { 'dev-coder3@core-platform': { profile: AUTO_CONSENT_PROFILES.MANUAL_ONLY } }
  }, DEFAULT_AUTO_CONSENT_CONFIG);
  const { grant } = createSessionGrant({
    grantId: 'grant-seat-1',
    scope: 'seat',
    targetId: 'dev-check@core-platform',
    profile: AUTO_CONSENT_PROFILES.TRUSTED_DEV,
    ttlMin: 47,
    maxApprovals: 25,
    seatSessionEpoch: 'epoch-1',
    nowMs
  });
  return {
    status: 'armed',
    config: cfg,
    sessionGrants: [{ ...grant, usedApprovals: 5 }],
    pendingApprovals: [{
      id: 'pend-1',
      seatId: 'dev-check@core-platform',
      rigId: 'core-platform',
      promptHash: 'fp1:abcdef0123456789',
      commandPreview: 'npm test',
      matchedProfile: AUTO_CONSENT_PROFILES.TRUSTED_DEV,
      sourceScope: 'session',
      createdAtMs: nowMs,
      fireAtMs: nowMs + 2400,
      graceWindowMs: 3000
    }],
    recentRuns: [{
      id: 'run-1',
      seatId: 'dev-check@core-platform',
      outcome: 'escalated',
      vetoCode: 'E-VETO-GIT_PUSH',
      sourceScope: 'project',
      commandPreview: 'git push origin main',
      reason: 'Hard safety veto: git push',
      at: new Date(nowMs - 30_000).toISOString()
    }],
    stats: { approvedCount: 12, escalatedCount: 1, canceledCount: 0, actionsLastHour: 12 }
  };
}

for (const lang of ['en', 'ru']) {
  test(`HUD pill is silent when OFF and renders active/dry-run/paused with 1-click pause/resume (${lang})`, () => {
    const td = tdFor(lang);
    assert.equal(renderAutoConsentHudPillHtml(null, { td, lang, nowMs: NOW }), '');
    assert.equal(
      renderAutoConsentHudPillHtml({ config: DEFAULT_AUTO_CONSENT_CONFIG }, { td, lang, nowMs: NOW }),
      ''
    );

    const active = makeActiveState(NOW);
    const armedHtml = renderAutoConsentHudPillHtml(active, { td, lang, nowMs: NOW });
    assert.match(armedHtml, /ac-hud-pill is-armed/);
    assert.match(armedHtml, /data-auto-consent-action="pause-all"/);
    assert.ok(armedHtml.includes(td('autoConsent.pauseAllBtn')));
    assert.ok(armedHtml.includes('12'));
    assert.doesNotMatch(armedHtml, /on(?:click|change|error)=/i);

    const dryState = { ...active, config: { ...active.config, mode: AUTO_CONSENT_MODES.DRY_RUN } };
    const dryHtml = renderAutoConsentHudPillHtml(dryState, { td, lang, nowMs: NOW });
    assert.match(dryHtml, /is-dry-run/);
    assert.match(dryHtml, /data-auto-consent-action="pause-all"/);

    const pausedState = { ...active, config: { ...active.config, masterPaused: true } };
    const pausedHtml = renderAutoConsentHudPillHtml(pausedState, { td, lang, nowMs: NOW });
    assert.match(pausedHtml, /is-paused/);
    assert.match(pausedHtml, /data-auto-consent-action="resume-all"/);
    assert.ok(pausedHtml.includes(td('autoConsent.hudPaused')));
    assert.ok(pausedHtml.includes(td('autoConsent.resumeAllBtn')));
  });

  test(`Pending 3s Grace-Window cancel toast renders countdown, redacted preview, scope & Cancel button (${lang})`, () => {
    const td = tdFor(lang);
    assert.equal(renderPendingConsentToastHtml([], { td, nowMs: NOW }), '');
    const pending = makeActiveState(NOW).pendingApprovals;
    const html3s = renderPendingConsentToastHtml(pending, { td, nowMs: NOW, shortSeat: (s) => s.split('@')[0] });
    assert.ok(html3s.includes(td('autoConsent.toastTitle', { sec: 3 })));
    assert.ok(html3s.includes(td('autoConsent.toastCancelBtn')));
    assert.ok(html3s.includes('npm test'));
    assert.ok(html3s.includes('dev-check'));
    assert.match(html3s, /data-auto-consent-action="cancel-pending"/);
    assert.match(html3s, /data-pending-id="pend-1"/);
    assert.doesNotMatch(html3s, /on(?:click|change|error)=/i);

    const html1s = renderPendingConsentToastHtml(pending, { td, nowMs: NOW + 1800 });
    assert.ok(html1s.includes(td('autoConsent.toastTitle', { sec: 1 })));
  });

  test(`Guardrails Auto-Consent tab renders all scopes, grants, flags, settings and audit log (${lang})`, () => {
    const td = tdFor(lang);
    const active = makeActiveState(NOW);
    const html = renderAutoConsentTabHtml({
      state: active,
      rigs: ['core-platform', 'kernel'],
      agents: [
        { id: 'dev-check@core-platform', shortName: 'dev-check', ctxPct: 38, seatSessionEpoch: 'epoch-1' },
        { id: 'dev-coder4@core-platform', shortName: 'dev-coder4', ctxPct: 79 }
      ],
      td,
      deckLang: lang,
      shortSeat: (s) => s.split('@')[0],
      nowMs: NOW,
      demoTrack: true
    });
    for (const id of ['acMasterEnable', 'acModeSelect', 'acGraceWindowSelect', 'acPauseCtxCheck', 'acCtxThresholdInput', 'acAllowPkgCheck', 'acAllowNetCheck']) {
      assert.ok(html.includes(`id="${id}"`), `Missing #${id}`);
    }
    assert.ok(html.includes(escapeHtml(td('autoConsent.projectsTitle'))));
    assert.ok(html.includes(escapeHtml(td('autoConsent.seatsTitle'))));
    assert.ok(html.includes(escapeHtml(td('autoConsent.sessionsTitle'))));
    assert.ok(html.includes(escapeHtml(td('autoConsent.settingsTitle'))));
    assert.ok(html.includes(escapeHtml(td('autoConsent.recentRunsTitle'))));
    assert.ok(html.includes(escapeHtml(td('autoConsent.demoTrackBanner'))));
    assert.ok(html.includes('CTX 79%'));
    assert.ok(html.includes('E-VETO-GIT_PUSH'));
    assert.match(html, /data-auto-consent-action="set-project-policy"/);
    assert.match(html, /data-auto-consent-action="set-seat-policy"/);
    assert.match(html, /data-auto-consent-action="revoke-grant"/);
    assert.match(html, /data-auto-consent-action="save-policy"/);
    assert.doesNotMatch(html, /on(?:click|change|error)=/i);

    const badge = getAutoConsentModalBadge(active, td);
    assert.equal(badge.text, lang === 'ru' ? 'БОЕВОЙ (ARMED) • 12/30/h' : 'ARMED • 12/30/h');
  });

  test(`Seat Inspector picker and HITL Allow + Trust Session 60m respect safety boundaries (${lang})`, () => {
    const td = tdFor(lang);
    const active = makeActiveState(NOW);
    const seatWithGrant = { id: 'dev-check@core-platform', seatSessionEpoch: 'epoch-1' };
    const htmlWithGrant = renderSeatAutoConsentPickerHtml({ seat: seatWithGrant, state: active, td, lang, nowMs: NOW });
    assert.match(htmlWithGrant, /data-auto-consent-action="set-seat-policy"/);
    assert.match(htmlWithGrant, /data-auto-consent-action="revoke-grant"/);
    assert.doesNotMatch(htmlWithGrant, /on(?:click|change|error)=/i);

    const seatNoGrant = { id: 'dev-coder@core-platform' };
    const htmlNoGrant = renderSeatAutoConsentPickerHtml({ seat: seatNoGrant, state: active, td, lang, nowMs: NOW });
    assert.match(htmlNoGrant, /data-auto-consent-action="grant-session"/);
    assert.ok(htmlNoGrant.includes(td('autoConsent.grantSessionBtn')));

    const routinePrompt = 'Requesting permission for:\n  $ npm test\nRun this command?\n› 1. Yes, allow once (y)\n  2. Yes, always allow\n  3. No, cancel (esc)';
    const trustBtn = renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: routinePrompt, td });
    assert.match(trustBtn, /data-auto-consent-action="hitl-trust-session"/);
    assert.ok(trustBtn.includes(td('autoConsent.hitlTrustSessionBtn')));
    assert.doesNotMatch(trustBtn, /on(?:click|change|error)=/i);

    // Must NOT render Allow + Trust Session on a Hard Safety Veto command (git push / rm -rf)
    const destructivePrompt = 'Requesting permission for:\n  $ git push origin main\nRun this command?\n› 1. Yes, allow once (y)\n  2. No, cancel (esc)';
    assert.equal(renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: destructivePrompt, td }), '');

    // Must NOT render when Option 1 itself is "Always allow"
    const alwaysPrompt = 'Requesting permission for:\n  $ npm test\nRun this command?\n› 1. Always allow\n  2. No, cancel';
    assert.equal(renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: alwaysPrompt, td }), '');
  });
}

test('XSS sanitization: untrusted rig, seat, command, grant, pending, veto and status strings stay text with zero inline handlers', () => {
  const xss = `<img src=x onerror="globalThis.__pwn=1">'&"`;
  const td = tdFor('en');
  const state = {
    status: 'armed',
    config: { enabled: true, mode: 'armed', masterPaused: false, graceWindowMs: 3000, projects: {}, seats: {} },
    sessionGrants: [{
      grantId: xss,
      scope: 'seat',
      targetId: xss,
      profile: 'trusted_dev',
      createdAtMs: NOW,
      expiresAtMs: NOW + 600_000,
      maxApprovals: 10,
      usedApprovals: 1,
      seatSessionEpoch: 'ep'
    }],
    pendingApprovals: [{
      id: xss,
      seatId: xss,
      rigId: xss,
      commandPreview: xss,
      matchedProfile: 'trusted_dev',
      sourceScope: 'session',
      createdAtMs: NOW,
      fireAtMs: NOW + 2500,
      graceWindowMs: 3000
    }],
    recentRuns: [{
      id: xss,
      seatId: xss,
      outcome: 'escalated',
      vetoCode: xss,
      sourceScope: 'seat',
      commandPreview: xss,
      reason: xss,
      at: new Date(NOW).toISOString()
    }],
    stats: { approvedCount: 1, escalatedCount: 1, canceledCount: 0, actionsLastHour: 1 },
    activeSummary: { enabled: true, mode: 'armed', masterPaused: false, hasActiveScopes: true, totalActiveScopes: 1, shortestSessionRemainingMin: 10 }
  };

  const parts = [
    renderAutoConsentHudPillHtml(state, { td, nowMs: NOW }),
    renderPendingConsentToastHtml(state.pendingApprovals, { td, nowMs: NOW, shortSeat: (s) => s }),
    renderAutoConsentTabHtml({ state, rigs: [xss], agents: [{ id: xss, shortName: xss }], td, shortSeat: (s) => s, nowMs: NOW, statusMessage: xss }),
    renderSeatAutoConsentPickerHtml({ seat: { id: xss }, state, td, nowMs: NOW }),
    renderHitlTrustSessionBtnHtml({
      seatId: xss,
      screenText: 'Requesting permission for:\n  $ npm test\nRun this command?\n› 1. Yes, allow once\n  2. No, cancel',
      td
    }),
    renderAutoConsentDemoBarHtml({ demoTrack: true, state, demoNote: xss, td })
  ];

  for (const html of parts) {
    assert.doesNotMatch(html, /<img/i);
    assert.ok(!html.includes(xss));
    assert.doesNotMatch(html, /\son(?:click|change|input|error|load)=["']/i);
  }
  const combined = parts.join('\n');
  assert.ok(combined.includes(escapeHtml(xss)));
});

test('readAutoConsentSettingsForm reads populated values and preserves fail-closed defaults when controls are absent', () => {
  const fields = {
    acMasterEnable: { checked: true },
    acModeSelect: { value: 'armed' },
    acGraceWindowSelect: { value: '5000' },
    acPauseCtxCheck: { checked: false },
    acCtxThresholdInput: { value: '82' },
    acAllowPkgCheck: { checked: true },
    acAllowNetCheck: { checked: true }
  };
  const parsed = readAutoConsentSettingsForm({ getElementById: (id) => fields[id] || null });
  assert.deepEqual(parsed, {
    enabled: true,
    mode: 'armed',
    graceWindowMs: 5000,
    defaults: {
      pauseOnCtxOverheat: false,
      ctxPauseThresholdPct: 82,
      allowPackageInstall: true,
      allowReadOnlyNetwork: true
    }
  });

  const defaults = readAutoConsentSettingsForm({ getElementById: () => null });
  assert.deepEqual(defaults, {
    enabled: false,
    mode: 'dry_run',
    graceWindowMs: 3000,
    defaults: {
      pauseOnCtxOverheat: true,
      ctxPauseThresholdPct: 75,
      allowPackageInstall: false,
      allowReadOnlyNetwork: false
    }
  });
});

test('live controller calls frozen /api/auto-consent/* contract, handles SSE events, and cleans up countdown ticker when idle', async () => {
  const hudRoot = makeSurface();
  const toastRoot = makeSurface();
  const inspectorRoot = makeSurface();
  const guardrailsBodyRoot = makeSurface();
  const hitlRoot = makeSurface();
  const calls = [];
  const allowOnceCalls = [];
  let activeIntervals = 0;
  let nextIntervalId = 1;

  const activeState = makeActiveState(NOW);
  const ctrl = createAutoConsentController({
    hudRoot,
    toastRoot,
    inspectorRoot,
    guardrailsBodyRoot,
    hitlRoots: [hitlRoot],
    td: tdFor('en'),
    lang: () => 'en',
    isLive: () => true,
    demo: false,
    getAgents: () => [{ id: 'dev-check@core-platform', shortName: 'dev-check', seatSessionEpoch: 'epoch-1' }],
    getRigs: () => ['core-platform'],
    getSelectedSeat: () => ({ id: 'dev-check@core-platform', seatSessionEpoch: 'epoch-1' }),
    getJson: async (endpoint) => {
      calls.push(['GET', endpoint]);
      return { ok: true, state: { ...activeState, pendingApprovals: [] } };
    },
    postJson: async (endpoint, body) => {
      calls.push(['POST', endpoint, body]);
      if (endpoint === '/api/auto-consent/pause-all') {
        return { ok: true, state: { ...activeState, pendingApprovals: [], config: { ...activeState.config, masterPaused: body.paused } } };
      }
      if (endpoint === '/api/auto-consent/cancel') {
        return { ok: true, canceledCount: 1, state: { ...activeState, pendingApprovals: [] } };
      }
      return { ok: true, state: { ...activeState, pendingApprovals: [] } };
    },
    sendAllowOnce: (seatId, statusElId) => allowOnceCalls.push([seatId, statusElId]),
    now: () => NOW,
    setIntervalFn: () => { activeIntervals++; return nextIntervalId++; },
    clearIntervalFn: () => { activeIntervals = Math.max(0, activeIntervals - 1); }
  });

  await ctrl.refresh();
  assert.equal(calls[0][0], 'GET');
  assert.equal(calls[0][1], '/api/auto-consent/state');
  assert.equal(activeIntervals, 0, 'zero intervals when no pending approval');

  // SSE pending starts countdown ticker and renders cancel toast
  ctrl.handleSseEvent('auto_consent_pending', { pending: activeState.pendingApprovals[0] });
  assert.equal(activeIntervals, 1);
  assert.match(toastRoot.innerHTML, /data-pending-id="pend-1"/);

  // Cancel button calls POST /api/auto-consent/cancel and stops ticker
  await toastRoot.click('cancel-pending', { pendingId: 'pend-1', seat: 'dev-check@core-platform' });
  assert.deepEqual(calls.at(-1), ['POST', '/api/auto-consent/cancel', { pendingId: 'pend-1', seatId: 'dev-check@core-platform' }]);
  assert.equal(activeIntervals, 0);
  assert.equal(toastRoot.innerHTML, '');

  // Top HUD pause button calls POST /api/auto-consent/pause-all
  await hudRoot.click('pause-all');
  assert.deepEqual(calls.at(-1), ['POST', '/api/auto-consent/pause-all', { paused: true }]);
  assert.match(hudRoot.innerHTML, /is-paused/);

  // Scope policy change in Guardrails tab calls POST /api/auto-consent/policy
  await guardrailsBodyRoot.change('set-project-policy', 'safe_readonly', { target: 'core-platform' });
  assert.deepEqual(calls.at(-1), ['POST', '/api/auto-consent/policy', { scope: 'project', targetId: 'core-platform', profile: 'safe_readonly' }]);

  // HITL Allow + Trust Session 60m dispatches Allow Once AND creates seat session grant
  await hitlRoot.click('hitl-trust-session', { seat: 'dev-check@core-platform', status: 'modalCmdStatus' });
  assert.deepEqual(allowOnceCalls, [['dev-check@core-platform', 'modalCmdStatus']]);
  assert.equal(calls.at(-1)[1], '/api/auto-consent/session-grant');
  assert.equal(calls.at(-1)[2].action, 'create');
  assert.equal(calls.at(-1)[2].scope, 'seat');
  assert.equal(calls.at(-1)[2].ttlMin, 60);

  // SSE resolved clears pending approval cleanly
  ctrl.handleSseEvent('auto_consent_pending', { pending: activeState.pendingApprovals[0] });
  assert.equal(activeIntervals, 1);
  ctrl.handleSseEvent('auto_consent_resolved', { pendingId: 'pend-1', seatId: 'dev-check@core-platform', outcome: 'approved' });
  assert.equal(activeIntervals, 0);
  assert.equal(toastRoot.innerHTML, '');

  ctrl.destroy();
  assert.equal(hudRoot.hasListener('click'), false);
});

test('offline /demo?track=auto-consent simulation executes enable, 3s grace cancel & auto-approve, git push Hard Veto, and pause-all with ZERO /api/* calls', async () => {
  const hudRoot = makeSurface();
  const toastRoot = makeSurface();
  const inspectorRoot = makeSurface();
  const demoBarRoot = makeSurface();
  const timeouts = new Map();
  let nextTid = 1;
  let clock = NOW;
  const screenUpdates = [];

  const ctrl = createAutoConsentController({
    hudRoot,
    toastRoot,
    inspectorRoot,
    demoBarRoot,
    td: tdFor('en'),
    lang: () => 'en',
    isLive: () => false,
    demo: true,
    demoTrack: true,
    getAgents: () => [{ id: 'dev-check@core-platform', shortName: 'dev-check', ctxPct: 38 }],
    getRigs: () => ['core-platform'],
    getSelectedSeat: () => ({ id: 'dev-check@core-platform', ctxPct: 38 }),
    getJson: () => assert.fail('offline demo must never issue GET /api/*'),
    postJson: () => assert.fail('offline demo must never issue POST /api/*'),
    onDemoScreenUpdate: (ev) => screenUpdates.push(ev),
    now: () => clock,
    setIntervalFn: () => 99,
    clearIntervalFn: () => {},
    setTimeoutFn: (fn) => { const id = nextTid++; timeouts.set(id, fn); return id; },
    clearTimeoutFn: (id) => { timeouts.delete(id); }
  });

  // Fail-closed before demo track starts
  await ctrl.refresh();
  assert.equal(hudRoot.innerHTML, '');

  // Start /demo?track=auto-consent: enables trusted_dev + enqueues 3s npm test countdown
  ctrl.startDemoTrack();
  assert.match(hudRoot.innerHTML, /ac-hud-pill is-armed/);
  assert.match(toastRoot.innerHTML, /npm test/);
  assert.match(toastRoot.innerHTML, /data-auto-consent-action="cancel-pending"/);
  assert.equal(ctrl.getState().pendingApprovals.length, 1);

  // Mid-countdown Cancel aborts timer and records VETO_OPERATOR_CANCELED
  const firstPendingId = ctrl.getState().pendingApprovals[0].id;
  await toastRoot.click('cancel-pending', { pendingId: firstPendingId, seat: 'dev-check@core-platform' });
  assert.equal(ctrl.getState().pendingApprovals.length, 0);
  assert.equal(ctrl.getState().stats.canceledCount, 1);
  assert.equal(ctrl.getState().recentRuns[0].vetoCode, AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED);
  assert.equal(timeouts.size, 0);

  // Re-trigger routine npm test and let 3s grace timer complete -> auto-approves Option 1
  clock += 5000;
  await demoBarRoot.click('demo-routine');
  assert.equal(ctrl.getState().pendingApprovals.length, 1);
  const [tid, fireFn] = [...timeouts.entries()][0];
  timeouts.delete(tid);
  clock += 3000;
  fireFn();
  assert.equal(ctrl.getState().pendingApprovals.length, 0);
  assert.equal(ctrl.getState().stats.approvedCount, 2);
  assert.equal(ctrl.getState().recentRuns[0].outcome, 'approved');
  assert.equal(screenUpdates.at(-1).seatState, 'working');

  // Hard Safety Veto: git push escalates immediately with 0 timers
  clock += 1000;
  await demoBarRoot.click('demo-veto');
  assert.equal(ctrl.getState().pendingApprovals.length, 0);
  assert.equal(timeouts.size, 0);
  assert.equal(ctrl.getState().recentRuns[0].vetoCode, 'E-VETO-GIT_PUSH');
  assert.equal(screenUpdates.at(-1).seatState, 'urgent');

  // 1-click PAUSE aborts active countdown and flips HUD pill to PAUSED
  clock += 1000;
  await demoBarRoot.click('demo-routine');
  assert.equal(ctrl.getState().pendingApprovals.length, 1);
  await hudRoot.click('pause-all');
  assert.equal(ctrl.getState().config.masterPaused, true);
  assert.equal(ctrl.getState().pendingApprovals.length, 0);
  assert.equal(timeouts.size, 0);
  assert.match(hudRoot.innerHTML, /is-paused/);

  ctrl.destroy();
});

test('non-live non-demo controller stays completely idle with zero network calls', async () => {
  const hudRoot = makeSurface();
  const ctrl = createAutoConsentController({
    hudRoot,
    td: tdFor('en'),
    isLive: () => false,
    demo: false,
    getJson: () => assert.fail('non-live GET'),
    postJson: () => assert.fail('non-live POST')
  });
  await ctrl.refresh();
  assert.equal(hudRoot.innerHTML, '');
  assert.equal(buildDemoAutoConsentInitialState({ active: false }).config.enabled, false);
  ctrl.destroy();
});

test('P1 regression: renderHitlTrustSessionBtnHtml delegates to evaluateAutoConsentPrompt (rejects product questions, above-fold scrolled options, and 16-line wrapped rm -rf)', () => {
  const td = tdFor('en');

  // 1. Product/architectural choice question
  const productChoice = 'Which caching backend should we use?\n› 1. Use Redis\n  2. Use SQLite';
  assert.equal(renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: productChoice, td }), '');

  // 2. Narrow-pane scrolled menu where option 1 is synthesized as "above fold"
  const scrolledAboveFold = [
    'Requesting permission for:',
    '  $ npm test',
    'Run this command?',
    '  3. Yes, always allow',
    '  4. No, cancel',
    '↑/↓ Navigate'
  ].join('\n');
  assert.equal(renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: scrolledAboveFold, td }), '');

  // 3. 16-line wrapped command starting with rm -rf beyond 12-line prompt-parser window
  const wrappedRmRf = [
    '$ rm -rf /tmp/x && \\',
    ...Array.from({ length: 15 }, (_, i) => `  echo step-${i} && \\`),
    '  echo done',
    'Run this command?',
    '› 1. Yes, allow once',
    '  2. No, cancel'
  ].join('\n');
  assert.equal(renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: wrappedRmRf, td }), '');

  // 4. Legitimate single-use permission prompt still renders the button (EN and RU)
  const validEn = 'Requesting permission for:\n  $ npm test\nRun this command?\n› 1. Yes, allow once (y)\n  2. Yes, always allow\n  3. No, cancel (esc)';
  assert.match(
    renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: validEn, td }),
    /data-auto-consent-action="hitl-trust-session"/
  );
  const validRu = 'Requesting permission for:\n  $ npm test\nRun this command?\n› 1. Да, разрешить один раз (y)\n  2. Да, всегда разрешать\n  3. Нет, отменить (esc)';
  assert.match(
    renderHitlTrustSessionBtnHtml({ seatId: 'dev-check@core-platform', screenText: validRu, td: tdFor('ru') }),
    /data-auto-consent-action="hitl-trust-session"/
  );
});

test('P1 regression: Slice 10.2 flat auto_consent_resolved runEntry honors status over decision (failed, canceled, drift_aborted never report approved)', () => {
  const hudRoot = makeSurface();
  const toastRoot = makeSurface();
  const guardrailsBodyRoot = makeSurface();
  const notices = [];
  const td = tdFor('en');

  const ctrl = createAutoConsentController({
    hudRoot,
    toastRoot,
    guardrailsBodyRoot,
    td,
    lang: () => 'en',
    isLive: () => true,
    demo: false,
    onToastNotice: (msg) => notices.push(msg),
    now: () => NOW,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  });

  // 1. Failed dispatch with status='failed' & decision='approve_once' MUST NOT fire toastApproved or render is-approved
  ctrl.handleSseEvent('auto_consent_pending', {
    id: 'pend-fail',
    seatId: 'dev-check@core-platform',
    commandPreview: 'npm test',
    fireAtMs: NOW + 3000,
    graceWindowMs: 3000
  });
  ctrl.handleSseEvent('auto_consent_resolved', {
    id: 'run-fail-1',
    pendingId: 'pend-fail',
    seatId: 'dev-check@core-platform',
    status: 'failed',
    decision: 'approve_once',
    commandPreview: 'npm test',
    reason: 'tmux exited',
    at: new Date(NOW).toISOString()
  });
  assert.equal(ctrl.getState().pendingApprovals.length, 0);
  assert.equal(ctrl.getState().recentRuns[0].id, 'run-fail-1');
  assert.ok(!notices.at(-1).includes('Approved Option 1'), `Unexpected approved toast: ${notices.at(-1)}`);
  assert.match(notices.at(-1), /failed/i);

  // 2. Flat canceled runEntry with status='canceled' & decision='escalate' fires toastCanceled and prepends to recentRuns
  ctrl.handleSseEvent('auto_consent_resolved', {
    id: 'run-cancel-1',
    pendingId: 'pend-cancel',
    seatId: 'dev-check@core-platform',
    status: 'canceled',
    decision: 'escalate',
    vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED,
    commandPreview: 'npm test',
    reason: 'Operator canceled',
    at: new Date(NOW + 1000).toISOString()
  });
  assert.equal(notices.at(-1), td('autoConsent.toastCanceled'));
  assert.equal(ctrl.getState().recentRuns[0].id, 'run-cancel-1');

  // 3. Flat drift_aborted runEntry fires vetoPromptDrift and never renders as approved
  ctrl.handleSseEvent('auto_consent_resolved', {
    id: 'run-drift-1',
    pendingId: 'pend-drift',
    seatId: 'dev-check@core-platform',
    status: 'drift_aborted',
    decision: 'approve_once',
    vetoCode: AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT,
    commandPreview: 'npm test',
    reason: 'Prompt drifted',
    at: new Date(NOW + 2000).toISOString()
  });
  assert.equal(notices.at(-1), td('autoConsent.vetoPromptDrift'));

  // 4. Paused-canceled run renders as canceled/paused, not escalated, and failed renders is-failed (never is-approved)
  const tabHtml = renderAutoConsentTabHtml({
    state: {
      ...ctrl.getState(),
      recentRuns: [
        ...ctrl.getState().recentRuns,
        {
          id: 'run-paused-1',
          seatId: 'dev-check@core-platform',
          status: 'canceled',
          decision: 'escalate',
          vetoCode: AUTO_CONSENT_VETO_CODES.MASTER_PAUSED,
          commandPreview: 'npm test',
          at: new Date(NOW + 3000).toISOString()
        }
      ]
    },
    td,
    deckLang: 'en',
    nowMs: NOW
  });
  assert.match(tabHtml, /ac-run-row is-failed/);
  assert.match(tabHtml, /Dispatch Failed/);
  assert.doesNotMatch(tabHtml, /ac-run-row is-approved/);
  assert.ok(tabHtml.includes(td('autoConsent.hudPaused')));
  ctrl.destroy();
});

test('P1 regression: live seat grants omit startedAt as seatSessionEpoch and Inspector Revoke matches server tmux epoch', async () => {
  const inspectorRoot = makeSurface();
  const td = tdFor('en');
  const postCalls = [];

  const liveSeatWithStartedAt = {
    id: 'dev-check@core-platform',
    shortName: 'dev-check',
    startedAt: '2026-11-26T10:00:00Z',
    sessionId: 'openrig-sess-99'
  };

  const serverTmuxGrant = {
    grantId: 'grant-live-1',
    scope: 'seat',
    targetId: 'dev-check@core-platform',
    profile: AUTO_CONSENT_PROFILES.TRUSTED_DEV,
    createdAtMs: NOW,
    expiresAtMs: NOW + 3_600_000,
    maxApprovals: 25,
    usedApprovals: 1,
    seatSessionEpoch: 'tmux:%12:48123'
  };

  // 1. Inspector picker MUST match server tmux grant and render Revoke even when seat has startedAt/sessionId
  const pickerHtml = renderSeatAutoConsentPickerHtml({
    seat: liveSeatWithStartedAt,
    state: {
      status: 'armed',
      config: { enabled: true, mode: 'armed', masterPaused: false },
      sessionGrants: [serverTmuxGrant]
    },
    td,
    lang: 'en',
    nowMs: NOW
  });
  assert.match(pickerHtml, /data-auto-consent-action="revoke-grant"/);
  assert.match(pickerHtml, /data-grant-id="grant-live-1"/);

  // 2. Live POST /api/auto-consent/session-grant MUST omit seatSessionEpoch when seat only has startedAt/sessionId
  const ctrl = createAutoConsentController({
    inspectorRoot,
    td,
    lang: () => 'en',
    isLive: () => true,
    demo: false,
    getAgents: () => [liveSeatWithStartedAt],
    getSelectedSeat: () => liveSeatWithStartedAt,
    postJson: async (endpoint, body) => {
      postCalls.push([endpoint, body]);
      return {
        ok: true,
        grant: serverTmuxGrant,
        state: {
          status: 'armed',
          config: { enabled: true, mode: 'armed', masterPaused: false },
          sessionGrants: [serverTmuxGrant]
        }
      };
    },
    now: () => NOW
  });

  await inspectorRoot.click('grant-session', { scope: 'seat', target: 'dev-check@core-platform', profile: 'trusted_dev', ttlMin: '60' });
  const grantCall = postCalls.find(([ep]) => ep === '/api/auto-consent/session-grant');
  assert.ok(grantCall, 'Expected POST /api/auto-consent/session-grant');
  assert.equal(Object.prototype.hasOwnProperty.call(grantCall[1], 'seatSessionEpoch'), false, 'Must not send startedAt/sessionId as seatSessionEpoch');
  assert.match(inspectorRoot.innerHTML, /data-auto-consent-action="revoke-grant"/);
  ctrl.destroy();
});

test('v3.8.1 UX: Top triage button badge, localized modal header badges, Inspector clickable status & CTAs, and Modal mode clarity + master-off warning (EN/RU)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'openrig/index.html'), 'utf8');

  // 1. Direct top button right next to #btnGuardrails in openrig/index.html
  assert.match(indexHtml, /id="btnGuardrails"[\s\S]{0,700}<\/button>\s*<button[^>]*id="btnAutoConsentTop"/);
  assert.match(indexHtml, /id="btnAutoConsentTop"[^>]*onclick="openGuardrailsModal\('auto-consent'\)"/);
  assert.match(indexHtml, /data-i18n="autoConsent\.topBtn"/);
  assert.match(indexHtml, /id="btnAutoConsentStateBadge"/);

  function makeClassList() {
    const set = new Set();
    return {
      toggle(cls, force) {
        if (force === undefined) {
          if (set.has(cls)) set.delete(cls);
          else set.add(cls);
        } else if (force) {
          set.add(cls);
        } else {
          set.delete(cls);
        }
      },
      contains(cls) { return set.has(cls); }
    };
  }

  for (const lang of ['en', 'ru']) {
    const td = tdFor(lang);
    const active = makeActiveState(NOW);

    // 2. Top button state & modal badge localization across all 4+ states
    const offState = { config: { ...DEFAULT_AUTO_CONSENT_CONFIG, enabled: false, mode: 'dry_run', masterPaused: false } };
    const dryState = { ...active, config: { ...active.config, enabled: true, mode: 'dry_run', masterPaused: false } };
    const armedState = { ...active, config: { ...active.config, enabled: true, mode: 'armed', masterPaused: false } };
    const pausedState = { ...active, config: { ...active.config, masterPaused: true } };
    const cappedState = { ...armedState, status: 'capped', stats: { ...armedState.stats, actionsLastHour: 30 } };

    assert.equal(getAutoConsentTopButtonState(offState, { td }).text, lang === 'ru' ? 'ВЫКЛ' : 'OFF');
    assert.equal(getAutoConsentTopButtonState(dryState, { td }).text, lang === 'ru' ? 'ТЕСТ' : 'DRY-RUN');
    assert.equal(getAutoConsentTopButtonState(armedState, { td }).text, lang === 'ru' ? 'БОЕВОЙ' : 'ARMED');
    assert.equal(getAutoConsentTopButtonState(pausedState, { td }).text, lang === 'ru' ? 'ПАУЗА' : 'PAUSED');

    assert.equal(getAutoConsentModalBadge(offState, td).text, lang === 'ru' ? 'АВТО-СОГЛАСИЕ ВЫКЛ' : 'AUTO-CONSENT OFF');
    assert.equal(getAutoConsentModalBadge(dryState, td).text, lang === 'ru' ? 'ТЕСТ (DRY-RUN)' : 'DRY-RUN PREVIEW');
    assert.equal(getAutoConsentModalBadge(armedState, td).text, lang === 'ru' ? 'БОЕВОЙ (ARMED) • 12/30/h' : 'ARMED • 12/30/h');
    assert.equal(getAutoConsentModalBadge(cappedState, td).text, lang === 'ru' ? 'ЛИМИТ КВОТЫ • 30/30/h' : 'RATE-CAPPED • 30/30/h');
    assert.equal(getAutoConsentModalBadge(pausedState, td).text, lang === 'ru' ? 'НА ПАУЗЕ' : 'PAUSED');

    // 3. Inspector actionable chip + inline banners
    const offWithProjectProfile = {
      config: sanitizeAutoConsentConfig({
        enabled: false,
        mode: 'armed',
        projects: { 'core-platform': { profile: 'trusted_dev' } }
      }, DEFAULT_AUTO_CONSENT_CONFIG),
      sessionGrants: []
    };
    const inspOffWithProfile = renderSeatAutoConsentPickerHtml({
      seat: { id: 'dev-coder@core-platform' },
      state: offWithProjectProfile,
      td,
      lang,
      nowMs: NOW
    });
    assert.match(inspOffWithProfile, /<button type="button" class="ac-eff-chip ac-eff-chip-btn is-off" data-auto-consent-action="open-tab">/);
    assert.ok(inspOffWithProfile.includes(escapeHtml(td('autoConsent.offEnableCta'))));
    assert.match(inspOffWithProfile, /class="ac-inspector-cta is-warn" data-auto-consent-action="open-tab"/);
    assert.ok(inspOffWithProfile.includes(escapeHtml(td('autoConsent.inspectorMasterOffBanner'))));
    assert.doesNotMatch(inspOffWithProfile, /on(?:click|change|error)=/i);

    // Master OFF with NO configured active profile -> shows Off -> Enable chip, NO warning banner
    const inspOffUnconfigured = renderSeatAutoConsentPickerHtml({
      seat: { id: 'dev-coder@unconfigured' },
      state: offState,
      td,
      lang,
      nowMs: NOW
    });
    assert.ok(inspOffUnconfigured.includes(escapeHtml(td('autoConsent.offEnableCta'))));
    assert.doesNotMatch(inspOffUnconfigured, /ac-inspector-cta/);

    // Dry-run with active effective policy -> shows dry-run inline CTA banner
    const inspDryActive = renderSeatAutoConsentPickerHtml({
      seat: { id: 'dev-coder@core-platform' },
      state: dryState,
      td,
      lang,
      nowMs: NOW
    });
    assert.match(inspDryActive, /class="ac-inspector-cta is-dry" data-auto-consent-action="open-tab"/);
    assert.ok(inspDryActive.includes(escapeHtml(td('autoConsent.inspectorDryRunBanner'))));

    // Armed & active -> no inline warning/dry-run banner
    const inspArmedActive = renderSeatAutoConsentPickerHtml({
      seat: { id: 'dev-coder@core-platform' },
      state: armedState,
      td,
      lang,
      nowMs: NOW
    });
    assert.doesNotMatch(inspArmedActive, /ac-inspector-cta/);

    // 4. Guardrails Auto-Consent tab: mode label, RU option copy, tone classes, master-off configured scopes warning
    const tabOffConfigured = renderAutoConsentTabHtml({
      state: offWithProjectProfile,
      rigs: ['core-platform'],
      agents: [{ id: 'dev-coder@core-platform', shortName: 'dev-coder' }],
      td,
      deckLang: lang,
      nowMs: NOW
    });
    assert.match(tabOffConfigured, /<label for="acModeSelect" class="ac-mode-label">/);
    assert.ok(tabOffConfigured.includes(escapeHtml(td('autoConsent.modeLabel'))));
    assert.match(tabOffConfigured, /id="acModeSelect" class="rig-select ac-mode-select is-armed"/);
    assert.match(tabOffConfigured, /class="ac-master-off-warn" role="alert"/);
    assert.ok(tabOffConfigured.includes(escapeHtml(td('autoConsent.masterOffConfiguredWarn', { n: 1 }))));
    if (lang === 'ru') {
      assert.ok(tabOffConfigured.includes('🧪 Тестовый (Dry-Run · 0 записей)'));
      assert.ok(tabOffConfigured.includes('⚡ Боевой (Armed · Allow Once после паузы)'));
    }

    const tabDry = renderAutoConsentTabHtml({
      state: dryState,
      rigs: ['core-platform'],
      agents: [{ id: 'dev-coder@core-platform', shortName: 'dev-coder' }],
      td,
      deckLang: lang,
      nowMs: NOW
    });
    assert.match(tabDry, /id="acModeSelect" class="rig-select ac-mode-select is-dry"/);
    assert.doesNotMatch(tabDry, /ac-master-off-warn/);

    // 5. Live controller updates topBtn / topBadge automatically on state change & preview-mode-tone toggles without network calls
    const topBtn = { classList: makeClassList() };
    const topBadge = { textContent: '', classList: makeClassList() };
    const inspectorRoot = makeSurface();
    const guardrailsBodyRoot = makeSurface();
    let openedTabCount = 0;
    const ctrl = createAutoConsentController({
      topBtn,
      topBadge,
      inspectorRoot,
      guardrailsBodyRoot,
      td,
      lang: () => lang,
      isLive: () => false,
      demo: true,
      getSelectedSeat: () => ({ id: 'dev-coder@core-platform' }),
      onOpenTab: () => { openedTabCount += 1; },
      postJson: () => assert.fail('preview-mode-tone must not issue POST'),
      now: () => NOW
    });

    assert.equal(topBadge.textContent, lang === 'ru' ? 'ВЫКЛ' : 'OFF');
    assert.equal(topBadge.classList.contains('is-off'), true);
    assert.equal(topBtn.classList.contains('ac-top-is-off'), true);

    ctrl.setState(dryState);
    assert.equal(topBadge.textContent, lang === 'ru' ? 'ТЕСТ' : 'DRY-RUN');
    assert.equal(topBadge.classList.contains('is-dry'), true);
    assert.equal(topBtn.classList.contains('ac-top-is-dry'), true);

    ctrl.setState(armedState);
    assert.equal(topBadge.textContent, lang === 'ru' ? 'БОЕВОЙ' : 'ARMED');
    assert.equal(topBadge.classList.contains('is-armed'), true);
    assert.equal(topBtn.classList.contains('ac-top-is-armed'), true);

    ctrl.setState(pausedState);
    assert.equal(topBadge.textContent, lang === 'ru' ? 'ПАУЗА' : 'PAUSED');
    assert.equal(topBadge.classList.contains('is-paused'), true);
    assert.equal(topBtn.classList.contains('ac-top-is-paused'), true);

    // Clicking open-tab on inspector chip/CTA invokes onOpenTab
    await inspectorRoot.click('open-tab');
    assert.equal(openedTabCount, 1);

    ctrl.destroy();
  }
});

test('v3.8.1 #39: Tactile role="switch" pill toggles, immediate apply, 2.5s cooldown lock + countdown + timer cleanup, and instant PAUSE bypass (EN/RU)', async () => {
  assert.equal(AUTO_CONSENT_SWITCH_COOLDOWN_MS, 2500);

  for (const lang of ['en', 'ru']) {
    const td = tdFor(lang);
    const html = renderAutoConsentTabHtml({
      state: makeActiveState(NOW),
      rigs: ['kernel', 'rig-commander'],
      agents: [{ id: 'dev-coder@rig-commander', shortName: 'dev-coder' }],
      td,
      deckLang: lang,
      nowMs: NOW
    });

    // 1. All 4 functional checkboxes render as role="switch" tactile pill toggles with exact preserved IDs
    for (const id of ['acMasterEnable', 'acPauseCtxCheck', 'acAllowPkgCheck', 'acAllowNetCheck']) {
      assert.match(html, new RegExp(`<input type="checkbox" role="switch" id="${id}" class="ac-switch-input" data-auto-consent-action="toggle-switch" data-switch-id="${id}"`));
    }
    assert.match(html, /class="ac-switch-track"/);
    assert.match(html, /class="ac-switch-thumb"/);
    assert.doesNotMatch(html, /class="ac-switch-state"/, 'v3.11.0: redundant outlined ON/OFF state pills next to tactile switch removed');
    assert.doesNotMatch(html, /class="ac-default-off-chip"/, 'v3.11.0: borderless subtext replaces fake-button default-off chip');
    assert.match(html, /class="ac-default-off-hint"/);
    assert.match(html, /id="acModeSelect"[^>]*data-auto-consent-action="change-mode"/);
    assert.doesNotMatch(html, /on(?:click|change|error)=/i);

    // 2. Cooldown state disables ONLY the cooling switch and renders live countdown chip, NEVER disables PAUSE
    const coolingHtml = renderAutoConsentTabHtml({
      state: makeActiveState(NOW),
      rigs: ['rig-commander'],
      td,
      deckLang: lang,
      nowMs: NOW,
      controlCooldowns: { acMasterEnable: 2300, acModeSelect: 1400 }
    });
    assert.match(coolingHtml, /id="acMasterEnable"[^>]*disabled/);
    assert.match(coolingHtml, /id="acModeSelect"[^>]*disabled/);
    assert.doesNotMatch(coolingHtml, /id="acAllowPkgCheck"[^>]*disabled/);
    assert.ok(coolingHtml.includes(lang === 'ru' ? '⏳ 3с' : '⏳ 3s'));
    assert.ok(coolingHtml.includes(lang === 'ru' ? '⏳ 2с' : '⏳ 2s'));
    assert.doesNotMatch(coolingHtml, /data-auto-consent-action="pause-all"[^>]*disabled/);
  }

  // 3. Live controller: immediate apply on switch toggle & mode change, 2.5s cooldown lock + release, zero leaked timers, instant PAUSE bypass
  const hudRoot = makeSurface();
  const calls = [];
  const intervals = new Map();
  let nextIntervalId = 1;
  let clock = NOW;
  let rerenderCount = 0;

  let serverState = {
    status: 'disabled',
    config: sanitizeAutoConsentConfig({ enabled: false, mode: 'dry_run', masterPaused: false }, DEFAULT_AUTO_CONSENT_CONFIG),
    sessionGrants: [],
    pendingApprovals: [],
    recentRuns: [],
    stats: { approvedCount: 0, escalatedCount: 0, canceledCount: 0, actionsLastHour: 0 }
  };

  // Wire a change-capable surface that forwards full element props
  const richBody = (() => {
    let changeFn = null;
    let clickFn = null;
    return {
      addEventListener(type, fn) {
        if (type === 'change') changeFn = fn;
        if (type === 'click') clickFn = fn;
      },
      removeEventListener(type) {
        if (type === 'change') changeFn = null;
        if (type === 'click') clickFn = null;
      },
      hasListener(type) {
        return type === 'change' ? Boolean(changeFn) : Boolean(clickFn);
      },
      async triggerChange(el) {
        return changeFn?.({ target: { closest: () => el } });
      },
      async triggerClick(el) {
        return clickFn?.({ target: { closest: () => el } });
      }
    };
  })();

  const ctrl2 = createAutoConsentController({
    hudRoot,
    guardrailsBodyRoot: richBody,
    td: tdFor('en'),
    lang: () => 'en',
    isLive: () => true,
    demo: false,
    onGuardrailsRerender: () => { rerenderCount += 1; },
    postJson: async (endpoint, body) => {
      calls.push([endpoint, body]);
      if (endpoint === '/api/auto-consent/policy') {
        serverState = {
          ...serverState,
          config: sanitizeAutoConsentConfig(body.patch || body, serverState.config)
        };
      } else if (endpoint === '/api/auto-consent/pause-all') {
        serverState = {
          ...serverState,
          config: sanitizeAutoConsentConfig({ masterPaused: Boolean(body.paused) }, serverState.config)
        };
      }
      return { ok: true, state: serverState };
    },
    now: () => clock,
    setIntervalFn: (fn) => { const id = nextIntervalId++; intervals.set(id, fn); return id; },
    clearIntervalFn: (id) => { intervals.delete(id); }
  });

  // A. Toggling #acMasterEnable applies IMMEDIATELY via POST /api/auto-consent/policy and starts 2.5s cooldown ticker
  await richBody.triggerChange({
    id: 'acMasterEnable',
    checked: true,
    disabled: false,
    dataset: { autoConsentAction: 'toggle-switch', switchId: 'acMasterEnable' }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/auto-consent/policy');
  assert.equal(calls[0][1].enabled, true);
  assert.equal(intervals.size, 1, 'cooldown ticker must run while cooling');
  assert.match(ctrl2.renderTabHtml(), /id="acMasterEnable"[^>]*disabled/);
  assert.match(ctrl2.renderTabHtml(), /⏳ 3s/);

  // B. Repeated toggle within 2.5s cooldown is blocked (0 extra POST calls!)
  clock += 1000;
  await richBody.triggerChange({
    id: 'acMasterEnable',
    checked: false,
    disabled: false,
    dataset: { autoConsentAction: 'toggle-switch', switchId: 'acMasterEnable' }
  });
  assert.equal(calls.length, 1, 'switch toggle during 2.5s cooldown must be blocked');
  assert.match(ctrl2.renderTabHtml(), /⏳ 2s/);

  // C. CRITICAL SAFETY INVARIANT: Emergency PAUSE bypasses cooldown immediately!
  await richBody.triggerClick({
    disabled: false,
    dataset: { autoConsentAction: 'pause-all' }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['/api/auto-consent/pause-all', { paused: true }]);
  assert.equal(ctrl2.getState().config.masterPaused, true);

  // D. Switching #acModeSelect applies immediately and gets its own 2.5s cooldown
  await richBody.triggerChange({
    id: 'acModeSelect',
    value: 'armed',
    disabled: false,
    dataset: { autoConsentAction: 'change-mode' }
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2][0], '/api/auto-consent/policy');
  assert.equal(calls[2][1].mode, 'armed');

  // E. After 2.5s elapses and ticker ticks -> cooldown releases & interval stops (0% idle CPU!)
  const prevRerenders = rerenderCount;
  clock += 2500;
  for (const fn of [...intervals.values()]) fn();
  assert.equal(intervals.size, 0, 'cooldown ticker MUST stop completely once cooldown expires');
  assert.ok(rerenderCount > prevRerenders);
  assert.doesNotMatch(ctrl2.renderTabHtml(), /id="acMasterEnable"[^>]*disabled/);
  assert.doesNotMatch(ctrl2.renderTabHtml(), /⏳/);

  // F. Now #acMasterEnable can be toggled again cleanly
  await richBody.triggerChange({
    id: 'acMasterEnable',
    checked: false,
    disabled: false,
    dataset: { autoConsentAction: 'toggle-switch', switchId: 'acMasterEnable' }
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[3][1].enabled, false);
  assert.equal(intervals.size, 1);

  // G. destroy() clears active cooldown timer cleanly (zero leaked timers!)
  ctrl2.destroy();
  assert.equal(intervals.size, 0, 'destroy() must clear active cooldown interval');
  assert.equal(richBody.hasListener('change'), false);
});

test('v3.8.1 #42 P2/P3 regression: DOM cooldown ticks patch only cooling control in-place without modal innerHTML wipes, and master-OFF copy reflects immediate switch apply', async () => {
  // P3: master-OFF banner copy must reflect immediate toggle switch apply (no stale Save Policy instruction)
  const enWarn = tDeck('en', 'autoConsent.masterOffConfiguredWarn', { n: 2 });
  const ruWarn = tDeck('ru', 'autoConsent.masterOffConfiguredWarn', { n: 2 });
  assert.doesNotMatch(enWarn, /Save Policy/i);
  assert.match(enWarn, /immediately/i);
  assert.doesNotMatch(ruWarn, /Сохранить политику/i);
  assert.match(ruWarn, /применяется сразу/i);

  // P2: DOM-capable guardrailsBodyRoot patches cooldown chip & disabled state in-place with ZERO onGuardrailsRerender calls during ticks
  function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
      add(c) { set.add(c); },
      remove(c) { set.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (set.has(c)) set.delete(c);
          else set.add(c);
        } else if (force) set.add(c);
        else set.delete(c);
      },
      contains(c) { return set.has(c); }
    };
  }

  let clock = NOW;
  const intervals = new Map();
  let nextIntervalId = 1;
  let rerenderCount = 0;

  let chipRemoved = false;
  const chipEl = {
    textContent: '⏳ 3s',
    remove() { chipRemoved = true; }
  };
  const switchLabel = {
    classList: makeClassList(['ac-switch', 'is-master', 'is-on', 'is-disabled', 'is-cooling'])
  };
  const masterInput = {
    id: 'acMasterEnable',
    checked: true,
    disabled: true,
    classList: makeClassList(['ac-switch-input']),
    dataset: { autoConsentAction: 'toggle-switch', switchId: 'acMasterEnable' },
    closest(sel) { return sel === '.ac-switch' ? switchLabel : null; }
  };
  const ctxInput = {
    id: 'acCtxThresholdInput',
    value: '88'
  };

  let changeFn = null;
  const domBody = {
    addEventListener(type, fn) { if (type === 'change') changeFn = fn; },
    removeEventListener(type) { if (type === 'change') changeFn = null; },
    querySelector(sel) {
      if (sel === '#acMasterEnable') return masterInput;
      if (sel === '.ac-cooldown-chip[data-cooldown-for="acMasterEnable"]') return chipRemoved ? null : chipEl;
      if (sel === '#acModeSelect') return { value: 'dry_run' };
      if (sel === '#acGraceWindowSelect') return { value: '3000' };
      if (sel === '#acPauseCtxCheck') return { checked: true };
      if (sel === '#acCtxThresholdInput') return ctxInput;
      if (sel === '#acAllowPkgCheck') return { checked: false };
      if (sel === '#acAllowNetCheck') return { checked: false };
      return null;
    }
  };

  const ctrl = createAutoConsentController({
    guardrailsBodyRoot: domBody,
    td: tdFor('en'),
    lang: () => 'en',
    isLive: () => false,
    demo: true,
    onGuardrailsRerender: () => { rerenderCount += 1; },
    now: () => clock,
    setIntervalFn: (fn) => { const id = nextIntervalId++; intervals.set(id, fn); return id; },
    clearIntervalFn: (id) => { intervals.delete(id); }
  });

  // Initial toggle applies immediately (one renderAll from applyDemoPolicyPatch), then starts 2.5s cooldown ticker
  await changeFn({ target: { closest: () => ({ ...masterInput, disabled: false }) } });
  assert.equal(intervals.size, 1);
  const rerendersAfterApply = rerenderCount;

  // Tick at +250ms, +1000ms, +1800ms -> updates chip text in-place with ZERO modal innerHTML rerenders!
  clock += 250;
  for (const fn of [...intervals.values()]) fn();
  assert.equal(rerenderCount, rerendersAfterApply, '250ms cooldown tick must NOT trigger full modal rerender');
  assert.equal(chipEl.textContent, '⏳ 3s');
  assert.equal(ctxInput.value, '88', 'sibling input must remain untouched');

  clock += 750; // +1000ms total -> 1500ms left -> 2s
  for (const fn of [...intervals.values()]) fn();
  assert.equal(rerenderCount, rerendersAfterApply, '1000ms cooldown tick must NOT trigger full modal rerender');
  assert.equal(chipEl.textContent, '⏳ 2s');

  clock += 800; // +1800ms total -> 700ms left -> 1s
  for (const fn of [...intervals.values()]) fn();
  assert.equal(rerenderCount, rerendersAfterApply, '1800ms cooldown tick must NOT trigger full modal rerender');
  assert.equal(chipEl.textContent, '⏳ 1s');

  // Expiry at +2500ms -> removes chip, re-enables switch, clears classes, stops interval, still ZERO modal rerenders!
  clock += 700;
  for (const fn of [...intervals.values()]) fn();
  assert.equal(rerenderCount, rerendersAfterApply, 'cooldown expiry must patch DOM in-place without full modal rerender');
  assert.equal(chipRemoved, true, 'expired cooldown chip must be removed in-place');
  assert.equal(masterInput.disabled, false, 'switch must be re-enabled in-place on cooldown expiry');
  assert.equal(switchLabel.classList.contains('is-cooling'), false);
  assert.equal(switchLabel.classList.contains('is-disabled'), false);
  assert.equal(intervals.size, 0, 'cooldown interval must stop completely on expiry');

  ctrl.destroy();
});

test('v3.9.0 UX: +60m Session renders muted when global Auto-Consent is OFF, #autoConsentInspectorRoot sits below #nodeInspector, and #btnAutoConsentTop stays outside collapsed tools menu', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'openrig/index.html'), 'utf8');

  // 1. #autoConsentInspectorRoot is placed BELOW #nodeInspector so identity & P0 HITL appear first
  const nodeIdx = indexHtml.indexOf('<div id="nodeInspector"></div>');
  const acIdx = indexHtml.indexOf('<div id="autoConsentInspectorRoot"></div>');
  assert.ok(nodeIdx > 0 && acIdx > nodeIdx, '#autoConsentInspectorRoot must sit below #nodeInspector');

  // 2. initCompactTriageTools preserves #btnAutoConsentTop directly in top bar
  assert.match(indexHtml, /keepDirect\s*=\s*new Set\([^)]*'btnAutoConsentTop'/);

  // 3. +60m Session button uses muted secondary class when global Auto-Consent is OFF, and drops muted class when ON
  const seat = { id: 'dev-check@core-platform' };
  const offState = { config: { ...DEFAULT_AUTO_CONSENT_CONFIG, enabled: false }, sessionGrants: [] };
  const onState = { config: { ...DEFAULT_AUTO_CONSENT_CONFIG, enabled: true, mode: 'armed' }, sessionGrants: [] };
  for (const lang of ['en', 'ru']) {
    const td = tdFor(lang);
    const offHtml = renderSeatAutoConsentPickerHtml({ seat, state: offState, td, lang, nowMs: NOW });
    assert.match(offHtml, /class="action-pill ac-insp-btn ac-insp-btn-muted"[^>]*data-auto-consent-action="grant-session"/);

    const onHtml = renderSeatAutoConsentPickerHtml({ seat, state: onState, td, lang, nowMs: NOW });
    assert.match(onHtml, /class="action-pill ac-insp-btn"[^>]*data-auto-consent-action="grant-session"/);
    assert.doesNotMatch(onHtml, /ac-insp-btn-muted/);
  }
});

test('v3.10 UX: Auto-Consent modal polish — seatsTitle key, Allowed vs Hard-Vetoed 3-col strip, footer separation, PAUSE hidden when OFF / emergency when ARMED, scrollable agents list', () => {
  for (const lang of ['en', 'ru']) {
    const seenKeys = new Set();
    const td = (key, vars) => {
      seenKeys.add(key);
      return tDeck(lang, key, vars);
    };

    const offState = {
      config: sanitizeAutoConsentConfig({ enabled: false, mode: 'dry_run', masterPaused: false }, DEFAULT_AUTO_CONSENT_CONFIG),
      sessionGrants: [],
      pendingApprovals: [],
      recentRuns: []
    };
    const dryOnState = {
      config: sanitizeAutoConsentConfig({ enabled: true, mode: 'dry_run', masterPaused: false }, DEFAULT_AUTO_CONSENT_CONFIG),
      sessionGrants: [],
      pendingApprovals: [],
      recentRuns: []
    };
    const armedState = makeActiveState(NOW);
    const pausedState = { ...armedState, config: { ...armedState.config, masterPaused: true } };

    const agents = [
      { id: 'dev-check@core-platform', shortName: 'dev-check' },
      { id: 'dev-coder4@core-platform', shortName: 'dev-coder4' }
    ];

    // 1. Master OFF: PAUSE is hidden, Save Policy is in .ac-modal-footer, seatsTitle key used, 3-col veto strip present, scroll class on agents list
    const offHtml = renderAutoConsentTabHtml({ state: offState, rigs: ['core-platform'], agents, td, deckLang: lang, nowMs: NOW });
    assert.ok(seenKeys.has('autoConsent.seatsTitle'), 'Must resolve autoConsent.seatsTitle via td()');
    for (const k of [
      'autoConsent.cmdStripLabel',
      'autoConsent.cmdStripSafeTitle',
      'autoConsent.cmdStripSafeBody',
      'autoConsent.cmdStripDevTitle',
      'autoConsent.cmdStripDevBody',
      'autoConsent.cmdStripVetoTitle',
      'autoConsent.cmdStripVetoBody'
    ]) {
      assert.ok(seenKeys.has(k), `Missing i18n key ${k}`);
      assert.ok(offHtml.includes(escapeHtml(tDeck(lang, k))), `Missing rendered text for ${k}`);
    }
    assert.match(offHtml, /class="ac-cmd-summary"/);
    assert.match(offHtml, /class="ac-cmd-col is-safe"/);
    assert.match(offHtml, /class="ac-cmd-col is-dev"/);
    assert.match(offHtml, /class="ac-cmd-col is-veto"/);
    assert.match(offHtml, /class="ac-policy-list ac-policy-list-scroll"/);
    assert.match(offHtml, /class="ac-count-label"/);
    assert.doesNotMatch(offHtml, /data-auto-consent-action="grant-session"/, 'v3.11.0: per-row +60m Session buttons hidden when global Auto-Consent is OFF');
    assert.match(offHtml, /class="ac-effective-bar"/, 'v3.14.1: explicit Effective-vs-Draft bar must render when master is OFF');
    assert.match(offHtml, /class="ac-empty-log-disclosure"/, 'v3.14.1: empty sessions & decisions log must collapse into 1 compact disclosure');
    assert.match(offHtml, /data-auto-consent-action="close-modal"/, 'v3.14.1: footer must include explicit Cancel button');
    assert.ok(offHtml.includes(escapeHtml(tDeck(lang, 'autoConsent.saveDraftBtn'))), 'v3.14.1: Save button must clearly state Save Draft when master is OFF');
    assert.match(offHtml, /<footer class="ac-modal-footer">[\s\S]*class="ac-footer-emergency"><\/div>[\s\S]*class="ac-footer-actions">[\s\S]*data-auto-consent-action="close-modal"[\s\S]*data-auto-consent-action="save-policy"/);
    assert.doesNotMatch(offHtml, /data-auto-consent-action="pause-all"/, 'PAUSE must be hidden when global Auto-Consent is OFF');
    assert.doesNotMatch(offHtml, /class="ac-btn-row"/, 'Old inline button row must be replaced by modal footer');
    assert.match(offHtml, /id="acModeSelect" class="rig-select ac-mode-select is-dry"/);
    assert.doesNotMatch(offHtml, /on(?:click|change|error)=/i);

    // 2. Enabled + Dry-Run: PAUSE appears without emergency class and per-row +60m Session buttons appear
    const dryHtml = renderAutoConsentTabHtml({ state: dryOnState, rigs: ['core-platform'], agents, td, deckLang: lang, nowMs: NOW });
    assert.match(dryHtml, /data-auto-consent-action="grant-session"/, 'per-row +60m Session buttons appear when Auto-Consent is enabled');
    assert.match(dryHtml, /class="action-pill key-cancel ac-pause-btn is-dry-pause" data-auto-consent-action="pause-all"/);
    assert.doesNotMatch(dryHtml, /ac-pause-btn is-emergency/);

    // 3. Enabled + Armed: PAUSE renders with high-contrast emergency class in footer emergency zone, separated from Save Policy
    const armedHtml = renderAutoConsentTabHtml({ state: armedState, rigs: ['core-platform'], agents, td, deckLang: lang, nowMs: NOW });
    assert.match(armedHtml, /<footer class="ac-modal-footer">[\s\S]*class="ac-footer-emergency">[\s\S]*class="action-pill key-cancel ac-pause-btn is-emergency" data-auto-consent-action="pause-all"[\s\S]*class="ac-footer-actions">[\s\S]*data-auto-consent-action="save-policy"/);
    assert.doesNotMatch(armedHtml, /data-auto-consent-action="pause-all"[^>]*disabled/);

    // 4. Master Paused: RESUME renders in footer emergency zone
    const pausedHtml = renderAutoConsentTabHtml({ state: pausedState, rigs: ['core-platform'], agents, td, deckLang: lang, nowMs: NOW });
    assert.match(pausedHtml, /<footer class="ac-modal-footer">[\s\S]*class="ac-footer-emergency">[\s\S]*class="action-pill key-proceed ac-resume-btn" data-auto-consent-action="resume-all"/);
  }
});
