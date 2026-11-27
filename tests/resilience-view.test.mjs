import test from 'node:test';
import assert from 'node:assert/strict';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import { buildDemoResilienceScenario } from '../openrig/assets/domain/resilience-model.js';
import { renderCrashCartBannerHtml, renderResilienceModalHtml, createResilienceController } from '../openrig/assets/ui/resilience-view.js';

const deps = lang => ({ lang, td: (key, vars) => tDeck(lang, key, vars) });
function status() {
  const data = buildDemoResilienceScenario('blackout');
  data.providers[0].report = data.report;
  data.providers[0].commandPreview = 'rig start --last --json';
  data.report.rigReports[0].commandPreview = 'rig start --rigs demo-fleet --json';
  return data;
}
const target = { providerId: 'openrig', scope: 'rig', target: 'demo-fleet' };
const planResponse = (now = Date.now()) => ({ plan: { ...buildDemoResilienceScenario('preview').plan, ...target,
  commandPreview: 'rig start --rigs demo-fleet --json' }, planHash: 'server-reviewed-hash', expiresAt: new Date(now + 60_000).toISOString() });
function surface() {
  const listeners = new Map();
  return { innerHTML: '', hidden: true, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key),
    async click(action, extra = {}) { const el = { disabled: false, dataset: { resilienceAction: action, providerId: target.providerId, scope: target.scope, target: target.target, ...extra } };
      return listeners.get('click')?.({ target: { closest: () => el } }); } };
}
function setup(options = {}) {
  const root = surface(), modalRoot = surface(), calls = [];
  const ui = createResilienceController({ root, modalRoot, td: deps('en').td, lang: () => 'en', isLive: () => true,
    getJson: async endpoint => { calls.push([endpoint]); return status(); },
    postJson: async (endpoint, body) => { calls.push([endpoint, body]); return endpoint.endsWith('/plan') ? planResponse() : { receipt: { status: 'partial' } }; }, ...options });
  ui.setStatus(status());
  return { root, modalRoot, ui, calls };
}

for (const lang of ['en', 'ru']) test(`${lang} healthy absence, capabilities, attributed rigs and truthful vault badges`, () => {
  const d = deps(lang), data = status();
  assert.equal(renderCrashCartBannerHtml(buildDemoResilienceScenario('recovered'), d), '');
  const html = renderCrashCartBannerHtml(data, d);
  assert.ok(html.includes(tDeck(lang, 'resilience.vaultLocal')));
  assert.ok(html.includes(tDeck(lang, 'resilience.snapFresh')));
  assert.match(html, /data-resilience-action="plan"/);
  const provider = data.providers[0]; provider.capabilities.checkpoints = false; provider.capabilities.fleetRecover = false; provider.capabilities.unitRecover = false;
  const unsupported = renderCrashCartBannerHtml(data, d);
  assert.doesNotMatch(unsupported, /data-resilience-action="snapshot"|data-resilience-action="plan"/);
  assert.match(unsupported, /data-resilience-action="copy"/);
  data.vault.encrypted = true;
  assert.ok(renderCrashCartBannerHtml(data, d).includes(tDeck(lang, 'resilience.vaultEncrypted')));
  data.providers.push({ id: 'other', capabilities: { unitRecover: true, planPreview: true }, report: { tier: 'rig_down', offlineRigs: ['other-rig'], rigReports: [{ rigId: 'other-rig', recoverable: true }] } });
  assert.match(renderCrashCartBannerHtml(data, d), /data-provider-id="other" data-scope="rig" data-target="other-rig"/);
});

for (const lang of ['en', 'ru']) test(`${lang} plan, confirmation/expiry, honest receipts and explicit demo copy`, () => {
  const d = deps(lang), response = planResponse();
  const html = renderResilienceModalHtml({ phase: 'preview', planResponse: response }, d);
  assert.match(html, /data-plan-hash="server-reviewed-hash"/);
  assert.ok(html.includes(tDeck(lang, 'resilience.confirmBtn')));
  assert.doesNotMatch(html, /onclick=|onerror=/);
  const expired = renderResilienceModalHtml({ phase: 'preview', planResponse: { ...response, expiresAt: '2000-01-01T00:00:00Z' } }, d);
  assert.match(expired, /data-resilience-action="confirm"[^>]*disabled/);
  for (const state of ['partial', 'failed', 'unknown']) {
    assert.ok(renderResilienceModalHtml({ phase: 'receipt', receipt: { status: state } }, d).includes(tDeck(lang, `resilience.${{ partial: 'statusPartial', failed: 'statusFailed', unknown: 'statusUnknown' }[state]}`)));
  }
  const simulation = renderResilienceModalHtml({ phase: 'preview', planResponse: { ...response, planHash: null } }, { ...d, demo: true });
  assert.ok(simulation.includes(tDeck(lang, 'resilience.demoNotice')));
  assert.match(simulation, /data-plan-hash="" data-simulated="true"/);
  assert.ok(renderResilienceModalHtml({ phase: 'receipt', snapshotSaved: true }, d).includes(tDeck(lang, 'resilience.snapshotSaved')));
});

test('untrusted names, command, error, attributes and receipts remain text', () => {
  const attack = `<img src=x onerror="globalThis.pwned=1">'&`, data = status();
  data.providers[0].id = attack; data.report.rigReports[0].rigId = attack; data.providers[0].commandPreview = attack;
  const html = renderCrashCartBannerHtml(data, deps('en')) + renderResilienceModalHtml({ phase: 'preview', error: attack, receipt: { status: 'unknown', seats: [{ target: attack }] }, planResponse: { ...planResponse(), planHash: attack, plan: { providerId: attack, commandPreview: attack, targetRigs: [attack], skippedRigs: [attack], warnings: [attack] } } }, deps('en'));
  assert.doesNotMatch(html, /<img|onclick=|data-command="<|data-plan-hash="</);
  assert.match(html, /&lt;img/);
});

test('review is read-only; separate confirmation uses exact hash/target and locks duplicate actions', async () => {
  let release;
  const { ui, root, modalRoot, calls } = setup({ postJson: async (endpoint, body) => {
    calls.push([endpoint, body]);
    if (endpoint.endsWith('/plan')) return planResponse();
    return new Promise(resolve => { release = () => resolve({ receipt: { status: 'partial' } }); });
  } });
  await root.click('plan'); assert.equal(calls.length, 1); assert.equal(ui.getState().phase, 'preview');
  const first = modalRoot.click('confirm', { planHash: 'server-reviewed-hash' });
  await modalRoot.click('confirm', { planHash: 'server-reviewed-hash' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['/api/resilience/resurrect', { ...target, confirmed: true, planHash: 'server-reviewed-hash' }]);
  assert.match(modalRoot.innerHTML, /data-resilience-action="confirm"[^>]*disabled/);
  release(); await first;
  assert.equal(ui.getState().receipt.status, 'partial');
});

test('canceled/stale/expired plans cannot execute; late preview never reopens canceled modal', async () => {
  let release;
  const { ui, root, modalRoot, calls } = setup({ postJson: async (endpoint, body) => { calls.push([endpoint, body]); return new Promise(resolve => { release = () => resolve(planResponse()); }); } });
  const first = root.click('plan'); ui.cancel(); release(); await first;
  assert.equal(ui.getState().phase, 'closed');
  await modalRoot.click('confirm', { planHash: 'server-reviewed-hash' }); assert.equal(calls.length, 1);
  const second = setup(); await second.root.click('plan');
  second.ui.setStatus({ ...status(), providers: [] });
  await second.modalRoot.click('confirm', { planHash: 'server-reviewed-hash' });
  assert.equal(second.calls.length, 1);
  let now = Date.now(); const expired = setup({ now: () => now }); await expired.root.click('plan'); now += 120_000;
  await expired.modalRoot.click('confirm', { planHash: 'server-reviewed-hash' }); assert.equal(expired.calls.length, 1);
});

test('HTTP success without receipt is unknown and failed receipts remain failed', async () => {
  for (const receipt of [undefined, { status: 'failed' }]) {
    const x = setup({ postJson: async endpoint => endpoint.endsWith('/plan') ? planResponse() : { ok: true, receipt } });
    await x.root.click('plan'); await x.modalRoot.click('confirm', { planHash: 'server-reviewed-hash' });
    assert.equal(x.ui.getState().receipt.status, receipt?.status || 'unknown');
  }
});

test('snapshot saved requires explicit matching checkpoint; no restore inferred, clipboard fallback is selectable text', async () => {
  for (const result of [{ checkpoint: { ...target, created: true } }, { checkpoint: { providerId: 'openrig', target: 'demo-fleet', created: true } }, { ok: true }]) {
    const x = setup({ postJson: async () => result }); await x.root.click('snapshot');
    assert.equal(x.ui.getState().snapshotSaved, Boolean(result.checkpoint?.created));
    assert.doesNotMatch(x.modalRoot.innerHTML, /class="resilience-result restored"/);
  }
  const x = setup(); await x.root.click('copy', { command: 'rig start --last --json' });
  assert.match(x.modalRoot.innerHTML, /textarea[^>]*readonly/);
});

test('offline controller walks explicit simulation with no GET/POST, and does not fabricate a live hash', async () => {
  const x = setup({ demo: true, isLive: () => false, getJson: () => assert.fail('offline GET'), postJson: () => assert.fail('offline POST') });
  await x.ui.refresh(); await x.root.click('plan');
  assert.equal(x.ui.getState().planResponse.planHash, null);
  await x.modalRoot.click('confirm');
  assert.equal(x.ui.getState().receipt.status, 'restored');
  assert.equal(x.root.innerHTML, '');
  const idle = setup({ demo: false, isLive: () => false, getJson: () => assert.fail('non-live GET'), postJson: () => assert.fail('non-live POST') });
  await idle.ui.refresh(); await idle.root.click('plan'); assert.equal(idle.ui.getState().phase, 'closed');
});

test('rig_down banner formats multi-day snapshot age cleanly and supports collapse toggle without hiding daemon_down', async () => {
  const rigDown = status();
  rigDown.report.tier = 'rig_down';
  rigDown.providers[0].report.tier = 'rig_down';
  rigDown.report.rigReports[0].snapshot.ageMs = 4 * 24 * 3600 * 1000;
  rigDown.report.rigReports[0].snapshot.freshness = 'stale';
  const expanded = renderCrashCartBannerHtml(rigDown, deps('en'));
  assert.match(expanded, /4 days ago/);
  assert.match(expanded, /data-resilience-action="toggle-collapse"/);
  const folded = renderCrashCartBannerHtml(rigDown, { ...deps('en'), collapsed: true });
  assert.match(folded, /is-collapsed/);
  assert.doesNotMatch(folded, /resilience-provider/);
  // daemon_down stays expanded even when collapsed=true
  const daemonDown = status();
  const ddHtml = renderCrashCartBannerHtml(daemonDown, { ...deps('en'), collapsed: true });
  assert.doesNotMatch(ddHtml, /is-collapsed/);
  assert.match(ddHtml, /resilience-provider/);
});

test('Control-Plane Queue Hygiene banner stays hidden when healthy, renders on zombie backlog, and executes 2-step plan/confirm', async () => {
  const healthyCp = {
    latency: { avgMs: 42, p95Ms: 80, consecutiveSlowCount: 0 },
    files: { daemonLog: { bytes: 1024 }, sqliteDb: { bytes: 4096 } },
    queue: { opgateOlderThan24h: 0, detachedTargetCount: 0, staleRuntimeHookCount: 0, byRig: {} },
    daemonLogTail: { permanentRoutingErrorCount: 0, noHumanRegisteredCount: 0, stuckSweepCrashLoopLines: 0, consecutiveFailures: 0 }
  };
  assert.equal(renderCrashCartBannerHtml(buildDemoResilienceScenario('recovered'), { ...deps('en'), controlPlane: healthyCp }), '');

  const zombieCp = {
    ...healthyCp,
    files: { daemonLog: { bytes: 60 * 1024 * 1024 }, sqliteDb: { bytes: 20 * 1024 * 1024 } },
    queue: { opgateOlderThan24h: 25, detachedTargetCount: 1, staleRuntimeHookCount: 0, byRig: {} }
  };
  const bannerHtml = renderCrashCartBannerHtml(buildDemoResilienceScenario('recovered'), { ...deps('en'), controlPlane: zombieCp });
  assert.match(bannerHtml, /data-resilience-action="hygiene-plan"/);
  assert.ok(bannerHtml.includes(tDeck('en', 'hygiene.planBtn')));
  assert.match(bannerHtml, /25/);
  assert.match(bannerHtml, /60\.0/);

  const calls = [];
  const root = surface(), modalRoot = surface();
  let returnMissingReceipt = false;
  const ui = createResilienceController({
    root, modalRoot, td: deps('en').td, lang: () => 'en', isLive: () => true,
    getJson: async () => buildDemoResilienceScenario('recovered'),
    postJson: async (endpoint, body) => {
      calls.push([endpoint, body]);
      if (endpoint.endsWith('/hygiene/plan')) {
        return {
          plan: { scope: 'fleet', cutoffHours: 24, daemonLogBytes: 60 * 1024 * 1024, sqliteBytes: 20 * 1024 * 1024, totals: { staleOpgateCount: 25 }, warnings: ['rotate ok'], commandPreview: 'rig queue update qitem-1 --state done --closure-reason canceled --json' },
          planHash: 'h-hash-123',
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      }
      return returnMissingReceipt ? { ok: true } : { receipt: { status: 'cleaned', targetCount: 25, cleanedCount: 25 } };
    }
  });
  ui.setStatus(buildDemoResilienceScenario('recovered'));
  ui.setControlPlane(zombieCp);
  assert.match(root.innerHTML, /data-resilience-action="hygiene-plan"/);

  await root.click('hygiene-plan', { scope: 'fleet', cutoffHours: '24' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/resilience/hygiene/plan');
  assert.equal(ui.getState().phase, 'preview');
  assert.equal(ui.getState().operation, 'hygiene');
  assert.match(modalRoot.innerHTML, /data-resilience-action="hygiene-confirm"[^>]*data-plan-hash="h-hash-123"/);

  await modalRoot.click('hygiene-confirm', { planHash: 'h-hash-123' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], '/api/resilience/hygiene/execute');
  assert.equal(calls[1][1].confirmed, true);
  assert.equal(calls[1][1].planHash, 'h-hash-123');
  assert.equal(ui.getState().hygieneReceipt.status, 'cleaned');

  returnMissingReceipt = true;
  await root.click('hygiene-plan', { scope: 'fleet', cutoffHours: '24' });
  await modalRoot.click('hygiene-confirm', { planHash: 'h-hash-123' });
  assert.equal(ui.getState().hygieneReceipt.status, 'unknown');
});
