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
  buildDemoAutoConsentInitialState,
  createAutoConsentController,
  escapeHtml,
  getAutoConsentModalBadge,
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
    assert.equal(badge.text, 'ARMED • 12/30/h');
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
