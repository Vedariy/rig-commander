import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import { PLAYBOOK_RULE_IDS, PLAYBOOK_RULES_META } from '../openrig/assets/domain/playbooks-model.js';
import { EVAL_HARDWARE_PROFILES, EVAL_SLOT_PRESETS } from '../openrig/assets/domain/evaluator-model.js';
import {
  renderGuardrailsModal, renderGuardrailsSettingsHtml,
  renderPlaybooksSettingsHtml, renderAiEvaluatorSettingsHtml,
  readPlaybooksFormPayload, readEvaluatorFormPayload
} from '../openrig/assets/ui/guardrails-view.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
const deps = (deckLang = 'en') => ({ deckLang, td: key => tDeck(deckLang, key), escapeHtml, shortSeat: s => s });
const formDoc = fields => ({ getElementById: id => fields[id] ?? null });
const includes = (html, text) => assert.ok(html.includes(text), `Missing ${text}`);

// Circuit Breaker and Telegram Preview are two sections of the existing main tab.
for (const lang of ['en', 'ru']) {
  test(`Circuit Breaker and Telegram HITL Preview render with existing hooks (${lang})`, () => {
    const d = deps(lang);
    const view = renderGuardrailsModal({ ...d, activeGuardrailsTab: 'guardrails',
      guardrails: { breaker: { status: 'tripped', config: { mode: 'auto_stop' }, recentTrips: [
        { title: 'Budget trip', detail: 'Seat paused', actionTaken: 'interrupted_cc' }
      ] }, telegram: { configured: true, chatId: 'demo-chat' } },
      agents: [{ id: 'qa@example', shortName: 'QA', state: 'urgent' }],
      parseInteractivePromptOptions: () => [
        { badge: '1', shortLabel: 'Approve', keyStroke: '1', isPrimary: true },
        { badge: '2', shortLabel: 'Cancel', keyStroke: 'Escape', isCancel: true }
      ]
    });
    for (const key of ['guard.breakerTitle', 'guard.tgTitle', 'guard.tgPreviewTitle']) {
      includes(view.html, d.td(key));
      assert.notEqual(d.td(key), key);
    }
    for (const hook of ['saveGuardrailsConfig()', 'simulateDemoBreakerTrip()', 'resetGuardrailsBreaker()',
      "handleTelegramAction('connect')", "handleTelegramAction('test')", "handleTelegramAction('disconnect')",
      'triggerTelegramPreviewAction(', 'answer_prompt_option', 'cancel_prompt']) includes(view.html, hook);
    includes(view.html, 'Budget trip');
    includes(view.html, 'id="tgPreviewInlineBtns"');
    includes(view.html, 'white-space:nowrap; flex-shrink:0;');
    assert.deepEqual(view.badge, { text: 'TRIPPED • AUTO-STOP', borderColor: '#ff0055', color: '#fda4af' });
  });

  test(`Playbooks rules, dry-run rows and Hard Safety Veto badges render (${lang})`, () => {
    const d = deps(lang);
    const playbooks = { status: 'armed', actionsLastHour: 2, config: { maxActionsPerHour: 6 },
      lastDryRun: {
        eligible: [{ ruleId: 'auto_compact_idle_hot', seatId: 'coder@example', reason: 'Idle context', kind: 'write' }],
        vetoed: [{ ruleId: 'auto_wake_parked', seatId: 'qa@example', detail: 'Active HITL', vetoCode: 'ACTIVE_HITL' }]
      }, recentRuns: [{ status: 'dry_run', ruleId: 'auto_compact_idle_hot', seatId: 'coder@example', reason: 'Preview only' }] };
    const view = renderGuardrailsModal({ ...d, activeGuardrailsTab: 'playbooks', playbooks, desktopNotificationsOn: true });
    for (const key of ['pb.subtitle', 'pb.eligibleTitle', 'pb.vetoedTitle', 'pb.desktopNotifOn']) includes(view.html, escapeHtml(d.td(key)));
    for (const id of PLAYBOOK_RULE_IDS) {
      includes(view.html, `id="pbRule_${id}"`);
      includes(view.html, escapeHtml(PLAYBOOK_RULES_META[id][lang === 'en' ? 'titleEn' : 'titleRu']));
    }
    for (const text of ['Hard Veto', 'ACTIVE_HITL', 'pb-veto-chip', 'Idle context', 'Active HITL', 'Preview only',
      'savePlaybooksConfig()', 'runPlaybooksDryRun()', "resetPlaybooksState('pause')", "resetPlaybooksState('reset_cooldowns')",
      'toggleDesktopNotifications()', 'sendTestDesktopNotification()']) includes(view.html, text);
    assert.equal(view.badge.text, 'ARMED • 2/6/h');
    assert.equal(renderGuardrailsModal({ ...d, activeGuardrailsTab: 'playbooks', playbooks: { ...playbooks, status: 'capped' } }).badge.text, 'RATE-CAPPED • 2/6/h');
  });

  test(`AI Evaluator slots, presets, hardware profiles and hooks render (${lang})`, () => {
    const d = deps(lang);
    const view = renderGuardrailsModal({ ...d, activeGuardrailsTab: 'evaluator', evaluator: {
      config: { privacyMode: 'configured_endpoints' }, discoveredModels: { system1: [{ id: 'demo-s1' }], system2: [{ id: 'demo-s2' }] }
    } });
    for (const key of ['eval.slot1Title', 'eval.slot2Title', 'eval.profileLabel', 'eval.advisoryNote']) includes(view.html, escapeHtml(d.td(key)));
    for (const p of EVAL_HARDWARE_PROFILES) includes(view.html, escapeHtml(p[lang === 'en' ? 'labelEn' : 'labelRu']));
    for (const role of ['system1', 'system2']) {
      for (const p of Object.values(EVAL_SLOT_PRESETS[role])) includes(view.html, escapeHtml(p.label));
    }
    for (const text of ['id="evalS1Model"', 'id="evalS2Model"', 'demo-s1', 'demo-s2', 'applyEvalHardwareProfile(',
      "applyEvalSlotPreset('system1', this.value)", "applyEvalSlotPreset('system2', this.value)",
      "loadEvalSlotModels('system1')", "loadEvalSlotModels('system2')", 'saveEvaluatorConfig()']) includes(view.html, text);
    assert.deepEqual(view.badge, { text: 'REDACTED HTTPS', borderColor: '#a855f7', color: '#e9d5ff' });
  });
}

for (const lang of ['en', 'ru']) {
  test(`Untrusted seat/rule labels, notes and form attributes are escaped (${lang})`, () => {
    const bad = `x'\"><img src=x onerror=alert(1)>&`;
    const d = deps(lang);
    const main = renderGuardrailsSettingsHtml({ ...d,
      agents: [{ id: bad, shortName: bad, state: 'urgent' }], tgPreviewReplyMsg: bad,
      guardrails: { breaker: { recentTrips: [{ title: bad, detail: bad, actionTaken: bad }] }, telegram: { chatId: bad, maskedToken: bad } },
      parseInteractivePromptOptions: () => [
        { badge: bad, shortLabel: bad, keyStroke: bad, isPrimary: true },
        { badge: '2', shortLabel: 'Cancel', keyStroke: 'Escape', isCancel: true }
      ]
    });
    const pb = renderPlaybooksSettingsHtml({ ...d, playbooksStatusMessage: bad,
      metaMap: { ...PLAYBOOK_RULES_META, auto_compact_idle_hot: { ...PLAYBOOK_RULES_META.auto_compact_idle_hot, titleEn: bad, titleRu: bad, descEn: bad, descRu: bad } },
      playbooks: { lastDryRun: { eligible: [{ ruleId: bad, seatId: bad, reason: bad, kind: bad }],
        vetoed: [{ ruleId: bad, seatId: bad, detail: bad, vetoCode: bad }] },
        recentRuns: [{ status: 'vetoed', ruleId: bad, seatId: bad, reason: bad, detail: bad }] }
    });
    const ev = renderAiEvaluatorSettingsHtml({ ...d, evaluator: { statusMessage: bad,
      config: { system1: { model: bad, baseUrl: bad, hasApiKey: true, maskedApiKey: bad } },
      discoveredModels: { system1: [{ id: bad }] }
    }, profiles: [{ id: bad, labelEn: bad, labelRu: bad }] });
    for (const html of [main, pb, ev]) {
      includes(html, escapeHtml(bad));
      assert.ok(!html.includes('<img'));
      assert.ok(!html.includes(bad));
      for (const [, handler] of html.matchAll(/on(?:click|change)="([^"]*)"/g)) assert.ok(!handler.includes('alert(1)'));
    }
  });
}

test('Dynamic inline handlers pass quoted data as values, never as JavaScript', () => {
  const bad = `model'); throw new Error('injected`;
  const html = renderAiEvaluatorSettingsHtml({ ...deps(), evaluator: { discoveredModels: { system1: [{ id: bad }] } } });
  const handler = html.match(/data-model="[^"]*" onclick="([^"]*)"/)[1];
  const modelInput = { value: '' };
  vm.runInNewContext(`(function () { ${handler} }).call(button)`, {
    document: { getElementById: () => modelInput }, button: { getAttribute: () => bad }
  });
  assert.equal(modelInput.value, bad);
});

test('Missing and empty config payloads keep usable defaults without changing input state', () => {
  for (const activeGuardrailsTab of ['guardrails', 'playbooks', 'evaluator']) {
    for (const state of [{}, { guardrails: {}, playbooks: { config: {} }, evaluator: { config: {} } },
      { guardrails: { breaker: { config: null } }, playbooks: { config: null }, evaluator: { config: null } }]) {
      const before = structuredClone(state);
      const view = renderGuardrailsModal({ ...deps(), activeGuardrailsTab, ...state });
      assert.ok(view.html.length > 1000);
      assert.ok(!/undefined|NaN|\[object Object\]/.test(view.html));
      assert.deepEqual(state, before);
      includes(view.html, activeGuardrailsTab === 'guardrails' ? 'id="guardMaxSession"' : activeGuardrailsTab === 'playbooks' ? 'id="pbMasterEnable"' : 'id="evalS1Model"');
    }
  }
});

test('Injected form readers preserve populated values and absent-control fallbacks', () => {
  const pb = readPlaybooksFormPayload(formDoc({
    pbMasterEnable: { checked: true }, pbModeSelect: { value: 'armed' }, pbMaxActionsPerHour: { value: '9' },
    pbParam_auto_compact_idle_hot: { value: '83' }, pbCooldown_auto_compact_idle_hot: { value: 'bad' },
    pbRule_auto_compact_idle_hot: { checked: true }, pbNotifyTgCheck: { checked: true }
  }));
  assert.equal(pb.enabled, true);
  assert.equal(pb.mode, 'armed');
  assert.equal(pb.maxActionsPerHour, 9);
  assert.deepEqual(pb.rules.auto_compact_idle_hot, { enabled: true, thresholdPct: 83, cooldownMin: 15 });
  assert.equal(pb.rules.auto_notify_critical_sa.notifyTelegram, true);
  assert.equal(readPlaybooksFormPayload(formDoc({})).maxActionsPerHour, 6);
  const ev = readEvaluatorFormPayload(formDoc({
    evalPrivacySelect: { value: 'configured_endpoints' }, evalMaxCallsInput: { value: '75' }, evalMaxUsdInput: { value: '3.5' },
    evalAutoS1Check: { checked: true }, evalS1Dialect: { value: 'disabled' }, evalS2Dialect: { value: 'ollama_native' },
    evalS2Model: { value: ' model-name ' }, evalS2ApiKey: { value: ' dummy-key ' }, evalS2Thinking: { value: 'high' }
  }));
  assert.equal(ev.maxCallsPerHour, 75);
  assert.equal(ev.maxDailyUsd, 3.5);
  assert.equal(ev.autoSystem1Hitl, true);
  assert.equal(ev.system1.enabled, false);
  assert.equal(ev.system2.model, 'model-name');
  assert.equal(ev.system2.apiKey, 'dummy-key');
  assert.equal(ev.system2.thinkingLevel, 'high');
  const missing = readEvaluatorFormPayload(formDoc({}));
  assert.equal(missing.privacyMode, 'local_only');
  assert.equal(missing.maxCallsPerHour, 60);
  assert.equal(missing.system2.thinkingLevel, 'medium');
});
