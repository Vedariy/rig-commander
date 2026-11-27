import { ganttChainColor, ganttRoleRank } from '../domain/gantt-model.js';
import { getContextThermal, computeBurn } from '../domain/thermal.js';
import { CONTEXT_WARN_PCT, CONTEXT_CRIT_PCT } from './actions.js';

const AGENT_ROLE_RE = /(check|qa|coder|owner|operator|senior|arch|lead)/i;

/**
 * Single source of truth for which daemon nodes belong in the operational topology.
 */
export function shouldIncludeLiveNode(liveNode) {
  if (!liveNode || !liveNode.canonicalSessionName) return false;
  const id = liveNode.canonicalSessionName;
  if (id.includes('operator-human') || id.includes('queue-worker')) return false;
  if (id.includes('@kernel') && id !== 'operator-agent@kernel') return false;
  if (
    liveNode.nodeKind === 'infrastructure' &&
    !liveNode.modelObservation?.model &&
    !liveNode.model &&
    !AGENT_ROLE_RE.test(id)
  ) {
    return false;
  }
  return true;
}

/**
 * Maintains a rolling context-usage history per seat, resetting on a compaction drop (>5%).
 */
export function updateContextHistory(prevHistory, ctxPct, nowMs = Date.now()) {
  const history = Array.isArray(prevHistory) ? prevHistory.slice() : [];
  if (typeof ctxPct !== 'number' || !Number.isFinite(ctxPct)) return history;
  const last = history[history.length - 1];
  if (last && ctxPct < last.pct - 5) {
    return [{ t: nowMs, pct: ctxPct }];
  }
  if (!last || last.pct !== ctxPct || nowMs - last.t > 60_000) {
    history.push({ t: nowMs, pct: ctxPct });
    if (history.length > 120) history.shift();
  }
  return history;
}

/**
 * Classifies a live daemon node + parked metadata into the canonical 5-state FSM.
 */
export function classifySeatOperationalState(liveNode, parkedData, ctxPct) {
  const actState = (liveNode && liveNode.activityState) || {};
  const needsInputCount = (actState.needsInput && actState.needsInput.count) || 0;
  const needsInputReason = (actState.needsInput && actState.needsInput.reason) || '';
  const dispState =
    actState.display ||
    (liveNode && liveNode.agentActivity && liveNode.agentActivity.state) ||
    'idle';
  const assignedWorkCount = (liveNode && liveNode.assignedWorkCount) || 0;
  const isTerminalBlocked = needsInputCount > 0 || dispState === 'needs-input';
  const isParked = Boolean(parkedData && parkedData.parked);

  let state = 'idle';
  let operationalState = 'idle';
  let activityLabel = liveNode && liveNode.needsAttention ? '🔵 IDLE (ATTN)' : '🔵 IDLE';
  let parkedReason = '';

  if (isTerminalBlocked) {
    state = 'urgent';
    operationalState = 'urgent';
    activityLabel = `🚨 NEEDS INPUT${needsInputReason ? ` (${needsInputReason})` : ''}`;
  } else if (dispState === 'working' || dispState === 'running') {
    state = 'working';
    operationalState = 'working';
    activityLabel = `🟢 WORKING (${assignedWorkCount})`;
  } else if (isParked) {
    state = 'waiting';
    operationalState = 'parked';
    activityLabel = `🟠 PARKED (${(parkedData.openCount || 0) + (parkedData.heldCount || 0)})`;
    parkedReason = parkedData.reason || '';
  } else if (parkedData && parkedData.heldCount > 0 && parkedData.unhealthyHeldCount === 0) {
    state = 'idle';
    operationalState = 'idle';
    activityLabel = `⏳ HELD (${parkedData.heldCount} с wake)`;
    parkedReason = parkedData.reason || '';
  } else if (assignedWorkCount > 0) {
    state = 'waiting';
    operationalState = 'waiting';
    activityLabel = `🟠 ЗАДАЧИ (${assignedWorkCount})`;
  }

  const isReadOnlyTranscript = liveNode.hasLivePane === false || liveNode.readOnlyTranscript === true || /\(JSONL\)$/i.test(String(liveNode.resolvedSpecName || ''));
  const isHotCtx = !isReadOnlyTranscript && typeof ctxPct === 'number' && ctxPct >= CONTEXT_CRIT_PCT;
  const isAttentionRequired = Boolean(state === 'urgent' || isParked || isHotCtx);
  const isCalmVisible = Boolean(isAttentionRequired || state === 'working');

  return {
    state,
    operationalState,
    activityLabel,
    needsInputCount,
    needsInputReason,
    isParked,
    parkedReason,
    isAttentionRequired,
    isCalmVisible
  };
}

function resolveDisplayModel(liveNode) {
  if (liveNode.modelObservation && liveNode.modelObservation.model) {
    const eff = liveNode.effort ? ` (${liveNode.effort}*)` : '';
    return `${liveNode.modelObservation.model}${eff}`;
  }
  if (Array.isArray(liveNode.modelObservation) && liveNode.modelObservation[0]) {
    return liveNode.modelObservation[0];
  }
  if (liveNode.model) return liveNode.model;
  if (liveNode.runtime === 'terminal') return 'terminal';
  return liveNode.runtime === 'codex' ? 'gpt-6.1-sol' : 'gpt-6.1';
}

/**
 * Builds the canonical Operational Ontology snapshot (Objects + Links + Situations)
 * from a raw /api/telemetry response and optional previous snapshot.
 */
export function buildOntologySnapshot(rawTelemetry, prevSnapshot = null, nowMs = Date.now()) {
  const data = rawTelemetry && typeof rawTelemetry === 'object' ? rawTelemetry : {};
  const rawRigs = Array.isArray(data.availableRigs) ? data.availableRigs : [];
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
  const activeQueue = Array.isArray(data.activeQueue) ? data.activeQueue : [];
  const ganttItems = Array.isArray(data.history && data.history.ganttItems) ? data.history.ganttItems : [];
  const nodeTraffic = (data.history && data.history.nodeTraffic) || {};
  const parkedSeats = data.parkedSeats || {};
  const seatCompactions = data.seatCompactions || {};
  const seatGuidance = data.seatGuidance || {};
  const seatUsage = data.seatUsage || {};
  const gitRadar = data.gitRadar || null;
  const gitBySeatId = (gitRadar && gitRadar.bySeatId) || {};
  const intelligence = data.intelligence || null;

  const hasLiveDaemonData = rawNodes.length > 0 || rawRigs.length > 0;

  // 1. Rigs
  const rigs = rawRigs.map(r => ({
    rigId: r.id || r.rigId || r.name,
    name: r.name || r.rigName || r.id,
    status: r.status || 'unknown',
    nodeCount: r.nodeCount || 0,
    runningCount: r.runningCount || 0,
    activeCount: r.activeCount || 0,
    hasWorkCount: r.hasWorkCount || 0
  }));
  const rigsById = Object.fromEntries(rigs.map(r => [r.rigId, r]));

  // 2. Seats & OccupantSessions
  const seats = [];
  const seatsById = {};
  const sessionsBySeatId = {};

  for (const liveNode of rawNodes) {
    if (!shouldIncludeLiveNode(liveNode)) continue;
    const seatId = liveNode.canonicalSessionName;
    const cu = liveNode.contextUsage || null;
    const ctxPct = cu && typeof cu.usedPercentage === 'number' ? cu.usedPercentage : null;
    const ctxWindowSize = (cu && cu.contextWindowSize) || 475000;
    const ctxUsedTokens = cu ? (cu.usedTokens || cu.totalInputTokens || null) : null;
    const parkedData = parkedSeats[seatId] || null;
    const fsm = classifySeatOperationalState(liveNode, parkedData, ctxPct);

    const prevSession = prevSnapshot && prevSnapshot.sessionsBySeatId && prevSnapshot.sessionsBySeatId[seatId];
    const ctxHistory = updateContextHistory(prevSession && prevSession.ctxHistory, ctxPct, nowMs);
    const burn = computeBurn({ ctxHistory });
    const thermal = getContextThermal(ctxPct, ctxWindowSize);
    const traffic = nodeTraffic[seatId] || { in: 0, out: 0 };
    const comp = seatCompactions[seatId] || {};
    const usage = seatUsage[seatId] || null;
    const model = resolveDisplayModel(liveNode);

    const seat = {
      seatId,
      rigId: liveNode.rigId || seatId.split('@')[1] || '',
      shortName: seatId.replace('@core-platform', '').replace('@kernel', ' (kernel)'),
      roleRank: ganttRoleRank(seatId),
      harness: liveNode.runtime || 'codex',
      state: fsm.state,
      operationalState: fsm.operationalState,
      activityLabel: fsm.activityLabel,
      needsInputCount: fsm.needsInputCount,
      needsInputReason: fsm.needsInputReason,
      isParked: fsm.isParked,
      parkedReason: fsm.parkedReason,
      parkedData,
      shellExited: Boolean(liveNode && liveNode.shellExited),
      hasLivePane: liveNode.hasLivePane !== false && liveNode.readOnlyTranscript !== true && !/\(JSONL\)$/i.test(String(liveNode.resolvedSpecName || '')),
      isAttentionRequired: fsm.isAttentionRequired,
      isCalmVisible: fsm.isCalmVisible,
      assignedWorkCount: liveNode.assignedWorkCount || 0,
      inProgressWorkCount: liveNode.inProgressWorkCount || 0,
      pendingWorkCount: liveNode.pendingWorkCount || 0,
      callsIn: traffic.in || 0,
      callsOut: traffic.out || 0,
      lastActivityAt: liveNode.lastActivityAt || null,
      tmuxAttachCommand: liveNode.tmuxAttachCommand || null,
      capabilities: liveNode.capabilities || null,
      swarmMeta: liveNode.swarmMeta || null,
      providerKind: liveNode.providerKind || null,
      schemaDrift: Boolean(liveNode.schemaDrift),
      providerDrift: liveNode.providerDrift || null,
      cwd: liveNode.cwd ? liveNode.cwd.split('/').pop() : 'core-platform',
      guidance: seatGuidance[seatId] || null,
      git: gitBySeatId[seatId] || null
    };

    const session = {
      sessionKey: (cu && cu.transcriptPath) || `${seatId}:live`,
      seatId,
      model,
      effort: liveNode.effort || null,
      ctxPct,
      ctxWindowSize,
      ctxUsedTokens,
      ctxSource: (cu && cu.source) || null,
      ctxSampledAt: (cu && cu.sampledAt) || null,
      ctxHistory,
      thermal,
      burn,
      compactionsCount: comp.compactionsCount || 0,
      recapSnippet: comp.recapSnippet || '',
      recapText: comp.recapText || '',
      lastSwapAt: (liveNode.activityState && liveNode.activityState.lastSwap && liveNode.activityState.lastSwap.at) || null,
      usage
    };

    seats.push(seat);
    seatsById[seatId] = seat;
    sessionsBySeatId[seatId] = session;
  }

  seats.sort((a, b) => a.roleRank - b.roleRank || a.seatId.localeCompare(b.seatId));

  // 3. WorkChains & QueueObligations
  const chainsById = {};
  const obligations = ganttItems.map(it => {
    const chainId = it.chain || (it.slice ? `slice:${it.slice}` : `q:${it.id}`);
    if (!chainsById[chainId]) {
      chainsById[chainId] = {
        chainId,
        sliceName: it.slice || '',
        colorToken: ganttChainColor(chainId),
        obligationIds: [],
        participantSeatIds: new Set(),
        qaRounds: 0,
        hasExcessiveRework: false
      };
    }
    const chain = chainsById[chainId];
    chain.obligationIds.push(it.id);
    if (it.from) chain.participantSeatIds.add(it.from);
    if (it.to) chain.participantSeatIds.add(it.to);
    if (it.to && /check|qa/i.test(it.to)) chain.qaRounds += 1;
    chain.hasExcessiveRework = chain.qaRounds > 2;
    return {
      qitemId: it.id,
      chainId,
      slice: it.slice || '',
      fromSeatId: it.from || '',
      toSeatId: it.to || '',
      state: it.state || 'done',
      summary: it.summary || '',
      createdAt: it.createdAt || null,
      claimedAt: it.claimedAt || null,
      endAt: it.endAt || null,
      isOpen: !it.endAt
    };
  });

  for (const chain of Object.values(chainsById)) {
    chain.participantSeatIds = Array.from(chain.participantSeatIds);
  }

  const openObligations = activeQueue.map(q => {
    const sliceTag = ((q.tags || []).find(t => typeof t === 'string' && t.startsWith('slice:')) || '').replace('slice:', '');
    return {
      qitemId: q.qitemId || q.id || '',
      chainId: sliceTag ? `slice:${sliceTag}` : `q:${q.qitemId || q.id || ''}`,
      slice: sliceTag,
      fromSeatId: q.sourceSession || '',
      toSeatId: q.destinationSession || '',
      state: q.state || 'pending',
      summary: q.summary || '',
      createdAt: q.tsCreated || q.createdAt || null,
      claimedAt: q.claimedAt || null,
      endAt: null,
      isOpen: true
    };
  });

  // 4. Unified Situations (P0-P3)
  const situations = [];
  for (const seat of seats) {
    const sess = sessionsBySeatId[seat.seatId];
    if (seat.operationalState === 'urgent') {
      situations.push({
        situationId: `hitl:${seat.seatId}`,
        severity: 'P0',
        category: 'hitl',
        targetSeatId: seat.seatId,
        title: `${seat.shortName}: ждёт человека`,
        reason: seat.needsInputReason || 'Остановлен на подтверждении в терминале'
      });
    }
    if (seat.isParked) {
      situations.push({
        situationId: `parked:${seat.seatId}`,
        severity: 'P1',
        category: 'topology',
        targetSeatId: seat.seatId,
        title: `${seat.shortName}: запаркован`,
        reason: seat.parkedReason || 'Обязательства без live wake'
      });
    }
    if (seat.hasLivePane !== false && sess && typeof sess.ctxPct === 'number' && sess.ctxPct >= CONTEXT_WARN_PCT) {
      situations.push({
        situationId: `ctx:${seat.seatId}`,
        severity: sess.ctxPct >= CONTEXT_CRIT_PCT ? 'P1' : 'P2',
        category: 'context',
        targetSeatId: seat.seatId,
        title: `${seat.shortName}: CTX ${sess.ctxPct}%`,
        reason: sess.burn.label
      });
    }
  }

  if (intelligence && Array.isArray(intelligence.allFindings)) {
    for (const f of intelligence.allFindings) {
      const targetSeatId = (f.actionPlan && f.actionPlan.seatTarget) || (f.metrics && f.metrics.affectedSeats && f.metrics.affectedSeats[0]) || null;
      const sevMap = { p0_urgent: 'P0', p1_high: 'P1', p2_medium: 'P2', p3_info: 'P3' };
      situations.push({
        situationId: `finding:${f.detectorId}:${targetSeatId || 'fleet'}`,
        severity: sevMap[f.severity] || 'P3',
        category: f.category || 'topology',
        targetSeatId,
        title: f.title || f.detectorId,
        reason: f.summary || ''
      });
    }
  }

  const sevRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  situations.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));

  return {
    timestamp: data.timestamp || new Date(nowMs).toISOString(),
    requestedRig: data.requestedRig || 'all',
    hasLiveDaemonData,
    rigs,
    rigsById,
    seats,
    seatsById,
    sessionsBySeatId,
    chainsById,
    obligations,
    openObligations,
    situations,
    actionRecords: Array.isArray(data.actionAudit) ? data.actionAudit : [],
    fleetUsageSummary: data.fleetUsageSummary || null,
    gitRadar,
    intelligence
  };
}

/**
 * Pure selector: returns recent operator ActionRecords for a seat (newest first).
 */
export function getActionRecordsForSeat(snapshot, seatId, limit = 5) {
  if (!snapshot || !seatId || !Array.isArray(snapshot.actionRecords)) return [];
  return snapshot.actionRecords
    .filter(r => r && r.targetSeatId === seatId)
    .slice(0, Math.max(1, limit));
}

const MODEL_POOL_SPECS = [
  { id: 'codex-gpt', name: '🟣 CODEX / GPT', color: '#a855f7' },
  { id: 'claude', name: '🟠 CLAUDE (Anthropic)', color: '#f59e0b' },
  { id: 'fast-open', name: '🟢 GLM / DEEPSEEK', color: '#00ff9d' },
  { id: 'terminal-agy', name: '🔵 TERMINAL / AGY', color: '#00f0ff' },
  { id: 'other', name: '🌐 OTHER MODELS', color: '#38bdf8' }
];

/**
 * Exclusive model-first pool classifier: every seat belongs to exactly one pool.
 * Model name always wins over harness (e.g. glm-5.3-flash running in claude-code -> fast-open).
 */
export function classifyModelPool(seat) {
  const model = String((seat && seat.model) || '').toLowerCase();
  const harness = String((seat && seat.harness) || '').toLowerCase();

  if (/glm|deepseek|qwen/i.test(model)) return 'fast-open';
  if (/claude|sonnet|opus|haiku/i.test(model)) return 'claude';
  if (/gpt|sol|terra|codex|\bo[134]\b/i.test(model)) return 'codex-gpt';
  if (/gemini|argon/i.test(model)) return 'terminal-agy';

  if (harness === 'pi') return 'fast-open';
  if (harness.includes('claude')) return 'claude';
  if (harness === 'codex') return 'codex-gpt';
  if (harness === 'terminal' || harness.includes('agy')) return 'terminal-agy';
  return 'other';
}

/**
 * Aggregates exclusive model pools scoped by rigFilter, including peak/avg CTX and session spend.
 */
export function computeModelPools(agents = [], rigFilter = 'all') {
  const scoped = (Array.isArray(agents) ? agents : []).filter(a => {
    if (!a || !a.id) return false;
    return !rigFilter || rigFilter === 'all' || String(a.id).endsWith('@' + rigFilter);
  });

  const buckets = new Map(MODEL_POOL_SPECS.map(spec => [spec.id, []]));
  for (const a of scoped) {
    const poolId = classifyModelPool(a);
    buckets.get(poolId).push(a);
  }

  const pools = [];
  for (const spec of MODEL_POOL_SPECS) {
    const matching = buckets.get(spec.id);
    if (!matching || matching.length === 0) continue;

    const activeCount = matching.filter(a => a.state === 'working').length;
    const validCtx = matching.map(a => a.ctxPct).filter(c => typeof c === 'number' && Number.isFinite(c));
    const hasValidCtx = validCtx.length > 0;
    const peakCtx = hasValidCtx ? Math.max(...validCtx) : null;
    const avgCtx = hasValidCtx ? Math.round(validCtx.reduce((sum, v) => sum + v, 0) / validCtx.length) : null;
    const isOver = hasValidCtx && peakCtx >= CONTEXT_CRIT_PCT;

    let totalTokens = 0;
    let totalUsd = 0;
    for (const a of matching) {
      if (a.usage && typeof a.usage.totalTokens === 'number') {
        totalTokens += a.usage.totalTokens;
        totalUsd += Number(a.usage.estUsd) || 0;
      }
    }

    const seatText = matching.length === 1 ? '1 SEAT' : `${matching.length} SEATS`;
    pools.push({
      ...spec,
      seatCount: matching.length,
      activeCount,
      hasValidCtx,
      peakCtx,
      avgCtx,
      isOver,
      hasUsage: totalTokens > 0,
      totalTokens,
      totalEstUsd: Number(totalUsd.toFixed(2)),
      seatNames: matching.map(a => a.shortName || a.id),
      statusLabel: activeCount > 0 ? `${activeCount}/${matching.length} ACTIVE` : seatText
    });
  }
  return pools;
}

/**
 * Pure selector: returns the primary active (in-progress preferred over pending) obligation for a seat.
 */
export function getSeatActiveObligation(snapshot, seatId) {
  if (!snapshot || !seatId || !Array.isArray(snapshot.openObligations)) return null;
  const mine = snapshot.openObligations.filter(
    o => o.toSeatId === seatId && (o.state === 'in-progress' || o.state === 'pending' || o.state === 'claimed')
  );
  if (mine.length === 0) return null;
  mine.sort((a, b) => (a.state === 'in-progress' ? -1 : 1) - (b.state === 'in-progress' ? -1 : 1));
  return { primary: mine[0], totalCount: mine.length };
}

/**
 * Pure selector: returns active situations targeting a given seat, sorted by severity.
 */
export function getSituationsForSeat(snapshot, seatId) {
  if (!snapshot || !seatId || !Array.isArray(snapshot.situations)) return [];
  return snapshot.situations.filter(s => s.targetSeatId === seatId);
}

/**
 * Pure selector: returns per-seat session usage rows sorted by estimated USD descending.
 */
export function getFleetBudgetRows(snapshot) {
  if (!snapshot || !snapshot.sessionsBySeatId) return [];
  const rows = [];
  for (const [seatId, sess] of Object.entries(snapshot.sessionsBySeatId)) {
    if (sess && sess.usage && sess.usage.totalTokens > 0) {
      rows.push({ seatId, ...sess.usage });
    }
  }
  rows.sort((a, b) => (b.estUsd || 0) - (a.estUsd || 0));
  return rows;
}
