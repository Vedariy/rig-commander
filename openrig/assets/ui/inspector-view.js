/** Inspector, queue scorecards and context lineage. The deck supplies current state on each render. */
import { getHitlPromptPresentation, detectLiveHitlPrompt, classifyTerminalScreen } from '../domain/prompt-parser.js';
import { buildSeatScopeKey, buildSeatSendKey } from '../domain/action-guard.js';
import { computeBurn, formatTokensShort, getContextThermal } from '../domain/thermal.js';
import { buildNudgeQueueAction, buildSeatRelaunchCommand, getManualHarnessActions, getSeatContextualActions, resolveActionFromFinding } from '../ontology/actions.js';
import { getActionRecordsForSeat, getSeatActiveObligation } from '../ontology/snapshot.js';

export function renderCurrentTaskHtml(ctx, agent) {
  const {
    isLive, ontologySnapshot, queueItems, deckLang, escapeHtml, shortSeat,
    resolveSeatIdByShort, lastScreenBySeat, liveScreenCapture
  } = ctx;
  if (!agent) return '';
  let activeTask = null;
  let totalCount = 0;
  if (isLive && ontologySnapshot) {
    const hit = getSeatActiveObligation(ontologySnapshot, agent.id);
    if (hit) {
      activeTask = {
        slice: hit.primary.slice,
        from: hit.primary.fromSeatId,
        state: hit.primary.state,
        summary: hit.primary.summary
      };
      totalCount = hit.totalCount;
    }
  } else {
    const myTasks = queueItems.filter(q =>
      q.to === agent.id || resolveSeatIdByShort(q.to) === agent.id
    ).map(q => ({
      slice: (q.slice || '').replace(/^slice:/, ''),
      from: q.from,
      state: String(q.state || '').includes('in-progress') ? 'in-progress' : 'pending',
      summary: q.summary || ''
    }));
    myTasks.sort((a, b) => (a.state === 'in-progress' ? -1 : 1) - (b.state === 'in-progress' ? -1 : 1));
    activeTask = myTasks[0] || null;
    totalCount = myTasks.length;
  }

  if (activeTask) {
    const sliceTag = activeTask.slice || '';
    const fromShort = activeTask.from ? shortSeat(activeTask.from) : '';
    const extra = totalCount > 1 ? ` <span style="color:#94a3b8; font-weight:500;">(+${totalCount - 1})</span>` : '';
    return `
      <div style="background:rgba(14,165,233,0.08); border:1px solid rgba(56,189,248,0.28); border-radius:6px; padding:7px 9px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:3px;">
          <span style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#38bdf8; letter-spacing:0.4px;">🎯 ${deckLang === 'en' ? 'CURRENT TASK' : 'ЧЕМ ЗАНЯТ СЕЙЧАС'}${extra}</span>
          ${sliceTag ? `<span style="font-family:var(--font-mono); font-size:10px; color:#7dd3fc; background:rgba(56,189,248,0.14); padding:1px 6px; border-radius:4px; max-width:165px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(sliceTag)}">${escapeHtml(sliceTag)}</span>` : ''}
        </div>
        <div style="font-size:11.5px; color:#e2e8f0; line-height:1.35;">${escapeHtml(activeTask.summary || (deckLang === 'en' ? 'Task in progress' : 'Задача в работе'))}</div>
        ${fromShort ? `<div style="font-size:10px; color:#94a3b8; margin-top:3px; font-family:var(--font-mono);">${deckLang === 'en' ? 'from' : 'от'} ${escapeHtml(fromShort)} • ${escapeHtml(activeTask.state)}</div>` : ''}
      </div>
    `;
  }

  if (agent.state === 'urgent') {
    const hasP0Diag = getActiveFindingsForSeat(ctx, agent.id).some(f => f && f.severity === 'p0_urgent');
    if (hasP0Diag) return '';
    return `
      <div style="background:rgba(255,0,85,0.12); border:1px solid rgba(255,0,85,0.5); border-radius:6px; padding:7px 9px;">
        <div style="font-family:var(--font-mono); font-size:10.5px; font-weight:800; color:#fda4af;">${deckLang === 'en' ? '🚨 WAITING FOR HUMAN INPUT' : '🚨 ЖДЁТ РЕШЕНИЯ ЧЕЛОВЕКА'}</div>
        <div style="font-size:11.5px; color:#ffe4e6; margin-top:2px;">${escapeHtml(agent.needsInputReason || (deckLang === 'en' ? 'Confirm the action in the terminal below' : 'Подтвердите действие в терминале ниже'))}</div>
      </div>
    `;
  }

  if (agent.parkedData && agent.parkedData.parked) {
    return `
      <div style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.45); border-radius:6px; padding:7px 9px;">
        <div style="font-family:var(--font-mono); font-size:10.5px; font-weight:800; color:#fde68a;">🟠 ${deckLang === 'en' ? 'SEAT PARKED' : 'УЗЕЛ ЗАПАРКОВАН'}</div>
        <div style="font-size:11.5px; color:#fef3c7; margin-top:2px;">${escapeHtml(agent.parkedReason || (deckLang === 'en' ? 'Open obligations without an active wake' : 'Есть обязательства без активного wake'))}</div>
      </div>
    `;
  }

  if (agent.state === 'working') {
    const screen = lastScreenBySeat[agent.id] || liveScreenCapture || '';
    const lastLine = screen.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[-─=]+$/.test(l)).slice(-1)[0] || '';
    return `
      <div style="background:rgba(0,255,157,0.06); border:1px solid rgba(0,255,157,0.25); border-radius:6px; padding:6px 9px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#6ee7b7;">${deckLang === 'en' ? '⚡ WORKING IN TERMINAL' : '⚡ РАБОТАЕТ В ТЕРМИНАЛЕ'}</div>
        ${lastLine ? `<div style="font-family:var(--font-mono); font-size:10.5px; color:#cbd5e1; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(lastLine)}">${escapeHtml(lastLine)}</div>` : ''}
      </div>
    `;
  }

  return `
    <div style="background:rgba(15,23,42,0.5); border:1px solid rgba(148,163,184,0.16); border-radius:6px; padding:6px 9px; display:flex; justify-content:space-between; align-items:center;">
      <span style="font-family:var(--font-mono); font-size:10.5px; color:#94a3b8;">💤 ${deckLang === 'en' ? 'Waiting for work' : 'Ожидает задачу'}</span>
      ${agent.assignedWorkCount ? `<span style="font-family:var(--font-mono); font-size:10.5px; color:#7dd3fc;">${deckLang === 'en' ? 'queued:' : 'в очереди:'} ${agent.assignedWorkCount}</span>` : ''}
    </div>
  `;
}

export function renderWarningSignsHtml(ctx, agent) {
  const { deckLang, escapeHtml, ageLabel } = ctx;
  const isCoder = agent.id.includes('dev-coder');
  const compCount = agent.compactionsCount || 0;
  const frequentSwaps = compCount >= 5;
  const retCount = typeof agent.returnCount === 'number'
    ? agent.returnCount
    : (Array.isArray(agent.reworkHistory) ? agent.reworkHistory.filter(r => r > 1).length : 0);
  const isReworkWarn = isCoder && (agent.reworkAvg || 1.0) > 2.0;

  // Note: context % + burn rate + ETA are already rendered in the top context pulse strip (#inspValContext),
  // so we avoid duplicating a tall "Context warming up" card and render secondary signals in one compact strip.
  const chips = [];
  if (frequentSwaps) {
    const swapMeta = agent.lastSwapAt ? ` · ${ageLabel(agent.lastSwapAt)}` : '';
    chips.push(`<span class="insp-signal-chip">🔄 ${deckLang === 'en' ? 'Swaps' : 'Свапы'}: <b>${compCount}</b>${escapeHtml(swapMeta)}</span>`);
  }
  if (isReworkWarn) {
    chips.push(`<span class="insp-signal-chip">🪃 ${deckLang === 'en' ? 'QA returns' : 'Возвраты QA'}: <b>${retCount}</b> (${agent.reworkAvg}${deckLang === 'en' ? 'r' : ' кр'})</span>`);
  }

  if (chips.length === 0) {
    if (agent.state === 'urgent') return '';
    const td = ctx.td || ((k) => k);
    return `
      <div class="insp-signals-strip">
        <span style="color:#6ee7b7;" title="${escapeHtml(td('insp.seatNominalTip'))}">🛡️ ${escapeHtml(td('insp.seatNominal'))}</span>
        <span>🔄 ${compCount} ${deckLang === 'en' ? 'swaps' : 'свап.'}${isCoder ? ` • 🪃 Avg ${agent.reworkAvg || 1.0}` : ''}</span>
      </div>
    `;
  }

  return `<div class="insp-signals-strip has-warn">${chips.join('<span style="opacity:0.35;">·</span>')}</div>`;
}

export function renderGuidanceHtml(ctx, agent) {
  const { deckLang, escapeHtml, activeInspectorTab } = ctx;
  const en = deckLang === 'en';
  const g = agent.guidance || {};
  const dutiesList = Array.isArray(g.duties) && g.duties.length > 0
    ? g.duties.map(d => `<div class="guidance-item-bullet"><span style="color:var(--cyan); flex-shrink:0;">▸</span><span>${escapeHtml(d)}</span></div>`).join('')
    : `<div style="color:#94a3b8;">${en ? 'Standard duties for this OpenRig role.' : 'Штатные обязанности агента OpenRig.'}</div>`;

  const boundariesList = Array.isArray(g.boundaries) && g.boundaries.length > 0
    ? g.boundaries.map(b => `<div class="guidance-boundary-item"><span style="color:#ff2a6d; flex-shrink:0;">⛔</span><span>${escapeHtml(b)}</span></div>`).join('')
    : `<div style="color:#94a3b8;">${en ? 'Uses the permissions granted to its workspace.' : 'Действует в рамках прав своего воркспейса.'}</div>`;

  if (activeInspectorTab === 'rules') {
    return `
      <div style="font-family:var(--font-mono); font-size:10.5px; font-weight:800; color:var(--cyan); margin-bottom:5px; text-transform:uppercase;">
        📌 ${en ? 'Role duties:' : 'Обязанности роли:'}
      </div>
      ${dutiesList}
      <div style="font-family:var(--font-mono); font-size:10.5px; font-weight:800; color:#fda4af; margin: 8px 0 5px 0; text-transform:uppercase;">
        🛑 ${en ? 'Required boundaries (AGENTS.md):' : 'Жесткие границы и запреты (AGENTS.md):'}
      </div>
      ${boundariesList}
    `;
  } else if (activeInspectorTab === 'fallback') {
    return `
      <div style="display:flex; flex-direction:column; gap:6px;">
        <div>
          <span style="font-family:var(--font-mono); font-size:10.5px; color:#94a3b8;">${en ? 'CURRENT HARNESS / MODEL:' : 'ТЕКУЩИЙ ХАРНЕС / МОДЕЛЬ:'}</span>
          <div style="font-family:var(--font-mono); font-size:12px; font-weight:700; color:#38bdf8;">${escapeHtml(agent.harness)} • ${escapeHtml(agent.model)}</div>
        </div>
        <div>
          <span style="font-family:var(--font-mono); font-size:10.5px; color:#94a3b8;">${en ? 'BILLING PROFILE:' : 'ПРОФИЛЬ БИЛЛИНГА:'}</span>
          <div style="font-size:11.5px; color:#e2e8f0;">${escapeHtml(g.profile || 'default')}</div>
        </div>
        <div>
          <span style="font-family:var(--font-mono); font-size:10.5px; color:#fcd34d;">${en ? 'FALLBACK WHEN QUOTA IS EXHAUSTED:' : 'ФОЛБЭК-МАРШРУТ (ПРИ ИСЧЕРПАНИИ КВОТЫ):'}</span>
          <div style="font-size:11.5px; color:#fde68a;">${escapeHtml(g.fallbackRoute || (deckLang === 'en' ? 'Standard restart via rig handover' : 'Штатный перезапуск через rig handover'))}</div>
        </div>
        <div style="font-size:11px; color:#94a3b8; line-height:1.4; margin-top:4px; padding:6px; background:rgba(0,0,0,0.3); border-radius:4px;">
          ${en ? '💡 <b>OpenRig:</b> The seat keeps its instructions and role during fallback. Only its runtime adapter (.toml profile, CLI flags) and model change.' : '💡 <b>Принцип OpenRig:</b> Инструкция и контракт роли привязаны к сиденью и <u>не меняются при фолбэке</u>. Меняется только адаптер рантайма (профиль .toml, CLI-флаги) и модель.'}
        </div>
      </div>
    `;
  } else if (activeInspectorTab === 'memory') {
    const recapText = agent.recapText || agent.recapSnippet || (deckLang === 'en' ? 'Latest checkpoint has no remarks.' : 'Свежая контрольная точка без замечаний.');
    return `
      <div style="font-family:var(--font-mono); font-size:10.5px; font-weight:800; color:#a7f3d0; margin-bottom:5px;">
        🧠 ${en ? 'CHECKPOINT (RECAP.md):' : 'БЕЗОПАСНАЯ ТОЧКА (RECAP.md):'}
      </div>
      <pre style="margin:0; font-family:var(--font-mono); font-size:10.5px; line-height:1.45; color:#cbd5e1; background:rgba(0,0,0,0.38); padding:8px; border-radius:5px; border-left:3px solid var(--emerald); max-height:210px; overflow:auto; white-space:pre-wrap; word-break:break-word;">${escapeHtml(recapText)}</pre>
      <div style="font-size:11px; color:#94a3b8; margin-top:6px;">
        ${en ? 'Session compactions and swaps:' : 'Всего сжатий и свапов сессии за историю:'} <b>${agent.compactionsCount || 0}</b>. ${en ? 'Seat memory is stored in' : 'Память сиденья сохраняется в'} <code>~/.openrig/topology/.../seats/${escapeHtml(agent.shortName)}/</code>.
      </div>
    `;
  }
  return '';
}

export function dedupeRadarItemsByAgent(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const out = [];
  const primaryBySeat = new Map();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const seatId = String(raw.seatId || '').trim();
    if (!seatId) {
      out.push(raw);
      continue;
    }
    const existing = primaryBySeat.get(seatId);
    if (!existing) {
      const entry = {
        ...raw,
        secondaryChips: Array.isArray(raw.secondaryChips) ? raw.secondaryChips.slice() : []
      };
      primaryBySeat.set(seatId, entry);
      out.push(entry);
      continue;
    }
    // Fold secondary signals for the same agent into compact inline chips on the primary card.
    const sliceText = String(raw.slice || '').trim();
    let chipLabel = '';
    if (/^CTX\s+\d+%/i.test(sliceText)) {
      chipLabel = `⚠️ ${sliceText}`;
    } else if (raw.prio < 1.5 && raw.state) {
      chipLabel = String(raw.state).trim();
    }
    if (chipLabel && !existing.secondaryChips.some(c => c.label === chipLabel)) {
      existing.secondaryChips.push({ label: chipLabel, tone: 'amber' });
    }
  }
  return out;
}

export function renderInteractivePromptOptionsHtml(ctx, seatId, screenText, statusElId = 'cmdSendStatus') {
  const { td, escapeHtml, getControlLockAttrs } = ctx;
  const { preview, fullCommand, options, contextLines = [] } = getHitlPromptPresentation(screenText);
  if (!preview && !options.length) return '';
  const agent = Array.isArray(ctx.agents) ? ctx.agents.find(a => a && a.id === seatId) : null;
  const shortName = ctx.shortSeat ? ctx.shortSeat(seatId) : String(seatId || '').split('@')[0];
  const cwdText = agent && agent.cwd ? String(agent.cwd).trim() : '';
  const scopeLabel = td('insp.hitlScopeSingle');
  const targetScopeHtml = options.length
    ? `<div class="hitl-target-scope">tmux: <b>${escapeHtml(shortName)}</b>${cwdText ? ` · <span>${escapeHtml(cwdText)}</span>` : ''} · <span>${escapeHtml(scopeLabel)}</span></div>`
    : '';
  const banner = preview
    ? `<div class="hitl-command-preview" title="${escapeHtml(fullCommand)}"><strong>🔍 ${escapeHtml(td('insp.hitlCmdLabel'))}</strong> <code>${escapeHtml(preview)}</code></div>`
    : '';
  const termContextHtml = contextLines.length
    ? `<pre class="hitl-term-context" aria-label="Live terminal context">${escapeHtml(contextLines.join('\n'))}</pre>`
    : '';
  if (!options.length) return banner;
  const scopeKey = buildSeatScopeKey(seatId);
  const primaryOpt = options.find(opt => opt.isPrimary && !opt.isCancel) || (!options[0].isCancel ? options[0] : null);
  const secondaryOpts = options
    .filter(opt => opt !== primaryOpt)
    .sort((a, b) => Number(Boolean(b.isCancel)) - Number(Boolean(a.isCancel)));

  let hasAlwaysOption = false;
  const renderOptBtn = (opt, isPrimarySlot) => {
    const isAlways = !isPrimarySlot && !opt.isCancel && (opt.badge === '2' || /always|всегда|remember|запомнить/i.test(`${opt.fullText || ''} ${opt.shortLabel || ''}`));
    if (isAlways) hasAlwaysOption = true;
    const cls = isPrimarySlot
      ? 'action-pill key-pill key-proceed hitl-btn-primary'
      : (opt.isCancel ? 'action-pill key-pill key-cancel hitl-btn-secondary' : 'action-pill key-pill key-neutral hitl-btn-secondary hitl-btn-always');
    const fp = buildSeatSendKey(seatId, 'key', opt.keyStroke);
    const lockAttrs = getControlLockAttrs(scopeKey, fp);
    const confirmAttrs = isAlways
      ? ` data-confirm-always="true" data-confirm-label="${escapeHtml(td('insp.hitlConfirmAlways'))}"`
      : '';
    let labelHtml;
    if (isPrimarySlot) {
      const isStandardAllowOnce = /^(?:yes,?\s*)?allow once|^(?:да,?\s*)?разрешить один раз/i.test(String(opt.shortLabel || '').trim());
      const primaryText = isStandardAllowOnce ? td('insp.hitlAllowOnceShort') : opt.shortLabel;
      labelHtml = `✅ <b>${escapeHtml(opt.badge)}.</b> ${escapeHtml(primaryText)}`;
    } else if (opt.isCancel) {
      labelHtml = `❌ ${escapeHtml(td('insp.hitlCancelShort'))}`;
    } else if (isAlways) {
      labelHtml = `🔹 ${escapeHtml(td('insp.hitlAlwaysShort'))}`;
    } else {
      labelHtml = `🔹 <b>${escapeHtml(opt.badge)}.</b> ${escapeHtml(opt.shortLabel)}`;
    }
    const btnTitle = isAlways ? `${opt.fullText} — ${td('insp.hitlAlwaysScopeNote')}` : opt.fullText;
    return `<button type="button" class="${cls}" title="${escapeHtml(btnTitle)}" data-seat="${escapeHtml(seatId)}" data-key="${escapeHtml(opt.keyStroke)}" data-status="${escapeHtml(statusElId)}"${confirmAttrs}${lockAttrs} onclick="triggerPromptOption(this)">${labelHtml}</button>`;
  };

  const primaryHtml = primaryOpt ? renderOptBtn(primaryOpt, true) : '';
  const secondaryHtml = secondaryOpts.length
    ? `<div class="hitl-secondary-row${secondaryOpts.length === 1 ? ' is-single' : ''}">${secondaryOpts.map(opt => renderOptBtn(opt, false)).join('')}</div>`
    : '';
  const alwaysNoteHtml = hasAlwaysOption
    ? `<div class="hitl-always-note">${escapeHtml(td('insp.hitlAlwaysScopeNote'))}</div>`
    : '';
  return `
    <div class="ctrl-prompt-options" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; width:100%; padding-bottom:6px; border-bottom:1px dashed rgba(56,189,248,0.25); margin-bottom:4px;">
      ${targetScopeHtml}
      ${banner}
      ${termContextHtml}
      <span class="hitl-options-kicker" style="font-family:var(--font-mono); font-size:10.5px; color:#fbbf24; font-weight:800;">${td('insp.promptOptions')}</span>
      ${primaryHtml}
      ${secondaryHtml}
      ${alwaysNoteHtml}
    </div>
  `;
}

export function updateInspectorPromptOptions(bar, html) {
  if (!bar) return;
  const doc = bar.ownerDocument;
  const hasTopInlineHitl = Boolean(doc && doc.getElementById && doc.getElementById('inspDiagInlineHitl'));
  const targetHtml = hasTopInlineHitl ? '' : html;
  if (bar.getAttribute('data-cache-key') !== targetHtml) {
    bar.innerHTML = targetHtml;
    bar.setAttribute('data-cache-key', targetHtml);
  }
}

export function renderOntologyActionBtn(ctx, desc, opts = {}) {
  const { escapeHtml, getControlLockAttrs, CMD_COPY_LABEL_HTML } = ctx;
  if (!desc) return '';
  const baseClass = opts.className || (
    desc.tone === 'proceed' ? 'action-pill key-pill key-proceed' :
    desc.tone === 'cancel' ? 'action-pill key-pill key-cancel' :
    'action-pill key-pill'
  );
  const toneStyle = opts.style || (
    desc.tone === 'critical' ? 'border-color:#ff0055; color:#fda4af;' :
    desc.tone === 'warn' ? 'border-color:#f59e0b; color:#fde68a;' : ''
  );
  const statusElId = opts.statusElId || 'cmdSendStatus';
  const closeModal = opts.closeModal || '';
  const stop = opts.stopPropagation ? 'event.stopPropagation(); ' : '';
  const isCopyCmd = desc.transport === 'clipboard';
  const explicitCopyLabel = desc.label && desc.label !== 'Cmd' ? desc.label : (ctx.td ? ctx.td('cmd.copyCommand') : 'Copy cmd');
  const btnLabelHtml = isCopyCmd
    ? `<span class="cmd-copy-label">📋 ${escapeHtml(explicitCopyLabel)}</span>`
    : escapeHtml(desc.label || (ctx.deckLang === 'en' ? '⚡ Apply' : '⚡ Применить'));
  const btnTitle = isCopyCmd && desc.payload
    ? `${desc.title || desc.label || 'Copy command'} (${desc.payload})`
    : (desc.title || desc.label || '');
  const isMutating = (desc.transport === 'tmux_key' || desc.transport === 'tmux_raw') && desc.seatId;
  let lockAttrs = '';
  if (isMutating) {
    const scopeKey = buildSeatScopeKey(desc.seatId);
    const sendType = desc.transport === 'tmux_raw' ? 'raw' : 'key';
    const fp = buildSeatSendKey(desc.seatId, sendType, desc.payload);
    lockAttrs = getControlLockAttrs(scopeKey, fp);
  }
  return `<button type="button" class="${baseClass}"${toneStyle ? ` style="${toneStyle}"` : ''} title="${escapeHtml(btnTitle)}" data-action-id="${escapeHtml(desc.id || '')}" data-transport="${escapeHtml(desc.transport || '')}" data-seat="${escapeHtml(desc.seatId || '')}" data-payload="${escapeHtml(desc.payload || '')}" data-finding-id="${escapeHtml(desc.findingId || '')}" data-status="${escapeHtml(statusElId)}" data-close-modal="${escapeHtml(closeModal)}"${lockAttrs} onclick="${stop}dispatchOntologyAction(this)">${btnLabelHtml}</button>`;
}

export function renderHarnessQuickKeys(ctx, agent, statusElId = 'cmdSendStatus') {
  const { td, lastScreenBySeat, liveScreenCapture, selectedAgentId } = ctx;
  if (!agent) return '';
  const screenText = lastScreenBySeat[agent.id] || (agent.id === selectedAgentId ? liveScreenCapture : '');
  const contextualActions = getSeatContextualActions(agent, screenText);
  const manualActions = getManualHarnessActions(agent);
  const contextualHtml = contextualActions.map(a => renderOntologyActionBtn(ctx, a, { statusElId })).join('');
  const manualHtml = manualActions.map(a => renderOntologyActionBtn(ctx, a, { statusElId })).join('');

  return `
    ${contextualHtml ? `<div style="display:flex; flex-wrap:wrap; gap:5px; align-items:center; width:100%;">${contextualHtml}</div>` : ''}
    <details style="width:100%; margin-top:${contextualHtml ? '4px' : '0'};">
      <summary style="cursor:pointer; font-family:var(--font-mono); font-size:10px; color:#64748b; user-select:none;">${td('insp.manualKeys')}</summary>
      <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:5px;">${manualHtml}</div>
    </details>
  `;
}

export function renderActionAuditHtml(ctx, seatId) {
  const { ontologySnapshot, td, escapeHtml } = ctx;
  const records = ontologySnapshot
    ? getActionRecordsForSeat(ontologySnapshot, seatId, 5)
    : [];
  if (!records.length) return '';
  const iconOf = (st) =>
    st === 'verified' ? '✅' :
    st === 'pending' ? '⏳' :
    st === 'unchanged' ? '⚠️' : '❌';
  const colorOf = (st) =>
    st === 'verified' ? '#6ee7b7' :
    st === 'pending' ? '#7dd3fc' :
    st === 'unchanged' ? '#fde68a' : '#fda4af';
  return `
    <div style="background:rgba(15,23,42,0.55); border:1px solid rgba(56,189,248,0.16); border-radius:6px; padding:6px 8px; display:flex; flex-direction:column; gap:4px;">
      <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#94a3b8; letter-spacing:0.4px;">${td('insp.auditTitle')}</div>
      ${records.map(r => {
        const tm = r.executedAt ? new Date(r.executedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        return `
          <div style="font-family:var(--font-mono); font-size:10.5px; display:flex; justify-content:space-between; align-items:baseline; gap:6px; border-top:1px dashed rgba(148,163,184,0.12); padding-top:3px;">
            <span style="color:#e2e8f0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(r.payloadPreview)}">${iconOf(r.postconditionStatus)} <b>${escapeHtml(r.actionId)}</b></span>
            <span style="color:${colorOf(r.postconditionStatus)}; flex-shrink:0; font-size:10px;" title="${escapeHtml(r.postconditionDetail || '')}">${escapeHtml(r.postconditionDetail || r.postconditionStatus)} · ${tm}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function isNoiseQueueItemUi(q) {
  if (!q) return false;
  const src = String(q.sourceSession || q.from || '').toLowerCase();
  const sum = String(q.summary || '').toLowerCase();
  const tags = Array.isArray(q.tags) ? q.tags.map(t => String(t || '').toLowerCase()) : [];
  return src.includes('change-detector') ||
    src.includes('context-guardian-observer') ||
    src.includes('opgate') ||
    tags.some(t => t.startsWith('stuck-sweep') || t.startsWith('recovery-for:') || t.startsWith('wake-')) ||
    sum.includes('undelivered-wake') || sum.includes('stalled-after-claim') || sum.includes('stuck-sweep');
}

function getActiveFindingsForSeat(ctx, seatId) {
  const { intelligence, focusedDiagnosisSeatId, focusedDiagnosisFindingId } = ctx;
  if (!seatId) return [];
  const all = (intelligence && Array.isArray(intelligence.allFindings))
    ? intelligence.allFindings
    : [];
  const matching = all.filter(f => {
    if (!f || f.severity === 'p3_info') return false;
    const target = f.actionPlan && f.actionPlan.seatTarget;
    const affected = Array.isArray(f.metrics && f.metrics.affectedSeats) ? f.metrics.affectedSeats : [];
    return target === seatId || affected.includes(seatId);
  });
  if (focusedDiagnosisFindingId && focusedDiagnosisSeatId === seatId) {
    const idx = matching.findIndex(f => f.id === focusedDiagnosisFindingId);
    if (idx > 0) {
      const [hit] = matching.splice(idx, 1);
      matching.unshift(hit);
    }
  }
  return matching;
}

export function renderSeatDiagnosisHtml(ctx, agent) {
  const {
    openQueue, deckLang, td, escapeHtml, shortSeat, focusedDiagnosisSeatId,
    focusedDiagnosisUntil, renderEvaluatorVerdictCardHtml, isEvalRunning
  } = ctx;
  if (!agent || !agent.id) return '';
  const findings = getActiveFindingsForSeat(ctx, agent.id);
  if (agent.state === 'urgent' && !findings.some(f => f && f.severity === 'p0_urgent')) {
    const sName = shortSeat(agent.id);
    findings.unshift({
      id: `live-hitl-${agent.id}`,
      detectorId: 'topology.live_blocker',
      severity: 'p0_urgent',
      title: deckLang === 'en'
        ? `🚨 ${sName} is waiting for human confirmation (HITL)`
        : `🚨 ${sName} ждёт подтверждения человека (HITL)`,
      summary: agent.needsInputReason || (deckLang === 'en'
        ? 'Agent paused on an interactive terminal confirmation prompt.'
        : 'Агент остановлен на подтверждении в терминале. Откройте окно HITL и выберите ответ.'),
      remediation: deckLang === 'en'
        ? 'Click "Resolve HITL prompt" to inspect the full terminal context, review AI risk, and pick an option.'
        : 'Нажмите «Ответить на запрос (HITL)», проверьте контекст в широком терминале и выберите вариант ответа.',
      actionPlan: { kind: 'open_modal', seatTarget: agent.id }
    });
  }
  const evalVerdictHtml = renderEvaluatorVerdictCardHtml('seat', agent.id);
  const s1Busy = isEvalRunning('seat', agent.id, 'system1');
  const s2Busy = isEvalRunning('seat', agent.id, 'system2');
  const evalTriggersHtml = `
    <span class="eval-inline-triggers">
      <button type="button" class="eval-mini-btn" data-eval-seat="${escapeHtml(agent.id)}" ${s1Busy ? 'disabled' : ''} title="${escapeHtml(td('eval.btnS1Tip'))}" onclick="runAiEvaluation('seat', this.getAttribute('data-eval-seat'), 'system1')">${s1Busy ? '⏳ S1' : escapeHtml(td('eval.btnS1Full'))}</button>
      <button type="button" class="eval-mini-btn is-s2" data-eval-seat="${escapeHtml(agent.id)}" ${s2Busy ? 'disabled' : ''} title="${escapeHtml(td('eval.btnS2Tip'))}" onclick="runAiEvaluation('seat', this.getAttribute('data-eval-seat'), 'system2')">${s2Busy ? '⏳ S2' : escapeHtml(td('eval.btnS2Full'))}</button>
      <button type="button" class="eval-mini-btn" style="border-color:rgba(148,163,184,0.3); color:#94a3b8; background:transparent;" title="${escapeHtml(td('eval.configureBtn'))}" onclick="openGuardrailsModal('evaluator')">⚙️</button>
    </span>
  `;
  const evalDetailsHtml = `
    <details class="diag-ai-details"${s1Busy || s2Busy ? ' open' : ''}>
      <summary class="diag-ai-summary" title="${escapeHtml(td('eval.detailsSummaryTip'))}">${escapeHtml(td('eval.detailsSummary'))}</summary>
      <div class="diag-ai-body">${evalTriggersHtml}</div>
    </details>
  `;
  if (findings.length === 0) {
    return `
      <div class="eval-bar-row" id="inspEvalMiniBar">
        ${evalDetailsHtml}
      </div>
      ${evalVerdictHtml}
    `;
  }

  const primary = findings[0];
  const extras = findings.slice(1, 3);
  const sevClass = primary.severity === 'p0_urgent' ? 'is-p0' : (primary.severity === 'p1_high' ? 'is-p1' : 'is-p2');
  const sevBadge = primary.severity === 'p0_urgent' ? 'P0' : (primary.severity === 'p1_high' ? 'P1' : 'P2');
  const isSpotlight = focusedDiagnosisSeatId === agent.id && Date.now() <= focusedDiagnosisUntil;

  // Collect concrete pending/open tasks for this seat so the operator sees WHAT is actually waiting
  let samples = Array.isArray(primary.metrics && primary.metrics.pendingSamples)
    ? primary.metrics.pendingSamples
    : [];
  let totalPending = Number(primary.metrics && primary.metrics.pendingCount) || samples.length;
  let noiseCount = Number(primary.metrics && primary.metrics.noisePendingCount) || 0;

  if (samples.length === 0 && Array.isArray(openQueue) && openQueue.length > 0) {
    const forSeat = openQueue.filter(q => q.destinationSession === agent.id && q.state !== 'done' && q.state !== 'terminal');
    const realRows = [];
    for (const q of forSeat) {
      if (isNoiseQueueItemUi(q)) {
        noiseCount++;
        continue;
      }
      const slice = ((q.tags || []).find(t => typeof t === 'string' && t.startsWith('slice:')) || '').replace(/^slice:/, '');
      realRows.push({
        from: q.sourceSession || '',
        slice,
        summary: String(q.summary || q.title || '').trim().slice(0, 120),
        state: q.state || 'pending'
      });
    }
    if (realRows.length > 0 && (primary.detectorId === 'topology.bottleneck' || primary.detectorId === 'topology.live_blocker' || primary.detectorId === 'parked_seat')) {
      samples = realRows.slice(0, 3);
      totalPending = realRows.length;
    }
  }

  const maxDiagSamples = agent.state === 'urgent' ? 2 : 3;
  const queueBoxHtml = (samples.length > 0 || noiseCount > 0) ? `
    <div class="diag-queue-box">
      <div class="diag-queue-head">
        <span>📦 ${escapeHtml(td('diag.queueWaiting'))} ${totalPending > 0 ? `<b>${totalPending}</b>` : '0'}</span>
        ${noiseCount > 0 ? `<span style="color:#94a3b8;">${escapeHtml(td('diag.noiseNote', { n: noiseCount }))}</span>` : ''}
      </div>
      ${samples.slice(0, maxDiagSamples).map(item => `
        <div class="diag-queue-row">
          ${item.slice ? `<span style="color:var(--cyan); font-weight:700;">${escapeHtml(item.slice)}</span> · ` : ''}
          <span style="color:#94a3b8;">${escapeHtml(shortSeat(item.from || ''))}</span>
          ${item.summary ? ` — ${escapeHtml(item.summary)}` : ''}
        </div>
      `).join('')}
      ${totalPending > maxDiagSamples ? `<div style="font-family:var(--font-mono); font-size:9.5px; color:#64748b;">${escapeHtml(td('diag.moreTasks', { n: totalPending - maxDiagSamples }))}</div>` : ''}
    </div>
  ` : '';

  // Remediation guidance text
  const fallbackRemediation = agent.shellExited
    ? (deckLang === 'en'
        ? `Agent exited to bare shell — restart the seat with ${buildSeatRelaunchCommand(agent.id, 'shell exited')}.`
        : `Агент вышел в shell — перезапустите сиденье командой ${buildSeatRelaunchCommand(agent.id, 'shell exited')}.`)
    : (primary.detectorId === 'topology.bottleneck' || primary.detectorId === 'topology.live_blocker' || primary.detectorId === 'parked_seat')
      ? (deckLang === 'en'
          ? 'Click "Process queue" to send an explicit instruction (empty Enter on an idle prompt does nothing), or inspect tasks on Gantt.'
          : 'Нажмите «Разобрать очередь», чтобы отправить агенту явную задачу проверить rig queue list --owned (пустой Enter на чистом промпте не запускает работу), либо откройте Гант.')
      : '';
  const remediationText = primary.remediation || fallbackRemediation;

  const inlineHitlScreen = agent.state === 'urgent'
    ? ((ctx.lastScreenBySeat && ctx.lastScreenBySeat[agent.id]) || (agent.id === ctx.selectedAgentId ? ctx.liveScreenCapture : '') || '')
    : '';
  const inlineHitlHtml = inlineHitlScreen
    ? renderInteractivePromptOptionsHtml(ctx, agent.id, inlineHitlScreen, 'cmdSendStatus')
    : '';
  const hasInlineHitlOptions = Boolean(inlineHitlHtml && inlineHitlHtml.includes('triggerPromptOption'));
  const inlineHitlBlockHtml = inlineHitlHtml
    ? `<div class="diag-inline-hitl" id="inspDiagInlineHitl">${inlineHitlHtml}</div>`
    : '';

  // Build actionable 1-click buttons (skip useless select_seat since we are already on this seat!)
  const actionBtns = [];
  const seenActionIds = new Set();
  const pushAction = (desc, extraStyle = '', extraClass = '') => {
    if (!desc || !desc.id || seenActionIds.has(desc.id)) return;
    seenActionIds.add(desc.id);
    const opts = { statusElId: 'cmdSendStatus', style: extraStyle };
    if (extraClass) opts.className = extraClass;
    actionBtns.push(renderOntologyActionBtn(ctx, desc, opts));
  };

  const resolvedPrimary = primary.actionPlan ? resolveActionFromFinding(primary.actionPlan, agent) : null;
  if (resolvedPrimary && resolvedPrimary.transport !== 'select_seat') {
    if (agent.state === 'urgent' && resolvedPrimary.transport === 'modal_terminal') {
      if (hasInlineHitlOptions) {
        pushAction({ ...resolvedPrimary, label: td('diag.openTmux80Btn') }, '', 'diag-tmux-secondary-link');
      } else {
        pushAction({ ...resolvedPrimary, label: td('diag.resolveHitlBtn') }, '', 'action-pill diag-hitl-primary');
      }
    } else {
      pushAction(resolvedPrimary);
    }
  }

  const isQueueOrParkedIssue =
    primary.detectorId === 'topology.bottleneck' ||
    primary.detectorId === 'topology.live_blocker' ||
    primary.detectorId === 'parked_seat';

  if (isQueueOrParkedIssue && !agent.shellExited && agent.state !== 'urgent') {
    pushAction(
      buildNudgeQueueAction(agent.id, deckLang, {
        label: td('diag.nudgeQueueBtn'),
        title: td('diag.nudgeQueueTip')
      }),
      'border-color:rgba(0,255,157,0.55); color:#6ee7b7; background:rgba(0,255,157,0.12);'
    );

    pushAction({
      id: 'open_diag_gantt',
      transport: 'gantt_slice',
      seatId: agent.id,
      payload: (primary.metrics && primary.metrics.affectedSlices && primary.metrics.affectedSlices[0]) || '',
      label: td('diag.openGanttBtn'),
      title: td('diag.openGanttBtn'),
      tone: 'default'
    });

    pushAction({
      id: 'copy_queue_cmd',
      transport: 'clipboard',
      seatId: agent.id,
      payload: 'rig queue list --owned',
      label: td('cmd.copyCommand'),
      title: 'rig queue list --owned',
      tone: 'default'
    });
  }

  const extrasHtml = extras.length > 0 ? `
    <div class="diag-extra-row">
      <div style="font-family:var(--font-mono); font-size:9.5px; color:#94a3b8; font-weight:700;">${escapeHtml(td('diag.moreFindings', { n: extras.length }))}:</div>
      ${extras.map(ex => `
        <div style="font-size:10.5px; color:#cbd5e1;">• <b>${escapeHtml(ex.title || '')}</b>${ex.summary ? ` — ${escapeHtml(String(ex.summary).slice(0, 120))}` : ''}</div>
      `).join('')}
    </div>
  ` : '';

  const useCompactUtilityRow = hasInlineHitlOptions && actionBtns.length === 1 && !s1Busy && !s2Busy;
  const actionsAndEvalHtml = useCompactUtilityRow
    ? `<div class="diag-utility-row">${actionBtns[0]}${evalDetailsHtml}</div>`
    : `${actionBtns.length > 0 ? `<div class="diag-actions">${actionBtns.join('')}</div>` : ''}${evalDetailsHtml}`;

  return `
    <div class="seat-diagnosis-card ${sevClass}${hasInlineHitlOptions ? ' is-inline-hitl-compact' : ''} ${isSpotlight ? 'is-spotlight' : ''}" id="seatDiagnosisCard">
      ${hasInlineHitlOptions ? '' : `<div class="diag-kicker"><span>${sevBadge} • ${escapeHtml(td('diag.header'))}</span></div><div class="diag-title">${escapeHtml(primary.title || '')}</div>`}
      ${primary.summary && !hasInlineHitlOptions ? `<div class="diag-summary">${escapeHtml(primary.summary)}</div>` : ''}
      ${inlineHitlBlockHtml}
      ${queueBoxHtml}
      ${remediationText && !inlineHitlHtml ? `<div class="diag-remediation"><b style="color:var(--cyan);">${escapeHtml(td('diag.whatToDo'))}</b> ${escapeHtml(remediationText)}</div>` : ''}
      ${actionsAndEvalHtml}
      ${evalVerdictHtml}
      ${extrasHtml}
    </div>
  `;
}

function formatSeatUsageMeta(agent, deckLang) {
  const u = agent && agent.usage;
  if (!u || !u.totalTokens) return '';
  return ` • 💰 ~$${u.estUsd.toFixed(2)} (${formatTokensShort(u.totalTokens)} tok, ${u.cachedPct}% ${deckLang === 'en' ? 'cached' : 'кэш'})`;
}

function formatAgentHarnessLabel(ctx, agent) {
  const { lastScreenBySeat, liveScreenCapture, selectedAgentId } = ctx;
  if (!agent) return '';
  let harness = String(agent.detectedHarness || agent.harness || 'agent').trim();
  let model = String(agent.model || '').trim();
  if (!model || model === 'terminal' || harness === 'terminal') {
    const scr = (lastScreenBySeat && lastScreenBySeat[agent.id]) || (agent.id === selectedAgentId ? liveScreenCapture : '');
    if (scr) {
      const cls = classifyTerminalScreen(scr, harness);
      if (cls && cls.harness && cls.harness !== 'generic' && (harness === 'terminal' || harness === 'generic')) {
        harness = cls.harness === 'antigravity' ? 'agy' : cls.harness;
      }
      if (cls && cls.detectedModel && (!model || model === 'terminal' || model === harness)) {
        model = cls.detectedModel;
      }
    }
  }
  if (harness === 'antigravity') harness = 'agy';
  if (!model || model === harness) return harness;
  return `${harness} • ${model}`;
}

// Follow output only while the reader is at the bottom. A blocking prompt must be visible
// even when the capture is unchanged (for example, after opening a collapsed panel).
export function updateTerminalScreen(box, text, followThreshold = 45, updateControls) {
  if (!box) return;
  const changed = box.textContent !== text;
  const oldHeight = box.clientHeight;
  const wasFollowing = box.scrollHeight - box.scrollTop - oldHeight < followThreshold;
  if (changed) box.textContent = text;
  // The modal controls share the available height with this scroll box.
  updateControls?.();
  const follow = wasFollowing && (changed || (updateControls && oldHeight !== box.clientHeight));
  if (follow || detectLiveHitlPrompt(text).blocked) box.scrollTop = box.scrollHeight;
}

export function renderInspectorAndScorecards(document, ctx, flashHighlight = false) {
  const {
    agents, queueItems, ganttRows, showAllQueuePackets, deckLang, td, escapeHtml, shortSeat,
    getNodeDisplayTitle, ageLabel, activeInspectorTab, lastScreenBySeat, liveScreenCapture,
    selectedAgentId, getControlLockAttrs, CMD_COPY_LABEL_HTML, renderStateIndicatorHtml,
    formatRoleForRig, tmuxStreamConnected, tmuxStreamSeat, autoFollow, inspectorRefOpen,
    currentRigFilter, expandedQueueEnvelopes, formatEnvelopeClock
  } = ctx;
  const agent = agents.find(a => a.id === selectedAgentId) || agents[0];
  const thermal = getContextThermal(agent.ctxPct, agent.ctxWindowSize);
  const box = document.getElementById('nodeInspector');
  const headerBadge = document.getElementById('selectedNodeHeaderBadge');
  if (headerBadge) {
    headerBadge.textContent = `◎ ${td('insp.selected', { name: getNodeDisplayTitle(agent).toUpperCase() })}`;
    headerBadge.style.color = '#7dd3fc';
    headerBadge.style.borderColor = 'rgba(0, 240, 255, 0.55)';
  }

  const lastActStr = agent.lastActivityAt
    ? new Date(agent.lastActivityAt).toLocaleTimeString('ru-RU')
    : 'live';
  const exactTokensLine = agent.ctxUsedTokens && agent.ctxWindowSize
    ? `${agent.ctxUsedTokens.toLocaleString('ru-RU')} / ${agent.ctxWindowSize.toLocaleString('ru-RU')} tok`
    : thermal.label;
  const isSwarmSeat = Boolean(agent.capabilities && agent.capabilities.canSendKeys === false && agent.capabilities.readOnlyBoard === true);
  const attachCmd = isSwarmSeat ? '/swarm board' : (agent.tmuxAttachCommand || `rig capture ${agent.id} --lines 40`);
  const showBurnInline = (typeof agent.ctxPct === 'number' && agent.ctxPct >= 60) || computeBurn(agent, deckLang).perHour > 0;
  const quickKeysHtml = isSwarmSeat ? '' : renderHarnessQuickKeys(ctx, agent, 'cmdSendStatus');
  const diagHtmlNow = renderSeatDiagnosisHtml(ctx, agent);
  const hasTopInlineHitl = Boolean(diagHtmlNow && diagHtmlNow.includes('id="inspDiagInlineHitl"'));
  const optionsHtml = (isSwarmSeat || hasTopInlineHitl)
    ? ''
    : renderInteractivePromptOptionsHtml(ctx, agent.id, lastScreenBySeat[agent.id] || '');
  const attachBtnLabel = isSwarmSeat ? td('swarm.copyBoardBtn') : td('insp.copyAttachBtn');
  const driftBadgeHtml = agent.schemaDrift
    ? `<span class="spec-drift-pill is-schema-drift" title="${escapeHtml(td('drift.schemaDriftTip'))}">⚠️ ${escapeHtml(td('drift.schemaDriftBadge'))}</span>`
    : (agent.providerDrift?.status === 'unverified_version'
        ? `<span class="spec-drift-pill is-unverified" title="${escapeHtml(td('drift.unverifiedTip'))}">ℹ️ ${escapeHtml(td('drift.unverifiedBadge'))}</span>`
        : '');
  const renderSwarmBoardBody = () => {
    const sm = agent.swarmMeta || {};
    const tail = Array.isArray(sm.boardTail) ? sm.boardTail : [];
    const metaLine = [sm.title, sm.workspaceMode ? `ws:${sm.workspaceMode}` : '', sm.boardCursor != null ? `#${sm.boardCursor}` : '']
      .filter(Boolean).join(' · ');
    const tailText = tail.length > 0
      ? tail.map(e => `[#${e.seq ?? '?'} ${e.agent || '?'}] ${e.text || ''}`).join('\n')
      : (sm.goalLine || td('swarm.emptyBoard'));
    return `${metaLine ? `${metaLine}\n${'─'.repeat(Math.min(48, Math.max(16, metaLine.length)))}\n` : ''}${tailText}`;
  };
  const screenOrSwarmTitle = isSwarmSeat ? `🐝 ${escapeHtml(td('swarm.boardTailTitle'))}` : '🖥️ TMUX';
  const screenOrSwarmText = isSwarmSeat ? renderSwarmBoardBody() : liveScreenCapture;

  const existingCard = document.getElementById('inspectorBoxCard');
  const canPatchInPlace = existingCard && existingCard.dataset.seat === agent.id && !flashHighlight;

  if (canPatchInPlace) {
    // --- SURGICAL IN-PLACE DOM PATCHING (Preserves input focus, text selection, scroll) ---
    // Dark Cockpit discipline: outer Inspector card stays calm slate/cyan (red is strictly inner P0 HITL card)
    existingCard.style.borderColor = '';

    const elAct = document.getElementById('inspValActivity');
    if (elAct) {
      const isUrg = agent.state === 'urgent';
      elAct.className = isUrg ? 'insp-act-pill is-urgent' : 'insp-act-pill';
      elAct.style.color = isUrg ? '#fecdd3' : (agent.state === 'working' ? '#6ee7b7' : '#7dd3fc');
      elAct.innerHTML = `${renderStateIndicatorHtml(agent)} <span style="font-size:10.5px; color:${isUrg ? '#ffe4e6' : '#94a3b8'}; font-weight:500;">(${lastActStr})</span>`;
    }

    const elHarness = document.getElementById('inspValHarness');
    if (elHarness) {
      const harnessLbl = formatAgentHarnessLabel(ctx, agent);
      elHarness.textContent = harnessLbl;
      elHarness.title = harnessLbl;
    }
    const elDrift = document.getElementById('inspValDriftBadge');
    if (elDrift && elDrift.getAttribute('data-cache-key') !== driftBadgeHtml) {
      elDrift.innerHTML = driftBadgeHtml;
      elDrift.setAttribute('data-cache-key', driftBadgeHtml);
    }

    const elCtx = document.getElementById('inspValContext');
    if (elCtx) {
      const isCritCtx = thermal.tier === 'crit';
      elCtx.className = isCritCtx ? 'insp-ctx-pill is-crit' : 'insp-ctx-pill';
      elCtx.style.color = isCritCtx ? '#fde68a' : thermal.color;
      elCtx.title = exactTokensLine;
      elCtx.textContent = agent.schemaDrift
        ? td('drift.unknownMetrics')
        : `${thermal.label}${showBurnInline ? ' • ' + computeBurn(agent, deckLang).label : ''}`;
    }

    const elCtxBar = document.getElementById('inspCtxBarFill');
    if (elCtxBar) {
      elCtxBar.style.width = `${thermal.pct}%`;
      elCtxBar.style.background = thermal.tier === 'crit' ? '#f59e0b' : thermal.color;
    }

    const elDiag = document.getElementById('inspSeatDiagnosis');
    if (elDiag) {
      if (elDiag.getAttribute('data-cache-key') !== diagHtmlNow) {
        elDiag.innerHTML = diagHtmlNow;
        elDiag.setAttribute('data-cache-key', diagHtmlNow);
      }
    }

    const elTask = document.getElementById('inspCurrentTask');
    if (elTask) {
      const taskHtml = renderCurrentTaskHtml(ctx, agent);
      if (elTask.getAttribute('data-cache-key') !== taskHtml) {
        elTask.innerHTML = taskHtml;
        elTask.setAttribute('data-cache-key', taskHtml);
      }
    }

    const elGit = document.getElementById('inspGitWorktree');
    if (elGit) {
      const gitHtml = renderSeatGitWorktreeHtml(ctx, agent);
      if (elGit.getAttribute('data-cache-key') !== gitHtml) {
        elGit.innerHTML = gitHtml;
        elGit.setAttribute('data-cache-key', gitHtml);
      }
    }

    const elWarnGrid = document.getElementById('inspWarningSignsGrid');
    if (elWarnGrid) {
      const warnHtml = renderWarningSignsHtml(ctx, agent);
      if (elWarnGrid.getAttribute('data-cache-key') !== warnHtml) {
        elWarnGrid.innerHTML = warnHtml;
        elWarnGrid.setAttribute('data-cache-key', warnHtml);
      }
    }

    const elQuickKeys = document.getElementById('ctrlQuickKeysBar');
    if (elQuickKeys && elQuickKeys.getAttribute('data-cache-key') !== quickKeysHtml) {
      elQuickKeys.innerHTML = quickKeysHtml;
      elQuickKeys.setAttribute('data-cache-key', quickKeysHtml);
    }

    const elTechMeta = document.getElementById('inspTechMeta');
    if (elTechMeta) {
      elTechMeta.innerHTML = `📥 ${agent.callsIn} / 📤 ${agent.callsOut} ${deckLang === 'en' ? 'calls' : 'выз'} • 📂 ${escapeHtml(agent.cwd)}${agent.assignedWorkCount ? ` • ${deckLang === 'en' ? 'Active' : 'В работе'}: ${agent.assignedWorkCount}` : ''}${escapeHtml(formatSeatUsageMeta(agent, deckLang))}`;
    }

    const elAudit = document.getElementById('inspActionAudit');
    if (elAudit) {
      const auditHtml = renderActionAuditHtml(ctx, agent.id);
      if (elAudit.getAttribute('data-cache-key') !== auditHtml) {
        elAudit.innerHTML = auditHtml;
        elAudit.setAttribute('data-cache-key', auditHtml);
      }
    }

    const elGuidance = document.getElementById('inspGuidanceBody');
    if (elGuidance) {
      const gHtml = renderGuidanceHtml(ctx, agent);
      const gKey = `${activeInspectorTab}:${gHtml}`;
      if (elGuidance.getAttribute('data-cache-key') !== gKey) {
        elGuidance.innerHTML = gHtml;
        elGuidance.setAttribute('data-cache-key', gKey);
      }
    }

    const tabBtns = document.querySelectorAll('.guidance-tab-btn');
    tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === activeInspectorTab);
    });

    updateInspectorPromptOptions(document.getElementById('inspectorPromptOptionsBar'), optionsHtml);
    const btnFollow = document.getElementById('btnAutoFollow');
    if (btnFollow) {
      btnFollow.textContent = autoFollow ? td('insp.autoFollowOn') : td('insp.autoFollowOff');
    }
  } else {
    // --- FULL MOUNT (When switching to another node or flashHighlight requested) ---
    const prevInput = document.getElementById('terminalCmdInput');
    const hadFocus = prevInput && document.activeElement === prevInput;
    const curInputVal = prevInput ? prevInput.value : '';

    box.innerHTML = `
      <div class="inspector-box" id="inspectorBoxCard" data-seat="${escapeHtml(agent.id)}" style="transition: box-shadow 0.25s ease;">
        <!-- SA Level 1: Identity & Primary Actions -->
        <div class="insp-identity-row" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:5px 6px; margin-bottom:5px; width:100%; box-sizing:border-box;">
          <div style="display:flex; align-items:center; gap:6px; min-width:130px; flex:1 1 130px;">
            <span style="font-size:17px; flex-shrink:0;">${escapeHtml(agent.icon)}</span>
            <div style="min-width:0; flex:1;">
              <div style="font-family:var(--font-mono); font-size:12.5px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.2;" title="${escapeHtml(agent.id)}">
                ${escapeHtml(getNodeDisplayTitle(agent))}
              </div>
              <div class="insp-role-subtitle" style="font-size:10.5px; color:#94a3b8; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(formatRoleForRig(agent.role))}</div>
            </div>
          </div>
          <div class="insp-identity-actions" style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button type="button" class="action-pill insp-copy-attach-btn" style="padding:4px 8px; font-size:10px; min-height:28px;" data-cmd="${escapeHtml(attachCmd)}" title="${escapeHtml(attachCmd)}" onclick="copyCmd(this.getAttribute('data-cmd'))">📋 ${escapeHtml(attachBtnLabel)}</button>
            ${isSwarmSeat ? '' : `<button type="button" class="action-pill key-cancel insp-ctrlc-btn" style="padding:4px 8px; font-size:10px; min-height:28px;" data-seat="${escapeHtml(agent.id)}" data-key="C-c" data-status="cmdSendStatus" title="${escapeHtml(td('insp.ctrlCTip'))}"${getControlLockAttrs(buildSeatScopeKey(agent.id), buildSeatSendKey(agent.id, 'key', 'C-c'))} onclick="sendTerminalKey(this.getAttribute('data-seat'), 'C-c', 'cmdSendStatus', 'ctrl_c', this)">🛑 Ctrl+C</button>`}
          </div>
        </div>

        <!-- SA Level 1: Unified Status & Context Pulse Strip -->
        <div class="insp-status-strip${agent.state === 'urgent' && hasTopInlineHitl ? ' is-compact-hitl' : ''}" style="background:rgba(15,23,42,0.62); border:1px solid rgba(56,189,248,0.18); border-radius:6px; padding:5px 8px; display:flex; flex-direction:column; gap:4px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
            <div id="inspValActivity" class="${agent.state === 'urgent' ? 'insp-act-pill is-urgent' : 'insp-act-pill'}" style="display:flex; align-items:center; gap:5px; font-family:var(--font-mono); font-size:11.5px; font-weight:700; color:${agent.state === 'urgent' ? '#fecdd3' : agent.state === 'working' ? '#6ee7b7' : '#7dd3fc'};">
              ${renderStateIndicatorHtml(agent)} <span style="font-size:10.5px; color:${agent.state === 'urgent' ? '#ffe4e6' : '#94a3b8'}; font-weight:500;">(${lastActStr})</span>
            </div>
            <span style="display:inline-flex; align-items:center; gap:4px; max-width:100%; flex-wrap:wrap; justify-content:flex-end;">
              <span id="inspValHarness" style="font-family:var(--font-mono); font-size:10.5px; color:#e9d5ff; background:rgba(168,85,247,0.12); border:1px solid rgba(168,85,247,0.25); padding:1px 6px; border-radius:4px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(formatAgentHarnessLabel(ctx, agent))}">${escapeHtml(formatAgentHarnessLabel(ctx, agent))}</span>
              <span id="inspValDriftBadge" data-cache-key="${escapeHtml(driftBadgeHtml)}">${driftBadgeHtml}</span>
            </span>
          </div>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <div style="flex:1 1 56px; min-width:44px; height:5px; background:rgba(148,163,184,0.16); border-radius:999px; overflow:hidden;">
              <div id="inspCtxBarFill" style="width:${thermal.pct}%; height:100%; background:${thermal.tier === 'crit' ? '#f59e0b' : thermal.color}; transition:width 0.3s ease;"></div>
            </div>
            <span id="inspValContext" class="${thermal.tier === 'crit' ? 'insp-ctx-pill is-crit' : 'insp-ctx-pill'}" style="font-family:var(--font-mono); font-size:10.5px; font-weight:700; color:${thermal.tier === 'crit' ? '#fde68a' : thermal.color}; max-width:100%; white-space:normal; line-height:1.35; overflow-wrap:anywhere;" title="${exactTokensLine}">${agent.schemaDrift ? escapeHtml(td('drift.unknownMetrics')) : `${thermal.label}${showBurnInline ? ' • ' + computeBurn(agent, deckLang).label : ''}`}</span>
          </div>
        </div>

        <!-- SA Level 1.5: Actionable Fleet Intelligence Diagnosis (What is wrong & how to fix it) -->
        <div id="inspSeatDiagnosis" data-cache-key="${escapeHtml(diagHtmlNow)}">${diagHtmlNow}</div>

        <!-- SA Level 2: Current Task -->
        <div id="inspCurrentTask">${renderCurrentTaskHtml(ctx, agent)}</div>

        <!-- SA Level 2: Git Worktree & Conflict Status -->
        <div id="inspGitWorktree">${renderSeatGitWorktreeHtml(ctx, agent)}</div>

        <!-- SA Level 2: Management-by-Exception Signals -->
        <div id="inspWarningSignsGrid">${renderWarningSignsHtml(ctx, agent)}</div>

        <!-- SA Level 3: Action Feedback, Live TMUX / Read-only Swarm Preview & Collapsible Manual Operator Input -->
        <div id="cmdSendStatus" class="ctrl-status"></div>
        <div style="font-family:var(--font-mono); font-size:10px; color:#94a3b8; display:flex; justify-content:space-between; align-items:center; margin-top:2px; gap:4px; flex-wrap:nowrap;">
          <span style="display:inline-flex; align-items:center; gap:5px; white-space:nowrap; font-weight:700;">${screenOrSwarmTitle} ${isSwarmSeat ? '' : `<span id="inspTmuxStreamBadge" class="tmux-stream-pill" style="display:${tmuxStreamConnected && tmuxStreamSeat === agent.id ? 'inline-flex' : 'none'};" title="${escapeHtml(td('sse.streamTip'))}">${escapeHtml(td('sse.streamLive'))}</span>`}</span>
          ${(isSwarmSeat || agent.state === 'urgent') ? '' : `<span style="display:flex; gap:4px; flex-shrink:0; align-items:center;">
            <button class="action-pill tmux-hdr-btn" type="button" title="${escapeHtml(td('insp.retryCaptureBtn'))}" onclick="fetchTerminalCapture(selectedAgentId, false)">🔄</button>
            <button class="action-pill tmux-hdr-btn" type="button" id="btnAutoFollow" onclick="toggleAutoFollow()">${autoFollow ? td('insp.autoFollowOn') : td('insp.autoFollowOff')}</button>
            <button class="action-pill tmux-hdr-btn" type="button" data-seat="${escapeHtml(agent.id)}" onclick="openTerminalModal(this.getAttribute('data-seat'))">${td('insp.expand80')}</button>
          </span>`}
        </div>
        <div class="terminal-screen" id="tmuxScreenBox">${escapeHtml(screenOrSwarmText)}</div>

        ${isSwarmSeat ? `
        <div class="swarm-readonly-note" style="font-family:var(--font-mono); font-size:10.5px; color:#94a3b8; background:rgba(15,23,42,0.55); border:1px solid rgba(56,189,248,0.22); border-radius:8px; padding:8px 10px; margin-top:4px; line-height:1.45;">🐝 ${escapeHtml(td('swarm.readonlyNotice'))}</div>
        ` : `
        <div class="terminal-ctrl-bar" id="terminalCtrlBar">
          <div id="inspectorPromptOptionsBar" data-cache-key="${escapeHtml(optionsHtml)}">${optionsHtml}</div>
          <div class="ctrl-quick-keys" id="ctrlQuickKeysBar" data-cache-key="${escapeHtml(quickKeysHtml)}">
            ${quickKeysHtml}
          </div>
          <details class="manual-cmd-disclosure" id="manualCmdDisclosure">
            <summary class="manual-cmd-summary">${escapeHtml(td('insp.manualCmdSummary'))}</summary>
            <form class="ctrl-input-form" data-seat="${escapeHtml(agent.id)}" onsubmit="submitAgentPrompt(this.dataset.seat, event, 'terminalCmdInput', 'cmdSendStatus')">
              <div class="ctrl-prompt-tag">&gt;</div>
              <input type="text" id="terminalCmdInput" class="ctrl-input" placeholder="${escapeHtml(td('insp.cmdPlaceholder'))}" autocomplete="off" onkeydown="handleHistoryKey(event, 'terminalCmdInput')" />
              <button type="submit" class="cyber-btn active ctrl-send-btn"${getControlLockAttrs(buildSeatScopeKey(agent.id))}>${td('insp.sendBtn')}</button>
            </form>
          </details>
        </div>
        `}

        <!-- SA Level 3: Verified Action Audit Trail (Always visible when records exist) -->
        <div id="inspActionAudit">${renderActionAuditHtml(ctx, agent.id)}</div>

        <!-- Reference & Rare Metadata Accordion (Collapsed by default) -->
        <details ${inspectorRefOpen ? 'open' : ''} ontoggle="setInspectorRefOpen(this.open)" style="border-top:1px solid rgba(56,189,248,0.14); padding-top:6px;">
          <summary style="cursor:pointer; font-family:var(--font-mono); font-size:10.5px; color:#94a3b8; user-select:none; display:flex; justify-content:space-between; align-items:center;">
            <span>${td('insp.refSummary')}</span>
            <span style="font-size:10px; color:#64748b;">${td('insp.expand')}</span>
          </summary>
          <div style="margin-top:8px; display:flex; flex-direction:column; gap:8px;">
            <div id="inspTechMeta" style="font-family:var(--font-mono); font-size:10.5px; color:#94a3b8; background:rgba(15,23,42,0.45); padding:5px 8px; border-radius:5px;">
              📥 ${agent.callsIn} / 📤 ${agent.callsOut} • 📂 ${escapeHtml(agent.cwd)}${agent.assignedWorkCount ? ` • ${deckLang === 'en' ? 'Active' : 'В работе'}: ${agent.assignedWorkCount}` : ''}${escapeHtml(formatSeatUsageMeta(agent, deckLang))}
            </div>
            <div class="guidance-panel" style="margin-top:0;">
              <div class="guidance-tabs">
                <button class="guidance-tab-btn ${activeInspectorTab === 'rules' ? 'active' : ''}" data-tab="rules" onclick="setInspectorTab('rules')">${td('insp.tabRules')}</button>
                <button class="guidance-tab-btn ${activeInspectorTab === 'fallback' ? 'active' : ''}" data-tab="fallback" onclick="setInspectorTab('fallback')">${td('insp.tabHarness')}</button>
                <button class="guidance-tab-btn ${activeInspectorTab === 'memory' ? 'active' : ''}" data-tab="memory" onclick="setInspectorTab('memory')">${td('insp.tabRecap')}</button>
              </div>
              <div class="guidance-body" id="inspGuidanceBody">
                ${renderGuidanceHtml(ctx, agent)}
              </div>
            </div>
          </div>
        </details>
      </div>
    `;

    const nextInput = document.getElementById('terminalCmdInput');
    if (nextInput && curInputVal) nextInput.value = curInputVal;
    if (nextInput && hadFocus) nextInput.focus();

    if (flashHighlight) {
      const card = document.getElementById('inspectorBoxCard');
      if (card) {
        card.style.boxShadow = `0 0 26px ${thermal.color}`;
        setTimeout(() => {
          if (card) card.style.boxShadow = 'none';
        }, 450);
      }
    }
  }

  updateTerminalScreen(document.getElementById('tmuxScreenBox'), screenOrSwarmText, 35);

  const visibleQItems = currentRigFilter === 'all'
    ? queueItems
    : queueItems.filter(q => {
        const sfx = '@' + currentRigFilter;
        return String(q.fromId || q.from || '').endsWith(sfx) || String(q.toId || q.to || '').endsWith(sfx);
      });
  document.getElementById('queueCountBadge').textContent = `${visibleQItems.length} ${td('insp.itemsUnit')}`;

  // Index Gantt history once for all queue cards.
  const ganttBySlice = new Map();
  for (const g of (Array.isArray(ganttRows) ? ganttRows : [])) {
    if (!g) continue;
    const sl = g.slice || (typeof g.chain === 'string' && g.chain.startsWith('slice:') ? g.chain.slice(6) : '');
    if (!sl) continue;
    if (!ganttBySlice.has(sl)) ganttBySlice.set(sl, []);
    ganttBySlice.get(sl).push(g);
  }

  const seatShort = getNodeDisplayTitle(agent);
  const isInvolvedItem = (q) => {
    const fromDisp = shortSeat(q.fromId || q.from);
    const toDisp = shortSeat(q.toId || q.to);
    return fromDisp === seatShort || toDisp === seatShort ||
      (q.fromId && q.fromId === agent.id) || (q.toId && q.toId === agent.id);
  };
  const sortedQItems = visibleQItems.slice().sort((a, b) => (isInvolvedItem(b) ? 1 : 0) - (isInvolvedItem(a) ? 1 : 0));
  const QUEUE_PACKETS_LIMIT = 24;
  const showAllQ = Boolean(showAllQueuePackets);
  const renderedQItems = showAllQ ? sortedQItems : sortedQItems.slice(0, QUEUE_PACKETS_LIMIT);
  const hiddenQCount = Math.max(0, sortedQItems.length - renderedQItems.length);

  const qListEl = document.getElementById('queuePacketsList');
  const nextQueueHtml = renderedQItems.map(q => {
    const fromDisp = shortSeat(q.fromId || q.from);
    const toDisp = shortSeat(q.toId || q.to);
    const isNodeInvolved = isInvolvedItem(q);
    const borderStyle = isNodeInvolved
      ? `border: 1px solid ${escapeHtml(q.color)}; border-left: 4px solid ${escapeHtml(q.color)}; background: rgba(0, 240, 255, 0.08);`
      : `border-left: 3px solid ${escapeHtml(q.color)};`;
    const cleanSlice = String(q.slice || '').replace(/^slice:/, '');
    const envKey = q.id || `${fromDisp}-${toDisp}-${cleanSlice}`;
    const rawRelated = cleanSlice ? (ganttBySlice.get(cleanSlice) || []) : [];
    const hasHistory = rawRelated.length > 1;
    const isExpanded = hasHistory && expandedQueueEnvelopes.has(envKey);
    const related = isExpanded
      ? rawRelated
          .slice()
          .sort((a, b) => (Date.parse(b.endAt || b.claimedAt || b.createdAt || 0) || 0) - (Date.parse(a.endAt || a.claimedAt || a.createdAt || 0) || 0))
          .slice(0, 8)
      : rawRelated;
    const tsStr = formatEnvelopeClock(q.ts);
    const historyHtml = isExpanded ? `
      <div class="env-history-timeline">
        ${related.map(ev => {
          const evColor = ev.state === 'in-progress' ? '#00ff9d' : ev.state === 'canceled' ? '#fda4af' : ev.state === 'blocked' ? '#fb923c' : '#7dd3fc';
          const evTs = formatEnvelopeClock(ev.endAt || ev.claimedAt || ev.createdAt);
          const evAge = ageLabel(ev.endAt || ev.claimedAt || ev.createdAt);
          const evIdShort = String(ev.id || '').slice(-8);
          return `
            <div class="env-history-row">
              <div class="env-history-row-head">
                <span style="color:#e2e8f0; font-weight:700;">${escapeHtml(shortSeat(ev.from))} ▶ ${escapeHtml(shortSeat(ev.to))}</span>
                <span style="display:flex; align-items:center; gap:5px;">
                  <span style="color:${evColor}; font-weight:700;">${escapeHtml(ev.state)}</span>
                  ${evTs ? `<span style="color:#94a3b8;">${escapeHtml(evTs)}${evAge ? ` · ${escapeHtml(evAge)}` : ''}</span>` : ''}
                  ${ev.id ? `<button type="button" class="env-copy-btn" title="rig queue show ${escapeHtml(ev.id)} --full" data-cmd="rig queue show ${escapeHtml(ev.id)} --full" onclick="event.stopPropagation(); copyCmd(this.dataset.cmd)">${CMD_COPY_LABEL_HTML}</button>` : ''}
                </span>
              </div>
              <div style="font-size:11px; color:#cbd5e1; line-height:1.35;">${escapeHtml(ev.summary || td('xray.emptySummary', { id: evIdShort || '—' })).slice(0, 220)}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';
    return `
      <div class="insp-stat" style="padding:8px 10px; ${borderStyle} cursor:pointer;" ${hasHistory ? `data-envelope="${escapeHtml(envKey)}" onclick="toggleQueueEnvelope(this.dataset.envelope)"` : `data-cmd="rig queue show ${escapeHtml(q.id)} --full" onclick="copyCmd(this.dataset.cmd)"`}>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; font-family:var(--font-mono); font-size:11px; font-weight:700; flex-wrap:wrap;">
          <span style="color:var(--cyan);">📨 ${escapeHtml(String(q.id || '').slice(0, 23))}</span>
          <span style="display:flex; align-items:center; gap:5px;">
            <span style="color:${escapeHtml(q.color)};">${escapeHtml(q.state)}</span>
            ${tsStr ? `<span style="color:#94a3b8; font-weight:500;">${escapeHtml(tsStr)}</span>` : ''}
            ${hasHistory ? `<span class="env-history-toggle ${isExpanded ? 'open' : ''}">📜 ${td('xray.eventsCount', { n: rawRelated.length })} ${isExpanded ? '▴' : '▾'}</span>` : ''}
            ${q.id ? `<button type="button" class="env-copy-btn" style="border-color:rgba(56,189,248,0.45); color:#7dd3fc;" title="${escapeHtml(td('ctx.openTip'))}" data-qitem="${escapeHtml(q.id)}" onclick="event.stopPropagation(); openQueueItemContext(this.dataset.qitem)">${escapeHtml(td('ctx.openBtn'))}</button>` : ''}
            <button type="button" class="env-copy-btn" title="rig queue show ${escapeHtml(q.id)} --full" data-cmd="rig queue show ${escapeHtml(q.id)} --full" onclick="event.stopPropagation(); copyCmd(this.dataset.cmd)">${CMD_COPY_LABEL_HTML}</button>
          </span>
        </div>
        <div style="font-family:var(--font-mono); font-size:11px; color:#e2e8f0; margin: 3px 0;">
          ${escapeHtml(fromDisp)} ──▶ ${escapeHtml(toDisp)} <span style="color:#94a3b8;">(${escapeHtml(q.slice)})</span>
        </div>
        ${renderContextBadgesHtml(ctx, q)}
        <div style="font-size:12px; color:#cbd5e1; line-height:1.38;">${escapeHtml(q.summary || td('xray.emptySummary', { id: String(q.id || '').slice(-8) }))}</div>
        ${historyHtml}
      </div>
    `;
  }).join('') + (hiddenQCount > 0
    ? `<button type="button" class="action-pill" style="width:100%; justify-content:center; margin-top:4px;" onclick="window.__showAllQueuePackets = true; renderInspectorAndScorecards(false);">${deckLang === 'en' ? `Show all ${sortedQItems.length} queue items (+${hiddenQCount})` : `Показать все ${sortedQItems.length} задач (+${hiddenQCount})`}</button>`
    : (showAllQ && sortedQItems.length > QUEUE_PACKETS_LIMIT
      ? `<button type="button" class="action-pill" style="width:100%; justify-content:center; margin-top:4px;" onclick="window.__showAllQueuePackets = false; renderInspectorAndScorecards(false);">${deckLang === 'en' ? `Collapse to top ${QUEUE_PACKETS_LIMIT}` : `Свернуть до ${QUEUE_PACKETS_LIMIT}`}</button>`
      : ''));
  if (qListEl && qListEl.__lastHtml !== nextQueueHtml) {
    qListEl.innerHTML = nextQueueHtml;
    qListEl.__lastHtml = nextQueueHtml;
  }

  const coders = agents.filter(a => a.reworkHistory && (currentRigFilter === 'all' || a.id.endsWith('@' + currentRigFilter)));
  const scoreEl = document.getElementById('coderScorecards');
  const nextScoreHtml = coders.map(c => {
    const isCurrent = c.id === selectedAgentId;
    const dots = c.reworkHistory.map(r =>
      `<span class="round-dot round-${Math.min(4, r)}" title="${deckLang === 'en' ? `Accepted on QA round ${r}` : `Принят с ${r}-го круга QA`}">${r} ${td('insp.roundsUnit')}</span>`
    ).join('');

    return `
      <div class="insp-stat" style="padding:8px 10px; cursor:pointer; ${isCurrent ? 'border-color:var(--cyan); background:rgba(0,240,255,0.09);' : ''}" data-seat="${escapeHtml(c.id)}" onclick="selectAgent(this.dataset.seat)">
        <div style="display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:12.5px; font-weight:700;">
          <span>${escapeHtml(c.icon)} ${escapeHtml(getNodeDisplayTitle(c))} (${escapeHtml(c.model)})</span>
          <span style="color:${c.reworkAvg > 2.0 ? '#fcd34d' : '#6ee7b7'}">🪃 Avg: ${c.reworkAvg} ${td('insp.roundsUnit')}</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:5px;">
          <span style="font-family:var(--font-mono); font-size:11px; color:#cbd5e1;">${td('insp.firstPass')} ${c.firstPassPct} • ${td('insp.calls')} ${c.callsIn + c.callsOut}</span>
          <div class="rework-history-dots">${dots}</div>
        </div>
      </div>
    `;
  }).join('');
  if (scoreEl && scoreEl.__lastHtml !== nextScoreHtml) {
    scoreEl.innerHTML = nextScoreHtml;
    scoreEl.__lastHtml = nextScoreHtml;
  }
}

export function renderContextBadgesHtml(ctx, meta) {
  const { escapeHtml } = ctx;
  if (!meta || typeof meta !== 'object') return '';
  const chips = [];
  if (meta.blockedOn || meta.blockedOnQitemId) {
    const blkId = meta.blockedOnQitemId || '';
    const blkText = String(meta.blockedOn || blkId).slice(0, 44);
    if (blkId) {
      chips.push(`<button type="button" class="ctx-chip is-blocker is-clickable" title="${escapeHtml(meta.blockedOn || blkId)}" data-qitem="${escapeHtml(blkId)}" onclick="event.stopPropagation(); openQueueItemContext(this.dataset.qitem)">🧱 ${escapeHtml(blkText)}</button>`);
    } else {
      chips.push(`<span class="ctx-chip is-blocker" title="${escapeHtml(meta.blockedOn)}">🧱 ${escapeHtml(blkText)}</span>`);
    }
  }
  if (meta.bodyContextRef) {
    chips.push(`<span class="ctx-chip is-pack" title="body-context:${escapeHtml(meta.bodyContextRef)}">📦 ${escapeHtml(meta.bodyContextRef)}</span>`);
  }
  if (meta.gate) {
    chips.push(`<span class="ctx-chip is-gate" title="gate:${escapeHtml(meta.gate)}">🛡️ gate:${escapeHtml(meta.gate)}</span>`);
  }
  if (meta.mission) {
    chips.push(`<span class="ctx-chip" title="mission:${escapeHtml(meta.mission)}">🎯 ${escapeHtml(meta.mission)}</span>`);
  }
  if (meta.project) {
    chips.push(`<span class="ctx-chip" title="project:${escapeHtml(meta.project)}">🏛️ ${escapeHtml(meta.project)}</span>`);
  }
  if (meta.parent) {
    chips.push(`<button type="button" class="ctx-chip is-clickable" title="parent:${escapeHtml(meta.parent)}" data-qitem="${escapeHtml(meta.parent)}" onclick="event.stopPropagation(); openQueueItemContext(this.dataset.qitem)">🔗 parent:${escapeHtml(String(meta.parent).slice(-8))}</button>`);
  }
  for (const [field, arrow] of [['handedOffFrom', '↖'], ['handedOffTo', '↘']]) {
    const ref = String(meta[field] ?? '').trim();
    if (!ref) continue;
    const escapedRef = escapeHtml(ref);
    const title = `${field}: ${escapedRef}`;
    if (/^qitem-/i.test(ref)) {
      chips.push(`<button type="button" class="ctx-chip is-clickable" title="${title}" data-qitem="${escapedRef}" onclick="event.stopPropagation(); openQueueItemContext(this.dataset.qitem)">${arrow} ${escapeHtml(ref.slice(-8))}</button>`);
    } else if (ref.includes('@')) {
      const label = ctx.shortSeat(ref.split('@')[0]) || ref;
      chips.push(`<button type="button" class="ctx-chip is-clickable" title="${title}" data-seat="${escapedRef}" onclick="event.stopPropagation(); selectAgent(this.dataset.seat)">${arrow} ${escapeHtml(label)}</button>`);
    } else {
      const chars = Array.from(ref);
      const label = chars.length > 24 ? chars.slice(0, 23).join('') + '…' : ref;
      chips.push(`<span class="ctx-chip" title="${title}">${arrow} ${escapeHtml(label)}</span>`);
    }
  }
  if (meta.evidenceRef) {
    chips.push(`<span class="ctx-chip is-artifact" title="${escapeHtml(meta.evidenceRef)}">📎 ${escapeHtml(meta.evidenceRef.split('/').pop())}</span>`);
  }
  if (meta.targetRepo) {
    chips.push(`<span class="ctx-chip" title="repo: ${escapeHtml(meta.targetRepo)}">📁 ${escapeHtml(meta.targetRepo)}</span>`);
  }
  return chips.length ? `<div class="ctx-chip-row">${chips.join('')}</div>` : '';
}

export function renderSeatGitWorktreeHtml(ctx, agent) {
  const { td, escapeHtml, shortSeat } = ctx;
  const g = agent && agent.git;
  if (!g) return '';
  const hasDanger = g.unmergedCount > 0 || g.conflictFilesCount > 0;
  const hasWarn = Boolean(g.isSharedWriteHazard) || (g.behind || 0) >= 15;
  const cardClass = hasDanger ? 'git-worktree-card has-conflict' : (hasWarn ? 'git-worktree-card has-warn' : 'git-worktree-card');

  const branchLabel = g.detached
    ? `${td('git.detached')} @${String(g.oid || '').slice(0, 7)}`
    : (g.branch || td('git.detached'));
  const sharedSeats = Array.isArray(g.sharedWithSeats) ? g.sharedWithSeats : [];
  const sharedTotal = sharedSeats.length + 1;
  const typeBadge = g.isSharedCheckout
    ? `<span class="git-badge is-shared" title="${escapeHtml(sharedSeats.map(shortSeat).join(', '))}">👥 ${escapeHtml(td('git.sharedBadge', { n: sharedTotal }))}</span>`
    : g.isWorktree
      ? `<span class="git-badge is-worktree">🌿 ${escapeHtml(td('git.worktreeBadge'))}</span>`
      : `<span class="git-badge">${escapeHtml(td('git.cloneBadge'))}</span>`;

  const driftBits = [];
  if (g.ahead > 0) driftBits.push(`↑${g.ahead}`);
  if (g.behind > 0) driftBits.push(`↓${g.behind}`);
  const driftBadge = driftBits.length > 0
    ? `<span class="git-badge ${g.behind >= 15 ? 'is-behind' : ''}" title="${g.behind >= 15 ? escapeHtml(td('git.behindWarn', { n: g.behind })) : ''}">${driftBits.join(' ')}</span>`
    : '';

  const diffStatBadge = g.dirtyCount === 0
    ? `<span class="git-badge is-clean">✓ ${escapeHtml(td('git.clean'))}</span>`
    : `<span class="git-badge">✎ ${escapeHtml(td('git.dirtyFiles', { n: g.dirtyCount }))}${g.insertions || g.deletions ? ` <span style="color:#86efac;">+${g.insertions}</span>/<span style="color:#fda4af;">-${g.deletions}</span>` : ''}</span>`;

  const banners = [];
  if (g.unmergedCount > 0) {
    banners.push(`<div class="git-conflict-banner">${escapeHtml(td('git.unmergedBanner', { n: g.unmergedCount }))}</div>`);
  }
  if (g.conflictFilesCount > 0) {
    const peerStr = (g.conflictPeers || []).slice(0, 3).map(shortSeat).join(', ');
    banners.push(`<div class="git-conflict-banner">${escapeHtml(td('git.conflictBanner', { n: g.conflictFilesCount, peers: peerStr || 'worktree' }))}</div>`);
  }
  if (g.isSharedWriteHazard) {
    banners.push(`<div class="git-conflict-banner is-warn">${escapeHtml(td('git.sharedHazard'))}</div>`);
  }

  const conflictSet = new Set(g.conflictFiles || []);
  const allFilePaths = Array.isArray(g.files)
    ? g.files.map(f => (typeof f === 'string' ? f : f && f.path)).filter(Boolean)
    : [];
  const sortedDirty = [...allFilePaths].sort((a, b) => Number(conflictSet.has(b)) - Number(conflictSet.has(a)));
  const shownFiles = sortedDirty.slice(0, 6);
  const hiddenCount = Math.max(0, (g.dirtyCount || sortedDirty.length) - shownFiles.length);
  const filePillsHtml = shownFiles.length > 0
    ? `<div class="git-file-pills">
        ${shownFiles.map(fp => {
          const isConf = conflictSet.has(fp);
          const shortFp = fp.length > 34 ? '…/' + fp.split('/').slice(-2).join('/') : fp;
          return `<button type="button" class="git-file-pill ${isConf ? 'is-conflict' : ''}" title="${escapeHtml(fp)}" data-seat="${escapeHtml(agent.id)}" data-file="${escapeHtml(fp)}" onclick="openGitDiffModal(this.getAttribute('data-seat'), this.getAttribute('data-file'))">${isConf ? '⚔️ ' : ''}${escapeHtml(shortFp)}</button>`;
        }).join('')}
        ${hiddenCount > 0 ? `<button type="button" class="git-file-pill" data-seat="${escapeHtml(agent.id)}" onclick="openGitDiffModal(this.getAttribute('data-seat'), '')">+${hiddenCount}</button>` : ''}
      </div>`
    : '';

  return `
    <div class="${cardClass}">
      <div class="git-worktree-head">
        <span style="font-size:10px; font-weight:800; color:#7dd3fc; letter-spacing:0.4px;">${escapeHtml(td('git.sectionTitle'))}</span>
        <button type="button" class="action-pill" style="padding:1px 7px; font-size:9.5px;" title="${escapeHtml(td('git.diffTip'))}" data-seat="${escapeHtml(agent.id)}" onclick="openGitDiffModal(this.getAttribute('data-seat'), '')">${escapeHtml(td('git.diffBtn'))}</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
        <span class="git-badge is-branch" title="${escapeHtml(g.dirName || '')}">⎇ ${escapeHtml(branchLabel)}</span>
        ${typeBadge}
        ${driftBadge}
        ${diffStatBadge}
      </div>
      ${banners.join('')}
      ${filePillsHtml}
    </div>
  `;
}

export function renderContextLineageHtml(ctx, data) {
  const { td, escapeHtml, shortSeat, CMD_COPY_LABEL_HTML } = ctx;
  if (!data || !data.item) return '';
  const it = data.item;
  const lin = data.lineage || { ancestors: [], descendants: [], blocker: null, dependents: [], parentRef: null, siblings: [], driftSignals: [] };
  const art = data.artifacts || { docs: [], adrs: [], commits: [], linkedQitems: [], mentionedSeats: [] };
  const decs = Array.isArray(data.relatedDecisions) ? data.relatedDecisions : [];

  const renderNodeCard = (ref, isCurrent = false) => {
    if (!ref) return '';
    const route = ref.from || ref.to ? `${shortSeat(ref.from || '?')} ▶ ${shortSeat(ref.to || '?')}` : ref.id.slice(-10);
    const clickAttr = !isCurrent && ref.id ? `data-qitem="${escapeHtml(ref.id)}" onclick="openQueueItemContext(this.dataset.qitem)"` : '';
    return `
      <button type="button" class="ctx-lineage-node ${isCurrent ? 'is-current' : ''}" ${clickAttr} title="${escapeHtml(ref.summary || ref.id)}">
        <span style="font-weight:800; color:${isCurrent ? '#00f0ff' : '#e2e8f0'};">${escapeHtml(route)}</span>
        <span style="font-size:9.5px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(ref.state || '')}${ref.id ? ` · #${escapeHtml(ref.id.slice(-8))}` : ''}</span>
      </button>
    `;
  };

  const chainCards = [
    ...(lin.ancestors || []).map(a => renderNodeCard(a, false)),
    renderNodeCard({ id: it.id, from: it.from, to: it.to, state: it.state, summary: it.summary }, true),
    ...(lin.descendants || []).map(d => renderNodeCard(d, false))
  ].join('<span style="color:#64748b; font-weight:800;">→</span>');

  const driftHtml = (lin.driftSignals || []).map(s => {
    if (s.kind === 'context_pack_drift') {
      return `<div style="font-family:var(--font-mono); font-size:11px; color:#fde68a; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.4); border-radius:6px; padding:6px 9px;">${escapeHtml(td('ctx.driftPack', { vals: (s.values || []).join(' ≠ ') }))}</div>`;
    }
    if (s.kind === 'active_blocker_chain') {
      return `<div style="font-family:var(--font-mono); font-size:11px; color:#fed7aa; background:rgba(251,146,60,0.12); border:1px solid rgba(251,146,60,0.42); border-radius:6px; padding:6px 9px;">${escapeHtml(td('ctx.driftBlockers', { n: s.count || 1 }))}</div>`;
    }
    return '';
  }).filter(Boolean).join('');

  const artifactChips = [
    ...art.docs.map(d => `<span class="ctx-chip is-artifact" title="${escapeHtml(d)}">📄 ${escapeHtml(d)}</span>`),
    ...art.adrs.map(a => `<span class="ctx-chip is-pack">📐 ${escapeHtml(a)}</span>`),
    ...art.commits.map(c => `<span class="ctx-chip">🔖 ${escapeHtml(c)}</span>`),
    ...art.linkedQitems.map(q => `<button type="button" class="ctx-chip is-clickable" data-qitem="${escapeHtml(q)}" onclick="openQueueItemContext(this.dataset.qitem)">🔗 #${escapeHtml(q.slice(-8))}</button>`)
  ];

  const fullCmd = `rig queue show ${it.id} --full`;

  return `
    <div style="display:flex; flex-direction:column; gap:10px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; background:rgba(15,23,42,0.72); border:1px solid rgba(56,189,248,0.22); border-radius:8px; padding:10px 12px;">
        <div style="min-width:0; flex:1;">
          <div style="font-family:var(--font-mono); font-size:11.5px; font-weight:800; color:#7dd3fc;">
            ${escapeHtml(shortSeat(it.from || '?'))} ▶ ${escapeHtml(shortSeat(it.to || '?'))}
            <span style="color:#6ee7b7; margin-left:6px;">[${escapeHtml(it.state)}]</span>
            ${it.slice ? `<span style="color:#fcd34d; margin-left:6px;">🏷️ ${escapeHtml(it.slice)}</span>` : ''}
          </div>
          <div style="font-size:12.5px; color:#f8fafc; margin-top:4px; line-height:1.4;">${escapeHtml(it.summary || it.id)}</div>
          ${renderContextBadgesHtml(ctx, it)}
        </div>
        <button type="button" class="action-pill" title="${escapeHtml(fullCmd)}" data-cmd="${escapeHtml(fullCmd)}" onclick="copyCmd(this.dataset.cmd)">${CMD_COPY_LABEL_HTML}</button>
      </div>

      ${driftHtml}

      <div>
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#94a3b8; margin-bottom:5px; letter-spacing:0.5px;">${escapeHtml(td('ctx.lineageTitle'))}</div>
        <div class="ctx-lineage-rail">${chainCards}</div>
        ${lin.blocker ? `
          <div class="ctx-chip-row" style="margin-top:6px;">
            <span style="font-family:var(--font-mono); font-size:10.5px; color:#fed7aa; font-weight:700;">${escapeHtml(td('ctx.blockedBy'))}</span>
            ${lin.blocker.id
              ? `<button type="button" class="ctx-chip is-blocker is-clickable" data-qitem="${escapeHtml(lin.blocker.id)}" onclick="openQueueItemContext(this.dataset.qitem)">🧱 #${escapeHtml(lin.blocker.id.slice(-8))} ${escapeHtml(lin.blocker.summary || lin.blocker.to || '')}</button>`
              : `<span class="ctx-chip is-blocker">🧱 ${escapeHtml(lin.blocker.summary)}</span>`}
          </div>
        ` : ''}
        ${lin.dependents && lin.dependents.length ? `
          <div class="ctx-chip-row" style="margin-top:6px;">
            <span style="font-family:var(--font-mono); font-size:10.5px; color:#7dd3fc; font-weight:700;">${escapeHtml(td('ctx.waitingOnThis'))}</span>
            ${lin.dependents.map(dep => `<button type="button" class="ctx-chip is-clickable" data-qitem="${escapeHtml(dep.id)}" onclick="openQueueItemContext(this.dataset.qitem)">⏳ ${escapeHtml(shortSeat(dep.to || ''))} · #${escapeHtml(dep.id.slice(-8))}</button>`).join('')}
          </div>
        ` : ''}
        ${lin.parentRef ? `
          <div class="ctx-chip-row" style="margin-top:6px;">
            <span style="font-family:var(--font-mono); font-size:10.5px; color:#cbd5e1; font-weight:700;">${escapeHtml(td('ctx.parentTask'))}</span>
            <button type="button" class="ctx-chip is-clickable" data-qitem="${escapeHtml(lin.parentRef.id)}" onclick="openQueueItemContext(this.dataset.qitem)">🔗 #${escapeHtml(lin.parentRef.id.slice(-8))} ${escapeHtml(lin.parentRef.summary || '')}</button>
          </div>
        ` : ''}
      </div>

      ${artifactChips.length ? `
        <div>
          <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#94a3b8; margin-bottom:5px; letter-spacing:0.5px;">${escapeHtml(td('ctx.artifactsTitle'))}</div>
          <div class="ctx-chip-row">${artifactChips.join('')}</div>
        </div>
      ` : ''}

      ${decs.length ? `
        <div>
          <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#94a3b8; margin-bottom:5px; letter-spacing:0.5px;">${escapeHtml(td('ctx.decisionsTitle'))}</div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            ${decs.map(d => `<div style="font-size:11px; color:#cbd5e1; background:rgba(15,23,42,0.55); border-left:2px solid #a855f7; padding:5px 8px; border-radius:4px;"><b style="color:#e9d5ff;">${escapeHtml(d.time || '')}</b> ${escapeHtml(d.decision || '')}${d.reason ? ` — <span style="color:#94a3b8;">${escapeHtml(d.reason)}</span>` : ''}</div>`).join('')}
          </div>
        </div>
      ` : ''}

      <div>
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#94a3b8; margin-bottom:5px; letter-spacing:0.5px;">${escapeHtml(td('ctx.bodyTitle'))}</div>
        <pre class="ctx-body-pre">${escapeHtml(it.body || td('ctx.emptyBody'))}</pre>
      </div>

      ${it.resolution ? `
        <div>
          <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#6ee7b7; margin-bottom:5px; letter-spacing:0.5px;">${escapeHtml(td('ctx.resolutionTitle'))}</div>
          <pre class="ctx-body-pre" style="max-height:130px; border-color:rgba(16,185,129,0.35);">${escapeHtml(it.resolution)}</pre>
        </div>
      ` : ''}

      ${lin.siblings && lin.siblings.length ? `
        <div>
          <div style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:#94a3b8; margin-bottom:5px; letter-spacing:0.5px;">${escapeHtml(td('ctx.siblingsTitle'))}</div>
          <div class="ctx-chip-row">
            ${lin.siblings.map(s => `<button type="button" class="ctx-chip is-clickable" data-qitem="${escapeHtml(s.id)}" onclick="openQueueItemContext(this.dataset.qitem)">${escapeHtml(shortSeat(s.from || '?'))}▶${escapeHtml(shortSeat(s.to || '?'))} (${escapeHtml(s.state)})</button>`).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}
