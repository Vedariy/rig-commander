import { ActionFlightGuard } from '../domain/action-guard.js';
import { evaluateControlPlaneHealth } from '../domain/control-plane-model.js';
import { buildDemoResilienceScenario, normalizeRestoreReceipt, validateResilienceTarget } from '../domain/resilience-model.js';

const array = value => Array.isArray(value) ? value : [];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const receiptKey = status => ({ restored: 'statusRestored', partial: 'statusPartial', failed: 'statusFailed' }[status] || 'statusUnknown');
const hygieneReceiptKey = status => ({ cleaned: 'statusCleaned', partial: 'statusPartial', failed: 'statusFailed' }[status] || 'statusUnknown');
const normalizeHygieneReceipt = raw => {
  if (!raw || typeof raw !== 'object') return { status: 'unknown', targetCount: 0, cleanedCount: 0, failedCount: 0, unknownCount: 0, logRotation: null };
  const status = ['cleaned', 'partial', 'failed', 'unknown'].includes(raw.status) ? raw.status : 'unknown';
  return {
    status,
    targetCount: Number.isFinite(raw.targetCount) ? raw.targetCount : 0,
    cleanedCount: Number.isFinite(raw.cleanedCount) ? raw.cleanedCount : 0,
    failedCount: Number.isFinite(raw.failedCount) ? raw.failedCount : 0,
    unknownCount: Number.isFinite(raw.unknownCount) ? raw.unknownCount : 0,
    logRotation: raw.logRotation || null
  };
};
const providerReport = (status, provider) => provider.report || (array(status.providers).length === 1 ? status.report : {});
const button = (action, label, attributes = '', disabled = false) => `<button type="button" class="cyber-btn" data-resilience-action="${action}" ${attributes}${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
const targetAttrs = request => `data-provider-id="${esc(request.providerId)}" data-scope="${esc(request.scope)}" data-target="${esc(request.target || '')}"`;
const sameTarget = (a, b) => a && b && a.providerId === b.providerId && a.scope === b.scope && (a.target || null) === (b.target || null);
function formatRelativeSnapshotAge(ageMs, lang) {
  if (!Number.isFinite(ageMs)) return '';
  const minutes = Math.max(0, Math.round(ageMs / 60000));
  const rtf = new Intl.RelativeTimeFormat(lang === 'ru' ? 'ru' : 'en', { style: 'short', numeric: 'always' });
  if (minutes >= 1440) return rtf.format(-Math.round(minutes / 1440), 'day');
  if (minutes >= 60) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-minutes, 'minute');
}

export function renderCrashCartBannerHtml(status, { td, lang = 'en', demo = false, busy = false, collapsed = false, controlPlane = null } = {}) {
  const hasOutage = Boolean(status && (status.report?.tier === 'daemon_down' || array(status.report?.offlineRigs).length ||
    array(status.providers).some(p => p.report?.tier === 'daemon_down' || array(p.report?.offlineRigs).length)));
  const effectiveCp = controlPlane || status?.controlPlane || null;
  const cpHealth = effectiveCp ? evaluateControlPlaneHealth(effectiveCp) : null;
  const m = cpHealth?.metrics || {};
  const hasActionableHygiene = Boolean(
    cpHealth && !cpHealth.healthy &&
    ((m.opgateOlderThan24h || 0) > 0 || (m.daemonLogBytes || 0) > 50 * 1024 * 1024)
  );
  const hasHygieneIssue = hasActionableHygiene;
  if (!hasOutage && !hasHygieneIssue) return '';

  const mb = bytes => ((Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
  const hygieneSectionHtml = hasHygieneIssue ? `<section class="resilience-provider resilience-hygiene"><div class="resilience-provider-head"><strong>🩺 ${esc(td('hygiene.bannerTitle'))}</strong>
    <span class="resilience-snapshot ${cpHealth.status === 'degraded' ? 'stale' : 'aging'}">${esc(td('hygiene.staleLabel', { count: m.opgateOlderThan24h || 0 }))}</span>
    <span class="resilience-vault">${esc(td('hygiene.logLabel', { mb: mb(m.daemonLogBytes) }))}</span>
    <span class="resilience-vault">${esc(td('hygiene.dbLabel', { mb: mb(m.sqliteBytes) }))}</span>
    ${button('hygiene-plan', td('hygiene.planBtn'), 'data-scope="fleet" data-cutoff-hours="24"', busy)}</div>
    ${array(cpHealth.findings).map(f => `<small style="display:block;color:#cbd5e1;margin-top:4px;">${esc(f.title || f.summary)}</small>`).join('')}</section>` : '';

  if (!hasOutage) {
    const isCollapsed = Boolean(collapsed);
    const toggleBtn = button('toggle-collapse', isCollapsed ? '▾' : '▴', `aria-expanded="${!isCollapsed}"`);
    const compactChips = isCollapsed
      ? `<span class="resilience-vault">daemon.log: ${mb(m.daemonLogBytes)} MB</span>${button('hygiene-plan', td('hygiene.planBtn'), 'data-scope="fleet" data-cutoff-hours="24"', busy)}`
      : '';
    return `<aside class="resilience-banner${isCollapsed ? ' is-collapsed' : ''}" aria-live="polite"><div class="resilience-heading"><div><strong>🩺 ${esc(td('hygiene.bannerTitle'))}</strong>
      ${isCollapsed ? '' : `<p>${esc(cpHealth.findings[0]?.summary || '')}</p>`}</div>
      ${compactChips}${button('refresh', td('triage.refresh'), '', busy)}${toggleBtn}</div>${isCollapsed ? '' : hygieneSectionHtml}</aside>`;
  }

  const isDaemonDown = status.report?.tier === 'daemon_down' || array(status.providers).some(p => p.report?.tier === 'daemon_down');
  const isCollapsed = Boolean(collapsed);
  const offlineRigsList = array(status.report?.offlineRigs);
  const primaryProvider = array(status.providers).find(p => {
    const rep = providerReport(status, p);
    return rep?.tier === 'daemon_down' || array(rep?.offlineRigs).length;
  }) || array(status.providers)[0];
  const collapsedFleetBtn = (isCollapsed && primaryProvider && primaryProvider.capabilities?.fleetRecover === true && primaryProvider.capabilities?.planPreview === true)
    ? button('plan', td('resilience.resurrectFleetBtn'), targetAttrs({ providerId: primaryProvider.id, scope: 'fleet', target: null }), busy)
    : '';
  const collapsedRigsChip = (isCollapsed && offlineRigsList.length)
    ? `<span class="resilience-vault" style="color:#fde68a;">${esc(offlineRigsList.join(' · '))}</span>`
    : '';
  const content = isCollapsed ? '' : array(status.providers).map(provider => {
    const report = providerReport(status, provider), caps = provider.capabilities || {};
    if (!(report?.tier === 'daemon_down' || array(report?.offlineRigs).length)) return '';
    const fleet = { providerId: provider.id, scope: 'fleet', target: null };
    return `<section class="resilience-provider"><div class="resilience-provider-head"><strong>${esc(provider.id)}</strong>
      ${caps.fleetRecover === true && caps.planPreview === true ? button('plan', td('resilience.resurrectFleetBtn'), targetAttrs(fleet), busy) : ''}
      ${button('copy', td('resilience.copyCommandBtn'), `data-command="${esc(provider.commandPreview || '')}"`, !provider.commandPreview)}</div>
      ${array(report.rigReports).filter(r => r.recoverable && !r.intentionallyStopped).map(rig => {
        const request = { providerId: provider.id, scope: 'rig', target: rig.rigId };
        const freshness = ['fresh', 'aging', 'stale'].includes(rig.snapshot?.freshness) ? rig.snapshot.freshness : 'missing';
        const label = { fresh: 'snapFresh', aging: 'snapAging', stale: 'snapStale', missing: 'snapMissing' }[freshness];
        const age = formatRelativeSnapshotAge(rig.snapshot?.ageMs, lang);
        return `<div class="resilience-rig"><div><b>${esc(rig.rigId)}</b><span class="resilience-snapshot ${freshness}">${esc(td(`resilience.${label}`))}</span>
          ${age ? `<small>${esc(td('resilience.snapshotAge', { age }))}</small>` : ''}</div><div class="resilience-actions">
          ${caps.unitRecover === true && caps.planPreview === true ? button('plan', td('resilience.wakeupBtn', { rig: rig.rigId }), targetAttrs(request), busy) : ''}
          ${caps.checkpoints === true ? button('snapshot', td('resilience.snapshotBtn'), targetAttrs(request), busy) : ''}
          ${button('dismiss', td('resilience.dismissBtn'), targetAttrs(request), busy)}
          ${button('copy', td('resilience.copyCommandBtn'), `data-command="${esc(rig.commandPreview || '')}"`, !rig.commandPreview)}</div></div>`;
      }).join('')}</section>`;
  }).join('');
  const toggleBtn = button('toggle-collapse', isCollapsed ? '▾' : '▴', `aria-expanded="${!isCollapsed}"`);
  return `<aside class="resilience-banner${isCollapsed ? ' is-collapsed' : ''}" aria-live="polite"><div class="resilience-heading"><div><strong>${esc(td(isDaemonDown ? 'resilience.daemonDownTitle' : 'resilience.rigDownTitle', { rig: offlineRigsList.join(', ') }))}</strong>
    ${isCollapsed ? '' : `<p>${esc(td(isDaemonDown ? 'resilience.daemonDownDesc' : 'resilience.rigDownDesc'))}</p>`}</div>
    ${collapsedRigsChip}${collapsedFleetBtn}${isCollapsed ? '' : `<span class="resilience-vault">${esc(td(status.vault?.encrypted === true ? 'resilience.vaultEncrypted' : 'resilience.vaultLocal'))}</span>`}
    ${button('refresh', td('triage.refresh'), '', busy)}${toggleBtn}</div>${demo && !isCollapsed ? `<p class="resilience-demo">${esc(td('resilience.demoNotice'))}</p>` : ''}${content}${isCollapsed ? '' : hygieneSectionHtml}</aside>`;
}

export function renderResilienceModalHtml(state, { td, demo = false, now = Date.now() } = {}) {
  if (!state || state.phase === 'closed') return '';
  const list = (key, values) => array(values).length ? `<h3>${esc(td(key))}</h3><ul>${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : '';
  const confirming = state.phase === 'preview';

  if (state.operation === 'hygiene') {
    const hResp = state.hygienePlanResponse, hPlan = hResp?.plan;
    const hReceipt = state.hygieneReceipt ? normalizeHygieneReceipt(state.hygieneReceipt) : null;
    const canConfirmH = confirming && Boolean(hPlan) && (demo || (typeof hResp?.planHash === 'string' && hResp.planHash.length > 0 && Date.parse(hResp.expiresAt) > now));
    const mb = bytes => ((Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
    return `<div class="resilience-backdrop"><section class="resilience-modal" role="dialog" aria-modal="true" aria-labelledby="resilienceModalTitle" tabindex="-1">
      <header><h2 id="resilienceModalTitle">${esc(td(hReceipt ? 'resilience.receiptTitle' : 'hygiene.bannerTitle'))}</h2>
      ${button('cancel', td('resilience.cancelBtn'))}</header>
      ${demo ? `<p class="resilience-demo">${esc(td('resilience.demoNotice'))}</p>` : ''}
      ${state.phase === 'loading' ? `<p role="status">${esc(td('modal.loading'))}</p>` : ''}
      ${hPlan ? `<p>${esc(td('hygiene.staleLabel', { count: hPlan.totals?.staleOpgateCount ?? 0 }))} · ${esc(td('hygiene.logLabel', { mb: mb(hPlan.daemonLogBytes) }))} · ${esc(td('hygiene.dbLabel', { mb: mb(hPlan.sqliteBytes) }))}</p>
        <h3>${esc(td('resilience.commandLabel'))}</h3><pre class="resilience-command">${esc(hPlan.commandPreview)}</pre>
        ${list('resilience.warnings', hPlan.warnings)}` : ''}
      ${state.error ? `<p class="resilience-error" role="alert">${esc(td('hygiene.statusUnknown'))}: ${esc(state.error)}</p>` : ''}
      ${state.phase === 'executing' ? `<p role="status">${esc(td('resilience.inProgress'))}</p>` : ''}
      ${hReceipt ? `<p class="resilience-result ${esc(hReceipt.status)}" role="status">${esc(td(`hygiene.${hygieneReceiptKey(hReceipt.status)}`))} (${hReceipt.cleanedCount}/${hReceipt.targetCount})</p>` : ''}
      <footer>${confirming || state.phase === 'executing' ? button('hygiene-confirm', td('hygiene.confirmBtn'), `data-plan-hash="${esc(hResp?.planHash || '')}"${demo ? ' data-simulated="true"' : ''}`, !canConfirmH) : ''}
      ${button('copy', td('resilience.copyCommandBtn'), `data-command="${esc(hPlan?.commandPreview || state.commandPreview || '')}"`, !(hPlan?.commandPreview || state.commandPreview))}</footer>
      ${state.copyFallback ? `<textarea class="resilience-copy-fallback" readonly aria-label="${esc(td('resilience.copyCommandBtn'))}">${esc(state.copyFallback)}</textarea>` : ''}
      </section></div>`;
  }

  const response = state.planResponse, plan = response?.plan;
  const receipt = state.receipt ? normalizeRestoreReceipt(state.receipt) : null;
  const suggestedSeatMatch = String(state.receipt?.detail || '').match(/rig\s+seat\s+launch\s+([A-Za-z0-9._-]+@[A-Za-z0-9._-]+)\s+--fresh/i);
  const suggestedSeatId = suggestedSeatMatch ? suggestedSeatMatch[1] : null;
  const canDismissFailedRig = Boolean(receipt?.status === 'failed' && state.request?.scope === 'rig' && state.request?.target);
  const canConfirm = confirming && plan?.supported === true && (demo || (typeof response.planHash === 'string' && response.planHash.length > 0 && Date.parse(response.expiresAt) > now));
  return `<div class="resilience-backdrop"><section class="resilience-modal" role="dialog" aria-modal="true" aria-labelledby="resilienceModalTitle" tabindex="-1">
    <header><h2 id="resilienceModalTitle">${esc(td(receipt || state.snapshotSaved ? 'resilience.receiptTitle' : 'resilience.previewTitle'))}</h2>
    ${button('cancel', td('resilience.cancelBtn'))}</header>
    ${demo ? `<p class="resilience-demo">${esc(td('resilience.demoNotice'))}</p>` : ''}
    ${state.phase === 'loading' ? `<p role="status">${esc(td('modal.loading'))}</p>` : ''}
    ${plan ? `<p>${esc(td('resilience.providerLabel'))}: <b>${esc(plan.providerId)}</b></p>
      <h3>${esc(td('resilience.commandLabel'))}</h3><pre class="resilience-command">${esc(plan.commandPreview)}</pre>
      ${list('resilience.targetRigs', plan.targetRigs)}${list('resilience.targetSeats', plan.targetSeats)}
      ${array(plan.skippedRigs).length ? `<p>${esc(td('resilience.intentionalSkipNote'))}</p><ul>${plan.skippedRigs.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${list('resilience.warnings', plan.warnings)}` : ''}
    ${state.error ? `<p class="resilience-error" role="alert">${esc(td('resilience.statusUnknown'))}: ${esc(state.error)}</p>` : ''}
    ${state.receipt?.detail ? `<pre class="resilience-command" style="color:#fda4af; border-color:rgba(244,63,94,0.4); white-space:pre-wrap;">${esc(state.receipt.detail)}</pre>` : ''}
    ${state.phase === 'executing' ? `<p role="status">${esc(td(state.operation === 'snapshot' ? 'modal.loading' : 'resilience.inProgress'))}</p>` : ''}
    ${state.snapshotSaved ? `<p role="status">${esc(td('resilience.snapshotSaved'))}</p>` : ''}
    ${receipt ? `<p class="resilience-result ${receipt.status}" role="status">${esc(td(`resilience.${receiptKey(receipt.status)}`))}</p>
      <ul>${[...receipt.rigs, ...receipt.seats].map(item => `<li>${esc(item.target)} — ${esc(td(`resilience.${receiptKey(item.status)}`))}</li>`).join('')}</ul>` : ''}
    <footer>${confirming || state.phase === 'executing' ? button('confirm', td('resilience.confirmBtn'), `data-plan-hash="${esc(response?.planHash || '')}"${demo ? ' data-simulated="true"' : ''}`, !canConfirm) : ''}
    ${suggestedSeatId ? button('plan', td('resilience.launchSuggestedSeat', { seat: suggestedSeatId }), targetAttrs({ providerId: plan?.providerId || 'openrig', scope: 'seat', target: suggestedSeatId })) : ''}
    ${canDismissFailedRig ? button('dismiss', td('resilience.dismissBtn'), targetAttrs(state.request)) : ''}
    ${button('copy', td('resilience.copyCommandBtn'), `data-command="${esc(plan?.commandPreview || state.commandPreview || '')}"`, !(plan?.commandPreview || state.commandPreview))}</footer>
    ${state.copyFallback ? `<textarea class="resilience-copy-fallback" readonly aria-label="${esc(td('resilience.copyCommandBtn'))}">${esc(state.copyFallback)}</textarea>` : ''}
    </section></div>`;
}

/** Explicit event adapter. No polling, automatic recovery, or offline network access. */
export function createResilienceController({ root, modalRoot, td, lang = () => 'en', isLive = () => false, demo = false,
  getJson, postJson, copyCommand = () => Promise.reject(new Error('Clipboard unavailable')),
  guard = new ActionFlightGuard(), now = Date.now } = {}) {
  let status = null, controlPlane = null, state = { phase: 'closed' }, epoch = 0, refreshing = null, destroyed = false, focusReturn = null, collapsed = !demo;
  const lockScope = 'resilience:operator';
  const busy = () => guard.isScopeInFlight(lockScope);
  const deps = () => ({ td, lang: lang(), demo, now: now(), busy: busy(), collapsed, controlPlane });
  const revision = value => JSON.stringify(array(value?.providers).map(p => [p.id, p.capabilities, providerReport(value, p)?.offlineRigs,
    array(providerReport(value, p)?.rigReports).map(r => [r.rigId, r.online, r.intentionallyStopped, r.snapshot?.id])]));
  const cpRevision = cp => cp ? JSON.stringify([cp?.queue?.opgateOlderThan24h, cp?.files?.daemonLog?.bytes, cp?.files?.sqliteDb?.bytes]) : '';
  function render() {
    if (destroyed) return;
    root.innerHTML = renderCrashCartBannerHtml(status, deps());
    modalRoot.innerHTML = renderResilienceModalHtml(state, deps());
    modalRoot.hidden = state.phase === 'closed';
  }
  function cancel() {
    epoch++; state = { phase: 'closed' }; render(); focusReturn?.focus?.();
  }
  function setStatus(next) {
    if (state.operation !== 'hygiene' && ['loading', 'preview'].includes(state.phase) && revision(next) !== revision(status)) cancel();
    status = next; render();
  }
  function setControlPlane(nextCp) {
    if (state.operation === 'hygiene' && ['loading', 'preview'].includes(state.phase) && cpRevision(nextCp) !== cpRevision(controlPlane)) cancel();
    controlPlane = nextCp || null; render();
  }
  function demoStatus(step) {
    const next = buildDemoResilienceScenario(step), p = next.providers[0];
    p.commandPreview = 'rig start --last --json';
    p.report = { ...next.report, rigReports: next.report.rigReports.map(r => ({ ...r, commandPreview: `rig start --rigs ${r.rigId} --json` })) };
    return next;
  }
  async function refresh() {
    if (destroyed || (!demo && !isLive())) return;
    if (demo) { if (!status) setStatus(demoStatus('blackout')); return; }
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { setStatus(await getJson('/api/resilience/status')); }
      catch (error) { if (state.phase === 'preview') cancel(); /* Keep last observed advisory, never invent a plan. */ }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  function allowed(request, capability) {
    if (!validateResilienceTarget(request)) return false;
    const provider = array(status?.providers).find(p => p.id === request.providerId);
    const caps = provider?.capabilities || {};
    return caps[capability] === true && (capability === 'checkpoints' || caps.planPreview === true);
  }
  function fallbackCommand(request) {
    const provider = array(status?.providers).find(p => p.id === request.providerId);
    return request.scope === 'fleet' ? provider?.commandPreview || '' : array(providerReport(status || {}, provider || {}).rigReports).find(r => r.rigId === request.target)?.commandPreview || '';
  }
  async function preview(request) {
    if (busy() || !allowed(request, request.scope === 'fleet' ? 'fleetRecover' : 'unitRecover') || (!demo && !isLive())) return;
    const token = ++epoch;
    state = { phase: 'loading', request, commandPreview: fallbackCommand(request) }; render();
    try {
      let response;
      if (demo) {
        const scenario = buildDemoResilienceScenario('preview');
        response = { plan: { ...scenario.plan, ...request, targetRigs: request.scope === 'rig' ? [request.target] : scenario.plan.targetRigs,
          commandPreview: request.scope === 'rig' ? `rig start --rigs ${request.target} --json` : scenario.plan.commandPreview }, planHash: null, expiresAt: null };
      } else response = await postJson('/api/resilience/plan', request);
      if (token !== epoch || destroyed) return;
      if (!sameTarget(request, response?.plan) || typeof response.plan.commandPreview !== 'string' || !response.plan.commandPreview.trim() ||
        (!demo && (typeof response.planHash !== 'string' || !response.planHash || !(Date.parse(response.expiresAt) > now())))) throw new Error(td('resilience.statusUnknown'));
      state = { phase: 'preview', request, planResponse: response }; render();
    } catch (error) { if (token === epoch && !destroyed) { state = { phase: 'receipt', commandPreview: fallbackCommand(request), error: String(error.message || error) }; render(); } }
  }
  async function mutate() {
    const reviewed = state;
    if (busy() || reviewed.phase !== 'preview' || (!demo && !isLive())) return;
    const request = reviewed.request, response = reviewed.planResponse;
    if (!allowed(request, request.scope === 'fleet' ? 'fleetRecover' : 'unitRecover') || response.plan.supported !== true ||
      !sameTarget(request, response.plan) || (!demo && !(Date.parse(response.expiresAt) > now()))) { cancel(); return; }
    const token = epoch;
    await guard.runGuarded({ scopeKey: lockScope, fingerprint: JSON.stringify(request), cooldownMs: 0 }, async () => {
      state = { ...reviewed, phase: 'executing' }; render();
      try {
        const result = demo ? { receipt: buildDemoResilienceScenario('recovered').receipt } : await postJson('/api/resilience/resurrect', { ...request, confirmed: true, planHash: response.planHash });
        if (token !== epoch || destroyed) return;
        state = { ...reviewed, phase: 'receipt', receipt: normalizeRestoreReceipt(result?.receipt) };
        if (demo) status = demoStatus('recovered');
      } catch (error) {
        if (token === epoch && !destroyed) state = { ...reviewed, phase: 'receipt', error: String(error.message || error), receipt: normalizeRestoreReceipt(error.receipt) };
      } finally { render(); }
    });
    render();
  }
  async function snapshot(request) {
    if (request.scope !== 'rig' || busy() || !allowed(request, 'checkpoints') || (!demo && !isLive())) return;
    const token = ++epoch;
    await guard.runGuarded({ scopeKey: lockScope, fingerprint: `snapshot:${JSON.stringify(request)}`, cooldownMs: 0 }, async () => {
      state = { phase: 'executing', operation: 'snapshot', commandPreview: fallbackCommand(request) }; render();
      try {
        const result = demo ? { checkpoint: { providerId: request.providerId, target: request.target, created: true } } : await postJson('/api/resilience/snapshot', request);
        if (token !== epoch || destroyed) return;
        const saved = result?.checkpoint?.created === true && result.checkpoint.providerId === request.providerId && result.checkpoint.target === request.target;
        state = { phase: 'receipt', commandPreview: fallbackCommand(request), snapshotSaved: saved, receipt: saved ? null : normalizeRestoreReceipt(null) };
      } catch (error) { if (token === epoch && !destroyed) state = { phase: 'receipt', commandPreview: fallbackCommand(request), error: String(error.message || error) }; }
      finally { render(); }
    });
    render();
  }
  async function hygienePreview(request) {
    if (busy() || (!demo && !isLive())) return;
    const token = ++epoch;
    const cutoff = [24, 72, 168].includes(Number(request?.cutoffHours)) ? Number(request.cutoffHours) : 24;
    const scope = request?.scope === 'rig' && request?.target ? 'rig' : 'fleet';
    const payload = {
      scope,
      ...(scope === 'rig' ? { targetRig: request.target } : {}),
      cutoffHours: cutoff,
      rotateDaemonLog: Boolean((controlPlane?.files?.daemonLog?.bytes || 0) > 50 * 1024 * 1024),
      includeDetachedTargets: true,
      includeOldBlocked: false
    };
    state = { phase: 'loading', operation: 'hygiene', request: payload, commandPreview: 'rig queue list -A --json' }; render();
    try {
      let response;
      if (demo) {
        response = {
          plan: {
            ...payload,
            daemonLogBytes: controlPlane?.files?.daemonLog?.bytes || 0,
            sqliteBytes: controlPlane?.files?.sqliteDb?.bytes || 0,
            totals: { staleOpgateCount: controlPlane?.queue?.opgateOlderThan24h || 0 },
            warnings: [],
            commandPreview: 'rig queue list -A --json'
          },
          planHash: null,
          expiresAt: null
        };
      } else {
        response = await postJson('/api/resilience/hygiene/plan', payload);
      }
      if (token !== epoch || destroyed) return;
      if (!response?.plan || typeof response.plan.commandPreview !== 'string' ||
        (!demo && (typeof response.planHash !== 'string' || !response.planHash || !(Date.parse(response.expiresAt) > now())))) {
        throw new Error(td('hygiene.statusUnknown'));
      }
      state = { phase: 'preview', operation: 'hygiene', request: payload, hygienePlanResponse: response, commandPreview: response.plan.commandPreview }; render();
    } catch (error) {
      if (token === epoch && !destroyed) {
        state = { phase: 'receipt', operation: 'hygiene', commandPreview: 'rig queue list -A --json', error: String(error.message || error) }; render();
      }
    }
  }
  async function hygieneMutate() {
    const reviewed = state;
    if (busy() || reviewed.phase !== 'preview' || reviewed.operation !== 'hygiene' || (!demo && !isLive())) return;
    const req = reviewed.request, resp = reviewed.hygienePlanResponse;
    if (!resp?.plan || (!demo && !(Date.parse(resp.expiresAt) > now()))) { cancel(); return; }
    const token = epoch;
    await guard.runGuarded({ scopeKey: lockScope, fingerprint: `hygiene:${JSON.stringify(req)}`, cooldownMs: 0 }, async () => {
      state = { ...reviewed, phase: 'executing' }; render();
      try {
        const result = demo
          ? { receipt: { status: 'cleaned', targetCount: 0, cleanedCount: 0 } }
          : await postJson('/api/resilience/hygiene/execute', { ...req, confirmed: true, planHash: resp.planHash });
        if (token !== epoch || destroyed) return;
        state = { ...reviewed, phase: 'receipt', hygieneReceipt: normalizeHygieneReceipt(result?.receipt) };
      } catch (error) {
        if (token === epoch && !destroyed) {
          state = { ...reviewed, phase: 'receipt', error: String(error.message || error), hygieneReceipt: error?.receipt ? normalizeHygieneReceipt(error.receipt) : null };
        }
      } finally { render(); }
    });
    render();
  }
  async function click(event) {
    const el = event.target?.closest?.('[data-resilience-action]');
    if (!el || el.disabled) return;
    const action = el.dataset.resilienceAction;
    const request = { providerId: el.dataset.providerId, scope: el.dataset.scope, target: el.dataset.target || null };
    if (action === 'cancel') return cancel();
    if (action === 'toggle-collapse') { collapsed = !collapsed; render(); return; }
    if (action === 'refresh') return refresh();
    if (action === 'copy') {
      try { await copyCommand(el.dataset.command || ''); }
      catch { if (state.phase === 'closed') state = { phase: 'receipt', commandPreview: el.dataset.command }; state.copyFallback = el.dataset.command; render(); modalRoot.querySelector?.('textarea')?.select(); }
      return;
    }
    focusReturn = el;
    if (action === 'plan') { await preview(request); modalRoot.querySelector?.('[role="dialog"]')?.focus(); }
    if (action === 'confirm') {
      if (!demo && el.dataset.planHash !== state.planResponse?.planHash) return cancel();
      await mutate();
    }
    if (action === 'hygiene-plan') { await hygienePreview({ ...request, cutoffHours: el.dataset.cutoffHours }); modalRoot.querySelector?.('[role="dialog"]')?.focus(); }
    if (action === 'hygiene-confirm') {
      if (!demo && el.dataset.planHash !== state.hygienePlanResponse?.planHash) return cancel();
      await hygieneMutate();
    }
    if (action === 'snapshot') await snapshot(request);
    if (action === 'dismiss' && request.scope === 'rig' && request.target) {
      if (demo) { cancel(); return; }
      try {
        await postJson('/api/resilience/dismiss', { target: request.target });
        cancel();
        await refresh();
      } catch (error) {
        state = { phase: 'receipt', request, error: String(error.message || error) };
        render();
      }
    }
  }
  function keydown(event) {
    if (state.phase === 'closed') return;
    if (event.key === 'Escape') { event.stopPropagation(); cancel(); }
    if (event.key === 'Tab') {
      const controls = [...(modalRoot.querySelectorAll?.('button:not([disabled]), textarea') || [])];
      if (!controls.length) return;
      const first = controls[0], last = controls.at(-1), active = modalRoot.ownerDocument?.activeElement;
      if (event.shiftKey && (active === first || !controls.includes(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !controls.includes(active))) { event.preventDefault(); first.focus(); }
    }
  }
  root.addEventListener('click', click); modalRoot.addEventListener('click', click); modalRoot.addEventListener('keydown', keydown);
  return { refresh, render, cancel, setStatus, setControlPlane, getState: () => state,
    destroy() { destroyed = true; epoch++; root.removeEventListener('click', click); modalRoot.removeEventListener('click', click); modalRoot.removeEventListener('keydown', keydown); } };
}
