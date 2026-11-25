/** Task Gantt/Sequence views. State and browser surfaces are supplied by the caller. */
import { buildGanttLanes, buildHandoffSequenceModel, formatGanttDuration } from '../domain/gantt-model.js';

export function syncGanttControlsUi(doc, {
  ganttWindowH, ganttMode, ganttGroupBy, ganttHideNoise,
  ganttOnlyBottlenecks, ganttZoom, ganttFocusChain, td
}, hiddenNoiseCount = 0) {
  doc.querySelectorAll('[data-gantt-window]').forEach(b => {
    b.classList.toggle('active', Number(b.getAttribute('data-gantt-window')) === ganttWindowH);
  });
  const bTm = doc.getElementById('btnGanttModeTimeline');
  const bSq = doc.getElementById('btnGanttModeSequence');
  if (bTm) bTm.classList.toggle('active', ganttMode === 'timeline');
  if (bSq) bSq.classList.toggle('active', ganttMode === 'sequence');

  const grpSw = doc.getElementById('ganttGroupSwitch');
  const zoomGrp = doc.getElementById('ganttZoomGroup');
  if (grpSw) grpSw.style.display = ganttMode === 'timeline' ? '' : 'none';
  if (zoomGrp) zoomGrp.style.display = ganttMode === 'timeline' ? '' : 'none';
  const bAg = doc.getElementById('btnGanttGroupAgent');
  const bCh = doc.getElementById('btnGanttGroupChain');
  if (bAg) bAg.classList.toggle('active', ganttGroupBy === 'agent');
  if (bCh) bCh.classList.toggle('active', ganttGroupBy === 'chain');

  const bNoise = doc.getElementById('btnGanttHideNoise');
  if (bNoise) {
    bNoise.classList.toggle('active', ganttHideNoise);
    const baseLbl = ganttHideNoise ? td('gantt.noiseHidden') : td('gantt.noiseShown');
    bNoise.textContent = ganttHideNoise && hiddenNoiseCount > 0 ? `${baseLbl} (${hiddenNoiseCount})` : baseLbl;
  }
  const bBot = doc.getElementById('btnGanttBottlenecks');
  if (bBot) {
    bBot.classList.toggle('active', ganttOnlyBottlenecks);
    bBot.style.display = ganttMode === 'timeline' ? '' : 'none';
  }
  const zLbl = doc.getElementById('ganttZoomLabel');
  if (zLbl) zLbl.textContent = `${ganttZoom}×`;
  const btnClr = doc.getElementById('btnGanttClearFocus');
  if (btnClr) btnClr.style.display = ganttFocusChain ? '' : 'none';
}

export function applyGanttFocus(doc, { ganttHoverChain, ganttFocusChain }) {
  const body = doc.getElementById('ganttBody');
  if (!body) return;
  const active = ganttHoverChain || ganttFocusChain;
  const dimOpacity = ganttHoverChain ? '0.52' : '0.32';
  body.querySelectorAll('.g-chain').forEach(g => {
    const isMatch = !active || g.getAttribute('data-chain') === active;
    g.style.opacity = isMatch ? '1' : dimOpacity;
    g.style.filter = active && isMatch ? 'drop-shadow(0 0 4px rgba(255,255,255,0.32))' : 'none';
  });
  body.querySelectorAll('.g-handoff-link').forEach(p => {
    const isMatch = active && p.getAttribute('data-chain') === active;
    p.style.opacity = active ? (isMatch ? '0.92' : '0.06') : '0.24';
  });
}

export function renderGanttTooltipHtml(sp, { deckLang, td, escapeHtml, shortSeat }) {
  if (!sp) return '';
  const dur = (ms) => formatGanttDuration(ms, deckLang);
  const fromStr = shortSeat(sp.from || '?');
  const toStr = shortSeat(sp.to || '?');
  const flags = [];
  if (sp.isLongWait) flags.push(`<span style="color:#fbbf24;">⚠️ ${escapeHtml(td('gantt.legLong'))}</span>`);
  if (sp.isBounceBack) flags.push(`<span style="color:#fb923c;">${escapeHtml(td('gantt.seqBounceBadge'))}</span>`);
  if (sp.isOpen) flags.push(`<span style="color:#00ff9d;">● LIVE</span>`);
  return `
    <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:3px;">
      <strong style="color:${sp.color};">${escapeHtml(sp.slice || sp.label)}</strong>
      <span style="color:#94a3b8; font-size:9.5px;">${escapeHtml(sp.state || '')}</span>
    </div>
    <div style="color:#cbd5e1; margin-bottom:4px;">${escapeHtml(fromStr)} → <b>${escapeHtml(toStr)}</b></div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:${sp.summary ? '4px' : '0'};">
      <span style="color:${sp.isLongWait ? '#fbbf24' : '#94a3b8'};">⏳ ${escapeHtml(td('gantt.kpiWait'))}: <b>${dur(sp.waitMs)}</b></span>
      <span style="color:#6ee7b7;">⚡ ${escapeHtml(td('gantt.kpiWork'))}: <b>${dur(sp.workMs)}</b></span>
      ${flags.join(' ')}
    </div>
    ${sp.summary ? `<div style="font-family:var(--font-sans); font-size:11px; color:#94a3b8; border-top:1px dashed rgba(148,163,184,0.18); padding-top:4px;">${escapeHtml(String(sp.summary).slice(0, 160))}</div>` : ''}
  `;
}

export function renderGanttSpanDetail(sp, {
  deckLang, td, escapeHtml, shortSeat, agents: AGENTS = [], ganttFocusChain, ganttMode,
  CMD_COPY_LABEL_HTML, renderContextBadgesHtml, renderEvaluatorVerdictCardHtml
}) {
  if (!sp) return '';
  const dur = (ms) => formatGanttDuration(ms, deckLang);
  const tFmt = (ms) => Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString(deckLang === 'en' ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '—';
  const hasSeat = AGENTS.some(a => a.id === sp.to);
  const isFocused = ganttFocusChain === sp.chain;
  const showCmd = sp.id && !String(sp.id).startsWith('demo-') ? `rig queue show ${sp.id}` : '';
  return `
    <div class="gantt-span-detail-top">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="color:${sp.color}; font-weight:800;">🏷️ ${escapeHtml(sp.slice || sp.label)}</span>
        <span style="color:#94a3b8;">${escapeHtml(shortSeat(sp.from || '?'))} → <b style="color:#f8fafc;">${escapeHtml(shortSeat(sp.to))}</b></span>
        <span style="color:${sp.isLongWait ? '#fbbf24' : '#94a3b8'};">⏳ ${dur(sp.waitMs)}</span>
        <span style="color:#6ee7b7;">⚡ ${dur(sp.workMs)}</span>
        <span style="color:#64748b; font-size:9.5px;">${tFmt(sp.created)} → ${sp.isOpen ? 'LIVE' : tFmt(sp.endT)}</span>
        ${sp.isBounceBack ? `<span style="color:#fb923c; font-weight:800;">${escapeHtml(td('gantt.seqBounceBadge'))}</span>` : ''}
      </div>
      <div class="gantt-span-detail-actions">
        ${ganttMode !== 'sequence' ? `<button type="button" class="action-pill" style="padding:2px 7px; font-size:10px;" data-chain="${escapeHtml(sp.chain)}" onclick="openChainInSequence(this.getAttribute('data-chain'))">${escapeHtml(td('gantt.spanOpenFlow'))}</button>` : ''}
        <button type="button" class="action-pill" style="padding:2px 7px; font-size:10px;" data-chain="${escapeHtml(sp.chain)}" onclick="setGanttFocus(ganttFocusChain === this.getAttribute('data-chain') ? null : this.getAttribute('data-chain'))">${escapeHtml(isFocused ? td('gantt.spanClearChain') : td('gantt.spanFocusChain'))}</button>
        ${hasSeat ? `<button type="button" class="action-pill" style="padding:2px 7px; font-size:10px;" data-seat="${escapeHtml(sp.to)}" onclick="focusSeatDiagnosis(this.getAttribute('data-seat'))">${escapeHtml(td('gantt.spanFocusSeat'))}</button>` : ''}
        ${hasSeat ? `<button type="button" class="action-pill" style="padding:2px 7px; font-size:10px;" data-seat="${escapeHtml(sp.to)}" onclick="openTerminalModal(this.getAttribute('data-seat'))">${escapeHtml(td('gantt.spanScreen'))}</button>` : ''}
        <button type="button" class="action-pill" style="padding:2px 7px; font-size:10px; border-color:rgba(168,85,247,0.48); color:#e9d5ff;" data-slice="${escapeHtml(sp.slice || sp.chain)}" onclick="runAiEvaluation('slice', this.getAttribute('data-slice'), 'system2')">${escapeHtml(td('eval.ganttAnalyzeS2'))}</button>
        ${sp.id ? `<button type="button" class="action-pill" style="padding:2px 7px; font-size:10px; border-color:rgba(56,189,248,0.48); color:#7dd3fc;" data-qid="${escapeHtml(sp.id)}" title="${escapeHtml(td('ctx.openTip'))}" onclick="openQueueItemContext(this.getAttribute('data-qid'))">${escapeHtml(td('ctx.openBtn'))}</button>` : ''}
        ${showCmd ? `<button type="button" class="env-copy-btn" data-cmd="${escapeHtml(showCmd)}" title="${escapeHtml(showCmd)}" onclick="copyCmd(this.getAttribute('data-cmd'))">${CMD_COPY_LABEL_HTML}</button>` : ''}
        <button type="button" class="action-pill" style="padding:2px 6px; font-size:10px; border-color:rgba(148,163,184,0.3); color:#94a3b8;" onclick="selectGanttSpan(null)">✕</button>
      </div>
    </div>
    ${renderContextBadgesHtml(sp)}
    ${sp.summary ? `<div class="gantt-span-detail-summary">${escapeHtml(sp.summary)}</div>` : ''}
    ${renderEvaluatorVerdictCardHtml('slice', sp.slice || sp.chain)}
  `;
}

export function renderGanttKpiStrip(kpis, { deckLang, td, escapeHtml, shortSeat }) {
  const dur = (ms) => formatGanttDuration(ms, deckLang);

  const topBtn = kpis.topBottleneck
    ? `<button type="button" class="gantt-bottleneck-btn" onclick="jumpToGanttBottleneck()" title="${escapeHtml(`${shortSeat(kpis.topBottleneck.to)} • ${kpis.topBottleneck.slice}`)}">🔥 ${escapeHtml(td('gantt.kpiTopDelay'))} ${escapeHtml(shortSeat(kpis.topBottleneck.to))} (${dur(kpis.topBottleneck.waitMs)} · ${escapeHtml(kpis.topBottleneck.slice)})</button>`
    : '';

  const bounceBadge = kpis.qaBounceCount > 0
    ? `<span style="color:#fb923c; font-weight:700;">🪃 ${escapeHtml(td('gantt.kpiBounces'))} <b>${kpis.qaBounceCount}</b></span>`
    : '';

  return `
    <div class="gantt-kpi-left">
      <span>${escapeHtml(td('gantt.kpiTasks'))} <b>${kpis.visibleSpans}</b> <span style="color:#64748b;">(${kpis.chainCount})</span></span>
      <span class="gantt-ratio-wrap" title="${escapeHtml(`${td('gantt.kpiWait')} ${dur(kpis.totalWaitMs)} / ${td('gantt.kpiWork')} ${dur(kpis.totalWorkMs)}`)}">
        <span style="color:#fbbf24;">⏳ ${kpis.waitPct}%</span>
        <span class="gantt-ratio-track"><span class="gantt-ratio-wait" style="width:${kpis.waitPct}%"></span><span class="gantt-ratio-work" style="width:${kpis.workPct}%"></span></span>
        <span style="color:#6ee7b7;">⚡ ${kpis.workPct}%</span>
      </span>
      ${topBtn}
      ${bounceBadge}
    </div>
    <span class="gantt-kpi-legend">
      <span><i style="background:repeating-linear-gradient(45deg, rgba(148,163,184,0.55) 0 3px, transparent 3px 6px); border:1px solid rgba(148,163,184,0.6);"></i>${escapeHtml(td('gantt.legWait'))}</span>
      <span><i style="background:#38bdf8;"></i>${escapeHtml(td('gantt.legWork'))}</span>
      <span><i style="background:transparent; border:2px solid #f59e0b;"></i>${escapeHtml(td('gantt.legLong'))}</span>
    </span>
  `;
}

export function renderHandoffSequenceView(allWindowSpans, {
  deckLang, td, escapeHtml, shortSeat, getNodeDisplayTitle,
  agents: AGENTS = [], selectedAgentId, ganttFocusChain, ganttSelectedSpanId,
  ganttWindowH, clientWidth
}) {
  const seq = buildHandoffSequenceModel(allWindowSpans, { focusChain: ganttFocusChain });
  if (!seq.activeChain || seq.steps.length === 0) {
    return `<div class="gantt-empty">${escapeHtml(td('gantt.empty', { h: ganttWindowH }))}</div>`;
  }

  const dur = (ms) => formatGanttDuration(ms, deckLang);
  const tFmt = (ms) => new Date(ms).toLocaleTimeString(deckLang === 'en' ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });

  const chainPillsHtml = seq.chains.map(c => {
    const isAct = c.chain === seq.activeChain;
    return `
      <button type="button" class="gantt-seq-pill ${isAct ? 'active' : ''}" data-chain="${escapeHtml(c.chain)}" onclick="setGanttFocus(this.getAttribute('data-chain'))">
        <span style="width:7px; height:7px; border-radius:50%; background:${c.color}; display:inline-block;"></span>
        <span>${escapeHtml(c.label)}</span>
        <span style="color:#94a3b8; font-weight:600;">(${c.stepCount})</span>
        ${c.bounceCount > 0 ? `<span style="color:#fb923c;">🪃${c.bounceCount}</span>` : ''}
      </button>
    `;
  }).join('');

  const cols = seq.participants;
  const W = Math.max(580, clientWidth - 28);
  const PAD_X = 96;
  const colStep = cols.length > 1 ? (W - PAD_X * 2) / (cols.length - 1) : 0;
  const colX = (i) => cols.length === 1 ? W / 2 : PAD_X + i * colStep;
  const HEAD_H = 44;
  const STEP_H = 54;
  const H = HEAD_H + seq.steps.length * STEP_H + 16;

  let headerSvg = '';
  cols.forEach((seatId, i) => {
    const cx = colX(i);
    const ag = AGENTS.find(a => a.id === seatId);
    const title = ag ? getNodeDisplayTitle(ag) : shortSeat(seatId);
    const label = ((ag && ag.icon) ? `${ag.icon} ` : '') + (title.length > 20 ? title.slice(0, 19) + '…' : title);
    const boxW = Math.min(168, Math.max(96, label.length * 7.2 + 18));
    headerSvg += `
      <line x1="${cx}" y1="${HEAD_H - 6}" x2="${cx}" y2="${H - 8}" stroke="rgba(148,163,184,0.2)" stroke-dasharray="4 4" />
      <rect x="${cx - boxW / 2}" y="6" width="${boxW}" height="28" rx="6" fill="rgba(14,23,42,0.95)" stroke="${seatId === selectedAgentId ? '#00f0ff' : 'rgba(56,189,248,0.38)'}" stroke-width="1.2" />
      <text x="${cx}" y="24" text-anchor="middle" fill="#f8fafc" font-size="10.5" font-weight="700" font-family="var(--font-mono)">${escapeHtml(label)}</text>
    `;
  });

  let stepsSvg = '';
  seq.steps.forEach((st, idx) => {
    const yTop = HEAD_H + idx * STEP_H;
    const yArrow = yTop + 20;
    const x1 = colX(st.fromIdx);
    const x2 = colX(st.toIdx);
    const isSelf = st.fromIdx === st.toIdx;
    const isSel = ganttSelectedSpanId === st.id;
    const strokeCol = st.isBounceBack ? '#fb923c' : (st.isOpen ? '#00ff9d' : seq.activeColor);
    const markerId = st.isBounceBack ? 'seqArrWarn' : (st.isOpen ? 'seqArrLive' : 'seqArrCyan');

    let arrowSvg = '';
    if (isSelf) {
      arrowSvg = `<path d="M ${x1} ${yArrow - 6} C ${x1 + 48} ${yArrow - 6}, ${x1 + 48} ${yArrow + 12}, ${x1 + 4} ${yArrow + 12}" fill="none" stroke="${strokeCol}" stroke-width="2" marker-end="url(#${markerId})" />`;
    } else {
      const dir = x2 > x1 ? 1 : -1;
      arrowSvg = `<line x1="${x1 + dir * 4}" y1="${yArrow}" x2="${x2 - dir * 8}" y2="${yArrow}" stroke="${strokeCol}" stroke-width="${st.isBounceBack ? 2.4 : 2}" ${st.isBounceBack ? 'stroke-dasharray="6 4"' : ''} marker-end="url(#${markerId})" />`;
    }

    const midX = isSelf ? (x1 + 56) : (x1 + x2) / 2;
    const waitTxt = st.waitMs >= 60_000 ? td('gantt.seqWaitBadge', { t: dur(st.waitMs) }) : '';
    const workTxt = st.workMs > 0 ? td('gantt.seqWorkBadge', { t: dur(st.workMs) }) : (st.isOpen ? '● LIVE' : '');
    const metaLine = [
      `#${st.stepNum}`,
      tFmt(st.created),
      waitTxt,
      workTxt,
      st.isBounceBack ? td('gantt.seqBounceBadge') : ''
    ].filter(Boolean).join(' · ');

    const sumClip = String(st.summary || `${shortSeat(st.from || '?')} → ${shortSeat(st.to)}`).slice(0, 74);
    const pillW = Math.min(W - 40, Math.max(150, metaLine.length * 6.4 + 16));
    const pillX = Math.max(12, Math.min(W - pillW - 12, midX - pillW / 2));

    stepsSvg += `
      <g class="gantt-seq-step ${isSel ? 'is-selected' : ''}" data-span-id="${escapeHtml(st.id)}" data-chain="${escapeHtml(st.chain)}" data-seat="${escapeHtml(st.to)}"
         onmouseenter="ganttHover(this.getAttribute('data-chain'), this.getAttribute('data-span-id'), event)"
         onmousemove="ganttMoveTip(event)"
         onmouseleave="ganttHover(null, '')"
         onclick="selectGanttSpan(this.getAttribute('data-span-id')); if (this.getAttribute('data-seat') && AGENTS.some(a => a.id === this.getAttribute('data-seat'))) selectAgent(this.getAttribute('data-seat'));">
        <rect class="seq-step-bg" x="6" y="${yTop + 2}" width="${W - 12}" height="${STEP_H - 4}" rx="6" fill="${idx % 2 === 0 ? 'rgba(15,23,42,0.34)' : 'transparent'}" />
        <circle cx="${x1}" cy="${yArrow}" r="3.5" fill="${strokeCol}" />
        ${arrowSvg}
        <rect x="${pillX}" y="${yTop + 5}" width="${pillW}" height="17" rx="4" fill="rgba(6,12,26,0.95)" stroke="${st.isLongWait || st.isBounceBack ? '#f59e0b' : 'rgba(148,163,184,0.32)'}" stroke-width="1" />
        <text x="${pillX + pillW / 2}" y="${yTop + 16.5}" text-anchor="middle" fill="${st.isBounceBack ? '#fdba74' : (st.isLongWait ? '#fde68a' : '#e2e8f0')}" font-size="9.5" font-weight="700" font-family="var(--font-mono)">${escapeHtml(metaLine)}</text>
        <text x="${Math.max(16, Math.min(W - 16, midX))}" y="${yTop + 39}" text-anchor="middle" fill="#94a3b8" font-size="10.5" font-family="var(--font-sans)">${escapeHtml(sumClip)}${String(st.summary || '').length > 74 ? '…' : ''}</text>
      </g>
    `;
  });

  return `
    <div class="gantt-seq-shell">
      <div class="gantt-seq-chains">${chainPillsHtml}</div>
      <div class="gantt-seq-meta">
        <span><b style="color:${seq.activeColor};">🏷️ ${escapeHtml(seq.activeLabel)}</b> · ${escapeHtml(td('gantt.seqTitle'))}</span>
        <span>
          ${escapeHtml(td('gantt.seqLead'))} <b style="color:#f8fafc;">${dur(seq.stats.totalLeadMs)}</b> ·
          ${escapeHtml(td('gantt.seqHandoffs'))} <b style="color:#7dd3fc;">${seq.stats.handoffCount}</b> ·
          <span style="color:#fbbf24;">⏳ ${seq.stats.waitPct}%</span> / <span style="color:#6ee7b7;">⚡ ${seq.stats.workPct}%</span>
          ${seq.stats.bounceCount > 0 ? ` · <span style="color:#fb923c; font-weight:800;">🪃 ${seq.stats.bounceCount}</span>` : ''}
        </span>
      </div>
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <defs>
          <marker id="seqArrCyan" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
          </marker>
          <marker id="seqArrLive" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#00ff9d" />
          </marker>
          <marker id="seqArrWarn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#fb923c" />
          </marker>
        </defs>
        ${headerSvg}
        ${stepsSvg}
      </svg>
    </div>
  `;
}

export function renderGantt(model, deps) {
  const {
    deckLang, td, escapeHtml, shortSeat, getNodeDisplayTitle, agents: AGENTS = [],
    selectedAgentId, ganttMode, ganttGroupBy, ganttWindowH, ganttZoom,
    ganttFocusChain, ganttSelectedSpanId, clientWidth
  } = deps;
  if (model.allWindowSpans.length === 0) {
    const winTxt = ganttWindowH < 1 ? `${Math.round(ganttWindowH * 60)}м` : `${ganttWindowH}ч`;
    return `<div class="gantt-empty">${escapeHtml(td('gantt.empty', { h: winTxt }))}${model.kpis.hiddenNoiseCount > 0 ? ` (${escapeHtml(td('gantt.noiseHidden'))}: ${model.kpis.hiddenNoiseCount})` : ''}</div>`;
  }
  if (ganttMode === 'sequence') return renderHandoffSequenceView(model.allWindowSpans, deps);
  if (model.spans.length === 0) {
    return `<div class="gantt-empty">🔥 ${deckLang === 'en' ? 'No long waits or QA bounces in this window — fleet flow is smooth!' : 'Долгих ожиданий и возвратов QA в этом окне нет — поток идёт ровно!'}</div>`;
  }
  const { t0, nowMs: now, spanMs, spans } = model;
  const baseW = Math.max(640, clientWidth - 4);
  const LABEL = 186;
  const RIGHT = 16;
  const plotW = Math.max(360, (baseW - LABEL - RIGHT) * ganttZoom);
  const W = LABEL + plotW + RIGHT;
  const minGapMs = Math.max(1000, (6 / Math.max(1, plotW)) * spanMs);
  const minSpanMs = Math.max(1000, (14 / Math.max(1, plotW)) * spanMs);

  const lanes = buildGanttLanes(spans, { groupBy: ganttGroupBy, minGapMs, minSpanMs });
  const TOP = 26;
  const SUB_ROW = 22;
  const LANE_PAD = 8;
  const BAR = 16;

  // Compute exact non-overlapping vertical layout per lane using sub-lane track counts
  const laneLayout = [];
  let curY = TOP;
  for (const lane of lanes) {
    const height = LANE_PAD + lane.trackCount * SUB_ROW;
    laneLayout.push({ lane, y: curY, height });
    curY += height;
  }
  const H = curY + 10;
  const xOf = t => LABEL + Math.min(1, Math.max(0, (t - t0) / spanMs)) * plotW;

  const nowX = xOf(now);
  const stepMin = ganttWindowH <= 0.5 ? 5 : (ganttWindowH <= 1 ? 10 : (ganttWindowH <= 6 ? 60 : 180));
  const stepMs = stepMin * 60 * 1000;
  let ticks = '';
  for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= now; t += stepMs) {
    const x = xOf(t);
    const label = new Date(t).toLocaleTimeString(deckLang === 'en' ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
    ticks += `<line x1="${x}" y1="${TOP - 4}" x2="${x}" y2="${H}" stroke="rgba(148,163,184,0.11)" />`;
    if (nowX - x >= 48 && x - LABEL >= 24) {
      ticks += `<text x="${x}" y="${TOP - 9}" fill="#64748b" font-size="10" text-anchor="middle" font-family="var(--font-mono)">${label}</text>`;
    }
  }

  const spanCoordsById = new Map();
  let laneRows = '';
  let chainsSvg = '';

  laneLayout.forEach(({ lane, y, height }, i) => {
    if (i % 2 === 0) {
      laneRows += `<rect x="0" y="${y}" width="${W}" height="${height}" fill="rgba(15,23,42,0.34)" />`;
    }
    laneRows += `<line x1="0" y1="${y + height}" x2="${W}" y2="${y + height}" stroke="rgba(148,163,184,0.08)" />`;

    if (lane.mode === 'agent') {
      const ag = AGENTS.find(a => a.id === lane.key);
      const title = ag ? getNodeDisplayTitle(ag) : shortSeat(lane.key);
      const isSel = lane.key === selectedAgentId;
      const prefix = (ag && ag.icon) ? `${ag.icon} ` : '';
      const txt = prefix + (title.length > 20 ? title.slice(0, 19) + '…' : title);
      laneRows += `<text x="8" y="${y + height / 2 + 3.5}" fill="${isSel ? '#00f0ff' : '#cbd5e1'}" font-size="11" font-weight="${isSel ? 800 : 600}" font-family="var(--font-mono)">${escapeHtml(txt)}<title>${escapeHtml(lane.key)}</title></text>`;
      if (lane.trackCount > 1) {
        laneRows += `<text x="${LABEL - 6}" y="${y + 13}" text-anchor="end" fill="#64748b" font-size="9" font-family="var(--font-mono)">×${lane.trackCount}</text>`;
      }
    } else {
      const title = lane.label.length > 21 ? lane.label.slice(0, 20) + '…' : lane.label;
      const isFoc = ganttFocusChain === lane.key;
      laneRows += `<circle cx="12" cy="${y + height / 2}" r="4" fill="${lane.color}" />`;
      laneRows += `<text x="22" y="${y + height / 2 + 3.5}" fill="${isFoc ? '#fff' : '#cbd5e1'}" font-size="10.5" font-weight="${isFoc ? 800 : 700}" font-family="var(--font-mono)" style="cursor:pointer;" data-chain="${escapeHtml(lane.key)}" onclick="setGanttFocus(ganttFocusChain === this.getAttribute('data-chain') ? null : this.getAttribute('data-chain'))">${escapeHtml(title)}<title>${escapeHtml(lane.label)}</title></text>`;
      if (lane.qaRounds > 1) {
        laneRows += `<text x="${LABEL - 6}" y="${y + height / 2 + 3.5}" text-anchor="end" fill="#fb923c" font-size="9.5" font-family="var(--font-mono)">🪃${lane.qaRounds}</text>`;
      }
    }

    for (const sp of lane.spans) {
      const barY = y + LANE_PAD / 2 + sp.subRow * SUB_ROW + (SUB_ROW - BAR) / 2;
      const xw0 = xOf(sp.created);
      const xw1 = xOf(sp.workStart);
      const xk1 = Math.max(xOf(sp.endT), xw1 + 3);
      spanCoordsById.set(sp.id, { xStart: xw0, xEnd: xk1, yMid: barY + BAR / 2, sp });

      let g = '';
      if (xw1 - xw0 >= 1.5) {
        g += `<rect x="${xw0}" y="${barY + 3}" width="${Math.max(2, xw1 - xw0)}" height="${BAR - 6}" rx="2" fill="url(#ganttWaitHatch)" stroke="${sp.isLongWait ? '#f59e0b' : 'rgba(148,163,184,0.35)'}" stroke-width="${sp.isLongWait ? '1.8' : '1'}" />`;
      }
      if (sp.workMs > 0 || !sp.isOpen || Number.isFinite(sp.claimed)) {
        g += `<rect x="${xw1}" y="${barY}" width="${Math.max(3, xk1 - xw1)}" height="${BAR}" rx="3.5" fill="${sp.color}" fill-opacity="${sp.isOpen ? 0.96 : 0.84}" stroke="${sp.isBounceBack ? '#fb923c' : (sp.isLongWait ? '#f59e0b' : '#060e1e')}" stroke-width="${sp.isBounceBack || sp.isLongWait ? '1.8' : '1'}" />`;
        if (sp.isOpen) {
          g += `<rect x="${xk1 - 3}" y="${barY}" width="3" height="${BAR}" fill="#fff" fill-opacity="0.88"><animate attributeName="fill-opacity" values="0.9;0.2;0.9" dur="1.6s" repeatCount="indefinite"/></rect>`;
        }
      }

      const barW = xk1 - xw1;
      const innerLabel = lane.mode === 'chain'
        ? `${shortSeat(sp.to)}${sp.isBounceBack ? ' 🪃' : ''}`
        : (sp.slice || sp.label);
      if (barW > 46 && innerLabel) {
        const maxChars = Math.floor((barW - 8) / 6.2);
        const txt = innerLabel.length > maxChars ? innerLabel.slice(0, Math.max(1, maxChars - 1)) + '…' : innerLabel;
        g += `<text x="${xw1 + 5}" y="${barY + BAR / 2 + 3.5}" fill="#060e1e" font-size="9.5" font-weight="800" font-family="var(--font-mono)" pointer-events="none">${escapeHtml(txt)}</text>`;
      }
      if (sp.isBounceBack && barW <= 46) {
        g += `<text x="${xk1 + 2}" y="${barY + BAR / 2 + 3.5}" font-size="10" pointer-events="none">🪃</text>`;
      }

      g += `<rect x="${xw0}" y="${barY - 2}" width="${Math.max(8, xk1 - xw0)}" height="${BAR + 4}" fill="transparent" />`;
      const isSel = ganttSelectedSpanId === sp.id;
      chainsSvg += `<g class="g-chain ${isSel ? 'is-selected' : ''}" data-span-id="${escapeHtml(sp.id)}" data-chain="${escapeHtml(sp.chain)}" data-seat="${escapeHtml(sp.to)}" onmouseenter="ganttHover(this.getAttribute('data-chain'), this.getAttribute('data-span-id'), event)" onmousemove="ganttMoveTip(event)" onmouseleave="ganttHover(null, '')" onclick="ganttClick(this, event)">${g}</g>`;
    }
  });

  // Draw subtle handoff connectors between consecutive spans of the same chain (brightens cleanly on hover/focus!)
  let handoffsSvg = '';
  if (ganttGroupBy === 'agent') {
    const byChain = new Map();
    for (const sp of spans) {
      if (!byChain.has(sp.chain)) byChain.set(sp.chain, []);
      byChain.get(sp.chain).push(sp);
    }
    for (const [chain, list] of byChain.entries()) {
      list.sort((a, b) => a.created - b.created);
      for (let i = 0; i < list.length - 1; i++) {
        const a = spanCoordsById.get(list[i].id);
        const b = spanCoordsById.get(list[i + 1].id);
        if (!a || !b || list[i].to === list[i + 1].to) continue;
        const ax = Math.min(a.xEnd, b.xStart);
        const ay = a.yMid;
        const bx = b.xStart;
        const by = b.yMid;
        handoffsSvg += `<path class="g-handoff-link" data-chain="${escapeHtml(chain)}" d="M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${(ax + 12).toFixed(1)} ${ay.toFixed(1)}, ${(bx - 12).toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}" fill="none" stroke="${list[i].color}" stroke-width="1.3" opacity="0.24" marker-end="url(#ganttArrow)" pointer-events="none" />`;
      }
    }
  }

  return `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs>
        <pattern id="ganttWaitHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="rgba(148,163,184,0.08)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(148,163,184,0.55)" stroke-width="2" />
        </pattern>
        <marker id="ganttArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#cbd5e1" />
        </marker>
      </defs>
      ${laneRows}
      <line x1="${LABEL}" y1="${TOP - 4}" x2="${LABEL}" y2="${H}" stroke="rgba(56,189,248,0.25)" />
      ${ticks}
      ${handoffsSvg}
      ${chainsSvg}
      <line x1="${nowX}" y1="${TOP - 6}" x2="${nowX}" y2="${H}" stroke="#ff2a6d" stroke-width="1.2" stroke-dasharray="3 3" />
      <text x="${nowX - 4}" y="${TOP - 9}" fill="#ff2a6d" font-size="10" font-weight="700" text-anchor="end" font-family="var(--font-mono)">${td('gantt.now')}</text>
    </svg>
  `;
}

// Offline view fixture; the caller supplies its fleet and clock.
export function buildDemoGanttItems({ agents: AGENTS, deckLang, nowMs }) {
  const now = nowMs;
  const min = 60 * 1000;
  const pick = (needle, fallback) => (AGENTS.find(a => a.id.includes(needle)) || {}).id || fallback;
  const owner = pick('owner', 'dev-owner@demo');
  const coder = pick('dev-coder@', 'dev-coder@demo');
  const coder4 = pick('coder4', 'dev-coder4@demo');
  const check = pick('check', 'dev-check@demo');
  const arch = pick('senior', 'dev-senior-architector@demo');
  const mk = (chain, slice, to, from, createdMin, claimedMin, endMin, summary) => ({
    id: `demo-${chain}-${to}-${createdMin}`,
    from, to, chain, slice, summary,
    state: endMin === null ? 'in-progress' : 'done',
    createdAt: new Date(now - createdMin * min).toISOString(),
    claimedAt: claimedMin === null ? null : new Date(now - claimedMin * min).toISOString(),
    endAt: endMin === null ? null : new Date(now - endMin * min).toISOString()
  });
  const en = deckLang === 'en';
  return [
    mk('slice:moderation-single-writer', 'moderation-single-writer', arch, owner, 330, 325, 290, en ? 'Single-writer spec & boundaries' : 'Спека и границы single-writer'),
    mk('slice:moderation-single-writer', 'moderation-single-writer', coder4, owner, 285, 280, 200, en ? 'Single-writer implementation + tests' : 'Реализация single-writer + тесты'),
    mk('slice:moderation-single-writer', 'moderation-single-writer', check, coder4, 198, 160, 140, en ? 'QA bounds: bounce (write race)' : 'QA границ: возврат (race на записи)'),
    mk('slice:moderation-single-writer', 'moderation-single-writer', coder4, check, 138, 135, 100, en ? 'Race fix + regression test' : 'Фикс race + регресс-тест'),
    mk('slice:moderation-single-writer', 'moderation-single-writer', check, coder4, 98, 95, 80, en ? 'QA round 2: bounce (limit +1)' : 'Повторный QA: возврат (лимит +1)'),
    mk('slice:moderation-single-writer', 'moderation-single-writer', coder4, check, 78, 76, 50, en ? 'Boundary limit +1 fix' : 'Фикс граничного лимита'),
    mk('slice:moderation-single-writer', 'moderation-single-writer', check, coder4, 48, 46, 30, 'QA: GREEN'),
    mk('slice:moderation-single-writer', 'moderation-single-writer', owner, check, 28, 20, null, en ? 'Acceptance & push' : 'Приёмка и push'),
    mk('slice:viewer-channel-chat', 'viewer-channel-chat', coder, owner, 240, 236, 120, en ? 'Viewer channel chat feature' : 'Чат канала зрителя'),
    mk('slice:viewer-channel-chat', 'viewer-channel-chat', check, coder, 118, 110, 70, en ? 'Chat QA: GREEN' : 'QA чата: GREEN'),
    mk('slice:viewer-channel-chat', 'viewer-channel-chat', owner, check, 68, 64, 55, en ? 'Accepted locally' : 'Приёмка локально'),
    mk('slice:context-supervision', 'context-supervision', coder, owner, 50, 12, null, en ? 'Context guard (long queue wait)' : 'Контроль контекста (долго ждал взятия)')
  ];
}

export function positionGanttTooltip(doc, ev, { innerWidth, innerHeight }) {
  if (!ev) return;
  const tipEl = doc.getElementById('ganttTooltip');
  if (!tipEl || !tipEl.classList.contains('visible')) return;
  const pad = 14;
  const tw = tipEl.offsetWidth || 280;
  const th = tipEl.offsetHeight || 90;
  let left = ev.clientX + pad;
  let top = ev.clientY + pad;
  if (left + tw > innerWidth - 10) left = Math.max(10, ev.clientX - tw - pad);
  if (top + th > innerHeight - 10) top = Math.max(10, ev.clientY - th - pad);
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}
