/** Topology views: explicit state/browser adapters plus pure geometry and markup builders. */
import { computeTopologyLayout, computeAnchoredPopoverRect } from '../domain/topology-layout.js';

export function renderStateIndicatorHtml(agent, { escapeHtml }) {
  if (agent.state === 'working') {
    const suffix = (agent.activityLabel || '').includes('ELB-003')
      ? 'ELB-003'
      : agent.assignedWorkCount
        ? `(${agent.assignedWorkCount})`
        : 'ACTIVE';
    return `<span class="heart-anim" title="Работает"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></span><span>${escapeHtml(suffix)}</span>`;
  }
  if (agent.state === 'idle') {
    return `<span class="zzz-anim" title="Спит (Idle)"><span>Z</span><span>z</span><span>z...</span></span>`;
  }
  if (agent.state === 'waiting') {
    return agent.shellExited
      ? `<span>⚠️ SHELL (${escapeHtml(agent.assignedWorkCount || 1)})</span>`
      : `<span>🟠 PARKED (${escapeHtml(agent.assignedWorkCount || 1)})</span>`;
  }
  if (agent.state === 'urgent') {
    return `<span>🚨 NEEDS INPUT</span>`;
  }
  return `<span>${escapeHtml(agent.activityLabel || 'IDLE')}</span>`;
}

export function getNodeThermalFillGrad(ctxPct) {
  if (typeof ctxPct !== 'number' || !Number.isFinite(ctxPct) || ctxPct <= 0) return 'transparent';
  if (ctxPct >= 75) return 'linear-gradient(90deg, rgba(255, 0, 85, 0.22), rgba(255, 0, 85, 0.05))';
  if (ctxPct >= 65) return 'linear-gradient(90deg, rgba(251, 146, 60, 0.17), rgba(251, 146, 60, 0.04))';
  if (ctxPct >= 55) return 'linear-gradient(90deg, rgba(250, 204, 21, 0.12), rgba(250, 204, 21, 0.02))';
  if (ctxPct >= 40) return 'linear-gradient(90deg, rgba(56, 189, 248, 0.11), rgba(56, 189, 248, 0.02))';
  if (ctxPct >= 20) return 'linear-gradient(90deg, rgba(96, 165, 250, 0.10), rgba(96, 165, 250, 0.02))';
  return 'linear-gradient(90deg, rgba(167, 139, 250, 0.10), rgba(167, 139, 250, 0.02))';
}

export function getNodeCtxValText(agent, thermal) {
  if (typeof agent.ctxPct !== 'number' || !Number.isFinite(agent.ctxPct)) return '';
  const pct = Math.min(100, Math.max(0, Math.round(agent.ctxPct)));
  return thermal.tier === 'crit' ? `${pct}%!` : `${pct}%`;
}

export function getNodeCtxValClass(thermal) {
  if (thermal.tier === 'crit') return 'node-ctx-val pill-crit';
  if (thermal.tier === 'warn') return 'node-ctx-val pill-warn';
  return 'node-ctx-val';
}

export function renderNodeMetaRowHtml(agent, thermal, { shortSeat, td, deckLang, escapeHtml }) {
  const tok = thermal && thermal.tokensShort ? thermal.tokensShort : '';
  const callsIn = Number(agent.callsIn) || 0;
  const callsOut = Number(agent.callsOut) || 0;
  const hasCalls = callsIn > 0 || callsOut > 0;
  const git = agent && agent.git;
  let gitAlertSpan = '';
  if (git && (git.unmergedCount > 0 || git.conflictFilesCount > 0)) {
    const peers = (git.conflictPeers || []).map(p => shortSeat(p)).join(', ');
    if (git.unmergedCount > 0) {
      const tip = td('git.unmergedBanner', { n: git.unmergedCount });
      gitAlertSpan = `<span class="node-meta-git-conflict" title="${escapeHtml(tip)}">🚨 ${escapeHtml(git.unmergedCount)}</span>`;
    } else {
      const tip = td('git.nodeConflictTip', { peers: peers || 'worktree' });
      gitAlertSpan = `<span class="node-meta-git-conflict" title="${escapeHtml(tip)}">⚔️ ${escapeHtml(git.conflictFilesCount)}</span>`;
    }
  }
  if (!tok && !hasCalls && !gitAlertSpan) return '';
  const tokTip = deckLang === 'en'
    ? `Context window used: ${tok}`
    : `Заполнение контекстного окна: ${tok}`;
  const callTip = deckLang === 'en'
    ? `Queue envelopes: ↓${callsIn} received / ↑${callsOut} sent`
    : `Передачи очереди: ↓${callsIn} получено / ↑${callsOut} отправлено`;
  const tokSpan = tok ? `<span class="node-meta-tokens" title="${escapeHtml(tokTip)}">${escapeHtml(tok)}</span>` : '';
  const callSpan = hasCalls ? `<span class="node-meta-traffic" title="${escapeHtml(callTip)}">↓${callsIn} ↑${callsOut}</span>` : '';
  return tokSpan + callSpan + gitAlertSpan;
}

export function renderNodeSpecMetaHtml(agent, burn, { deckLang, escapeHtml }) {
  const parts = [];
  const harness = String(agent.harness || '').trim();
  const model = String(agent.model || '').trim();
  if (harness) {
    parts.push(`<span class="spec-harness">${escapeHtml(harness)}</span>`);
  }
  if (model && model.toLowerCase() !== harness.toLowerCase()) {
    parts.push(`<span class="spec-model">${escapeHtml(model)}</span>`);
  }
  // Show real QA rework metric only (strip leading emoji/noise; never duplicate static role or ctx%)
  const rawRework = String(agent.reworkBadge || '').trim();
  if (rawRework && !/Spec\s*&\s*Arch|Watchdog/i.test(rawRework)) {
    const cleanRework = rawRework.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '').trim();
    if (cleanRework) {
      const isWarn = (agent.reworkClass || '').includes('warn');
      parts.push(`<span class="spec-qa ${isWarn ? 'is-warn' : ''}">${escapeHtml(cleanRework)}</span>`);
    }
  }
  // Show ETA to 75% ONLY when backed by a real measured positive burn rate (no fabricated 20%/h fallback!)
  if (typeof agent.ctxPct === 'number' && agent.ctxPct >= 65 && agent.ctxPct < 75 && burn && typeof burn.perHour === 'number' && burn.perHour > 0.5) {
    const etaMin = Math.max(1, Math.round(((75 - agent.ctxPct) / burn.perHour) * 60));
    const etaLabel = deckLang === 'en' ? `~${etaMin}m to 75%` : `~${etaMin}м до 75%`;
    parts.push(`<span class="spec-eta" title="${escapeHtml(burn.label || '')}">${escapeHtml(etaLabel)}</span>`);
  }
  return parts.join('<span class="spec-sep">·</span>');
}

export function renderDormantFlagHtml(agent) {
  if (!agent || agent.state !== 'waiting') return '';
  const count = agent.assignedWorkCount || 1;
  return agent.shellExited ? `⚠️ ${count}` : `🟠 ${count}`;
}

export function intersectNodeBorder(cx, cy, hw, hh, vx, vy, pad) {
  const w = hw + pad;
  const h = hh + pad;
  const tx = Math.abs(vx) > 1e-5 ? w / Math.abs(vx) : 1e9;
  const ty = Math.abs(vy) > 1e-5 ? h / Math.abs(vy) : 1e9;
  const t = Math.min(tx, ty);
  return { x: cx + vx * t, y: cy + vy * t };
}

export function renderNodeCardHtml(agent, deps) {
  const { getContextThermal, selectedAgentId, currentRigFilter, collapsedIdleIds,
    hoveredAgentId, connectedNodeIds, layoutResult, computeBurn, deckLang,
    getNodeDisplayTitle, escapeHtml, td, buildThermalCurveSvgHtml } = deps;
  const thermal = getContextThermal(agent.ctxPct, agent.ctxWindowSize);
  const isSelected = agent.id === selectedAgentId;
  const isRigMatch = currentRigFilter === 'all' || agent.id.endsWith('@' + currentRigFilter);
  const isHidden = collapsedIdleIds.has(agent.id) || !isRigMatch;
  const isDimmed = Boolean(hoveredAgentId && !connectedNodeIds.has(agent.id));
  const calmClass = agent.isAnomaly ? 'calm-anomaly' : 'calm-normal';
  const tier = layoutResult.tiers[agent.id] || 'active';
  const benchEdge = layoutResult.benchEdgeById[agent.id] || '';
  const ledClass =
    agent.state === 'urgent' ? 'led-urgent' :
    agent.state === 'working' ? 'led-working' :
    agent.state === 'waiting' ? 'led-waiting' : 'led-idle';

  const burn = computeBurn(agent, deckLang);

  return `
    <div class="agent-node state-${agent.state} ${calmClass} ${isSelected ? 'selected' : ''} ${isDimmed ? 'dimmed' : ''}"
         data-agent-id="${escapeHtml(agent.id)}"
         data-thermal-tier="${thermal.tier || 'none'}"
         data-activity-tier="${tier}"
         ${benchEdge ? `data-bench-edge="${escapeHtml(benchEdge)}"` : ''}
         style="left:${agent.x}%; top:${agent.y}%; ${isHidden ? 'display:none;' : ''} --ctx-color:${thermal.color}; --ctx-glow:${thermal.glow}; --ctx-fill-pct:${thermal.pct}%; --ctx-fill-grad:${getNodeThermalFillGrad(agent.ctxPct)};"
         onmouseenter="setHoverAgent(this.getAttribute('data-agent-id'))"
         onmouseleave="setHoverAgent(null)"
         onmousedown="selectAgent(this.getAttribute('data-agent-id'), event)"
         onclick="selectAgent(this.getAttribute('data-agent-id'), event)">
      <div class="node-top">
        <div class="node-identity">
          <div class="node-icon">${escapeHtml(agent.icon)}</div>
          <div class="node-title-wrap">
            <div class="node-name" title="${escapeHtml(getNodeDisplayTitle(agent))}">${escapeHtml(getNodeDisplayTitle(agent))}</div>
            <div class="node-role">${escapeHtml(agent.role)}</div>
          </div>
        </div>
        <span class="node-dormant-flag" title="${escapeHtml(agent.activityLabel || '')}">${escapeHtml(renderDormantFlagHtml(agent))}</span>
        <span class="${getNodeCtxValClass(thermal)}" title="${escapeHtml(thermal.label || '')}">${escapeHtml(getNodeCtxValText(agent, thermal))}</span>
        <span class="status-led ${ledClass}" data-seat-id="${escapeHtml(agent.id)}" data-state-key="${escapeHtml(agent.state + ':' + agent.activityLabel + ':' + (agent.shellExited ? 1 : 0))}"${agent.state === 'urgent' ? ` role="button" title="${escapeHtml(td('node.urgentBadgeTip'))}"` : ''} onmousedown="handleNodeLedMouseDown(event, this)" onclick="handleNodeLedClick(event, this)">${renderStateIndicatorHtml(agent, deps)}</span>
      </div>

      <div class="node-meta-row">${renderNodeMetaRowHtml(agent, thermal, deps)}</div>

      <div class="badge-row">${renderNodeSpecMetaHtml(agent, burn, deps)}</div>

      <div class="ctx-box">
        <div class="ctx-header">
          <span class="ctx-thermal-label" style="color:${thermal.color}; font-weight:700;">${thermal.label}</span>
          <span style="color:#94a3b8;" title="Число задач в очереди (получено / отправлено)">Очередь: 📥${agent.callsIn} / 📤${agent.callsOut}</span>
        </div>
        <div class="ctx-bar-bg">
          <div class="ctx-bar-fill" style="width:${thermal.pct}%; background:${thermal.color};"></div>
        </div>
      </div>

      <!-- Integrated non-linear exponential thermal spectrum wedge (under content, above card background) -->
      <div class="node-bottom-meter">
        <div class="node-bottom-meter-fill">${typeof buildThermalCurveSvgHtml === 'function' ? buildThermalCurveSvgHtml() : ''}</div>
      </div>
    </div>
  `;
}

export function renderTopologyEdgesHtml({
  edges: EDGES, nodeMap, collapsedIdleIds, currentRigFilter, cw, ch, boxSizes,
  layoutResult, hasSliceMatch, isEdgeInSlice, hoveredAgentId, deckLang, shortSeat, escapeHtml
}) {
  return EDGES.map((edge, edgeIdx) => {
    const n1 = nodeMap[edge.from];
    const n2 = nodeMap[edge.to];
    if (!n1 || !n2) return '';
    if (collapsedIdleIds.has(edge.from) || collapsedIdleIds.has(edge.to)) return '';
    if (currentRigFilter !== 'all' && (!edge.from.endsWith('@' + currentRigFilter) || !edge.to.endsWith('@' + currentRigFilter))) return '';

    const cx1 = (n1.x / 100) * cw;
    const cy1 = (n1.y / 100) * ch;
    const cx2 = (n2.x / 100) * cw;
    const cy2 = (n2.y / 100) * ch;

    // Center-to-center vector (preserves exact center-to-center orientation!)
    const dx = cx2 - cx1;
    const dy = cy2 - cy1;

    const sz1 = boxSizes[n1.id] || { hw: 100, hh: 32 };
    const sz2 = boxSizes[n2.id] || { hw: 100, hh: 32 };

    // Start point right at the border of source block (pad = 2px)
    const p1 = intersectNodeBorder(cx1, cy1, sz1.hw, sz1.hh, dx, dy, 2);
    // End point right at the border of target block (pad = 4px so arrowhead tip touches border)
    const p2 = intersectNodeBorder(cx2, cy2, sz2.hw, sz2.hh, -dx, -dy, 4);

    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const pathD = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;

    const statusKey = edge.queueStatus || (edge.liveActive ? 'live' : 'ghost');
    const isLive = statusKey === 'live';
    const isQueuedStatic = statusKey === 'blocked' || statusKey === 'parked' || statusKey === 'held' || statusKey === 'pending';
    const segClass = isLive ? 'is-live' : (isQueuedStatic ? `is-${statusKey}` : 'is-ghost');
    const isDormantGhost = !isLive && !isQueuedStatic &&
      (layoutResult.tiers[edge.from] === 'dormant' || layoutResult.tiers[edge.to] === 'dormant');
    const trunkWidth = isLive
      ? Math.max(4, Math.round(Math.log2(1 + (edge.calls || 1)) * 2.4))
      : (isQueuedStatic ? 2.6 : 2);
    const streamWidth = Math.max(2, Math.round(trunkWidth * 0.45));

    const isVisibleSlice = !hasSliceMatch || isEdgeInSlice(edge);
    const isHoveredMatch = !hoveredAgentId || edge.from === hoveredAgentId || edge.to === hoveredAgentId;
    const dimmedClass = (!isVisibleSlice || !isHoveredMatch) ? 'dimmed' : '';
    const hoverFocusClass = (hoveredAgentId && isHoveredMatch) ? 'hover-focus' : '';

    const showBadge = isLive || isQueuedStatic || (edge.calls && edge.calls > 0);
    const sliceLabel = edge.slice && edge.slice !== 'all' ? edge.slice : '';
    let badgeText = '';
    if (isLive) {
      badgeText = `📨 ${sliceLabel || (deckLang === 'en' ? 'Active' : 'В работе')}`;
    } else if (isQueuedStatic) {
      const icon = edge.statusIcon || (statusKey === 'blocked' ? '🚧' : statusKey === 'parked' ? '🅿️' : statusKey === 'held' ? '⏸️' : '⏳');
      const fallbackWord = edge.statusLabel || statusKey;
      badgeText = sliceLabel ? `${icon} ${sliceLabel}` : `${icon} ${fallbackWord}`;
    } else {
      badgeText = `⚡ ${edge.calls} ${deckLang === 'en' ? 'calls' : 'выз.'}`;
    }
    const badgeWidth = Math.max(76, badgeText.length * 7.2 + 16);
    const badgeX = mx - badgeWidth / 2;
    const tooltipText = edge.statusTooltip || `${badgeText} (${shortSeat(edge.from)} → ${shortSeat(edge.to)})`;

    return `
      <g class="edge-group ${segClass} ${isDormantGhost ? 'is-dormant-edge' : ''} ${dimmedClass} ${hoverFocusClass}" style="--edge-stroke:${edge.color};" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" data-slice="${escapeHtml(edge.slice)}" data-edge-status="${escapeHtml(statusKey)}" onclick="selectEdge(${edgeIdx}, event)">
        <title>${escapeHtml(tooltipText)}</title>
        <path d="${pathD}" stroke="transparent" stroke-width="18" fill="none" style="pointer-events:stroke;" />
        <path d="${pathD}" class="edge-trunk" stroke="${isLive || isQueuedStatic ? edge.color : '#334155'}" stroke-width="${trunkWidth}"${isQueuedStatic ? ` marker-end="url(#${edge.marker || 'arr-amber'})"` : ''} />
        ${isLive ? `
          <path d="${pathD}" class="edge-stream live-active" stroke="${edge.color}" stroke-width="${streamWidth}"
                style="--stream-speed:${edge.speed}; --edge-glow:${edge.color};" marker-end="url(#${edge.marker})" />
        ` : ''}
        ${showBadge ? `
          <rect x="${badgeX}" y="${my - 9}" width="${badgeWidth}" height="18" rx="4" class="edge-badge-bg" />
          <text x="${mx}" y="${my + 3.5}" text-anchor="middle" class="edge-badge-text">${escapeHtml(badgeText)}</text>
        ` : ''}
      </g>
    `;
  }).join('');
}

export function renderRigClustersHtml(clusters, { cw, ch, escapeHtml }) {
  if (!clusters || clusters.length < 2) return '';
  return clusters.map(c => {
    const x = c.xPct * cw / 100, y = c.yPct * ch / 100;
    const w = c.wPct * cw / 100, h = c.hPct * ch / 100;
    const label = `@${c.rigId} · ${c.count}`;
    return `<g class="rig-cluster-zone" data-rig-id="${escapeHtml(c.rigId)}"><title>${escapeHtml(label)}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/><text x="${x + 12}" y="${y + 21}">${escapeHtml(label)}</text></g>`;
  }).join('');
}

export function renderTopology(deps) {
  const { doc, browser, viewState, agents: AGENTS, edges: EDGES, isEdgeInSlice,
    hoveredAgentId, currentSliceFilter, currentRigFilter, hideIdleNodes, selectedAgentId,
    getNodeDisplayTitle, escapeHtml, td, nodeLastActiveAt, nowMs, TOPOLOGY_STAGE_COOLDOWN_MS,
    graphLayoutMode, getContextThermal, computeBurn, deckLang } = deps;
  const nodesLayer = doc.getElementById('nodesLayer');
  const svgGroup = doc.getElementById('svgEdgesGroup');
  const nodeMap = Object.fromEntries(AGENTS.map(a => [a.id, a]));

  const activeEdges = EDGES.filter(e =>
    isEdgeInSlice(e) &&
    (!hoveredAgentId || e.from === hoveredAgentId || e.to === hoveredAgentId)
  );
  const connectedNodeIds = new Set();
  if (hoveredAgentId) {
    connectedNodeIds.add(hoveredAgentId);
    activeEdges.forEach(e => { connectedNodeIds.add(e.from); connectedNodeIds.add(e.to); });
  } else if (currentSliceFilter !== 'all') {
    activeEdges.forEach(e => { connectedNodeIds.add(e.from); connectedNodeIds.add(e.to); });
  }

  const activeEndpointIds = new Set();
  EDGES.forEach(e => {
    const st = String(e.queueStatus || (e.liveActive ? 'live' : 'ghost')).toLowerCase();
    if (st !== 'ghost') {
      activeEndpointIds.add(e.from);
      activeEndpointIds.add(e.to);
    }
  });

  const collapsedIdleIds = new Set();
  const collapsedIdleNames = [];
  if (hideIdleNodes) {
    AGENTS.forEach(a => {
      if (currentRigFilter !== 'all' && !a.id.endsWith('@' + currentRigFilter)) return;
      const isHotCtx = typeof a.ctxPct === 'number' && a.ctxPct >= 75;
      const isPureIdle = a.state === 'idle' && !a.isAnomaly && !isHotCtx && a.id !== selectedAgentId && !activeEndpointIds.has(a.id);
      if (isPureIdle) {
        collapsedIdleIds.add(a.id);
        collapsedIdleNames.push(getNodeDisplayTitle(a));
      }
    });
  }

  const idlePill = doc.getElementById('idleCollapsedPill');
  if (idlePill) {
    if (collapsedIdleIds.size > 0) {
      const preview = collapsedIdleNames.slice(0, 3).join(', ') + (collapsedIdleNames.length > 3 ? ` +${collapsedIdleNames.length - 3}` : '');
      idlePill.innerHTML = `<span>💤 Скрыто спящих: <b>${collapsedIdleIds.size}</b> (${escapeHtml(preview)})</span><span style="color:var(--cyan); font-weight:700;">Показать</span>`;
      idlePill.classList.add('visible');
    } else {
      idlePill.classList.remove('visible');
    }
  }

  // Compute Adaptive (Dynamic Stage + Dormant Bench) or Fixed Role-Tiered layout in real canvas pixels
  const wrapEl = nodesLayer.parentElement;
  const minWidth = browser.getComputedStyle ? Number.parseFloat(browser.getComputedStyle(nodesLayer).minWidth) || 0 : 0;
  let cw = Math.max(wrapEl?.clientWidth || nodesLayer.clientWidth || 1000, minWidth);
  let ch = wrapEl?.clientHeight || nodesLayer.clientHeight || 510;
  const isDetailed = doc.body.classList.contains('density-detailed');
  const visibleAgents = AGENTS.filter(a => {
    const isRigMatch = currentRigFilter === 'all' || a.id.endsWith('@' + currentRigFilter);
    return isRigMatch && !collapsedIdleIds.has(a.id);
  });

  const recentActiveIds = new Set();
  if (viewState.hasInitialLayout) {
    for (const a of visibleAgents) {
      if (a.state === 'working' || a.state === 'urgent' || activeEndpointIds.has(a.id)) {
        nodeLastActiveAt.set(a.id, nowMs);
      }
      const lastAt = nodeLastActiveAt.get(a.id);
      if (typeof lastAt === 'number' && (nowMs - lastAt) <= TOPOLOGY_STAGE_COOLDOWN_MS) {
        recentActiveIds.add(a.id);
      }
    }
  }

  const activeRigIds = new Set();
  for (const a of visibleAgents) {
    const isAct = a.state === 'working' || a.state === 'urgent' || activeEndpointIds.has(a.id) || (graphLayoutMode === 'dynamic' && recentActiveIds.has(a.id));
    if (isAct) {
      const idStr = String(a.id || '');
      activeRigIds.add(idStr.includes('@') ? idStr.slice(idStr.lastIndexOf('@') + 1) : 'local');
    }
  }
  const useCompactClusterTitle = currentRigFilter === 'all' && activeRigIds.size >= 2;
  const resolveCardTitle = (agent) => {
    const base = getNodeDisplayTitle(agent);
    if (!useCompactClusterTitle || !agent || !agent.id) return base;
    const raw = String(agent.id);
    const at = raw.lastIndexOf('@');
    return at > 0 ? raw.slice(0, at) : base;
  };
  const renderDeps = useCompactClusterTitle ? { ...deps, getNodeDisplayTitle: resolveCardTitle } : deps;

  const measuredBoxes = {};
  const visibleById = new Map(visibleAgents.map(a => [a.id, a]));
  nodesLayer.querySelectorAll('.agent-node').forEach(domEl => {
    const aid = domEl.getAttribute('data-agent-id');
    if (!aid || aid === hoveredAgentId || domEl.style.display === 'none') return;
    const ag = visibleById.get(aid);
    if (!ag) return;
    const nameEl = domEl.querySelector('.node-name');
    const expectedTitle = resolveCardTitle(ag);
    // Ignore stale DOM measurements when rig filter or title just changed!
    if (nameEl && nameEl.textContent !== expectedTitle) return;
    if (domEl.offsetWidth > 30 && domEl.offsetHeight > 16) {
      measuredBoxes[aid] = {
        width: domEl.offsetWidth,
        height: domEl.offsetHeight,
        tier: domEl.getAttribute('data-activity-tier') || 'active',
        detailed: isDetailed
      };
    }
  });

  const bottomReservePx = 0;
  const layoutResult = (typeof computeTopologyLayout === 'function')
    ? computeTopologyLayout({
        agents: visibleAgents.map(a => ({ ...a, displayTitle: resolveCardTitle(a) })),
        edges: EDGES,
        mode: graphLayoutMode,
        canvasWidth: cw,
        canvasHeight: ch,
        detailed: isDetailed,
        measuredBoxes,
        recentActiveIds,
        bottomReservePx
      })
    : { positions: {}, tiers: {}, benchEdgeById: {}, benchSeparatorY: null, activeCount: visibleAgents.length, dormantCount: 0 };

  const clustered = layoutResult.rigClusters?.length >= 2;
  const svgEl = doc.getElementById('topologySvg');
  cw = layoutResult.canvasWidth || cw;
  ch = layoutResult.canvasHeight || ch;
  if (wrapEl) wrapEl.classList.toggle('has-rig-clusters', clustered);
  nodesLayer.style.width = clustered ? `${cw}px` : '';
  nodesLayer.style.height = clustered ? `${ch}px` : '';
  if (svgEl) {
    svgEl.style.width = clustered ? `${cw}px` : '';
    svgEl.style.height = clustered ? `${ch}px` : '';
    let zones = doc.getElementById('rigClusterZones');
    if (!zones && clustered) {
      zones = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      zones.id = 'rigClusterZones';
      zones.setAttribute('aria-hidden', 'true');
      svgEl.insertBefore(zones, svgGroup);
    }
    if (zones) {
      const html = renderRigClustersHtml(layoutResult.rigClusters, { cw, ch, escapeHtml });
      if (zones.__lastHtml !== html) { zones.innerHTML = html; zones.__lastHtml = html; }
    }
  }

  const benchDiv = doc.getElementById('dormantBenchDivider');
  const benchLbl = doc.getElementById('dormantBenchLabel');
  if (benchDiv) {
    if (layoutResult.benchSeparatorY != null && layoutResult.dormantCount > 0) {
      benchDiv.style.top = `${layoutResult.benchSeparatorY}%`;
      if (benchLbl) benchLbl.textContent = `${td('graph.dormantBench')} · ${layoutResult.dormantCount}`;
      benchDiv.classList.add('visible');
    } else {
      benchDiv.classList.remove('visible');
    }
  }

  const targetPositions = {};
  const startPositions = {};
  let maxPosDelta = 0;
  for (const a of visibleAgents) {
    const pos = layoutResult.positions[a.id];
    if (pos) {
      startPositions[a.id] = { x: a.x, y: a.y };
      targetPositions[a.id] = { x: pos.x, y: pos.y };
      const d = Math.hypot(pos.x - a.x, pos.y - a.y);
      if (d > maxPosDelta) maxPosDelta = d;
    }
  }

  const prefersReducedMotion = Boolean(
    browser.matchMedia && browser.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const shouldAnimateLayout = Boolean(
    viewState.hasInitialLayout &&
    !clustered && !viewState.clustered &&
    !prefersReducedMotion &&
    maxPosDelta >= 0.8 &&
    nodesLayer.querySelectorAll('.agent-node').length === AGENTS.length
  );

  if (!shouldAnimateLayout) {
    for (const a of visibleAgents) {
      if (targetPositions[a.id]) {
        a.x = targetPositions[a.id].x;
        a.y = targetPositions[a.id].y;
      }
    }
  }
  if (visibleAgents.length > 0) {
    viewState.hasInitialLayout = true;
  }
  viewState.clustered = clustered;

  const hasSliceMatch = currentSliceFilter !== 'all' && activeEdges.length > 0;
  const shouldDimByContext = Boolean(hoveredAgentId || hasSliceMatch);
  const existingNodes = nodesLayer.querySelectorAll('.agent-node');
  const allNodesMatch = existingNodes.length === AGENTS.length &&
    AGENTS.every(a => nodesLayer.querySelector(`.agent-node[data-agent-id="${a.id}"]`));
  if (allNodesMatch) {
    // Update in-place without recreating DOM nodes so animations (heart / Zzz...) and clicks are never interrupted!
    AGENTS.forEach(agent => {
      const el = nodesLayer.querySelector(`.agent-node[data-agent-id="${agent.id}"]`);
      if (!el) return;
      const isRigMatch = currentRigFilter === 'all' || agent.id.endsWith('@' + currentRigFilter);
      const isHidden = collapsedIdleIds.has(agent.id) || !isRigMatch;
      el.style.display = isHidden ? 'none' : '';
      if (isHidden) return;
      const thermal = getContextThermal(agent.ctxPct, agent.ctxWindowSize);
      const isSelected = agent.id === selectedAgentId;
      const isDimmed = Boolean(shouldDimByContext && !connectedNodeIds.has(agent.id));
      const calmClass = agent.isAnomaly ? 'calm-anomaly' : 'calm-normal';
      const tier = layoutResult.tiers[agent.id] || 'active';
      const benchEdge = layoutResult.benchEdgeById[agent.id] || '';
      const ledClass =
        agent.state === 'urgent' ? 'led-urgent' :
        agent.state === 'working' ? 'led-working' :
        agent.state === 'waiting' ? 'led-waiting' : 'led-idle';

      el.className = `agent-node state-${agent.state} ${calmClass} ${isSelected ? 'selected' : ''} ${isDimmed ? 'dimmed' : ''}`;
      el.setAttribute('data-thermal-tier', thermal.tier || 'none');
      el.setAttribute('data-activity-tier', tier);
      if (benchEdge) el.setAttribute('data-bench-edge', benchEdge);
      else el.removeAttribute('data-bench-edge');
      el.style.left = `${agent.x}%`;
      el.style.top = `${agent.y}%`;
      el.style.setProperty('--ctx-color', thermal.color);
      el.style.setProperty('--ctx-glow', thermal.glow);
      el.style.setProperty('--ctx-fill-pct', `${thermal.pct}%`);
      el.style.setProperty('--ctx-fill-grad', getNodeThermalFillGrad(agent.ctxPct));

      const ledEl = el.querySelector('.status-led');
      if (ledEl) {
        ledEl.className = `status-led ${ledClass}`;
        if (agent.state === 'urgent') {
          ledEl.setAttribute('role', 'button');
          ledEl.setAttribute('title', td('node.urgentBadgeTip'));
        } else {
          ledEl.removeAttribute('role');
          ledEl.removeAttribute('title');
        }
        const nextLedHtml = renderStateIndicatorHtml(agent, deps);
        const ledKey = `${agent.state}:${agent.activityLabel}:${agent.shellExited ? 1 : 0}`;
        if (ledEl.getAttribute('data-state-key') !== ledKey) {
          ledEl.innerHTML = nextLedHtml;
          ledEl.setAttribute('data-state-key', ledKey);
        }
      }

      const dormantFlagEl = el.querySelector('.node-dormant-flag');
      if (dormantFlagEl) {
        const nextFlag = renderDormantFlagHtml(agent);
        if (dormantFlagEl.textContent !== nextFlag) {
          dormantFlagEl.textContent = nextFlag;
          dormantFlagEl.title = agent.activityLabel || '';
        }
      }

      const nameEl = el.querySelector('.node-name');
      if (nameEl) {
        const nextTitle = resolveCardTitle(agent);
        if (nameEl.textContent !== nextTitle) {
          nameEl.textContent = nextTitle;
          nameEl.title = agent.id || nextTitle;
        }
      }

      const burn = computeBurn(agent, deckLang);
      const badgeRowEl = el.querySelector('.badge-row');
      if (badgeRowEl) {
        const nextSpecHtml = renderNodeSpecMetaHtml(agent, burn, deps);
        if (badgeRowEl.innerHTML !== nextSpecHtml) {
          badgeRowEl.innerHTML = nextSpecHtml;
        }
      }

      const ctxLabelEl = el.querySelector('.ctx-thermal-label');
      if (ctxLabelEl) {
        ctxLabelEl.textContent = thermal.label;
        ctxLabelEl.style.color = thermal.color;
      }

      const fillEl = el.querySelector('.ctx-bar-fill');
      if (fillEl) {
        fillEl.style.width = `${thermal.pct}%`;
        fillEl.style.background = thermal.color;
      }

      // Update integrated compact telemetry (Row 1 % + Row 2 tokens/traffic) in-place
      const ctxValEl = el.querySelector('.node-ctx-val');
      if (ctxValEl) {
        ctxValEl.className = getNodeCtxValClass(thermal);
        const nextCtxTxt = getNodeCtxValText(agent, thermal);
        if (ctxValEl.textContent !== nextCtxTxt) ctxValEl.textContent = nextCtxTxt;
        ctxValEl.title = thermal.label || '';
      }
      const metaRowEl = el.querySelector('.node-meta-row');
      if (metaRowEl) {
        const nextMetaHtml = renderNodeMetaRowHtml(agent, thermal, deps);
        if (metaRowEl.innerHTML !== nextMetaHtml) metaRowEl.innerHTML = nextMetaHtml;
      }
    });
  } else {
    nodesLayer.innerHTML = AGENTS.map(agent => renderNodeCardHtml(agent, { ...renderDeps, collapsedIdleIds, connectedNodeIds, layoutResult })).join('');
  }

  // Sync SVG viewBox with actual pixel canvas dimensions so 1 SVG unit = 1px
  // and clip every route segment to the exact outer border of each block along the center-to-center ray.
  if (svgEl) svgEl.setAttribute('viewBox', `0 0 ${cw} ${ch}`);

  // Measure DOM node boxes ONCE before drawing / animating to prevent Forced Synchronous Layout inside rAF!
  const cachedDomById = new Map();
  const cachedBoxSizes = {};
  nodesLayer.querySelectorAll('.agent-node').forEach(domEl => {
    const aid = domEl.getAttribute('data-agent-id');
    if (!aid) return;
    cachedDomById.set(aid, domEl);
    cachedBoxSizes[aid] = {
      hw: domEl.offsetWidth ? domEl.offsetWidth / 2 : 80,
      hh: domEl.offsetHeight ? domEl.offsetHeight / 2 : 18
    };
  });

  const drawTopologyEdgesNow = (boxSizes = cachedBoxSizes) => {
    const nextEdgesHtml = renderTopologyEdgesHtml({ ...deps, nodeMap, collapsedIdleIds,
      cw, ch, boxSizes, layoutResult, hasSliceMatch });
    if (svgGroup.__lastHtml !== nextEdgesHtml) {
      svgGroup.innerHTML = nextEdgesHtml;
      svgGroup.__lastHtml = nextEdgesHtml;
    }
  };

  if (viewState.tweenRaf) {
    browser.cancelAnimationFrame(viewState.tweenRaf);
    viewState.tweenRaf = null;
  }

  if (shouldAnimateLayout) {
    const animDuration = 280;
    const t0 = browser.performance.now();
    const stepTween = (now) => {
      const p = Math.min(1, (now - t0) / animDuration);
      const ease = 1 - Math.pow(1 - p, 3);
      for (const a of visibleAgents) {
        const st = startPositions[a.id];
        const tg = targetPositions[a.id];
        if (!st || !tg) continue;
        a.x = st.x + (tg.x - st.x) * ease;
        a.y = st.y + (tg.y - st.y) * ease;
        const domEl = cachedDomById.get(a.id);
        if (domEl) {
          domEl.style.left = `${a.x}%`;
          domEl.style.top = `${a.y}%`;
        }
      }
      drawTopologyEdgesNow(cachedBoxSizes);
      if (p < 1) {
        viewState.tweenRaf = browser.requestAnimationFrame(stepTween);
      } else {
        viewState.tweenRaf = null;
      }
    };
    viewState.tweenRaf = browser.requestAnimationFrame(stepTween);
  } else {
    drawTopologyEdgesNow(cachedBoxSizes);
  }
}

export function renderSwimlanes({ visibleLanes, stageNames: STAGE_NAMES, currentSliceFilter, escapeHtml }) {
  return visibleLanes.map(lane => {
    const isSelectedSlice = currentSliceFilter === lane.id;
    const stagesHtml = STAGE_NAMES.map((stName, idx) => {
      let cls = '';
      let icon = '';
      if (idx < lane.currentStage) {
        cls = 'done';
        icon = '✓ ';
      } else if (idx === lane.currentStage) {
        cls = 'current';
        icon = '🟢 ';
      }
      return `<div class="stage-cell ${cls}">${icon}${escapeHtml(stName)}</div>`;
    }).join('');

    return `
      <div class="swimlane-row"
           style="--lane-pad:${lane.padPx}; --lane-bar:${lane.barPx}; --lane-color:${lane.color}; ${isSelectedSlice ? 'border-color:var(--cyan); box-shadow:0 0 14px rgba(0,240,255,0.3);' : ''}"
           data-slice="${escapeHtml(lane.id === currentSliceFilter ? 'all' : lane.id)}" onclick="setSliceFilter(this.getAttribute('data-slice'))">
        <div class="lane-info">
          <div class="lane-name">${escapeHtml(lane.name)}</div>
          <div class="lane-metrics">
            ${escapeHtml(lane.coder)} • ⚡ <b>${lane.turns} выз</b> • 🪃 <b>QA: ${lane.qaRounds} кр</b>
          </div>
        </div>
        <div class="stages-track">${stagesHtml}</div>
      </div>
    `;
  }).join('');
}

export function computeEdgeFallbackAnchor(edge, wrapEl, agents) {
  if (!edge || !wrapEl) return null;
  const cw = wrapEl.scrollWidth || wrapEl.clientWidth || 0;
  const ch = wrapEl.scrollHeight || wrapEl.clientHeight || 0;
  if (!cw || !ch) return null;
  const fromNode = agents.find(a => a.id === edge.from);
  const toNode = agents.find(a => a.id === edge.to);
  if (fromNode && toNode && [fromNode.x, fromNode.y, toNode.x, toNode.y].every(Number.isFinite)) {
    return {
      x: Math.max(0, Math.min(cw, (((fromNode.x + toNode.x) / 2) / 100) * cw)),
      y: Math.max(0, Math.min(ch, (((fromNode.y + toNode.y) / 2) / 100) * ch))
    };
  }
  return { x: cw / 2, y: ch / 2 };
}

export function positionEdgeXrayDrawer(drawer, { edge, anchor: cursorAnchor, agents }) {
  if (!drawer || drawer.style.display === 'none') return;
  const wrapEl = drawer.parentElement;
  if (!wrapEl) return;
  const anchor = cursorAnchor || computeEdgeFallbackAnchor(edge, wrapEl, agents);
  if (!anchor) return;
  const cw = wrapEl.clientWidth || 0;
  const ch = wrapEl.clientHeight || 0;
  const pw = drawer.offsetWidth || 340;
  const ph = drawer.offsetHeight || 220;
  const scrollLeft = wrapEl.scrollLeft || 0;
  const scrollTop = wrapEl.scrollTop || 0;
  const pos = typeof computeAnchoredPopoverRect === 'function'
    ? computeAnchoredPopoverRect({
        anchorX: anchor.x - scrollLeft,
        anchorY: anchor.y - scrollTop,
        containerW: cw,
        containerH: ch,
        popoverW: pw,
        popoverH: ph,
        pad: 12,
        offset: 16
      })
    : { left: 12, top: 12, placement: 'clamped' };
  drawer.style.left = `${pos.left + scrollLeft}px`;
  drawer.style.top = `${pos.top + scrollTop}px`;
  drawer.style.right = 'auto';
  drawer.setAttribute('data-placement', pos.placement);
}

export function renderEdgeXray(edge, {
  pairEnvelopes: PAIR_ENVELOPES, openQueue: LIVE_OPEN_QUEUE, expandedXrayEnvelopes,
  extractItemContextMeta, formatEnvelopeClock, ageLabel, shortSeat, escapeHtml, td,
  CMD_COPY_LABEL_HTML, renderContextBadgesHtml
}) {
  if (!edge) return '';
  const key = [edge.from, edge.to].sort().join(' <-> ');
  const histEnvs = Array.isArray(PAIR_ENVELOPES[key]) ? PAIR_ENVELOPES[key] : [];
  const openRows = LIVE_OPEN_QUEUE.filter(q =>
    (q.sourceSession === edge.from && q.destinationSession === edge.to) ||
    (q.sourceSession === edge.to && q.destinationSession === edge.from)
  );

  // 1. Merge & deduplicate live + history envelopes by qitemId (live never duplicates into history!)
  const byId = new Map();
  for (const h of histEnvs) {
    const id = h.id || `${h.from}|${h.to}|${h.slice}|${h.state}|${h.updatedAt}`;
    byId.set(id, {
      id: h.id || '',
      from: h.from || '',
      to: h.to || '',
      slice: h.slice || '',
      state: h.state || 'done',
      summary: h.summary || '',
      createdAt: h.createdAt || '',
      updatedAt: h.updatedAt || h.createdAt || '',
      blockedOn: h.blockedOn || '',
      blockedOnQitemId: h.blockedOnQitemId || '',
      handedOffFrom: h.handedOffFrom || '',
      handedOffTo: h.handedOffTo || '',
      parent: h.parent || '',
      project: h.project || '',
      mission: h.mission || '',
      gate: h.gate || '',
      bodyContextRef: h.bodyContextRef || '',
      evidenceRef: h.evidenceRef || '',
      targetRepo: h.targetRepo || '',
      isLive: false
    });
  }
  for (const q of openRows) {
    const id = q.qitemId || q.id || '';
    const prev = id ? byId.get(id) : null;
    const meta = typeof extractItemContextMeta === 'function' ? extractItemContextMeta(q) : {};
    const slice = meta.slice || (prev && prev.slice) || '';
    const ts = q.tsUpdated || q.tsCreated || q.updatedAt || q.createdAt || (prev && prev.updatedAt) || '';
    byId.set(id || `live-${Math.random()}`, {
      id,
      from: q.sourceSession || (prev && prev.from) || '',
      to: q.destinationSession || (prev && prev.to) || '',
      slice,
      state: q.state || 'in-progress',
      summary: q.summary || q.title || q.subject || (prev && prev.summary) || '',
      createdAt: q.tsCreated || q.createdAt || (prev && prev.createdAt) || ts,
      updatedAt: ts,
      blockedOn: meta.blockedOn || (prev && prev.blockedOn) || '',
      blockedOnQitemId: meta.blockedOnQitemId || (prev && prev.blockedOnQitemId) || '',
      handedOffFrom: meta.handedOffFrom || (prev && prev.handedOffFrom) || '',
      handedOffTo: meta.handedOffTo || (prev && prev.handedOffTo) || '',
      parent: meta.parent || (prev && prev.parent) || '',
      project: meta.project || (prev && prev.project) || '',
      mission: meta.mission || (prev && prev.mission) || '',
      gate: meta.gate || (prev && prev.gate) || '',
      bodyContextRef: meta.bodyContextRef || (prev && prev.bodyContextRef) || '',
      evidenceRef: meta.evidenceRef || (prev && prev.evidenceRef) || '',
      targetRepo: meta.targetRepo || (prev && prev.targetRepo) || '',
      isLive: true
    });
  }

  // 2. Pack history inside each logical envelope (grouped by slice when present, else by id)
  const groupsMap = new Map();
  for (const ev of byId.values()) {
    const gKey = ev.slice ? `slice:${ev.slice}` : `id:${ev.id}`;
    if (!groupsMap.has(gKey)) groupsMap.set(gKey, { key: gKey, slice: ev.slice, events: [] });
    groupsMap.get(gKey).events.push(ev);
  }

  const envelopes = Array.from(groupsMap.values()).map(g => {
    g.events.sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      return (Date.parse(b.updatedAt || b.createdAt || 0) || 0) - (Date.parse(a.updatedAt || a.createdAt || 0) || 0);
    });
    g.lead = g.events[0];
    g.hasLive = g.events.some(e => e.isLive);
    g.latestTs = Math.max(...g.events.map(e => Date.parse(e.updatedAt || e.createdAt || 0) || 0));
    return g;
  }).sort((a, b) => {
    if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;
    return b.latestTs - a.latestTs;
  });

  const stateColor = (st, live) =>
    live || st === 'in-progress' ? '#00ff9d' :
    st === 'canceled' ? '#fda4af' :
    st === 'blocked' ? '#fb923c' :
    st === 'pending' ? '#fbbf24' : '#7dd3fc';

  const cardsHtml = envelopes.map(env => {
    const lead = env.lead;
    const hasHistory = env.events.length > 1;
    const isExpanded = hasHistory && expandedXrayEnvelopes.has(env.key);
    const leadTs = formatEnvelopeClock(lead.updatedAt || lead.createdAt);
    const leadAge = ageLabel(lead.updatedAt || lead.createdAt);
    const leadShortId = String(lead.id || '').slice(-8);
    const leadSummary = lead.summary || td('xray.emptySummary', { id: leadShortId || '—' });

    const timelineHtml = isExpanded ? `
      <div class="env-history-timeline">
        ${env.events.map(ev => {
          const c = stateColor(ev.state, ev.isLive);
          const ts = formatEnvelopeClock(ev.updatedAt || ev.createdAt);
          const age = ageLabel(ev.updatedAt || ev.createdAt);
          const sid = String(ev.id || '').slice(-8);
          return `
            <div class="env-history-row">
              <div class="env-history-row-head">
                <span style="color:#e2e8f0; font-weight:700;">${escapeHtml(shortSeat(ev.from))} ▶ ${escapeHtml(shortSeat(ev.to))}</span>
                <span style="display:flex; align-items:center; gap:5px;">
                  <span style="color:${c}; font-weight:700;">${ev.isLive ? '● ' : ''}${escapeHtml(ev.state)}</span>
                  ${ts ? `<span style="color:#94a3b8;">${escapeHtml(ts)}${age ? ` · ${escapeHtml(age)}` : ''}</span>` : ''}
                  ${ev.id ? `<button type="button" class="env-copy-btn" title="rig queue show ${escapeHtml(ev.id)} --full" data-cmd="${escapeHtml('rig queue show ' + ev.id + ' --full')}" onclick="event.stopPropagation(); copyCmd(this.getAttribute('data-cmd'))">${CMD_COPY_LABEL_HTML}</button>` : ''}
                </span>
              </div>
              <div style="font-size:11px; color:#cbd5e1; line-height:1.35;">${escapeHtml(ev.summary || td('xray.emptySummary', { id: sid || '—' })).slice(0, 260)}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    return `
      <div class="insp-stat" style="padding:8px 10px; margin-top:7px; border-left:3px solid ${stateColor(lead.state, env.hasLive)};${hasHistory ? ' cursor:pointer;' : ''}"${hasHistory ? ` data-env-key="${escapeHtml(env.key)}" onclick="event.stopPropagation(); toggleXrayEnvelope(this.getAttribute('data-env-key'))" title="${escapeHtml(td('xray.historyHint'))}"` : ''}>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; font-family:var(--font-mono); font-size:10.5px; font-weight:700; flex-wrap:wrap;">
          <span style="color:var(--cyan);">${escapeHtml(shortSeat(lead.from))} ▶ ${escapeHtml(shortSeat(lead.to))}</span>
          <span style="display:flex; align-items:center; gap:5px;">
            <span style="color:${stateColor(lead.state, env.hasLive)};">${env.hasLive ? '🟢 ' : ''}${escapeHtml(lead.state)}</span>
            ${leadTs ? `<span style="color:#94a3b8; font-weight:500;">${escapeHtml(leadTs)}${leadAge ? ` · ${escapeHtml(leadAge)}` : ''}</span>` : ''}
          </span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-top:4px; flex-wrap:wrap;">
          <span style="font-family:var(--font-mono); font-size:10.5px; color:#fcd34d;">
            ${env.slice ? `🏷️ ${escapeHtml(env.slice)}` : `📨 #${escapeHtml(leadShortId || 'qitem')}`}
          </span>
          <span style="display:flex; align-items:center; gap:5px;">
            ${hasHistory ? `<span class="env-history-toggle ${isExpanded ? 'open' : ''}">📜 ${td('xray.eventsCount', { n: env.events.length })} ${isExpanded ? '▴' : '▾'}</span>` : ''}
            ${lead.id ? `<button type="button" class="env-copy-btn" style="border-color:rgba(56,189,248,0.48); color:#7dd3fc;" title="${escapeHtml(td('ctx.openTip'))}" data-qid="${escapeHtml(lead.id)}" onclick="event.stopPropagation(); openQueueItemContext(this.getAttribute('data-qid'))">${escapeHtml(td('ctx.openBtn'))}</button>` : ''}
            ${lead.id ? `<button type="button" class="env-copy-btn" title="rig queue show ${escapeHtml(lead.id)} --full" data-cmd="${escapeHtml('rig queue show ' + lead.id + ' --full')}" onclick="event.stopPropagation(); copyCmd(this.getAttribute('data-cmd'))">${CMD_COPY_LABEL_HTML}</button>` : ''}
          </span>
        </div>
        ${renderContextBadgesHtml(lead)}
        <div style="font-size:11.5px; color:#cbd5e1; line-height:1.38; margin-top:4px;">${escapeHtml(leadSummary).slice(0, 320)}</div>
        ${timelineHtml}
      </div>
    `;
  }).join('');

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; font-family:var(--font-mono); font-size:12px; font-weight:800; color:#fff; gap:8px;">
      <span>${td('xray.title')}</span>
      <span style="display:flex; align-items:center; gap:6px;">
        <button type="button" class="widget-hint" data-hint-key="hint.xray" aria-label="Info">?</button>
        <button class="action-pill" onclick="closeEdgeXray()">✕</button>
      </span>
    </div>
    <div style="font-family:var(--font-mono); font-size:11px; color:#94a3b8; margin-top:3px;">
      ${escapeHtml(shortSeat(edge.from))} ⇄ ${escapeHtml(shortSeat(edge.to))} • ${td('xray.totalCalls')} <b style="color:#00ff9d">${edge.calls || 0}</b>
    </div>
    ${envelopes.length ? cardsHtml : `<div style="font-size:11.5px; color:#94a3b8; margin-top:6px;">${td('xray.noHistory')}</div>`}
  `;
}
