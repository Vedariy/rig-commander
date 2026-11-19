import { parseInteractivePromptOptions } from '../domain/prompt-parser.js';

export const CONTEXT_WARN_PCT = 65;
export const CONTEXT_CRIT_PCT = 75;

export function isPiHarness(seat) {
  if (!seat) return false;
  const harness = String(seat.harness || '').toLowerCase();
  const id = String(seat.id || '');
  return harness.includes('pi') || id.includes('coder3');
}

function buildSeatContext(seat, screenText = '') {
  const id = String((seat && seat.id) || '');
  const harness = String((seat && seat.harness) || '').toLowerCase();
  const isPi = isPiHarness(seat);
  const isClaude = harness.includes('claude');
  const isAgy = harness.includes('terminal') || harness.includes('agy') || id.includes('coder5');
  const parsedOptions = parseInteractivePromptOptions(screenText);
  const hasParsedOptions = parsedOptions.length >= 2;
  const isUrgent = Boolean(seat && seat.state === 'urgent');
  const isWorking = Boolean(seat && seat.state === 'working');
  const ctxPct = seat && typeof seat.ctxPct === 'number' ? seat.ctxPct : null;
  const isHotCtx = ctxPct !== null && ctxPct >= CONTEXT_WARN_PCT;
  const isCritCtx = ctxPct !== null && ctxPct >= CONTEXT_CRIT_PCT;
  const isParked = Boolean(
    seat && ((seat.parkedData && seat.parkedData.parked) || String(seat.activityLabel || '').includes('PARKED'))
  );
  return {
    seat,
    id,
    harness,
    isPi,
    isClaude,
    isAgy,
    parsedOptions,
    hasParsedOptions,
    isUrgent,
    isWorking,
    ctxPct,
    isHotCtx,
    isCritCtx,
    isParked
  };
}

/**
 * Canonical declarative Action Registry (Operational Ontology v2.0).
 * Every write-back or navigation action declares its own precondition, transport,
 * reversibility, and UI descriptor so all 4 UI surfaces stay 100% consistent.
 */
export const ACTION_DEFINITIONS = [
  {
    id: 'proceed_prompt',
    transport: 'tmux_key',
    reversibility: 'manual_undo',
    precondition: (ctx) => ctx.isUrgent && !ctx.hasParsedOptions && !ctx.isPi,
    buildDescriptor: (ctx) => ({
      id: 'proceed_prompt',
      transport: 'tmux_key',
      seatId: ctx.id,
      payload: '1 Enter',
      label: '✅ 1 (Proceed)',
      title: 'Подтвердить вариант 1 в терминале',
      tone: 'proceed'
    })
  },
  {
    id: 'confirm_yes',
    transport: 'tmux_key',
    reversibility: 'manual_undo',
    precondition: (ctx) => ctx.isUrgent && !ctx.hasParsedOptions,
    buildDescriptor: (ctx) => ({
      id: 'confirm_yes',
      transport: 'tmux_key',
      seatId: ctx.id,
      payload: 'y Enter',
      label: 'y (Yes)',
      title: 'Отправить y + Enter в терминал',
      tone: 'default'
    })
  },
  {
    id: 'cancel_prompt',
    transport: 'tmux_key',
    reversibility: 'fully_reversible',
    precondition: (ctx) => ctx.isUrgent || ctx.hasParsedOptions,
    buildDescriptor: (ctx) => ({
      id: 'cancel_prompt',
      transport: 'tmux_key',
      seatId: ctx.id,
      payload: 'Escape',
      label: '❌ Esc',
      title: 'Отменить интерактивный запрос (Escape)',
      tone: 'cancel'
    })
  },
  {
    id: 'interrupt_execution',
    transport: 'tmux_key',
    reversibility: 'manual_undo',
    precondition: (ctx) => ctx.isWorking || ctx.isUrgent,
    buildDescriptor: (ctx) => ({
      id: 'interrupt_execution',
      transport: 'tmux_key',
      seatId: ctx.id,
      payload: 'C-c',
      label: '🛑 Ctrl+C',
      title: 'Прервать текущую операцию (Ctrl+C)',
      tone: 'default'
    })
  },
  {
    id: 'compact_context',
    transport: 'tmux_raw',
    reversibility: 'checkpointed',
    precondition: (ctx) => ctx.isHotCtx && !ctx.isPi,
    buildDescriptor: (ctx) => ({
      id: 'compact_context',
      transport: 'tmux_raw',
      seatId: ctx.id,
      payload: '/compact',
      label: `⚡ /compact (${ctx.ctxPct}%)`,
      title: `Контекст ${ctx.ctxPct}% — запустить сжатие сессии`,
      tone: ctx.isCritCtx ? 'critical' : 'warn'
    })
  },
  {
    id: 'copy_restart_seat',
    transport: 'clipboard',
    reversibility: 'checkpointed',
    precondition: (ctx) => ctx.isHotCtx && ctx.isPi,
    buildDescriptor: (ctx) => ({
      id: 'copy_restart_seat',
      transport: 'clipboard',
      seatId: ctx.id,
      payload: `rig restart ${ctx.id}`,
      label: `🔄 Ротация (${ctx.ctxPct}%)`,
      title: `Харнес Pi не поддерживает /compact — скопировать rig restart ${ctx.id}`,
      tone: ctx.isCritCtx ? 'critical' : 'warn'
    })
  },
  {
    id: 'wake_parked_seat',
    transport: 'tmux_key',
    reversibility: 'fully_reversible',
    precondition: (ctx) => ctx.isParked,
    buildDescriptor: (ctx) => ({
      id: 'wake_parked_seat',
      transport: 'tmux_key',
      seatId: ctx.id,
      payload: 'Enter',
      label: '⚡ Разбудить (Enter)',
      title: 'Отправить Enter в запаркованное сиденье',
      tone: 'warn'
    })
  }
];

/**
 * Returns only the contextual actions justified by the seat's current state.
 * For a healthy idle seat (ctxPct < 65, not urgent/working/parked), returns [].
 */
export function getSeatContextualActions(seat, screenText = '') {
  if (!seat || !seat.id) return [];
  const ctx = buildSeatContext(seat, screenText);
  const actions = [];
  for (const def of ACTION_DEFINITIONS) {
    if (def.precondition(ctx)) {
      actions.push(def.buildDescriptor(ctx));
    }
  }
  return actions;
}

/**
 * Returns manual harness slash/key commands shown inside the collapsed disclosure drawer.
 */
export function getManualHarnessActions(seat) {
  if (!seat || !seat.id) return [];
  const ctx = buildSeatContext(seat, '');
  const id = ctx.id;
  if (ctx.isPi) {
    return [
      { id: 'manual_enter', transport: 'tmux_key', seatId: id, payload: 'Enter', label: '⏎ Enter', tone: 'default' }
    ];
  }
  if (ctx.isClaude) {
    return [
      { id: 'manual_compact', transport: 'tmux_raw', seatId: id, payload: '/compact', label: '⚡ /compact', tone: 'default' },
      { id: 'manual_clear', transport: 'tmux_raw', seatId: id, payload: '/clear', label: '🧹 /clear', tone: 'default' },
      { id: 'manual_cost', transport: 'tmux_raw', seatId: id, payload: '/cost', label: '💰 /cost', tone: 'default' },
      { id: 'manual_enter', transport: 'tmux_key', seatId: id, payload: 'Enter', label: '⏎ Enter', tone: 'default' }
    ];
  }
  if (ctx.isAgy) {
    return [
      { id: 'manual_compact', transport: 'tmux_raw', seatId: id, payload: '/compact', label: '⚡ /compact', tone: 'default' },
      { id: 'manual_effort', transport: 'tmux_raw', seatId: id, payload: '/effort high', label: '⚙️ /effort', tone: 'default' },
      { id: 'manual_enter', transport: 'tmux_key', seatId: id, payload: 'Enter', label: '⏎ Enter', tone: 'default' }
    ];
  }
  return [
    { id: 'manual_compact', transport: 'tmux_raw', seatId: id, payload: '/compact', label: '⚡ /compact', tone: 'default' },
    { id: 'manual_new', transport: 'tmux_raw', seatId: id, payload: '/new', label: '🆕 /new', tone: 'default' },
    { id: 'manual_enter', transport: 'tmux_key', seatId: id, payload: 'Enter', label: '⏎ Enter', tone: 'default' }
  ];
}

/**
 * Maps a FleetIntelligence actionPlan into a canonical Ontology Action descriptor,
 * enforcing the Pi harness guard consistently across Triage Strip and Fleet Advisor.
 */
export function resolveActionFromFinding(actionPlan, seat = null) {
  if (!actionPlan) return null;
  const seatId = actionPlan.seatTarget || (seat && seat.id) || '';
  const targetSeat = seat || (seatId ? { id: seatId, harness: '' } : null);

  if (actionPlan.kind === 'compact_seat' && seatId) {
    if (isPiHarness(targetSeat)) {
      return {
        id: 'copy_restart_seat',
        transport: 'clipboard',
        seatId,
        payload: `rig restart ${seatId}`,
        label: actionPlan.label || '🔄 Ротация Pi',
        title: `Харнес Pi не поддерживает /compact — скопировать rig restart ${seatId}`,
        tone: 'warn'
      };
    }
    return {
      id: 'compact_context',
      transport: 'tmux_raw',
      seatId,
      payload: '/compact',
      label: actionPlan.label || '⚡ /compact',
      title: `Отправить /compact в ${seatId}`,
      tone: 'proceed'
    };
  }

  return {
    id: 'copy_command',
    transport: 'clipboard',
    seatId,
    payload: actionPlan.commandPreview || '',
    label: actionPlan.label || '⚡ Применить',
    title: actionPlan.commandPreview || 'Скопировать команду в буфер обмена',
    tone: 'proceed'
  };
}
