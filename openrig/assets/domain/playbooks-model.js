/**
 * Opt-In Safe Playbook Automation — Pure Zero-DOM Domain Model.
 * Deterministic, whitelisted non-destructive operational playbooks with
 * non-overridable Hard Safety Vetoes, cooldowns, hourly rate caps, and dry-run preview.
 * Importable directly in both Node.js (server + node --test) and browser ES modules.
 */

import { isGanttItemNoise } from './gantt-model.js';

export const PLAYBOOK_RULE_IDS = Object.freeze([
  'auto_compact_idle_hot',
  'auto_wake_parked',
  'auto_nudge_stalled_queue',
  'auto_notify_critical_sa'
]);

export const PLAYBOOK_VETO_CODES = Object.freeze({
  SHELL_EXITED: 'VETO_SHELL_EXITED',
  HITL_PROMPT: 'VETO_HITL_PROMPT',
  SEAT_WORKING: 'VETO_SEAT_WORKING',
  UNSUPPORTED_HARNESS: 'VETO_UNSUPPORTED_HARNESS',
  CLOSED_LOOP_UNCHANGED: 'VETO_CLOSED_LOOP_UNCHANGED',
  BREAKER_TRIPPED: 'VETO_BREAKER_TRIPPED',
  COOLDOWN_ACTIVE: 'VETO_COOLDOWN_ACTIVE',
  HOURLY_RATE_CAP: 'VETO_HOURLY_RATE_CAP'
});

export const PLAYBOOK_RULES_META = Object.freeze({
  auto_compact_idle_hot: {
    id: 'auto_compact_idle_hot',
    kind: 'write',
    actionId: 'compact_context',
    icon: '🗜️',
    titleRu: 'Авто /compact при перегреве свободного узла',
    titleEn: 'Auto /compact on Overheated Idle Seat',
    descRu: 'Отправляет /compact на Codex/Claude-узел с CTX ≥ порога, только если он не работает, не ждёт HITL и не вышел в shell.',
    descEn: 'Dispatches /compact to a Codex/Claude seat above CTX threshold only when idle, free of HITL prompts, and not in bare shell.',
    paramKey: 'thresholdPct',
    paramLabelRu: 'Порог CTX (%)',
    paramLabelEn: 'CTX Threshold (%)',
    min: 65,
    max: 95
  },
  auto_wake_parked: {
    id: 'auto_wake_parked',
    kind: 'write',
    actionId: 'wake_parked_seat',
    icon: '🔔',
    titleRu: 'Авто-пробуждение зависшего PARKED узла',
    titleEn: 'Auto-Wake Stale PARKED Seat',
    descRu: 'Отправляет Enter в живой запаркованный узел с открытыми задачами после паузы простоя (никогда не будит мёртвый shell или узел под авто-тормозом).',
    descEn: 'Sends Enter to a live PARKED seat holding open work after idle grace period (never wakes bare shells or breaker-tripped seats).',
    paramKey: 'minIdleMin',
    paramLabelRu: 'Простой (мин)',
    paramLabelEn: 'Min Idle (min)',
    min: 2,
    max: 120
  },
  auto_nudge_stalled_queue: {
    id: 'auto_nudge_stalled_queue',
    kind: 'write',
    actionId: 'nudge_queue',
    icon: '📨',
    titleRu: 'Авто-пинок при застое очереди на пустом промпте',
    titleEn: 'Auto-Nudge Stalled Pending Queue on Idle Prompt',
    descRu: 'Отправляет команду разбора очереди свободному агенту, если реальная (не служебная) входящая задача ждёт дольше порога.',
    descEn: 'Sends queue-review prompt to an idle agent when a non-noise pending task waits beyond threshold.',
    paramKey: 'minWaitMin',
    paramLabelRu: 'Ожидание (мин)',
    paramLabelEn: 'Min Wait (min)',
    min: 3,
    max: 180
  },
  auto_notify_critical_sa: {
    id: 'auto_notify_critical_sa',
    kind: 'notify',
    actionId: 'notify_critical_sa',
    icon: '🚨',
    titleRu: 'Эскалация Critical SA (HITL / Shell / Git-конфликт)',
    titleEn: 'Critical SA Escalation (HITL / Shell / Git Conflict)',
    descRu: 'Read-only уведомление в журнал смены, SSE-поток и Telegram при зависании HITL дольше порога, выходе в shell или конфликте worktree.',
    descEn: 'Read-only alert to Shift History, SSE stream, and Telegram on prolonged HITL prompt, bare shell exit, or worktree file conflict.',
    paramKey: 'minHitlMin',
    paramLabelRu: 'HITL дольше (мин)',
    paramLabelEn: 'HITL Age (min)',
    min: 1,
    max: 60
  }
});

export const DEFAULT_PLAYBOOK_CONFIG = Object.freeze({
  enabled: false,
  mode: 'dry_run', // 'dry_run' | 'armed'
  maxActionsPerHour: 6,
  rules: Object.freeze({
    auto_compact_idle_hot: Object.freeze({ enabled: false, thresholdPct: 78, cooldownMin: 15 }),
    auto_wake_parked: Object.freeze({ enabled: false, minIdleMin: 10, cooldownMin: 20 }),
    auto_nudge_stalled_queue: Object.freeze({ enabled: false, minWaitMin: 12, cooldownMin: 25 }),
    auto_notify_critical_sa: Object.freeze({ enabled: true, minHitlMin: 3, cooldownMin: 10, notifyTelegram: true })
  })
});

function clampInt(val, fallback, min, max) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizePlaybookConfig(patch = {}, base = DEFAULT_PLAYBOOK_CONFIG) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const b = base && typeof base === 'object' ? base : DEFAULT_PLAYBOOK_CONFIG;
  const br = (b.rules && typeof b.rules === 'object') ? b.rules : DEFAULT_PLAYBOOK_CONFIG.rules;
  const sr = (src.rules && typeof src.rules === 'object') ? src.rules : {};

  const compactSrc = sr.auto_compact_idle_hot || {};
  const compactBase = br.auto_compact_idle_hot || DEFAULT_PLAYBOOK_CONFIG.rules.auto_compact_idle_hot;

  const wakeSrc = sr.auto_wake_parked || {};
  const wakeBase = br.auto_wake_parked || DEFAULT_PLAYBOOK_CONFIG.rules.auto_wake_parked;

  const nudgeSrc = sr.auto_nudge_stalled_queue || {};
  const nudgeBase = br.auto_nudge_stalled_queue || DEFAULT_PLAYBOOK_CONFIG.rules.auto_nudge_stalled_queue;

  const notifySrc = sr.auto_notify_critical_sa || {};
  const notifyBase = br.auto_notify_critical_sa || DEFAULT_PLAYBOOK_CONFIG.rules.auto_notify_critical_sa;

  const mode = src.mode === 'armed' || src.mode === 'dry_run'
    ? src.mode
    : (b.mode === 'armed' ? 'armed' : 'dry_run');

  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : Boolean(b.enabled),
    mode,
    maxActionsPerHour: clampInt(
      src.maxActionsPerHour !== undefined ? src.maxActionsPerHour : b.maxActionsPerHour,
      DEFAULT_PLAYBOOK_CONFIG.maxActionsPerHour,
      1,
      30
    ),
    rules: {
      auto_compact_idle_hot: {
        enabled: typeof compactSrc.enabled === 'boolean' ? compactSrc.enabled : Boolean(compactBase.enabled),
        thresholdPct: clampInt(compactSrc.thresholdPct !== undefined ? compactSrc.thresholdPct : compactBase.thresholdPct, 78, 65, 95),
        cooldownMin: clampInt(compactSrc.cooldownMin !== undefined ? compactSrc.cooldownMin : compactBase.cooldownMin, 15, 2, 180)
      },
      auto_wake_parked: {
        enabled: typeof wakeSrc.enabled === 'boolean' ? wakeSrc.enabled : Boolean(wakeBase.enabled),
        minIdleMin: clampInt(wakeSrc.minIdleMin !== undefined ? wakeSrc.minIdleMin : wakeBase.minIdleMin, 10, 2, 120),
        cooldownMin: clampInt(wakeSrc.cooldownMin !== undefined ? wakeSrc.cooldownMin : wakeBase.cooldownMin, 20, 2, 180)
      },
      auto_nudge_stalled_queue: {
        enabled: typeof nudgeSrc.enabled === 'boolean' ? nudgeSrc.enabled : Boolean(nudgeBase.enabled),
        minWaitMin: clampInt(nudgeSrc.minWaitMin !== undefined ? nudgeSrc.minWaitMin : nudgeBase.minWaitMin, 12, 3, 180),
        cooldownMin: clampInt(nudgeSrc.cooldownMin !== undefined ? nudgeSrc.cooldownMin : nudgeBase.cooldownMin, 25, 2, 180)
      },
      auto_notify_critical_sa: {
        enabled: typeof notifySrc.enabled === 'boolean' ? notifySrc.enabled : Boolean(notifyBase.enabled),
        minHitlMin: clampInt(notifySrc.minHitlMin !== undefined ? notifySrc.minHitlMin : notifyBase.minHitlMin, 3, 1, 60),
        cooldownMin: clampInt(notifySrc.cooldownMin !== undefined ? notifySrc.cooldownMin : notifyBase.cooldownMin, 10, 1, 180),
        notifyTelegram: typeof notifySrc.notifyTelegram === 'boolean'
          ? notifySrc.notifyTelegram
          : Boolean(notifyBase.notifyTelegram !== false)
      }
    }
  };
}

function getSeatId(node) {
  return String((node && (node.canonicalSessionName || node.id || node.seatId)) || '').trim();
}

function getDisplayState(node) {
  if (!node || typeof node !== 'object') return 'idle';
  if (node.activityState && typeof node.activityState.display === 'string') return node.activityState.display;
  if (typeof node.state === 'string') {
    if (node.state === 'urgent') return 'needs-input';
    return node.state;
  }
  return 'idle';
}

function getNeedsInputCount(node) {
  if (!node || typeof node !== 'object') return 0;
  const fromAct = node.activityState && node.activityState.needsInput && Number(node.activityState.needsInput.count);
  if (Number.isFinite(fromAct) && fromAct > 0) return fromAct;
  const fromDirect = Number(node.needsInputCount);
  if (Number.isFinite(fromDirect) && fromDirect > 0) return fromDirect;
  return getDisplayState(node) === 'needs-input' ? 1 : 0;
}

function isShellExited(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.shellExited === true) return true;
  if (node.activityState && node.activityState.shellExited === true) return true;
  if (node.activityState && node.activityState.display === 'shell-exited') return true;
  return false;
}

function isCompactSupportedHarness(node) {
  const raw = String(
    (node && (node.runtime || node.harness || node.model || (node.activityState && node.activityState.runtime))) || ''
  ).toLowerCase();
  if (!raw) return true;
  if (raw.includes('pi') || raw.includes('deepseek') || raw.includes('terminal') || raw.includes('agy') || raw.includes('antigravity')) {
    return false;
  }
  return raw.includes('codex') || raw.includes('claude') || raw.includes('gpt') || raw.includes('anthropic') || raw.includes('glm');
}

function getCtxPct(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.contextUsage && typeof node.contextUsage.usedPercentage === 'number' && Number.isFinite(node.contextUsage.usedPercentage)) {
    return node.contextUsage.usedPercentage;
  }
  if (typeof node.ctxPct === 'number' && Number.isFinite(node.ctxPct)) return node.ctxPct;
  return null;
}

function parseTsMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function getSeatIdleMs(node, nowMs) {
  const ts = parseTsMs(node && (node.lastActivityAt || node.updatedAt || (node.activityState && node.activityState.updatedAt)));
  if (ts === null) return null;
  return Math.max(0, nowMs - ts);
}

function hasRecentFailedOrUnchangedAudit(actionAudit, actionId, seatId, windowMs, nowMs) {
  if (!Array.isArray(actionAudit) || !actionAudit.length) return false;
  for (const rec of actionAudit) {
    if (!rec || rec.targetSeatId !== seatId || rec.actionId !== actionId) continue;
    const status = rec.postconditionStatus;
    if (status !== 'unchanged' && status !== 'failed') continue;
    const recTs = parseTsMs(rec.executedAt || rec.executedMs);
    if (recTs !== null && nowMs - recTs <= windowMs) {
      return true;
    }
  }
  return false;
}

function isBreakerTrippedForSeat(breakerState, seatId) {
  if (!breakerState || breakerState.status !== 'tripped') return false;
  const tripped = Array.isArray(breakerState.trippedSeats) ? breakerState.trippedSeats : [];
  return tripped.some((t) => t && (t.seatId === seatId || t.seatId === 'fleet'));
}

/**
 * Pure deterministic evaluation of all 4 whitelisted safe playbooks against a fleet snapshot.
 * Returns { eligible: [], vetoed: [], summary: { eligibleCount, vetoedCount, writeEligibleCount, notifyEligibleCount } }.
 */
export function evaluatePlaybookCandidates(snapshot = {}, rawConfig = DEFAULT_PLAYBOOK_CONFIG, context = {}) {
  const cfg = sanitizePlaybookConfig(rawConfig, DEFAULT_PLAYBOOK_CONFIG);
  const nowMs = typeof context.nowMs === 'number' && Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const lastRunAtByKey = context.lastRunAtByKey instanceof Map ? context.lastRunAtByKey : new Map();
  const recentExecutedTimestamps = Array.isArray(context.recentExecutedTimestamps) ? context.recentExecutedTimestamps : [];
  const ignoreEnabledFlag = Boolean(context.ignoreEnabledFlag);

  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const parkedSeats = (snapshot.parkedSeats && typeof snapshot.parkedSeats === 'object') ? snapshot.parkedSeats : {};
  const activeQueue = Array.isArray(snapshot.activeQueue) ? snapshot.activeQueue : [];
  const gitRadar = (snapshot.gitRadar && typeof snapshot.gitRadar === 'object') ? snapshot.gitRadar : null;
  const actionAudit = Array.isArray(snapshot.actionAudit) ? snapshot.actionAudit : [];
  const breakerState = snapshot.breakerState || (snapshot.guardrails && snapshot.guardrails.breaker) || null;

  const actionsLastHour = recentExecutedTimestamps.filter((t) => nowMs - t < 3_600_000).length;
  let projectedWriteActions = actionsLastHour;

  const eligible = [];
  const vetoed = [];

  if (!ignoreEnabledFlag && !cfg.enabled) {
    return {
      eligible,
      vetoed,
      summary: { eligibleCount: 0, vetoedCount: 0, writeEligibleCount: 0, notifyEligibleCount: 0, actionsLastHour }
    };
  }

  const pushVeto = (ruleId, seatId, vetoCode, detail) => {
    vetoed.push({
      ruleId,
      actionId: (PLAYBOOK_RULES_META[ruleId] && PLAYBOOK_RULES_META[ruleId].actionId) || ruleId,
      kind: (PLAYBOOK_RULES_META[ruleId] && PLAYBOOK_RULES_META[ruleId].kind) || 'write',
      seatId,
      vetoCode,
      detail
    });
  };

  const checkCooldown = (ruleId, seatId, cooldownMin) => {
    const key = `${ruleId}:${seatId}`;
    const lastTs = lastRunAtByKey.get(key) || 0;
    const cdMs = cooldownMin * 60_000;
    if (lastTs > 0 && nowMs - lastTs < cdMs) {
      const leftMin = Math.max(1, Math.ceil((cdMs - (nowMs - lastTs)) / 60_000));
      pushVeto(ruleId, seatId, PLAYBOOK_VETO_CODES.COOLDOWN_ACTIVE, `Cooldown active (${leftMin}m left)`);
      return false;
    }
    return true;
  };

  // Pre-index non-noise pending queue items by target seat
  const pendingBySeat = new Map();
  for (const q of activeQueue) {
    if (!q || typeof q !== 'object') continue;
    const status = String(q.status || '').toLowerCase();
    if (status !== 'pending' && status !== 'open') continue;
    if (isGanttItemNoise(q)) continue;
    const owner = String(q.owner || q.to || q.recipient || '').trim();
    if (!owner) continue;
    if (!pendingBySeat.has(owner)) pendingBySeat.set(owner, []);
    pendingBySeat.get(owner).push(q);
  }

  // ===== RULE 1: auto_compact_idle_hot =====
  const compactRule = cfg.rules.auto_compact_idle_hot;
  if (compactRule.enabled) {
    for (const node of nodes) {
      const seatId = getSeatId(node);
      if (!seatId) continue;
      const ctxPct = getCtxPct(node);
      if (ctxPct === null || ctxPct < compactRule.thresholdPct) continue;

      const disp = getDisplayState(node);
      if (isShellExited(node)) {
        pushVeto('auto_compact_idle_hot', seatId, PLAYBOOK_VETO_CODES.SHELL_EXITED, `CTX ${ctxPct}% but seat exited to bare shell`);
        continue;
      }
      if (getNeedsInputCount(node) > 0 || disp === 'needs-input') {
        pushVeto('auto_compact_idle_hot', seatId, PLAYBOOK_VETO_CODES.HITL_PROMPT, `CTX ${ctxPct}% but active HITL prompt requires human`);
        continue;
      }
      if (disp === 'working' || disp === 'running') {
        pushVeto('auto_compact_idle_hot', seatId, PLAYBOOK_VETO_CODES.SEAT_WORKING, `CTX ${ctxPct}% — deferring until seat finishes current turn`);
        continue;
      }
      if (!isCompactSupportedHarness(node)) {
        pushVeto('auto_compact_idle_hot', seatId, PLAYBOOK_VETO_CODES.UNSUPPORTED_HARNESS, `Harness does not support /compact (use manual rotation)`);
        continue;
      }
      if (hasRecentFailedOrUnchangedAudit(actionAudit, 'compact_context', seatId, compactRule.cooldownMin * 60_000, nowMs)) {
        pushVeto('auto_compact_idle_hot', seatId, PLAYBOOK_VETO_CODES.CLOSED_LOOP_UNCHANGED, `Recent /compact had unchanged/failed postcondition — blocked anti-loop`);
        continue;
      }
      if (!checkCooldown('auto_compact_idle_hot', seatId, compactRule.cooldownMin)) continue;
      if (projectedWriteActions >= cfg.maxActionsPerHour) {
        pushVeto('auto_compact_idle_hot', seatId, PLAYBOOK_VETO_CODES.HOURLY_RATE_CAP, `Hourly fleet cap (${cfg.maxActionsPerHour}/h) reached`);
        continue;
      }
      projectedWriteActions += 1;
      eligible.push({
        ruleId: 'auto_compact_idle_hot',
        actionId: 'compact_context',
        kind: 'write',
        seatId,
        reason: `Idle seat CTX ${ctxPct}% >= ${compactRule.thresholdPct}%`,
        payload: '/compact',
        transport: 'raw',
        cooldownMin: compactRule.cooldownMin
      });
    }
  }

  // ===== RULE 2: auto_wake_parked =====
  const wakeRule = cfg.rules.auto_wake_parked;
  if (wakeRule.enabled) {
    for (const node of nodes) {
      const seatId = getSeatId(node);
      if (!seatId) continue;
      const pk = parkedSeats[seatId] || node.parkedData || null;
      const isParked = Boolean(pk && pk.parked);
      const openCount = Number((pk && pk.openCount) || 0);
      if (!isParked || openCount <= 0) continue;

      const disp = getDisplayState(node);
      if (disp === 'offline' || disp === 'stopped' || disp === 'awaiting-decision') continue;

      if (isShellExited(node)) {
        pushVeto('auto_wake_parked', seatId, PLAYBOOK_VETO_CODES.SHELL_EXITED, `PARKED (${openCount} open) but shell exited — requires rig seat launch --fresh --stop`);
        continue;
      }
      if (getNeedsInputCount(node) > 0 || disp === 'needs-input') {
        pushVeto('auto_wake_parked', seatId, PLAYBOOK_VETO_CODES.HITL_PROMPT, `PARKED seat is waiting on human HITL prompt`);
        continue;
      }
      if (disp === 'working' || disp === 'running') {
        pushVeto('auto_wake_parked', seatId, PLAYBOOK_VETO_CODES.SEAT_WORKING, `Seat is already working despite stale PARKED flag`);
        continue;
      }
      if (isBreakerTrippedForSeat(breakerState, seatId)) {
        pushVeto('auto_wake_parked', seatId, PLAYBOOK_VETO_CODES.BREAKER_TRIPPED, `Budget Circuit-Breaker tripped — auto-wake suppressed`);
        continue;
      }
      const idleMs = getSeatIdleMs(node, nowMs);
      const minIdleMs = wakeRule.minIdleMin * 60_000;
      if (idleMs !== null && idleMs < minIdleMs) continue;

      if (hasRecentFailedOrUnchangedAudit(actionAudit, 'wake_parked_seat', seatId, wakeRule.cooldownMin * 60_000, nowMs)) {
        pushVeto('auto_wake_parked', seatId, PLAYBOOK_VETO_CODES.CLOSED_LOOP_UNCHANGED, `Recent wake had unchanged/failed postcondition — blocked anti-loop`);
        continue;
      }
      if (!checkCooldown('auto_wake_parked', seatId, wakeRule.cooldownMin)) continue;
      if (projectedWriteActions >= cfg.maxActionsPerHour) {
        pushVeto('auto_wake_parked', seatId, PLAYBOOK_VETO_CODES.HOURLY_RATE_CAP, `Hourly fleet cap (${cfg.maxActionsPerHour}/h) reached`);
        continue;
      }
      projectedWriteActions += 1;
      const idleLabel = idleMs !== null ? `${Math.round(idleMs / 60_000)}m idle` : 'stale PARKED';
      eligible.push({
        ruleId: 'auto_wake_parked',
        actionId: 'wake_parked_seat',
        kind: 'write',
        seatId,
        reason: `PARKED with ${openCount} open obligation(s) (${idleLabel})`,
        payload: 'Enter',
        transport: 'key',
        cooldownMin: wakeRule.cooldownMin
      });
    }
  }

  // ===== RULE 3: auto_nudge_stalled_queue =====
  const nudgeRule = cfg.rules.auto_nudge_stalled_queue;
  if (nudgeRule.enabled) {
    const minWaitMs = nudgeRule.minWaitMin * 60_000;
    for (const node of nodes) {
      const seatId = getSeatId(node);
      if (!seatId) continue;
      const pending = pendingBySeat.get(seatId) || [];
      if (!pending.length) continue;

      // Find oldest waiting non-noise item
      let oldestAgeMs = 0;
      let oldestItem = pending[0];
      for (const item of pending) {
        const ts = parseTsMs(item.updatedAt || item.createdAt || item.tsUpdated || item.tsCreated);
        const age = ts !== null ? Math.max(0, nowMs - ts) : minWaitMs;
        if (age >= oldestAgeMs) {
          oldestAgeMs = age;
          oldestItem = item;
        }
      }
      if (oldestAgeMs < minWaitMs) continue;

      const pk = parkedSeats[seatId] || node.parkedData || null;
      if (pk && pk.parked) continue; // handled by auto_wake_parked

      const disp = getDisplayState(node);
      if (disp === 'offline' || disp === 'stopped' || disp === 'awaiting-decision') continue;

      if (isShellExited(node)) {
        pushVeto('auto_nudge_stalled_queue', seatId, PLAYBOOK_VETO_CODES.SHELL_EXITED, `${pending.length} pending item(s), but seat exited to bare shell`);
        continue;
      }
      if (getNeedsInputCount(node) > 0 || disp === 'needs-input') {
        pushVeto('auto_nudge_stalled_queue', seatId, PLAYBOOK_VETO_CODES.HITL_PROMPT, `Seat has active HITL prompt — cannot nudge queue`);
        continue;
      }
      if (disp === 'working' || disp === 'running') {
        pushVeto('auto_nudge_stalled_queue', seatId, PLAYBOOK_VETO_CODES.SEAT_WORKING, `Seat is actively working — queue wait is normal`);
        continue;
      }
      if (isBreakerTrippedForSeat(breakerState, seatId)) {
        pushVeto('auto_nudge_stalled_queue', seatId, PLAYBOOK_VETO_CODES.BREAKER_TRIPPED, `Budget Circuit-Breaker tripped — auto-nudge suppressed`);
        continue;
      }
      if (hasRecentFailedOrUnchangedAudit(actionAudit, 'nudge_queue', seatId, nudgeRule.cooldownMin * 60_000, nowMs)) {
        pushVeto('auto_nudge_stalled_queue', seatId, PLAYBOOK_VETO_CODES.CLOSED_LOOP_UNCHANGED, `Recent queue nudge had unchanged/failed postcondition — blocked anti-loop`);
        continue;
      }
      if (!checkCooldown('auto_nudge_stalled_queue', seatId, nudgeRule.cooldownMin)) continue;
      if (projectedWriteActions >= cfg.maxActionsPerHour) {
        pushVeto('auto_nudge_stalled_queue', seatId, PLAYBOOK_VETO_CODES.HOURLY_RATE_CAP, `Hourly fleet cap (${cfg.maxActionsPerHour}/h) reached`);
        continue;
      }
      projectedWriteActions += 1;
      const waitMin = Math.round(oldestAgeMs / 60_000);
      const qRef = oldestItem && (oldestItem.id || oldestItem.qitemId) ? ` (${oldestItem.id || oldestItem.qitemId})` : '';
      eligible.push({
        ruleId: 'auto_nudge_stalled_queue',
        actionId: 'nudge_queue',
        kind: 'write',
        seatId,
        reason: `${pending.length} pending task(s) waiting ${waitMin}m on idle prompt${qRef}`,
        payload: 'rig queue list --owned — проверь входящие задачи в очереди и возьми в работу.',
        transport: 'raw',
        cooldownMin: nudgeRule.cooldownMin
      });
    }
  }

  // ===== RULE 4: auto_notify_critical_sa (read-only escalation, never mutates tmux!) =====
  const notifyRule = cfg.rules.auto_notify_critical_sa;
  if (notifyRule.enabled) {
    const minHitlMs = notifyRule.minHitlMin * 60_000;
    for (const node of nodes) {
      const seatId = getSeatId(node);
      if (!seatId) continue;
      if (isShellExited(node)) {
        if (!checkCooldown('auto_notify_critical_sa', `shell:${seatId}`, notifyRule.cooldownMin)) continue;
        eligible.push({
          ruleId: 'auto_notify_critical_sa',
          actionId: 'notify_critical_sa',
          kind: 'notify',
          seatId,
          cooldownKey: `auto_notify_critical_sa:shell:${seatId}`,
          severity: 'critical',
          reason: `Bare shell exit detected on ${seatId} (requires rig seat launch --fresh --stop)`,
          notifyTelegram: notifyRule.notifyTelegram,
          cooldownMin: notifyRule.cooldownMin
        });
        continue;
      }
      if (getNeedsInputCount(node) > 0 || getDisplayState(node) === 'needs-input') {
        const idleMs = getSeatIdleMs(node, nowMs);
        if (idleMs !== null && idleMs < minHitlMs) continue;
        if (!checkCooldown('auto_notify_critical_sa', `hitl:${seatId}`, notifyRule.cooldownMin)) continue;
        const ageMin = idleMs !== null ? Math.max(notifyRule.minHitlMin, Math.round(idleMs / 60_000)) : notifyRule.minHitlMin;
        eligible.push({
          ruleId: 'auto_notify_critical_sa',
          actionId: 'notify_critical_sa',
          kind: 'notify',
          seatId,
          cooldownKey: `auto_notify_critical_sa:hitl:${seatId}`,
          severity: 'critical',
          reason: `HITL prompt unattended for ~${ageMin}m on ${seatId}`,
          notifyTelegram: notifyRule.notifyTelegram,
          cooldownMin: notifyRule.cooldownMin
        });
      }
    }

    const conflicts = (gitRadar && Array.isArray(gitRadar.conflicts)) ? gitRadar.conflicts : [];
    if (conflicts.length > 0) {
      const top = conflicts[0];
      const conflictSeat = (Array.isArray(top.seats) && top.seats[0]) || 'fleet';
      const cKey = `git:${top.file || 'overlap'}`;
      if (checkCooldown('auto_notify_critical_sa', cKey, notifyRule.cooldownMin)) {
        eligible.push({
          ruleId: 'auto_notify_critical_sa',
          actionId: 'notify_critical_sa',
          kind: 'notify',
          seatId: conflictSeat,
          cooldownKey: `auto_notify_critical_sa:${cKey}`,
          severity: 'critical',
          reason: `Git worktree conflict (${conflicts.length} file(s)): ${top.file || 'overlap'} across ${(top.seats || []).join(', ')}`,
          notifyTelegram: notifyRule.notifyTelegram,
          cooldownMin: notifyRule.cooldownMin
        });
      }
    }
  }

  const writeEligibleCount = eligible.filter((e) => e.kind === 'write').length;
  const notifyEligibleCount = eligible.filter((e) => e.kind === 'notify').length;

  return {
    eligible,
    vetoed,
    summary: {
      eligibleCount: eligible.length,
      vetoedCount: vetoed.length,
      writeEligibleCount,
      notifyEligibleCount,
      actionsLastHour
    }
  };
}

/**
 * Generates an inline SVG data URI for the browser tab favicon with a live SA alert badge.
 * Pure zero-DOM helper (directly testable in node --test).
 */
export function buildPlaybookFaviconDataUri(severity = 'ok', count = 0) {
  const n = Math.max(0, Math.min(99, Math.round(Number(count) || 0)));
  const badgeText = n > 9 ? '9+' : String(n);
  let badgeMarkup = '';
  if (severity === 'critical' && n > 0) {
    badgeMarkup = `<circle cx="48" cy="18" r="15" fill="#ff0055" stroke="#030712" stroke-width="3"/><text x="48" y="23" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-size="16" font-weight="800">${badgeText}</text>`;
  } else if (severity === 'warn' && n > 0) {
    badgeMarkup = `<circle cx="48" cy="18" r="13" fill="#fbbf24" stroke="#030712" stroke-width="3"/><text x="48" y="23" text-anchor="middle" fill="#030712" font-family="system-ui,sans-serif" font-size="15" font-weight="800">${badgeText}</text>`;
  }
  const ringStroke = severity === 'critical' ? '#ff2a6d' : severity === 'warn' ? '#fbbf24' : '#00f0ff';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#050b18"/><path d="M32 12 L52 32 L32 52 L12 32 Z" fill="rgba(0,240,255,0.16)" stroke="${ringStroke}" stroke-width="3.5"/><circle cx="32" cy="32" r="7" fill="${ringStroke}"/>${badgeMarkup}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
