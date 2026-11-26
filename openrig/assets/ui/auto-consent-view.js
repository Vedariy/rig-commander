/**
 * Scoped Opt-In Auto-Consent UI Views & Explicit Controller.
 * Zero-build native ESM: pure markup builders (zero DOM coupling, zero inline JS handlers,
 * 100% escapeHtml + data-* delegation) + explicit event/timer controller.
 */
import { ActionFlightGuard } from '../domain/action-guard.js';
import { getHitlPromptPresentation } from '../domain/prompt-parser.js';
import {
  AUTO_CONSENT_LIMITS,
  AUTO_CONSENT_MODES,
  AUTO_CONSENT_PROFILES,
  AUTO_CONSENT_VETO_CODES,
  DEFAULT_AUTO_CONSENT_CONFIG,
  classifyDestructiveVetoes,
  createSessionGrant,
  evaluateAutoConsentPrompt,
  isSessionGrantValid,
  resolveEffectiveConsentPolicy,
  sanitizeAutoConsentConfig,
  summarizeActiveAutoConsentScopes
} from '../domain/auto-consent-model.js';

const array = (value) => (Array.isArray(value) ? value : []);

const PERSISTENT_ALLOW_RE = /(?:always\s+allow|allow\s+always|allow\s+all|don'?t\s+ask\s+again|do\s+not\s+ask\s+again|persist\s+to\s+settings|settings\.json|remember\s+(?:this|my)\s+(?:choice|decision)|всегда\s+разрешать|запомнить\s+выбор|больше\s+не\s+спрашивать)/i;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function inferRigId(seatId) {
  const s = String(seatId || '').trim();
  const at = s.lastIndexOf('@');
  return at > 0 && at < s.length - 1 ? s.slice(at + 1) : '';
}

function formatTtlShort(minutes, lang = 'en') {
  const m = Math.max(1, Math.round(Number(minutes) || 0));
  return lang === 'ru' ? `${m}м` : `${m}m`;
}

function formatClock(ts, lang = 'en') {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch {
    return '';
  }
}

export function getProfileLabel(profile, td) {
  const map = {
    off: 'autoConsent.profileOff',
    inherit: 'autoConsent.profileInherit',
    manual_only: 'autoConsent.profileManualOnly',
    safe_readonly: 'autoConsent.profileSafeReadonly',
    trusted_dev: 'autoConsent.profileTrustedDev',
    sprint_all: 'autoConsent.profileSprintAll'
  };
  return td(map[profile] || 'autoConsent.profileOff');
}

export function getScopeLabel(scope, td) {
  if (scope === 'session') return td('autoConsent.scopeSession');
  if (scope === 'seat' || scope === 'agent') return td('autoConsent.scopeSeat');
  if (scope === 'project' || scope === 'rig') return td('autoConsent.scopeProject');
  return td('autoConsent.scopeGlobal');
}

export function getVetoLabel(vetoCode, fallbackReason = '', { td, ctxPct = null } = {}) {
  if (!vetoCode) return fallbackReason || '';
  if (String(vetoCode).startsWith('E-VETO-')) return td('autoConsent.vetoHardSafety');
  const map = {
    [AUTO_CONSENT_VETO_CODES.NO_SINGLE_ALLOW_OPTION]: 'autoConsent.vetoNoSingleAllow',
    [AUTO_CONSENT_VETO_CODES.NON_PERMISSION_QUESTION]: 'autoConsent.vetoNonPermission',
    [AUTO_CONSENT_VETO_CODES.CTX_OVERHEAT]: 'autoConsent.vetoCtxOverheat',
    [AUTO_CONSENT_VETO_CODES.PACKAGE_INSTALL_POLICY]: 'autoConsent.vetoPkgInstall',
    [AUTO_CONSENT_VETO_CODES.NETWORK_POLICY]: 'autoConsent.vetoNetwork',
    [AUTO_CONSENT_VETO_CODES.RETRY_LOOP]: 'autoConsent.vetoRetryLoop',
    [AUTO_CONSENT_VETO_CODES.RATE_CAP]: 'autoConsent.vetoRateCap',
    [AUTO_CONSENT_VETO_CODES.PROMPT_DRIFT]: 'autoConsent.vetoPromptDrift',
    [AUTO_CONSENT_VETO_CODES.MANUAL_ONLY]: 'autoConsent.vetoManualOnly',
    [AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED]: 'autoConsent.toastCanceled',
    [AUTO_CONSENT_VETO_CODES.MASTER_PAUSED]: 'autoConsent.pausedBanner'
  };
  const key = map[vetoCode];
  if (key) {
    return td(key, { pct: ctxPct ?? 75 });
  }
  return fallbackReason || String(vetoCode);
}

function deriveStatus(config, stats, rawStatus) {
  if (config.masterPaused) return 'paused';
  if (!config.enabled) return 'disabled';
  if (rawStatus === 'capped' || stats.actionsLastHour >= config.maxActionsPerHour) return 'capped';
  return config.mode === AUTO_CONSENT_MODES.ARMED ? 'armed' : 'dry_run';
}

export function normalizeAutoConsentState(rawState = null, nowMs = Date.now()) {
  const src = rawState && typeof rawState === 'object' ? rawState : {};
  const config = sanitizeAutoConsentConfig(src.config || {}, DEFAULT_AUTO_CONSENT_CONFIG);
  const sessionGrants = array(src.sessionGrants).filter((g) => g && typeof g === 'object');
  const pendingApprovals = array(src.pendingApprovals).filter((p) => p && typeof p === 'object' && p.id);
  const recentRuns = array(src.recentRuns).filter((r) => r && typeof r === 'object');

  const rawStats = src.stats && typeof src.stats === 'object' ? src.stats : {};
  const actionsLastHour = Math.max(0, Math.floor(Number(rawStats.actionsLastHour || 0)));
  const stats = {
    approvedCount: Math.max(0, Math.floor(Number(rawStats.approvedCount || 0))),
    escalatedCount: Math.max(0, Math.floor(Number(rawStats.escalatedCount || 0))),
    canceledCount: Math.max(0, Math.floor(Number(rawStats.canceledCount || 0))),
    actionsLastHour,
    remainingHourlyQuota: rawStats.remainingHourlyQuota !== undefined
      ? Math.max(0, Math.floor(Number(rawStats.remainingHourlyQuota)))
      : Math.max(0, config.maxActionsPerHour - actionsLastHour)
  };

  const derivedSummary = summarizeActiveAutoConsentScopes(config, sessionGrants, nowMs);
  const rawSummary = src.activeSummary && typeof src.activeSummary === 'object' ? src.activeSummary : null;
  const activeSummary = rawSummary && !src.config
    ? { ...derivedSummary, ...rawSummary }
    : derivedSummary;

  return {
    status: deriveStatus(config, stats, src.status),
    config,
    sessionGrants,
    pendingApprovals,
    recentRuns,
    stats,
    activeSummary
  };
}

function getSeatEpochForDisplay(seat, sessionGrants) {
  if (seat && typeof seat === 'object') {
    const explicit = seat.seatSessionEpoch ?? seat.sessionEpoch ?? seat.sessionId ?? seat.startedAt;
    if (explicit !== null && explicit !== undefined && String(explicit).trim()) {
      return String(explicit).trim();
    }
  }
  const seatId = typeof seat === 'string' ? seat : String(seat?.id || seat?.seatId || '').trim();
  if (!seatId) return null;
  const serverGrant = array(sessionGrants).find(
    (g) => g && g.scope === 'seat' && g.targetId === seatId && g.revoked !== true && g.seatSessionEpoch
  );
  return serverGrant ? String(serverGrant.seatSessionEpoch) : null;
}

function getActiveSessionGrants(sessionGrants, nowMs) {
  const out = [];
  for (const grant of array(sessionGrants)) {
    if (!grant || typeof grant !== 'object' || grant.revoked === true) continue;
    const check = isSessionGrantValid(grant, {
      rigId: grant.scope === 'rig' ? grant.targetId : inferRigId(grant.targetId),
      seatId: grant.scope === 'seat' ? grant.targetId : '',
      seatSessionEpoch: grant.scope === 'seat' ? grant.seatSessionEpoch : null,
      nowMs
    });
    if (!check.valid) continue;
    const remainingMin = Math.max(1, Math.ceil((check.effectiveExpiresAtMs - nowMs) / 60_000));
    const maxCap = grant.profile === AUTO_CONSENT_PROFILES.SPRINT_ALL
      ? AUTO_CONSENT_LIMITS.MAX_SPRINT_APPROVALS
      : AUTO_CONSENT_LIMITS.MAX_SESSION_APPROVALS;
    const effectiveMax = Math.min(Math.floor(Number(grant.maxApprovals) || 0), maxCap);
    out.push({
      grant,
      remainingMin,
      remainingApprovals: check.remainingApprovals,
      effectiveMax,
      effectiveExpiresAtMs: check.effectiveExpiresAtMs
    });
  }
  return out;
}

export function getAutoConsentModalBadge(rawState, td) {
  const state = normalizeAutoConsentState(rawState);
  const cfg = state.config;
  const quota = `${state.stats.actionsLastHour}/${cfg.maxActionsPerHour}/h`;
  if (cfg.masterPaused) {
    return { text: td('autoConsent.hudPaused'), borderColor: '#ff0055', color: '#fda4af' };
  }
  if (!cfg.enabled) {
    return { text: 'DISABLED (SAFE)', borderColor: '#38bdf8', color: '#7dd3fc' };
  }
  if (state.status === 'capped') {
    return { text: `RATE-CAPPED • ${quota}`, borderColor: '#ff0055', color: '#fda4af' };
  }
  if (cfg.mode === AUTO_CONSENT_MODES.ARMED) {
    return { text: `ARMED • ${quota}`, borderColor: '#00ff9d', color: '#6ee7b7' };
  }
  return { text: 'DRY-RUN PREVIEW', borderColor: '#38bdf8', color: '#7dd3fc' };
}

/**
 * Top HUD active indicator & 1-click panic kill-switch.
 * Completely silent ('') when OFF and no scope/grant is active.
 */
export function renderAutoConsentHudPillHtml(rawState, { td, lang = 'en', nowMs = Date.now(), busy = false } = {}) {
  if (!rawState) return '';
  const state = normalizeAutoConsentState(rawState, nowMs);
  const { config: cfg, activeSummary: summary, stats, pendingApprovals } = state;

  const showPaused = Boolean(cfg.masterPaused && (cfg.enabled || summary.totalActiveScopes > 0));
  const showActive = Boolean(summary.hasActiveScopes || pendingApprovals.length > 0);
  if (!showPaused && !showActive) return '';

  const disabledAttr = busy ? ' disabled' : '';

  if (showPaused) {
    return `<div class="ac-hud-pill is-paused" role="status" aria-live="polite">` +
      `<button type="button" class="ac-hud-status-btn" data-auto-consent-action="open-tab">${escapeHtml(td('autoConsent.hudPaused'))}</button>` +
      `<button type="button" class="ac-hud-ctrl-btn is-resume" data-auto-consent-action="resume-all"${disabledAttr}>${escapeHtml(td('autoConsent.resumeAllBtn'))}</button>` +
      `</div>`;
  }

  const scopeCount = Math.max(1, summary.totalActiveScopes);
  const scopesText = td('autoConsent.scopeCount', { n: scopeCount });
  const isDryRun = cfg.mode !== AUTO_CONSENT_MODES.ARMED;

  let statusLabel;
  if (isDryRun) {
    statusLabel = td('autoConsent.hudDryRun', { scopes: scopesText });
  } else if (summary.shortestSessionRemainingMin !== null && summary.shortestSessionRemainingMin !== undefined) {
    statusLabel = td('autoConsent.hudActive', {
      scopes: scopesText,
      ttl: formatTtlShort(summary.shortestSessionRemainingMin, lang),
      count: stats.approvedCount
    });
  } else {
    statusLabel = td('autoConsent.hudActiveNoTtl', {
      scopes: scopesText,
      count: stats.approvedCount
    });
  }

  const toneClass = isDryRun ? 'is-dry-run' : 'is-armed';
  return `<div class="ac-hud-pill ${toneClass}" role="status" aria-live="polite">` +
    `<button type="button" class="ac-hud-status-btn" data-auto-consent-action="open-tab">${escapeHtml(statusLabel)}</button>` +
    `<button type="button" class="ac-hud-ctrl-btn is-pause" data-auto-consent-action="pause-all"${disabledAttr}>${escapeHtml(td('autoConsent.pauseAllBtn'))}</button>` +
    `</div>`;
}

/**
 * Live 3-second Grace-Window countdown cancel toast.
 * Displays seat, redacted command preview, scope/profile badge, live countdown, and [Cancel].
 */
export function renderPendingConsentToastHtml(
  pendingInput,
  { td, nowMs = Date.now(), shortSeat = (s) => s, busy = false } = {}
) {
  const list = Array.isArray(pendingInput)
    ? pendingInput.filter((p) => p && typeof p === 'object' && p.id)
    : (pendingInput && typeof pendingInput === 'object' && pendingInput.id ? [pendingInput] : []);
  if (!list.length) return '';

  const cards = list.map((item) => {
    const graceMs = Math.max(
      AUTO_CONSENT_LIMITS.MIN_GRACE_MS,
      Number(item.graceWindowMs) || AUTO_CONSENT_LIMITS.DEFAULT_GRACE_MS
    );
    const fireAtMs = Number(item.fireAtMs) || (nowMs + graceMs);
    const remMs = Math.max(0, fireAtMs - nowMs);
    const remSec = remMs > 0 ? Math.max(1, Math.ceil(remMs / 1000)) : 0;
    const pct = Math.max(0, Math.min(100, Math.round((remMs / graceMs) * 100)));
    const seatLabel = shortSeat(item.seatId || '');
    const scopeLabel = getScopeLabel(item.sourceScope || 'session', td);
    const profileLabel = getProfileLabel(item.matchedProfile || AUTO_CONSENT_PROFILES.TRUSTED_DEV, td);
    const preview = String(item.commandPreview || 'Option 1 (Allow Once)').trim();

    return `<div class="ac-pending-toast" role="alert" data-pending-id="${escapeHtml(item.id)}">` +
      `<div class="ac-toast-head">` +
        `<div class="ac-toast-title">${escapeHtml(td('autoConsent.toastTitle', { sec: remSec }))}</div>` +
        `<button type="button" class="ac-toast-cancel-btn" data-auto-consent-action="cancel-pending" data-pending-id="${escapeHtml(item.id)}" data-seat="${escapeHtml(item.seatId || '')}"${busy ? ' disabled' : ''}>${escapeHtml(td('autoConsent.toastCancelBtn'))}</button>` +
      `</div>` +
      `<div class="ac-toast-meta">` +
        `<span class="ac-scope-chip is-seat">${escapeHtml(seatLabel)}</span>` +
        `<span class="ac-scope-chip is-scope">${escapeHtml(scopeLabel)}</span>` +
        `<span class="ac-scope-chip is-profile">${escapeHtml(profileLabel)}</span>` +
      `</div>` +
      `<code class="ac-toast-cmd">${escapeHtml(preview)}</code>` +
      `<div class="ac-toast-progress"><div class="ac-toast-progress-fill" style="width:${pct}%;"></div></div>` +
    `</div>`;
  }).join('');

  return `<div class="ac-toast-stack">${cards}</div>`;
}

/**
 * Pure form reader for the Guardrails Auto-Consent settings section.
 */
export function readAutoConsentSettingsForm(root) {
  const byId = (id) => {
    if (!root) return null;
    if (typeof root.getElementById === 'function') {
      const found = root.getElementById(id);
      if (found) return found;
    }
    if (typeof root.querySelector === 'function') {
      return root.querySelector(`#${id}`);
    }
    return null;
  };
  const chk = (id, fallback = false) => {
    const el = byId(id);
    return el ? Boolean(el.checked) : fallback;
  };
  const val = (id, fallback = '') => {
    const el = byId(id);
    return el && el.value !== undefined && el.value !== null ? String(el.value) : fallback;
  };
  const num = (id, fallback) => {
    const rawStr = val(id, '').trim();
    if (!rawStr) return fallback;
    const raw = Number(rawStr);
    return Number.isFinite(raw) ? raw : fallback;
  };

  return {
    enabled: chk('acMasterEnable', false),
    mode: val('acModeSelect', AUTO_CONSENT_MODES.DRY_RUN) === AUTO_CONSENT_MODES.ARMED
      ? AUTO_CONSENT_MODES.ARMED
      : AUTO_CONSENT_MODES.DRY_RUN,
    graceWindowMs: num('acGraceWindowSelect', AUTO_CONSENT_LIMITS.DEFAULT_GRACE_MS),
    defaults: {
      pauseOnCtxOverheat: chk('acPauseCtxCheck', true),
      ctxPauseThresholdPct: num('acCtxThresholdInput', AUTO_CONSENT_LIMITS.DEFAULT_CTX_THRESHOLD_PCT),
      allowPackageInstall: chk('acAllowPkgCheck', false),
      allowReadOnlyNetwork: chk('acAllowNetCheck', false)
    }
  };
}

/**
 * Guardrails Modal `⚡ Auto-Consent` Tab pure markup builder.
 */
export function renderAutoConsentTabHtml({
  state: rawState = null,
  rigs = [],
  agents = [],
  td,
  deckLang = 'en',
  shortSeat = (s) => s,
  nowMs = Date.now(),
  statusMessage = '',
  demoTrack = false,
  busy = false
} = {}) {
  const en = deckLang === 'en';
  const state = normalizeAutoConsentState(rawState, nowMs);
  const { config: cfg, sessionGrants, recentRuns, stats } = state;
  const activeGrants = getActiveSessionGrants(sessionGrants, nowMs);
  const disabledAttr = busy ? ' disabled' : '';

  const rigSet = new Set();
  for (const r of array(rigs)) {
    const id = typeof r === 'string' ? r : String(r?.name || r?.id || '').trim();
    if (id) rigSet.add(id);
  }
  for (const a of array(agents)) {
    const rig = inferRigId(a?.id || a?.seatId || a?.canonicalSessionName);
    if (rig) rigSet.add(rig);
  }
  for (const key of Object.keys(cfg.projects || {})) {
    if (key) rigSet.add(key);
  }
  const rigList = Array.from(rigSet);

  const seatMap = new Map();
  for (const a of array(agents)) {
    const id = String(a?.id || a?.seatId || a?.canonicalSessionName || '').trim();
    if (!id) continue;
    seatMap.set(id, a);
  }
  for (const key of Object.keys(cfg.seats || {})) {
    if (key && !seatMap.has(key)) {
      seatMap.set(key, { id: key, shortName: shortSeat(key), harness: '', ctxPct: null });
    }
  }
  const seatList = Array.from(seatMap.values());

  const projectRowsHtml = rigList.length === 0
    ? `<div class="ac-empty-note">${escapeHtml(en ? 'No projects discovered yet.' : 'Проекты ещё не обнаружены.')}</div>`
    : rigList.map((rigId) => {
        const currentProfile = cfg.projects?.[rigId]?.profile || AUTO_CONSENT_PROFILES.OFF;
        const opts = [
          AUTO_CONSENT_PROFILES.OFF,
          AUTO_CONSENT_PROFILES.MANUAL_ONLY,
          AUTO_CONSENT_PROFILES.SAFE_READONLY,
          AUTO_CONSENT_PROFILES.TRUSTED_DEV
        ].map((p) => `<option value="${escapeHtml(p)}"${currentProfile === p ? ' selected' : ''}>${escapeHtml(getProfileLabel(p, td))}</option>`).join('');
        return `<div class="ac-policy-row">` +
          `<div class="ac-policy-target"><span class="ac-scope-chip is-scope">${escapeHtml(td('autoConsent.scopeProject'))}</span><b>${escapeHtml(rigId)}</b></div>` +
          `<div class="ac-policy-controls">` +
            `<select class="rig-select ac-policy-select" aria-label="${escapeHtml(rigId)}" data-auto-consent-action="set-project-policy" data-target="${escapeHtml(rigId)}"${disabledAttr}>${opts}</select>` +
            `<button type="button" class="action-pill ac-mini-btn" data-auto-consent-action="grant-session" data-scope="rig" data-target="${escapeHtml(rigId)}" data-profile="trusted_dev" data-ttl-min="60"${disabledAttr}>${escapeHtml(td('autoConsent.grantSessionBtn'))}</button>` +
          `</div>` +
        `</div>`;
      }).join('');

  const seatRowsHtml = seatList.length === 0
    ? `<div class="ac-empty-note">${escapeHtml(en ? 'No active seats discovered yet.' : 'Активные сиденья ещё не обнаружены.')}</div>`
    : seatList.map((seat) => {
        const seatId = String(seat.id || seat.seatId || seat.canonicalSessionName || '');
        const rigId = inferRigId(seatId);
        const explicitProfile = cfg.seats?.[seatId]?.profile || 'inherit';
        const parentProfile = (rigId && cfg.projects?.[rigId]?.profile) || AUTO_CONSENT_PROFILES.OFF;
        const effective = resolveEffectiveConsentPolicy(cfg, sessionGrants, {
          rigId,
          seatId,
          seatSessionEpoch: getSeatEpochForDisplay(seat, sessionGrants),
          nowMs
        });
        const effClass = effective.active
          ? (cfg.mode === AUTO_CONSENT_MODES.ARMED ? 'is-active' : 'is-dry')
          : (effective.profile === AUTO_CONSENT_PROFILES.MANUAL_ONLY ? 'is-deny' : 'is-off');
        const effText = cfg.masterPaused
          ? td('autoConsent.hudPaused')
          : `${getProfileLabel(effective.profile, td)} · ${getScopeLabel(effective.sourceScope, td)}`;
        const ctxVal = typeof seat.ctxPct === 'number'
          ? seat.ctxPct
          : (typeof seat.contextUsage?.usedPercentage === 'number' ? seat.contextUsage.usedPercentage : null);
        const isCtxHot = ctxVal !== null && cfg.defaults.pauseOnCtxOverheat && ctxVal >= cfg.defaults.ctxPauseThresholdPct;
        const opts = [
          { val: 'inherit', label: td('autoConsent.inheritedLabel', { profile: getProfileLabel(parentProfile, td) }) },
          { val: AUTO_CONSENT_PROFILES.OFF, label: getProfileLabel(AUTO_CONSENT_PROFILES.OFF, td) },
          { val: AUTO_CONSENT_PROFILES.MANUAL_ONLY, label: getProfileLabel(AUTO_CONSENT_PROFILES.MANUAL_ONLY, td) },
          { val: AUTO_CONSENT_PROFILES.SAFE_READONLY, label: getProfileLabel(AUTO_CONSENT_PROFILES.SAFE_READONLY, td) },
          { val: AUTO_CONSENT_PROFILES.TRUSTED_DEV, label: getProfileLabel(AUTO_CONSENT_PROFILES.TRUSTED_DEV, td) }
        ].map((o) => `<option value="${escapeHtml(o.val)}"${explicitProfile === o.val ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');

        return `<div class="ac-policy-row">` +
          `<div class="ac-policy-target">` +
            `<b>${escapeHtml(shortSeat(seatId))}</b>` +
            `<span class="ac-eff-chip ${effClass}">${escapeHtml(effText)}</span>` +
            `${isCtxHot ? `<span class="ac-ctx-warn-chip">CTX ${escapeHtml(ctxVal)}%</span>` : ''}` +
          `</div>` +
          `<div class="ac-policy-controls">` +
            `<select class="rig-select ac-policy-select" aria-label="${escapeHtml(seatId)}" data-auto-consent-action="set-seat-policy" data-target="${escapeHtml(seatId)}"${disabledAttr}>${opts}</select>` +
            `<button type="button" class="action-pill ac-mini-btn" data-auto-consent-action="grant-session" data-scope="seat" data-target="${escapeHtml(seatId)}" data-profile="trusted_dev" data-ttl-min="60"${disabledAttr}>${escapeHtml(td('autoConsent.grantSessionBtn'))}</button>` +
          `</div>` +
        `</div>`;
      }).join('');

  const grantsHtml = activeGrants.length === 0
    ? `<div class="ac-empty-note">${escapeHtml(td('autoConsent.noSessions'))}</div>`
    : activeGrants.map(({ grant, remainingMin, remainingApprovals, effectiveMax }) => {
        const meta = td('autoConsent.remainingMeta', {
          min: remainingMin,
          left: remainingApprovals,
          max: effectiveMax
        });
        return `<div class="ac-grant-row">` +
          `<div class="ac-grant-info">` +
            `<span class="ac-scope-chip is-scope">${escapeHtml(getScopeLabel(grant.scope, td))}</span>` +
            `<b>${escapeHtml(grant.scope === 'seat' ? shortSeat(grant.targetId) : grant.targetId)}</b>` +
            `<span class="ac-scope-chip is-profile">${escapeHtml(getProfileLabel(grant.profile, td))}</span>` +
            `<span class="ac-grant-meta">${escapeHtml(meta)}</span>` +
          `</div>` +
          `<button type="button" class="action-pill key-cancel ac-mini-btn" data-auto-consent-action="revoke-grant" data-grant-id="${escapeHtml(grant.grantId)}"${disabledAttr}>${escapeHtml(td('autoConsent.revokeGrantBtn'))}</button>` +
        `</div>`;
      }).join('');

  const runsHtml = recentRuns.length === 0
    ? `<div class="ac-empty-note">${escapeHtml(td('autoConsent.noRuns'))}</div>`
    : recentRuns.slice(0, 10).map((run) => {
        const outcome = String(run.outcome || run.decision || run.status || 'escalate');
        const isApproved = outcome === 'approved' || outcome === 'approve_once' || outcome === 'executed';
        const isDry = outcome === 'dry_run';
        const isCanceled = outcome === 'canceled' || run.vetoCode === AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED;
        const toneClass = isApproved ? 'is-approved' : (isDry ? 'is-dry' : (isCanceled ? 'is-canceled' : 'is-escalated'));
        const badgeText = isApproved
          ? td('autoConsent.decisionApprove')
          : (isDry ? td('autoConsent.decisionDryRun') : (isCanceled ? td('autoConsent.toastCanceled') : td('autoConsent.decisionEscalate')));
        const vetoDetail = run.vetoCode
          ? getVetoLabel(run.vetoCode, run.reason || '', { td, ctxPct: run.ctxPct })
          : (run.reason || '');
        const clock = formatClock(run.at || run.timestampMs || run.resolvedAtMs, deckLang);

        return `<div class="ac-run-row ${toneClass}">` +
          `<div class="ac-run-main">` +
            `<div class="ac-run-head">` +
              `<span class="ac-run-status">${escapeHtml(badgeText)}</span>` +
              `<b>${escapeHtml(shortSeat(run.seatId || ''))}</b>` +
              `${run.sourceScope ? `<span class="ac-scope-chip is-scope">${escapeHtml(getScopeLabel(run.sourceScope, td))}</span>` : ''}` +
              `${run.vetoCode ? `<span class="pb-veto-chip">${escapeHtml(run.vetoCode)}</span>` : ''}` +
            `</div>` +
            `${run.commandPreview ? `<code class="ac-run-cmd">${escapeHtml(run.commandPreview)}</code>` : ''}` +
            `${vetoDetail ? `<div class="ac-run-detail">${escapeHtml(vetoDetail)}</div>` : ''}` +
          `</div>` +
          `${clock ? `<span class="ac-run-clock">${escapeHtml(clock)}</span>` : ''}` +
        `</div>`;
      }).join('');

  const graceOptions = [
    { ms: 1500, label: en ? '1.5s (Fast)' : '1.5с (Быстро)' },
    { ms: 3000, label: en ? '3s (Default)' : '3с (По умолчанию)' },
    { ms: 5000, label: en ? '5s (Cautious)' : '5с (Осторожно)' }
  ];
  const selectedGrace = graceOptions.some((g) => g.ms === cfg.graceWindowMs) ? cfg.graceWindowMs : 3000;

  return `<div class="ac-tab-wrap">` +
    `${demoTrack ? `<div class="ac-demo-notice">${escapeHtml(td('autoConsent.demoTrackBanner'))}</div>` : ''}` +
    `${cfg.masterPaused ? `<div class="ac-paused-banner"><span>${escapeHtml(td('autoConsent.pausedBanner'))}</span><button type="button" class="action-pill key-proceed" data-auto-consent-action="resume-all"${disabledAttr}>${escapeHtml(td('autoConsent.resumeAllBtn'))}</button></div>` : ''}` +
    `<div class="ac-subtitle-box">${escapeHtml(td('autoConsent.subtitle'))}</div>` +

    `<div class="ac-top-grid">` +
      `<section class="ac-card">` +
        `<div class="ac-card-head">` +
          `<label class="ac-check-label is-master">` +
            `<input type="checkbox" id="acMasterEnable"${cfg.enabled ? ' checked' : ''}${disabledAttr} />` +
            `<span>${escapeHtml(td('autoConsent.masterEnable'))}</span>` +
          `</label>` +
          `<span class="ac-quota-chip">${escapeHtml(en ? 'Quota' : 'Квота')}: <b>${escapeHtml(stats.actionsLastHour)} / ${escapeHtml(cfg.maxActionsPerHour)}/h</b></span>` +
        `</div>` +
        `<div class="ac-inline-row">` +
          `<select id="acModeSelect" class="rig-select ac-mode-select"${disabledAttr}>` +
            `<option value="dry_run"${cfg.mode === AUTO_CONSENT_MODES.DRY_RUN ? ' selected' : ''}>${escapeHtml(td('autoConsent.modeDryRun'))}</option>` +
            `<option value="armed"${cfg.mode === AUTO_CONSENT_MODES.ARMED ? ' selected' : ''}>${escapeHtml(td('autoConsent.modeArmed'))}</option>` +
          `</select>` +
        `</div>` +
        `<div class="ac-stats-strip">` +
          `<span>${escapeHtml(en ? 'Approved' : 'Одобрено')}: <b class="ac-stat-ok">${escapeHtml(stats.approvedCount)}</b></span>` +
          `<span>${escapeHtml(en ? 'Escalated' : 'Эскалаций')}: <b class="ac-stat-warn">${escapeHtml(stats.escalatedCount)}</b></span>` +
          `<span>${escapeHtml(en ? 'Canceled' : 'Отменено')}: <b class="ac-stat-cancel">${escapeHtml(stats.canceledCount)}</b></span>` +
        `</div>` +
        `<div class="ac-btn-row">` +
          `<button type="button" class="action-pill key-proceed" data-auto-consent-action="save-policy"${disabledAttr}>${escapeHtml(td('autoConsent.saveBtn'))}</button>` +
          `<button type="button" class="action-pill ${cfg.masterPaused ? 'key-proceed' : 'key-cancel'}" data-auto-consent-action="${cfg.masterPaused ? 'resume-all' : 'pause-all'}"${disabledAttr}>${escapeHtml(cfg.masterPaused ? td('autoConsent.resumeAllBtn') : td('autoConsent.pauseAllBtn'))}</button>` +
        `</div>` +
      `</section>` +

      `<section class="ac-card">` +
        `<div class="ac-section-title">🛡️ ${escapeHtml(td('autoConsent.settingsTitle'))}</div>` +
        `<div class="ac-setting-row">` +
          `<label for="acGraceWindowSelect">${escapeHtml(td('autoConsent.graceWindowLabel'))}</label>` +
          `<select id="acGraceWindowSelect" class="rig-select ac-compact-select"${disabledAttr}>` +
            `${graceOptions.map((g) => `<option value="${g.ms}"${selectedGrace === g.ms ? ' selected' : ''}>${escapeHtml(g.label)}</option>`).join('')}` +
          `</select>` +
        `</div>` +
        `<div class="ac-setting-row">` +
          `<label class="ac-check-label">` +
            `<input type="checkbox" id="acPauseCtxCheck"${cfg.defaults.pauseOnCtxOverheat ? ' checked' : ''}${disabledAttr} />` +
            `<span>${escapeHtml(td('autoConsent.ctxOverheatToggle'))}</span>` +
          `</label>` +
          `<label class="ac-threshold-wrap">` +
            `<span>${escapeHtml(td('autoConsent.ctxThresholdLabel'))}</span>` +
            `<input id="acCtxThresholdInput" type="number" min="${AUTO_CONSENT_LIMITS.MIN_CTX_THRESHOLD_PCT}" max="${AUTO_CONSENT_LIMITS.MAX_CTX_THRESHOLD_PCT}" value="${escapeHtml(cfg.defaults.ctxPauseThresholdPct)}" class="ctrl-input ac-num-input"${disabledAttr} />` +
          `</label>` +
        `</div>` +
        `<div class="ac-setting-row">` +
          `<label class="ac-check-label">` +
            `<input type="checkbox" id="acAllowPkgCheck"${cfg.defaults.allowPackageInstall ? ' checked' : ''}${disabledAttr} />` +
            `<span>${escapeHtml(td('autoConsent.allowPkgInstallLabel'))}</span>` +
          `</label>` +
          `<span class="ac-default-off-chip">${escapeHtml(td('autoConsent.defaultOffHint'))}</span>` +
        `</div>` +
        `<div class="ac-setting-row">` +
          `<label class="ac-check-label">` +
            `<input type="checkbox" id="acAllowNetCheck"${cfg.defaults.allowReadOnlyNetwork ? ' checked' : ''}${disabledAttr} />` +
            `<span>${escapeHtml(td('autoConsent.allowReadOnlyNetLabel'))}</span>` +
          `</label>` +
          `<span class="ac-default-off-chip">${escapeHtml(td('autoConsent.defaultOffHint'))}</span>` +
        `</div>` +
      `</section>` +
    `</div>` +

    `${statusMessage ? `<div class="ac-status-banner" role="status">${escapeHtml(statusMessage)}</div>` : ''}` +

    `<div class="ac-scopes-grid">` +
      `<section class="ac-card">` +
        `<div class="ac-section-title">🏛️ ${escapeHtml(td('autoConsent.projectsTitle'))}</div>` +
        `<div class="ac-policy-list">${projectRowsHtml}</div>` +
      `</section>` +
      `<section class="ac-card">` +
        `<div class="ac-section-title">🤖 ${escapeHtml(td('autoConsent.seatsTitle'))}</div>` +
        `<div class="ac-policy-list">${seatRowsHtml}</div>` +
      `</section>` +
    `</div>` +

    `<section class="ac-card">` +
      `<div class="ac-section-title">⏱️ ${escapeHtml(td('autoConsent.sessionsTitle'))} (${activeGrants.length})</div>` +
      `<div class="ac-policy-list">${grantsHtml}</div>` +
    `</section>` +

    `<section class="ac-card">` +
      `<div class="ac-section-title">📜 ${escapeHtml(td('autoConsent.recentRunsTitle'))}</div>` +
      `<div class="ac-runs-list">${runsHtml}</div>` +
    `</section>` +
  `</div>`;
}

/**
 * Compact Seat Inspector quick policy picker.
 */
export function renderSeatAutoConsentPickerHtml({
  seat = null,
  state: rawState = null,
  td,
  lang = 'en',
  nowMs = Date.now(),
  busy = false
} = {}) {
  const seatId = String(seat?.id || seat?.seatId || seat?.canonicalSessionName || '').trim();
  if (!seatId) return '';

  const state = normalizeAutoConsentState(rawState, nowMs);
  const { config: cfg, sessionGrants } = state;
  const rigId = inferRigId(seatId);
  const explicitProfile = cfg.seats?.[seatId]?.profile || 'inherit';
  const parentProfile = (rigId && cfg.projects?.[rigId]?.profile) || AUTO_CONSENT_PROFILES.OFF;
  const seatEpoch = getSeatEpochForDisplay(seat, sessionGrants);
  const effective = resolveEffectiveConsentPolicy(cfg, sessionGrants, {
    rigId,
    seatId,
    seatSessionEpoch: seatEpoch,
    nowMs
  });

  const activeSeatGrant = getActiveSessionGrants(sessionGrants, nowMs).find(
    (entry) => entry.grant.scope === 'seat' && entry.grant.targetId === seatId && (!seatEpoch || entry.grant.seatSessionEpoch === seatEpoch)
  );

  const disabledAttr = busy ? ' disabled' : '';
  const effClass = cfg.masterPaused
    ? 'is-deny'
    : (effective.active
      ? (cfg.mode === AUTO_CONSENT_MODES.ARMED ? 'is-active' : 'is-dry')
      : (effective.profile === AUTO_CONSENT_PROFILES.MANUAL_ONLY ? 'is-deny' : 'is-off'));

  const effSummary = cfg.masterPaused
    ? td('autoConsent.hudPaused')
    : (effective.active && effective.sourceScope === 'session' && activeSeatGrant
      ? `${getProfileLabel(effective.profile, td)} (${formatTtlShort(activeSeatGrant.remainingMin, lang)})`
      : `${getProfileLabel(effective.profile, td)}${effective.active ? ` · ${getScopeLabel(effective.sourceScope, td)}` : ''}`);

  const options = [
    { val: 'inherit', label: td('autoConsent.inheritedLabel', { profile: getProfileLabel(parentProfile, td) }) },
    { val: AUTO_CONSENT_PROFILES.MANUAL_ONLY, label: getProfileLabel(AUTO_CONSENT_PROFILES.MANUAL_ONLY, td) },
    { val: AUTO_CONSENT_PROFILES.SAFE_READONLY, label: getProfileLabel(AUTO_CONSENT_PROFILES.SAFE_READONLY, td) },
    { val: AUTO_CONSENT_PROFILES.TRUSTED_DEV, label: getProfileLabel(AUTO_CONSENT_PROFILES.TRUSTED_DEV, td) }
  ];
  if (explicitProfile === AUTO_CONSENT_PROFILES.OFF) {
    options.splice(1, 0, { val: AUTO_CONSENT_PROFILES.OFF, label: getProfileLabel(AUTO_CONSENT_PROFILES.OFF, td) });
  }

  const sessionControl = activeSeatGrant
    ? `<button type="button" class="action-pill key-cancel ac-insp-btn" data-auto-consent-action="revoke-grant" data-grant-id="${escapeHtml(activeSeatGrant.grant.grantId)}" title="${escapeHtml(td('autoConsent.remainingMeta', { min: activeSeatGrant.remainingMin, left: activeSeatGrant.remainingApprovals, max: activeSeatGrant.effectiveMax }))}"${disabledAttr}>${escapeHtml(td('autoConsent.revokeGrantBtn'))} (${escapeHtml(formatTtlShort(activeSeatGrant.remainingMin, lang))})</button>`
    : `<button type="button" class="action-pill ac-insp-btn" data-auto-consent-action="grant-session" data-scope="seat" data-target="${escapeHtml(seatId)}" data-profile="trusted_dev" data-ttl-min="60"${disabledAttr}>${escapeHtml(td('autoConsent.grantSessionBtn'))}</button>`;

  return `<div class="ac-inspector-strip" data-seat="${escapeHtml(seatId)}">` +
    `<div class="ac-inspector-head">` +
      `<span class="ac-inspector-label">${escapeHtml(td('autoConsent.tabTitle'))}</span>` +
      `<span class="ac-eff-chip ${effClass}">${escapeHtml(effSummary)}</span>` +
      `<button type="button" class="ac-insp-gear" data-auto-consent-action="open-tab" aria-label="${escapeHtml(td('autoConsent.modalTitle'))}" title="${escapeHtml(td('autoConsent.modalTitle'))}">⚙️</button>` +
    `</div>` +
    `<div class="ac-inspector-controls">` +
      `<select class="rig-select ac-insp-select" aria-label="${escapeHtml(td('autoConsent.tabTitle'))}" data-auto-consent-action="set-seat-policy" data-target="${escapeHtml(seatId)}"${disabledAttr}>` +
        `${options.map((o) => `<option value="${escapeHtml(o.val)}"${explicitProfile === o.val ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}` +
      `</select>` +
      `${sessionControl}` +
    `</div>` +
  `</div>`;
}

/**
 * HITL prompt quick action beside [1] Allow once:
 * Renders `⚡ Allow + Trust Session 60m` ONLY when Option 1 is a safe single-use Allow
 * and the visible command does NOT trigger a Hard Safety Veto.
 */
export function renderHitlTrustSessionBtnHtml({
  seatId = '',
  screenText = '',
  td,
  statusElId = 'cmdSendStatus',
  disabled = false
} = {}) {
  const cleanSeat = String(seatId || '').trim();
  if (!cleanSeat || typeof screenText !== 'string' || !screenText.trim()) return '';
  const { preview, fullCommand, options } = getHitlPromptPresentation(screenText);
  if (!Array.isArray(options) || options.length < 2) return '';
  const opt1 = options.find((o) => o && String(o.badge) === '1');
  if (!opt1 || opt1.isCancel) return '';
  const opt1Text = String(opt1.fullText || opt1.shortLabel || '');
  if (PERSISTENT_ALLOW_RE.test(opt1Text)) return '';
  if (classifyDestructiveVetoes(fullCommand || preview || '').length > 0) return '';

  return `<button type="button" class="action-pill key-pill ac-hitl-trust-btn" data-auto-consent-action="hitl-trust-session" data-seat="${escapeHtml(cleanSeat)}" data-status="${escapeHtml(statusElId)}"${disabled ? ' disabled' : ''}>${escapeHtml(td('autoConsent.hitlTrustSessionBtn'))}</button>`;
}

/**
 * Interactive simulation strip strictly for `/demo?track=auto-consent` (0 network calls).
 */
export function renderAutoConsentDemoBarHtml({
  demoTrack = false,
  state: rawState = null,
  activeDemoStep = '',
  demoNote = '',
  td,
  lang = 'en'
} = {}) {
  if (!demoTrack) return '';
  const en = lang === 'en';
  const state = normalizeAutoConsentState(rawState);
  const paused = state.config.masterPaused;
  const stepBtn = (id, action, label) =>
    `<button type="button" class="action-pill ac-demo-step-btn${activeDemoStep === id ? ' active' : ''}" data-auto-consent-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;

  return `<aside class="ac-demo-bar" aria-live="polite">` +
    `<div class="ac-demo-bar-head">` +
      `<span class="ac-demo-bar-title">${escapeHtml(td('autoConsent.demoTrackBanner'))}</span>` +
      `<div class="ac-demo-bar-steps">` +
        `${stepBtn('enable', 'demo-enable', en ? '1. Enable Trusted Dev' : '1. Вкл. Trusted Dev')}` +
        `${stepBtn('routine', 'demo-routine', en ? '2. npm test (3s Cancel)' : '2. npm test (3с Отмена)')}` +
        `${stepBtn('veto', 'demo-veto', en ? '3. git push (Hard Veto)' : '3. git push (Hard Veto)')}` +
        `${stepBtn('pause', 'demo-pause', paused ? td('autoConsent.resumeAllBtn') : `4. ${td('autoConsent.pauseAllBtn')}`)}` +
        `<button type="button" class="action-pill ac-demo-step-btn is-accent" data-auto-consent-action="open-tab">${escapeHtml(td('autoConsent.tabTitle'))} ⚙️</button>` +
      `</div>` +
    `</div>` +
    `${demoNote ? `<div class="ac-demo-bar-note">${escapeHtml(demoNote)}</div>` : ''}` +
  `</aside>`;
}

const DEMO_RIG = 'core-platform';
const DEMO_SEAT = 'dev-check@core-platform';
const DEMO_EPOCH = 'demo-epoch-dev-check@core-platform';

export function buildDemoAutoConsentPrompts(lang = 'en') {
  const en = lang === 'en';
  return {
    routineScreen: en
      ? `[${DEMO_SEAT}] core-platform (codex • gpt-6.2-sol)\nRequesting permission for:\n  $ npm test\nRun this command?\n› 1. Yes, allow once (y)\n  2. Yes, always allow in this worktree\n  3. No, cancel and tell agent (esc)`
      : `[${DEMO_SEAT}] core-platform (codex • gpt-6.2-sol)\nRequesting permission for:\n  $ npm test\nRun this command?\n› 1. Да, разрешить один раз (y)\n  2. Да, всегда разрешать в этом рабочем дереве\n  3. Нет, отменить и сообщить агенту (esc)`,
    vetoScreen: en
      ? `[${DEMO_SEAT}] core-platform (codex • gpt-6.2-sol)\nRequesting permission for:\n  $ git push origin main\nRun this command?\n› 1. Yes, allow once (y)\n  2. No, cancel and tell agent (esc)`
      : `[${DEMO_SEAT}] core-platform (codex • gpt-6.2-sol)\nRequesting permission for:\n  $ git push origin main\nRun this command?\n› 1. Да, разрешить один раз (y)\n  2. Нет, отменить и сообщить агенту (esc)`
  };
}

export function buildDemoAutoConsentInitialState({ active = false, nowMs = Date.now() } = {}) {
  if (!active) {
    return normalizeAutoConsentState({ config: DEFAULT_AUTO_CONSENT_CONFIG }, nowMs);
  }
  const config = sanitizeAutoConsentConfig({
    enabled: true,
    mode: AUTO_CONSENT_MODES.ARMED,
    masterPaused: false,
    graceWindowMs: AUTO_CONSENT_LIMITS.DEFAULT_GRACE_MS,
    projects: { [DEMO_RIG]: { profile: AUTO_CONSENT_PROFILES.TRUSTED_DEV } }
  }, DEFAULT_AUTO_CONSENT_CONFIG);
  const created = createSessionGrant({
    grantId: 'demo-grant-dev-check',
    scope: 'seat',
    targetId: DEMO_SEAT,
    profile: AUTO_CONSENT_PROFILES.TRUSTED_DEV,
    ttlMin: 60,
    maxApprovals: 25,
    seatSessionEpoch: DEMO_EPOCH,
    nowMs
  });
  const grant = created.ok ? { ...created.grant, usedApprovals: 1 } : null;
  return normalizeAutoConsentState({
    config,
    sessionGrants: grant ? [grant] : [],
    pendingApprovals: [],
    recentRuns: [
      {
        id: 'demo-run-seed-1',
        seatId: 'dev-coder4@core-platform',
        outcome: 'approved',
        decision: 'approve_once',
        matchedProfile: AUTO_CONSENT_PROFILES.TRUSTED_DEV,
        sourceScope: 'project',
        commandPreview: 'node --test tests/boundaries.test.mjs',
        reason: 'Matched trusted_dev policy (project) — Option 1 (Allow Once)',
        at: new Date(nowMs - 110_000).toISOString()
      }
    ],
    stats: {
      approvedCount: 1,
      escalatedCount: 0,
      canceledCount: 0,
      actionsLastHour: 1
    }
  }, nowMs);
}

/**
 * Explicit event & timer controller for Auto-Consent UI.
 * Zero background timers when no grace-window countdown is active.
 * Zero /api/* requests in demo or non-live modes.
 */
export function createAutoConsentController({
  hudRoot = null,
  toastRoot = null,
  inspectorRoot = null,
  demoBarRoot = null,
  guardrailsBodyRoot = null,
  hitlRoots = [],
  td,
  lang = () => 'en',
  isLive = () => false,
  demo = false,
  demoTrack = false,
  getAgents = () => [],
  getRigs = () => [],
  getSelectedSeat = () => null,
  getJson,
  postJson,
  sendAllowOnce = () => {},
  onOpenTab = () => {},
  onGuardrailsRerender = () => {},
  onDemoScreenUpdate = () => {},
  onToastNotice = () => {},
  now = Date.now,
  setIntervalFn = (...args) => globalThis.setInterval(...args),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
  setTimeoutFn = (...args) => globalThis.setTimeout(...args),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  guard = new ActionFlightGuard()
} = {}) {
  let state = buildDemoAutoConsentInitialState({ active: false, nowMs: now() });
  let isDemoTrack = Boolean(demoTrack);
  let activeDemoStep = '';
  let demoNote = '';
  let statusMessage = '';
  let destroyed = false;
  let refreshing = null;
  let countdownInterval = null;
  const demoTimers = new Map();
  const lockScope = 'auto-consent:operator';
  const busy = () => guard.isScopeInFlight(lockScope);

  function stopCountdownTicker() {
    if (countdownInterval !== null) {
      clearIntervalFn(countdownInterval);
      countdownInterval = null;
    }
  }

  function clearAllDemoTimers() {
    for (const handle of demoTimers.values()) {
      clearTimeoutFn(handle);
    }
    demoTimers.clear();
  }

  function syncCountdownTicker() {
    if (destroyed) {
      stopCountdownTicker();
      return;
    }
    if (state.pendingApprovals.length > 0) {
      if (countdownInterval === null) {
        countdownInterval = setIntervalFn(() => {
          if (destroyed || state.pendingApprovals.length === 0) {
            stopCountdownTicker();
            return;
          }
          renderToast();
        }, 150);
      }
    } else {
      stopCountdownTicker();
    }
  }

  function renderHud() {
    if (destroyed || !hudRoot) return;
    hudRoot.innerHTML = renderAutoConsentHudPillHtml(state, {
      td,
      lang: lang(),
      nowMs: now(),
      busy: busy()
    });
  }

  function renderToast() {
    if (destroyed || !toastRoot) return;
    toastRoot.innerHTML = renderPendingConsentToastHtml(state.pendingApprovals, {
      td,
      nowMs: now(),
      shortSeat: (s) => {
        const a = array(getAgents()).find((x) => x && x.id === s);
        return a?.shortName || String(s || '').split('@')[0] || String(s || '');
      },
      busy: busy()
    });
  }

  function renderInspector(seatOverride = null) {
    if (destroyed || !inspectorRoot) return;
    const seat = seatOverride || getSelectedSeat();
    inspectorRoot.innerHTML = renderSeatAutoConsentPickerHtml({
      seat,
      state,
      td,
      lang: lang(),
      nowMs: now(),
      busy: busy()
    });
  }

  function renderDemoBar() {
    if (destroyed || !demoBarRoot) return;
    demoBarRoot.innerHTML = renderAutoConsentDemoBarHtml({
      demoTrack: isDemoTrack,
      state,
      activeDemoStep,
      demoNote,
      td,
      lang: lang()
    });
  }

  function renderTabHtml() {
    return renderAutoConsentTabHtml({
      state,
      rigs: getRigs(),
      agents: getAgents(),
      td,
      deckLang: lang(),
      shortSeat: (s) => {
        const a = array(getAgents()).find((x) => x && x.id === s);
        return a?.shortName || String(s || '').split('@')[0] || String(s || '');
      },
      nowMs: now(),
      statusMessage,
      demoTrack: isDemoTrack,
      busy: busy()
    });
  }

  function renderAll() {
    if (destroyed) return;
    syncCountdownTicker();
    renderHud();
    renderToast();
    renderInspector();
    renderDemoBar();
    onGuardrailsRerender();
  }

  function setState(nextRawState) {
    if (destroyed) return;
    state = normalizeAutoConsentState(nextRawState, now());
    renderAll();
  }

  function handleSseEvent(eventType, payload = {}) {
    if (destroyed || !payload || typeof payload !== 'object') return;
    if (eventType === 'auto_consent_state') {
      setState(payload.state || payload);
      return;
    }
    if (eventType === 'auto_consent_pending') {
      if (payload.state) {
        setState(payload.state);
        return;
      }
      const pending = payload.pending || payload;
      if (!pending || !pending.id) return;
      const filtered = state.pendingApprovals.filter(
        (p) => p.id !== pending.id && (!pending.seatId || p.seatId !== pending.seatId)
      );
      state = normalizeAutoConsentState({
        ...state,
        pendingApprovals: [pending, ...filtered]
      }, now());
      renderAll();
      return;
    }
    if (eventType === 'auto_consent_resolved') {
      const pendingId = payload.pendingId || payload.id || payload.run?.pendingId || '';
      const seatId = payload.seatId || payload.run?.seatId || '';
      const outcome = String(payload.outcome || payload.decision || payload.run?.outcome || '');
      if (payload.state) {
        setState(payload.state);
      } else {
        const remaining = state.pendingApprovals.filter(
          (p) => (pendingId ? p.id !== pendingId : true) && (seatId ? p.seatId !== seatId : true)
        );
        const nextRuns = payload.run ? [payload.run, ...state.recentRuns].slice(0, 40) : state.recentRuns;
        state = normalizeAutoConsentState({
          ...state,
          pendingApprovals: remaining,
          recentRuns: nextRuns
        }, now());
        renderAll();
      }
      if (outcome === 'approved' || outcome === 'approve_once') {
        onToastNotice(td('autoConsent.toastApproved', { seat: seatId.split('@')[0] || seatId }));
      } else if (outcome === 'canceled') {
        onToastNotice(td('autoConsent.toastCanceled'));
      }
    }
  }

  async function refresh() {
    if (destroyed || demo || !isLive()) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await getJson('/api/auto-consent/state');
        if (!destroyed && res && (res.state || res.config)) {
          setState(res.state || res);
        }
      } catch {
        // Keep last observed state on transient failure.
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function applyDemoPolicyPatch(patch, { scope = '', targetId = '', profile = '' } = {}) {
    const nextCfg = scope === 'project' && targetId
      ? sanitizeAutoConsentConfig({ projects: { [targetId]: { profile } } }, state.config)
      : (scope === 'seat' && targetId
        ? sanitizeAutoConsentConfig({ seats: { [targetId]: { profile } } }, state.config)
        : sanitizeAutoConsentConfig(patch || {}, state.config));
    state = normalizeAutoConsentState({ ...state, config: nextCfg }, now());
    statusMessage = lang() === 'en' ? '✓ [DEMO] Auto-consent policy updated.' : '✓ [ДЕМО] Политика авто-подтверждений обновлена.';
    renderAll();
  }

  function applyDemoGrantCreate({ scope, targetId, profile, ttlMin = 60, maxApprovals = 25, seatSessionEpoch = null, autoArm = false }) {
    const ts = now();
    const epoch = scope === 'seat' ? (seatSessionEpoch || `demo-epoch-${targetId}`) : null;
    const created = createSessionGrant({
      grantId: `demo-grant-${ts.toString(36)}`,
      scope,
      targetId,
      profile,
      ttlMin,
      maxApprovals,
      seatSessionEpoch: epoch,
      nowMs: ts
    });
    if (!created.ok) {
      statusMessage = `✕ ${created.error}`;
      renderAll();
      return;
    }
    let nextCfg = state.config;
    if (!nextCfg.enabled) {
      nextCfg = sanitizeAutoConsentConfig({
        enabled: true,
        mode: autoArm ? AUTO_CONSENT_MODES.ARMED : nextCfg.mode
      }, nextCfg);
    } else if (autoArm && nextCfg.mode !== AUTO_CONSENT_MODES.ARMED) {
      nextCfg = sanitizeAutoConsentConfig({ mode: AUTO_CONSENT_MODES.ARMED }, nextCfg);
    }
    const grants = [
      created.grant,
      ...state.sessionGrants.filter((g) => !(g.scope === scope && g.targetId === targetId && g.revoked !== true))
    ];
    state = normalizeAutoConsentState({
      ...state,
      config: nextCfg,
      sessionGrants: grants
    }, ts);
    statusMessage = lang() === 'en'
      ? `✓ [DEMO] Session grant active (${ttlMin}m, ${created.grant.maxApprovals} approvals).`
      : `✓ [ДЕМО] Временная сессия активна (${ttlMin}м, до ${created.grant.maxApprovals} подтверждений).`;
    renderAll();
  }

  function applyDemoGrantRevoke(grantId) {
    const grants = state.sessionGrants.map((g) => (g.grantId === grantId ? { ...g, revoked: true } : g));
    state = normalizeAutoConsentState({ ...state, sessionGrants: grants }, now());
    statusMessage = lang() === 'en' ? '✓ [DEMO] Session grant revoked.' : '✓ [ДЕМО] Временная сессия отозвана.';
    renderAll();
  }

  function applyDemoPauseAll(paused) {
    const nextPaused = Boolean(paused);
    let canceledCount = 0;
    let nextRuns = state.recentRuns;
    if (nextPaused) {
      clearAllDemoTimers();
      canceledCount = state.pendingApprovals.length;
      if (canceledCount > 0) {
        const ts = new Date(now()).toISOString();
        const canceledRuns = state.pendingApprovals.map((p) => ({
          id: `demo-paused-${p.id}`,
          seatId: p.seatId,
          outcome: 'canceled',
          decision: 'escalate',
          vetoCode: AUTO_CONSENT_VETO_CODES.MASTER_PAUSED,
          sourceScope: p.sourceScope,
          commandPreview: p.commandPreview,
          reason: td('autoConsent.pausedBanner'),
          at: ts
        }));
        nextRuns = [...canceledRuns, ...state.recentRuns].slice(0, 40);
      }
    }
    const nextCfg = sanitizeAutoConsentConfig({ masterPaused: nextPaused }, state.config);
    state = normalizeAutoConsentState({
      ...state,
      config: nextCfg,
      pendingApprovals: nextPaused ? [] : state.pendingApprovals,
      recentRuns: nextRuns,
      stats: {
        ...state.stats,
        canceledCount: state.stats.canceledCount + canceledCount
      }
    }, now());
    if (isDemoTrack) {
      activeDemoStep = 'pause';
      demoNote = nextPaused
        ? td('autoConsent.pausedBanner')
        : (lang() === 'en' ? '▶ Auto-consent resumed.' : '▶ Авто-подтверждения возобновлены.');
    }
    statusMessage = nextPaused ? td('autoConsent.pausedBanner') : (lang() === 'en' ? '▶ Resumed.' : '▶ Возобновлено.');
    renderAll();
  }

  function applyDemoCancelPending(pendingId, seatId) {
    const matches = state.pendingApprovals.filter(
      (p) => (pendingId && p.id === pendingId) || (!pendingId && seatId && p.seatId === seatId)
    );
    if (!matches.length) return;
    for (const p of matches) {
      const handle = demoTimers.get(p.id);
      if (handle !== undefined) {
        clearTimeoutFn(handle);
        demoTimers.delete(p.id);
      }
    }
    const ids = new Set(matches.map((m) => m.id));
    const ts = new Date(now()).toISOString();
    const canceledRuns = matches.map((p) => ({
      id: `demo-cancel-${p.id}`,
      seatId: p.seatId,
      outcome: 'canceled',
      decision: 'escalate',
      vetoCode: AUTO_CONSENT_VETO_CODES.OPERATOR_CANCELED,
      sourceScope: p.sourceScope,
      commandPreview: p.commandPreview,
      reason: td('autoConsent.toastCanceled'),
      at: ts
    }));
    state = normalizeAutoConsentState({
      ...state,
      pendingApprovals: state.pendingApprovals.filter((p) => !ids.has(p.id)),
      recentRuns: [...canceledRuns, ...state.recentRuns].slice(0, 40),
      stats: {
        ...state.stats,
        canceledCount: state.stats.canceledCount + matches.length
      }
    }, now());
    demoNote = td('autoConsent.toastCanceled');
    onToastNotice(td('autoConsent.toastCanceled'));
    renderAll();
  }

  function triggerDemoRoutinePrompt() {
    clearAllDemoTimers();
    const ts = now();
    if (!state.config.enabled || state.config.masterPaused || state.config.mode !== AUTO_CONSENT_MODES.ARMED) {
      state = buildDemoAutoConsentInitialState({ active: true, nowMs: ts });
    }
    const prompts = buildDemoAutoConsentPrompts(lang());
    const seat = { id: DEMO_SEAT, harness: 'codex', ctxPct: 38, seatSessionEpoch: DEMO_EPOCH };
    const effectivePolicy = resolveEffectiveConsentPolicy(state.config, state.sessionGrants, {
      rigId: DEMO_RIG,
      seatId: DEMO_SEAT,
      seatSessionEpoch: DEMO_EPOCH,
      nowMs: ts
    });
    const evalRes = evaluateAutoConsentPrompt({
      screenText: prompts.routineScreen,
      seat,
      effectivePolicy,
      nowMs: ts,
      config: state.config
    });

    onDemoScreenUpdate({
      seatId: DEMO_SEAT,
      screenText: prompts.routineScreen,
      seatState: 'urgent',
      reason: 'npm test permission prompt',
      ctxPct: 38
    });

    if (evalRes.decision !== 'approve_once') {
      activeDemoStep = 'routine';
      demoNote = getVetoLabel(evalRes.vetoCode, evalRes.reason, { td });
      renderAll();
      return;
    }

    const graceMs = state.config.graceWindowMs || AUTO_CONSENT_LIMITS.DEFAULT_GRACE_MS;
    const pendingId = `demo-pending-${ts.toString(36)}`;
    const pending = {
      id: pendingId,
      seatId: DEMO_SEAT,
      rigId: DEMO_RIG,
      promptHash: evalRes.promptFingerprint,
      commandPreview: evalRes.commandPreview || 'npm test',
      matchedProfile: evalRes.matchedProfile,
      sourceScope: evalRes.sourceScope,
      createdAtMs: ts,
      fireAtMs: ts + graceMs,
      graceWindowMs: graceMs
    };

    state = normalizeAutoConsentState({
      ...state,
      pendingApprovals: [pending]
    }, ts);
    activeDemoStep = 'routine';
    demoNote = lang() === 'en'
      ? 'Routine `npm test` matched Trusted Dev — 3s cancelable grace window running (Option 1 only).'
      : 'Штатная команда `npm test` прошла Trusted Dev — идёт 3с окно отмены (только п.1 Allow Once).';
    renderAll();

    const handle = setTimeoutFn(() => {
      demoTimers.delete(pendingId);
      if (destroyed) return;
      const stillPending = state.pendingApprovals.find((p) => p.id === pendingId);
      if (!stillPending || state.config.masterPaused || !state.config.enabled) return;

      const fireTs = now();
      const updatedGrants = state.sessionGrants.map((g) => (
        g.scope === 'seat' && g.targetId === DEMO_SEAT && g.revoked !== true
          ? { ...g, usedApprovals: (Number(g.usedApprovals) || 0) + 1 }
          : g
      ));
      const run = {
        id: `demo-approved-${pendingId}`,
        seatId: DEMO_SEAT,
        outcome: 'approved',
        decision: 'approve_once',
        matchedProfile: stillPending.matchedProfile,
        sourceScope: stillPending.sourceScope,
        commandPreview: stillPending.commandPreview,
        reason: lang() === 'en'
          ? 'TOCTOU hash verified — dispatched Option 1 (1 Enter)'
          : 'TOCTOU-хэш совпал — отправлен п.1 (1 Enter)',
        at: new Date(fireTs).toISOString()
      };
      state = normalizeAutoConsentState({
        ...state,
        sessionGrants: updatedGrants,
        pendingApprovals: state.pendingApprovals.filter((p) => p.id !== pendingId),
        recentRuns: [run, ...state.recentRuns].slice(0, 40),
        stats: {
          ...state.stats,
          approvedCount: state.stats.approvedCount + 1,
          actionsLastHour: state.stats.actionsLastHour + 1
        }
      }, fireTs);
      demoNote = td('autoConsent.toastApproved', { seat: 'dev-check' });
      onDemoScreenUpdate({
        seatId: DEMO_SEAT,
        screenText: lang() === 'en'
          ? `[${DEMO_SEAT}] core-platform (codex • gpt-6.2-sol)\n$ npm test\n✓ Auto-approved Option 1 (Allow Once) after 3s grace window.\n✓ 42 tests passed (0 failed).`
          : `[${DEMO_SEAT}] core-platform (codex • gpt-6.2-sol)\n$ npm test\n✓ Авто-одобрен п.1 (разово) после 3с окна отмены.\n✓ 42 теста пройдены (0 ошибок).`,
        seatState: 'working',
        reason: ''
      });
      onToastNotice(td('autoConsent.toastApproved', { seat: 'dev-check' }));
      renderAll();
    }, graceMs);
    demoTimers.set(pendingId, handle);
  }

  function triggerDemoHardVeto() {
    clearAllDemoTimers();
    const ts = now();
    if (!state.config.enabled) {
      state = buildDemoAutoConsentInitialState({ active: true, nowMs: ts });
    }
    const prompts = buildDemoAutoConsentPrompts(lang());
    const seat = { id: DEMO_SEAT, harness: 'codex', ctxPct: 38, seatSessionEpoch: DEMO_EPOCH };
    const effectivePolicy = resolveEffectiveConsentPolicy(state.config, state.sessionGrants, {
      rigId: DEMO_RIG,
      seatId: DEMO_SEAT,
      seatSessionEpoch: DEMO_EPOCH,
      nowMs: ts
    });
    const evalRes = evaluateAutoConsentPrompt({
      screenText: prompts.vetoScreen,
      seat,
      effectivePolicy,
      nowMs: ts,
      config: state.config
    });

    const run = {
      id: `demo-veto-${ts.toString(36)}`,
      seatId: DEMO_SEAT,
      outcome: 'escalated',
      decision: evalRes.decision,
      vetoCode: evalRes.vetoCode || 'E-VETO-GIT_PUSH',
      matchedProfile: evalRes.matchedProfile,
      sourceScope: evalRes.sourceScope,
      commandPreview: evalRes.commandPreview || 'git push origin main',
      reason: evalRes.reason,
      at: new Date(ts).toISOString()
    };
    state = normalizeAutoConsentState({
      ...state,
      pendingApprovals: [],
      recentRuns: [run, ...state.recentRuns].slice(0, 40),
      stats: {
        ...state.stats,
        escalatedCount: state.stats.escalatedCount + 1
      }
    }, ts);
    activeDemoStep = 'veto';
    demoNote = `${run.vetoCode}: ${td('autoConsent.vetoHardSafety')} — git push origin main`;
    onDemoScreenUpdate({
      seatId: DEMO_SEAT,
      screenText: prompts.vetoScreen,
      seatState: 'urgent',
      reason: `${run.vetoCode}: git push origin main`
    });
    renderAll();
  }

  function startDemoTrack() {
    clearAllDemoTimers();
    isDemoTrack = true;
    state = buildDemoAutoConsentInitialState({ active: true, nowMs: now() });
    triggerDemoRoutinePrompt();
  }

  async function runLivePost(endpoint, payload, fingerprintSuffix = '') {
    if (destroyed || demo || !isLive()) return null;
    const out = await guard.runGuarded(
      { scopeKey: lockScope, fingerprint: `${endpoint}:${fingerprintSuffix}`, cooldownMs: 0 },
      async () => {
        renderAll();
        try {
          const data = await postJson(endpoint, payload);
          if (!destroyed && data && (data.state || data.config)) {
            setState(data.state || data);
          }
          return data;
        } catch (err) {
          if (!destroyed) {
            statusMessage = `✕ ${String(err?.message || err)}`;
          }
          return null;
        } finally {
          renderAll();
        }
      }
    );
    return out?.value || null;
  }

  async function savePolicyFromRoot(formRoot) {
    const formPatch = readAutoConsentSettingsForm(formRoot);
    if (demo || !isLive()) {
      applyDemoPolicyPatch(formPatch);
      return;
    }
    const res = await runLivePost('/api/auto-consent/policy', { ...formPatch, patch: formPatch }, 'save');
    if (res && res.ok !== false) {
      statusMessage = lang() === 'en' ? '✓ Auto-consent policy saved (0600).' : '✓ Политика авто-подтверждений сохранена (0600).';
      renderAll();
    }
  }

  async function setScopePolicy(scope, targetId, profile) {
    if (!targetId) return;
    if (demo || !isLive()) {
      applyDemoPolicyPatch(null, { scope, targetId, profile });
      return;
    }
    const res = await runLivePost('/api/auto-consent/policy', { scope, targetId, profile }, `${scope}:${targetId}:${profile}`);
    if (res && res.ok !== false) {
      statusMessage = lang() === 'en' ? `✓ Updated ${scope} policy (${targetId}).` : `✓ Политика обновлена (${targetId}).`;
      renderAll();
    }
  }

  async function grantSession({ scope, targetId, profile = AUTO_CONSENT_PROFILES.TRUSTED_DEV, ttlMin = 60, maxApprovals = 25, autoArm = false }) {
    if (!targetId) return;
    const seatObj = scope === 'seat' ? array(getAgents()).find((a) => a && a.id === targetId) : null;
    const seatSessionEpoch = scope === 'seat'
      ? (getSeatEpochForDisplay(seatObj || targetId, state.sessionGrants) || (demo ? `demo-epoch-${targetId}` : undefined))
      : undefined;

    if (demo || !isLive()) {
      applyDemoGrantCreate({ scope, targetId, profile, ttlMin, maxApprovals, seatSessionEpoch, autoArm });
      return;
    }

    const payload = {
      action: 'create',
      scope,
      targetId,
      profile,
      ttlMin,
      maxApprovals
    };
    if (seatSessionEpoch) payload.seatSessionEpoch = seatSessionEpoch;
    const res = await runLivePost('/api/auto-consent/session-grant', payload, `grant:${scope}:${targetId}`);
    if (res && res.ok !== false) {
      if (!state.config.enabled && !state.config.masterPaused) {
        const enablePatch = autoArm
          ? { enabled: true, mode: AUTO_CONSENT_MODES.ARMED }
          : { enabled: true };
        await runLivePost('/api/auto-consent/policy', { ...enablePatch, patch: enablePatch }, 'enable-after-grant');
      }
      statusMessage = lang() === 'en' ? `✓ Session grant created (${ttlMin}m).` : `✓ Временная сессия создана (${ttlMin}м).`;
      renderAll();
    }
  }

  async function revokeGrant(grantId) {
    if (!grantId) return;
    if (demo || !isLive()) {
      applyDemoGrantRevoke(grantId);
      return;
    }
    const res = await runLivePost('/api/auto-consent/session-grant', { action: 'revoke', grantId }, `revoke:${grantId}`);
    if (res && res.ok !== false) {
      statusMessage = lang() === 'en' ? '✓ Session grant revoked.' : '✓ Временная сессия отозвана.';
      renderAll();
    }
  }

  async function cancelPending(pendingId, seatId) {
    if (demo || !isLive()) {
      applyDemoCancelPending(pendingId, seatId);
      return;
    }
    const payload = {};
    if (pendingId) payload.pendingId = pendingId;
    if (seatId) payload.seatId = seatId;
    const res = await runLivePost('/api/auto-consent/cancel', payload, `cancel:${pendingId || seatId}`);
    if (res && res.ok !== false) {
      onToastNotice(td('autoConsent.toastCanceled'));
    }
  }

  async function setPausedAll(paused) {
    if (demo || !isLive()) {
      applyDemoPauseAll(paused);
      return;
    }
    const res = await runLivePost('/api/auto-consent/pause-all', { paused: Boolean(paused) }, `pause:${paused}`);
    if (res && res.ok !== false) {
      statusMessage = paused ? td('autoConsent.pausedBanner') : (lang() === 'en' ? '▶ Resumed.' : '▶ Возобновлено.');
      renderAll();
    }
  }

  async function handleClick(event) {
    const el = event?.target?.closest?.('[data-auto-consent-action]');
    if (!el || el.disabled) return;
    const action = el.dataset.autoConsentAction;
    if (action === 'open-tab') {
      onOpenTab();
      return;
    }
    if (action === 'pause-all') {
      await setPausedAll(true);
      return;
    }
    if (action === 'resume-all') {
      await setPausedAll(false);
      return;
    }
    if (action === 'cancel-pending') {
      await cancelPending(el.dataset.pendingId || '', el.dataset.seat || '');
      return;
    }
    if (action === 'save-policy') {
      await savePolicyFromRoot(guardrailsBodyRoot || el.ownerDocument);
      return;
    }
    if (action === 'grant-session') {
      await grantSession({
        scope: el.dataset.scope === 'rig' ? 'rig' : 'seat',
        targetId: el.dataset.target || '',
        profile: el.dataset.profile || AUTO_CONSENT_PROFILES.TRUSTED_DEV,
        ttlMin: Number(el.dataset.ttlMin) || 60
      });
      return;
    }
    if (action === 'revoke-grant') {
      await revokeGrant(el.dataset.grantId || '');
      return;
    }
    if (action === 'hitl-trust-session') {
      const seatId = el.dataset.seat || '';
      const statusElId = el.dataset.status || 'cmdSendStatus';
      if (!seatId) return;
      sendAllowOnce(seatId, statusElId, el);
      await grantSession({
        scope: 'seat',
        targetId: seatId,
        profile: AUTO_CONSENT_PROFILES.TRUSTED_DEV,
        ttlMin: 60,
        maxApprovals: 25,
        autoArm: true
      });
      return;
    }
    if (action === 'demo-enable') {
      clearAllDemoTimers();
      isDemoTrack = true;
      state = buildDemoAutoConsentInitialState({ active: true, nowMs: now() });
      activeDemoStep = 'enable';
      demoNote = lang() === 'en'
        ? 'Enabled Trusted Dev on core-platform + 60m session grant on dev-check.'
        : 'Включён Trusted Dev на core-platform + временная сессия 60м для dev-check.';
      renderAll();
      return;
    }
    if (action === 'demo-routine') {
      triggerDemoRoutinePrompt();
      return;
    }
    if (action === 'demo-veto') {
      triggerDemoHardVeto();
      return;
    }
    if (action === 'demo-pause') {
      applyDemoPauseAll(!state.config.masterPaused);
    }
  }

  async function handleChange(event) {
    const el = event?.target?.closest?.('[data-auto-consent-action]');
    if (!el || el.disabled) return;
    const action = el.dataset.autoConsentAction;
    if (action === 'set-project-policy') {
      await setScopePolicy('project', el.dataset.target || '', el.value);
    } else if (action === 'set-seat-policy') {
      await setScopePolicy('seat', el.dataset.target || '', el.value);
    }
  }

  const clickTargets = [hudRoot, toastRoot, inspectorRoot, demoBarRoot, guardrailsBodyRoot, ...array(hitlRoots)].filter(Boolean);
  const changeTargets = [inspectorRoot, guardrailsBodyRoot].filter(Boolean);
  for (const t of clickTargets) t.addEventListener('click', handleClick);
  for (const t of changeTargets) t.addEventListener('change', handleChange);

  renderAll();

  return {
    refresh,
    setState,
    getState: () => state,
    isBusy: busy,
    handleSseEvent,
    renderAll,
    renderHud,
    renderToast,
    renderInspector,
    renderDemoBar,
    renderTabHtml,
    startDemoTrack,
    triggerDemoRoutinePrompt,
    triggerDemoHardVeto,
    destroy() {
      destroyed = true;
      stopCountdownTicker();
      clearAllDemoTimers();
      for (const t of clickTargets) t.removeEventListener('click', handleClick);
      for (const t of changeTargets) t.removeEventListener('change', handleChange);
    }
  };
}
