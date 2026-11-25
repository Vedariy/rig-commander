/**
 * Pure zero-DOM domain module for Shift Catch-Up / Overnight Digest
 * and telemetry state-transition diffing (ADR-0014).
 *
 * Works identically in Node.js (server.mjs / tests) and browser ES modules (offline demo).
 */

export const SHIFT_DIGEST_WINDOWS_H = Object.freeze([1, 4, 8, 24]);
export const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
export const CHECKPOINT_SPEND_DELTA_USD = 0.25;
export const CTX_WARN_THRESHOLD = 75;
export const CTX_CRIT_THRESHOLD = 85;
export const CTX_COMPACT_DROP_PCT = 15;

function toMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (!val) return 0;
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortSeatLabel(seatId) {
  const s = String(seatId || '').trim();
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

function rigFromSeat(seatId) {
  const s = String(seatId || '').trim();
  const at = s.indexOf('@');
  return at > 0 ? s.slice(at + 1) : '';
}

function matchesRigFilter(rigFilter, rigId, seatId) {
  if (!rigFilter || rigFilter === 'all') return true;
  if (rigId && rigId !== 'all' && rigId === rigFilter) return true;
  if (seatId && rigFromSeat(seatId) === rigFilter) return true;
  return false;
}

function extractNodeSummary(node, parkedSeats = {}) {
  const seatId = (node && (node.canonicalSessionName || node.logicalId || node.id)) || '';
  if (!seatId) return null;
  const rigId = (node && node.rigId) || rigFromSeat(seatId) || 'default';
  const act = (node && node.activityState) || {};
  const display = act.display || (node && node.agentActivity && node.agentActivity.state) || (node && node.state) || 'idle';
  const needsInputCount = Number((act.needsInput && act.needsInput.count) || (node && node.needsInputCount) || 0);
  const needsInputReason = String((act.needsInput && act.needsInput.reason) || (node && node.needsInputReason) || '').slice(0, 140);
  const shellExited = Boolean((act && act.shellExited) || (node && node.shellExited));
  const parkedObj = (parkedSeats && parkedSeats[seatId]) || (node && node.parkedData) || null;
  const parked = Boolean(parkedObj && parkedObj.parked);
  const parkedReason = String((parkedObj && parkedObj.reason) || (node && node.parkedReason) || '').slice(0, 120);
  const cu = (node && node.contextUsage) || null;
  const ctxPct = cu && typeof cu.usedPercentage === 'number'
    ? Math.round(cu.usedPercentage)
    : (typeof node.ctxPct === 'number' ? Math.round(node.ctxPct) : null);
  const assignedWorkCount = Number(
    (node && node.workState && node.workState.assignedCount) ||
    (node && node.assignedWorkCount) ||
    0
  );

  let normState = 'idle';
  if (shellExited) normState = 'shell_exited';
  else if (display === 'needs-input' || display === 'urgent' || needsInputCount > 0) normState = 'needs_input';
  else if (parked) normState = 'parked';
  else if (display === 'working' || display === 'running') normState = 'working';

  return {
    seatId,
    rigId,
    normState,
    display,
    needsInputCount,
    needsInputReason,
    shellExited,
    parked,
    parkedReason,
    ctxPct,
    assignedWorkCount
  };
}

/**
 * Compares previous compact snapshot state against the latest telemetry payload
 * and emits only meaningful edge-triggered transition events (+ periodic checkpoint).
 */
export function diffTelemetrySnapshots(prevState, payload, nowMs = Date.now()) {
  const tsIso = new Date(nowMs).toISOString();
  const nodes = Array.isArray(payload && payload.nodes) ? payload.nodes : [];
  const parkedSeats = (payload && payload.parkedSeats) || {};
  const gitRadar = (payload && payload.gitRadar) || null;
  const intelligence = (payload && payload.intelligence) || null;
  const usageSummary = (payload && payload.fleetUsageSummary) || {};
  const activeQueue = Array.isArray(payload && payload.activeQueue) ? payload.activeQueue : [];

  const nextSeats = {};
  const events = [];

  for (const rawNode of nodes) {
    const cur = extractNodeSummary(rawNode, parkedSeats);
    if (!cur) continue;
    nextSeats[cur.seatId] = cur;

    const prev = prevState && prevState.seats ? prevState.seats[cur.seatId] : null;
    if (!prev) continue;

    // 1. Seat state transitions
    if (prev.normState !== cur.normState) {
      if (cur.normState === 'shell_exited') {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'seat_state',
          severity: 'critical',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `state:${cur.seatId}:shell_exited`,
          title: `${shortSeatLabel(cur.seatId)} exited to OS shell`,
          detail: 'Agent process terminated; restart required.',
          meta: { from: prev.normState, to: cur.normState }
        });
      } else if (cur.normState === 'needs_input') {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'seat_state',
          severity: 'critical',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `state:${cur.seatId}:needs_input`,
          title: `${shortSeatLabel(cur.seatId)} waiting for human (HITL)`,
          detail: cur.needsInputReason || 'Stopped at terminal confirmation prompt.',
          meta: { from: prev.normState, to: cur.normState, needsInputCount: cur.needsInputCount }
        });
      } else if (prev.normState === 'needs_input') {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'seat_state',
          severity: 'success',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `state:${cur.seatId}:hitl_cleared`,
          title: `${shortSeatLabel(cur.seatId)} resumed from HITL`,
          detail: `State: ${cur.normState}`,
          meta: { from: prev.normState, to: cur.normState }
        });
      } else if (cur.normState === 'parked') {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'seat_state',
          severity: cur.assignedWorkCount > 0 ? 'warn' : 'info',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `state:${cur.seatId}:parked`,
          title: `${shortSeatLabel(cur.seatId)} parked`,
          detail: cur.parkedReason || (cur.assignedWorkCount > 0 ? `${cur.assignedWorkCount} open obligations` : 'No active wake timer'),
          meta: { from: prev.normState, to: cur.normState, assignedWorkCount: cur.assignedWorkCount }
        });
      } else if (prev.normState === 'parked' && cur.normState === 'working') {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'seat_state',
          severity: 'success',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `state:${cur.seatId}:unparked`,
          title: `${shortSeatLabel(cur.seatId)} unparked & resumed work`,
          detail: 'Active execution resumed.',
          meta: { from: prev.normState, to: cur.normState }
        });
      }
    }

    // 2. Context window threshold crossings & compactions
    if (typeof prev.ctxPct === 'number' && typeof cur.ctxPct === 'number') {
      if (prev.ctxPct < CTX_CRIT_THRESHOLD && cur.ctxPct >= CTX_CRIT_THRESHOLD) {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'ctx_event',
          severity: 'critical',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `ctx:${cur.seatId}:crit`,
          title: `${shortSeatLabel(cur.seatId)} context critical (${cur.ctxPct}%)`,
          detail: `Crossed ${CTX_CRIT_THRESHOLD}% threshold (${prev.ctxPct}% -> ${cur.ctxPct}%).`,
          meta: { fromPct: prev.ctxPct, toPct: cur.ctxPct, eventType: 'overheat' }
        });
      } else if (prev.ctxPct < CTX_WARN_THRESHOLD && cur.ctxPct >= CTX_WARN_THRESHOLD) {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'ctx_event',
          severity: 'warn',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `ctx:${cur.seatId}:warn`,
          title: `${shortSeatLabel(cur.seatId)} context reached ${cur.ctxPct}%`,
          detail: `Recommend /compact soon (${prev.ctxPct}% -> ${cur.ctxPct}%).`,
          meta: { fromPct: prev.ctxPct, toPct: cur.ctxPct, eventType: 'warn' }
        });
      } else if (prev.ctxPct - cur.ctxPct >= CTX_COMPACT_DROP_PCT) {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'ctx_event',
          severity: 'success',
          rigId: cur.rigId,
          seatId: cur.seatId,
          key: `ctx:${cur.seatId}:compact`,
          title: `${shortSeatLabel(cur.seatId)} context compacted (${prev.ctxPct}% → ${cur.ctxPct}%)`,
          detail: `Reclaimed ${prev.ctxPct - cur.ctxPct}% context window.`,
          meta: { fromPct: prev.ctxPct, toPct: cur.ctxPct, eventType: 'compacted' }
        });
      }
    }
  }

  // 3. Git Worktree / Conflict transitions
  const nextConflictKeys = {};
  const nextUnmergedKeys = {};
  if (gitRadar && Array.isArray(gitRadar.conflicts)) {
    for (const c of gitRadar.conflicts) {
      const ck = `${c.repoKey || c.repoLabel || 'repo'}::${c.filePath}`;
      const primarySeat = (c.workspaces && c.workspaces[0] && c.workspaces[0].seatIds && c.workspaces[0].seatIds[0]) || null;
      nextConflictKeys[ck] = {
        filePath: c.filePath,
        severity: c.severity || 'medium',
        seatId: primarySeat,
        rigId: rigFromSeat(primarySeat) || 'all',
        dirs: (c.workspaces || []).map(w => w.dirName).filter(Boolean)
      };
    }
  }
  if (gitRadar && Array.isArray(gitRadar.unmergedWorkspaces)) {
    for (const u of gitRadar.unmergedWorkspaces) {
      const uk = u.workspaceId || u.dirName;
      const primarySeat = (u.seatIds && u.seatIds[0]) || null;
      nextUnmergedKeys[uk] = {
        dirName: u.dirName,
        unmergedCount: u.unmergedCount || 1,
        seatId: primarySeat,
        rigId: rigFromSeat(primarySeat) || 'all'
      };
    }
  }

  if (prevState) {
    const prevConflicts = prevState.gitConflicts || {};
    for (const [ck, info] of Object.entries(nextConflictKeys)) {
      if (!prevConflicts[ck]) {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'git_alert',
          severity: info.severity === 'high' ? 'critical' : 'warn',
          rigId: info.rigId,
          seatId: info.seatId,
          key: `git:overlap:${ck}`,
          title: `Cross-worktree overlap: ${info.filePath}`,
          detail: `Edited in parallel across ${info.dirs.join(' vs ')}.`,
          meta: { filePath: info.filePath, dirs: info.dirs, alertType: 'overlap' }
        });
      }
    }
    for (const [ck, oldInfo] of Object.entries(prevConflicts)) {
      if (!nextConflictKeys[ck]) {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'git_alert',
          severity: 'success',
          rigId: oldInfo.rigId,
          seatId: oldInfo.seatId,
          key: `git:overlap_cleared:${ck}`,
          title: `Worktree overlap resolved: ${oldInfo.filePath}`,
          detail: 'File is no longer modified concurrently.',
          meta: { filePath: oldInfo.filePath, alertType: 'overlap_cleared' }
        });
      }
    }

    const prevUnmerged = prevState.gitUnmerged || {};
    for (const [uk, info] of Object.entries(nextUnmergedKeys)) {
      if (!prevUnmerged[uk]) {
        events.push({
          ts: tsIso,
          tsMs: nowMs,
          kind: 'git_alert',
          severity: 'critical',
          rigId: info.rigId,
          seatId: info.seatId,
          key: `git:unmerged:${uk}`,
          title: `Unmerged conflict in ${info.dirName} (${info.unmergedCount})`,
          detail: 'Repository index contains unresolved merge entries.',
          meta: { dirName: info.dirName, unmergedCount: info.unmergedCount, alertType: 'unmerged' }
        });
      }
    }
  }

  // 4. Periodic telemetry checkpoint (for spend/token/health deltas across windows)
  const seatValues = Object.values(nextSeats);
  const workingCount = seatValues.filter(s => s.normState === 'working').length;
  const urgentCount = seatValues.filter(s => s.normState === 'needs_input' || s.normState === 'shell_exited').length;
  const estUsd = Number(usageSummary.totalEstUsd) || 0;
  const totalTokens = Number(usageSummary.totalTokens) || 0;
  const healthScore = intelligence && typeof intelligence.healthScore === 'number' ? intelligence.healthScore : null;

  const prevCpTs = (prevState && prevState.lastCheckpointMs) || 0;
  const prevCpUsd = (prevState && typeof prevState.lastCheckpointUsd === 'number') ? prevState.lastCheckpointUsd : estUsd;
  const needCheckpoint = !prevState ||
    (nowMs - prevCpTs >= CHECKPOINT_INTERVAL_MS) ||
    Math.abs(estUsd - prevCpUsd) >= CHECKPOINT_SPEND_DELTA_USD;

  let lastCheckpointMs = prevCpTs;
  let lastCheckpointUsd = prevCpUsd;
  if (needCheckpoint && seatValues.length > 0) {
    lastCheckpointMs = nowMs;
    lastCheckpointUsd = estUsd;
    events.push({
      ts: tsIso,
      tsMs: nowMs,
      kind: 'checkpoint',
      severity: 'info',
      rigId: (payload && payload.requestedRig) || 'all',
      seatId: null,
      key: `cp:${Math.floor(nowMs / 60000)}`,
      title: `Telemetry checkpoint`,
      detail: `working=${workingCount}, urgent=${urgentCount}, openQueue=${activeQueue.length}`,
      meta: {
        seatsCount: seatValues.length,
        workingCount,
        urgentCount,
        openQueueCount: activeQueue.length,
        estUsd: Math.round(estUsd * 100) / 100,
        totalTokens,
        healthScore,
        conflictCount: Object.keys(nextConflictKeys).length
      }
    });
  }

  return {
    events,
    nextState: {
      seats: nextSeats,
      gitConflicts: nextConflictKeys,
      gitUnmerged: nextUnmergedKeys,
      lastCheckpointMs,
      lastCheckpointUsd
    }
  };
}

/**
 * Builds the Shift Catch-Up / Overnight Digest across the chosen time window
 * by fusing persisted append-only shift events + live OpenRig history, decisions,
 * usage metrics, git worktree radar, and current unresolved blockers.
 */
export function buildShiftDigest({
  windowHours = 8,
  sinceMs = 0,
  nowMs = Date.now(),
  rigFilter = 'all',
  events = [],
  ganttItems = [],
  activeQueue = [],
  decisions = [],
  nodes = [],
  parkedSeats = {},
  seatUsage = {},
  fleetUsageSummary = {},
  gitRadar = null,
  actionAudit = [],
  intelligence = null,
  historyMeta = null
} = {}) {
  const safeHours = Math.max(0.25, Math.min(168, Number(windowHours) || 8));
  const usedSinceVisit = Boolean(sinceMs && Number.isFinite(sinceMs) && sinceMs > 0 && sinceMs < nowMs);
  const cutoffMs = usedSinceVisit ? sinceMs : (nowMs - safeHours * 3600 * 1000);
  const actualDurationMs = Math.max(60_000, nowMs - cutoffMs);

  // 1. Filter persisted events within window & rig
  const windowEvents = (Array.isArray(events) ? events : []).filter(ev => {
    if (!ev) return false;
    const t = toMs(ev.tsMs || ev.ts);
    if (t < cutoffMs || t > nowMs + 60_000) return false;
    return matchesRigFilter(rigFilter, ev.rigId, ev.seatId);
  });

  const checkpoints = windowEvents.filter(e => e.kind === 'checkpoint').sort((a, b) => toMs(a.tsMs || a.ts) - toMs(b.tsMs || b.ts));
  const nonCheckpointEvents = windowEvents.filter(e => e.kind !== 'checkpoint');

  // 2. Completed & active slices from OpenRig ganttItems inside the window
  const sliceMap = new Map();
  for (const raw of (Array.isArray(ganttItems) ? ganttItems : [])) {
    if (!raw) continue;
    const seatA = raw.from || raw.sourceSession || '';
    const seatB = raw.to || raw.destinationSession || '';
    if (rigFilter !== 'all' && !matchesRigFilter(rigFilter, raw.rigId, seatA) && !matchesRigFilter(rigFilter, raw.rigId, seatB)) {
      continue;
    }
    const endT = toMs(raw.endAt || raw.tsUpdated || raw.claimedAt || raw.createdAt);
    if (endT < cutoffMs) continue;
    const state = String(raw.state || '').toLowerCase();
    const sliceName = String(raw.slice || raw.chain || 'general').replace(/^slice:/, '').trim();
    if (!sliceName || sliceName === 'noise' || /^q:qitem-recovery-/i.test(sliceName) || /stuck-sweep|change-detector|opgate/i.test(sliceName)) continue;

    if (!sliceMap.has(sliceName)) {
      sliceMap.set(sliceName, {
        slice: sliceName,
        doneCount: 0,
        activeCount: 0,
        seats: new Set(),
        latestAtMs: 0,
        latestSummary: ''
      });
    }
    const entry = sliceMap.get(sliceName);
    if (state === 'done' || state === 'closed' || state === 'accepted' || state === 'completed') {
      entry.doneCount += 1;
    } else if (state === 'in-progress' || state === 'pending' || state === 'claimed' || state === 'open') {
      entry.activeCount += 1;
    }
    if (seatA) entry.seats.add(shortSeatLabel(seatA));
    if (seatB) entry.seats.add(shortSeatLabel(seatB));
    if (endT >= entry.latestAtMs) {
      entry.latestAtMs = endT;
      if (raw.summary) entry.latestSummary = String(raw.summary).slice(0, 140);
    }
  }

  const completedSlices = [];
  const activeSlices = [];
  for (const entry of sliceMap.values()) {
    const obj = {
      slice: entry.slice,
      doneCount: entry.doneCount,
      activeCount: entry.activeCount,
      seats: Array.from(entry.seats).slice(0, 5),
      latestAt: entry.latestAtMs ? new Date(entry.latestAtMs).toISOString() : null,
      latestSummary: entry.latestSummary
    };
    if (entry.doneCount > 0 && entry.activeCount === 0) completedSlices.push(obj);
    else if (entry.activeCount > 0) activeSlices.push(obj);
    else if (entry.doneCount > 0) completedSlices.push(obj);
  }
  completedSlices.sort((a, b) => toMs(b.latestAt) - toMs(a.latestAt));
  activeSlices.sort((a, b) => toMs(b.latestAt) - toMs(a.latestAt));

  // 3. Decisions inside the window
  const recentDecisions = (Array.isArray(decisions) ? decisions : [])
    .filter(d => {
      if (!d) return false;
      const dt = toMs(d.ts || d.timestamp || d.createdAt || d.date);
      if (dt > 0 && dt < cutoffMs) return false;
      if (rigFilter !== 'all' && d.rigId && d.rigId !== rigFilter) return false;
      return true;
    })
    .slice(0, 10)
    .map(d => ({
      id: d.id || d.decisionId || '',
      ts: d.ts || d.timestamp || d.date || '',
      title: String(d.title || d.summary || d.decision || d.subject || '').slice(0, 140),
      scope: String(d.scope || d.slice || d.rigId || '')
    }))
    .filter(d => d.title);

  // 4. Open attention items RIGHT NOW (what still requires operator action)
  const openAttentionNow = [];
  for (const rawNode of (Array.isArray(nodes) ? nodes : [])) {
    const s = extractNodeSummary(rawNode, parkedSeats);
    if (!s || !matchesRigFilter(rigFilter, s.rigId, s.seatId)) continue;
    if (s.normState === 'shell_exited') {
      openAttentionNow.push({
        severity: 'p0',
        kind: 'shell_exited',
        seatId: s.seatId,
        title: `${shortSeatLabel(s.seatId)}: agent exited to OS shell`,
        detail: 'Requires relaunch (rig seat launch --fresh --stop).',
        actionTransport: 'select_seat',
        actionPayload: ''
      });
    } else if (s.normState === 'needs_input') {
      openAttentionNow.push({
        severity: 'p0',
        kind: 'hitl',
        seatId: s.seatId,
        title: `${shortSeatLabel(s.seatId)}: waiting for HITL approval`,
        detail: s.needsInputReason || 'Interactive terminal prompt awaiting decision.',
        actionTransport: 'modal_terminal',
        actionPayload: ''
      });
    } else if (s.normState === 'parked' && s.assignedWorkCount > 0) {
      openAttentionNow.push({
        severity: 'p1',
        kind: 'parked',
        seatId: s.seatId,
        title: `${shortSeatLabel(s.seatId)}: parked with ${s.assignedWorkCount} open item(s)`,
        detail: s.parkedReason || 'Open obligations without active wake timer.',
        actionTransport: 'select_seat',
        actionPayload: ''
      });
    }
    if (typeof s.ctxPct === 'number' && s.ctxPct >= CTX_WARN_THRESHOLD) {
      openAttentionNow.push({
        severity: s.ctxPct >= CTX_CRIT_THRESHOLD ? 'p0' : 'p1',
        kind: 'hot_ctx',
        seatId: s.seatId,
        title: `${shortSeatLabel(s.seatId)}: context at ${s.ctxPct}%`,
        detail: 'Run /compact before context degradation.',
        actionTransport: 'select_seat',
        actionPayload: ''
      });
    }
  }

  if (gitRadar && Array.isArray(gitRadar.unmergedWorkspaces)) {
    for (const u of gitRadar.unmergedWorkspaces) {
      const seatId = (u.seatIds && u.seatIds[0]) || '';
      if (!matchesRigFilter(rigFilter, null, seatId)) continue;
      openAttentionNow.push({
        severity: 'p0',
        kind: 'git_unmerged',
        seatId,
        title: `${u.dirName}: ${u.unmergedCount} unmerged git conflict(s)`,
        detail: 'Unresolved merge index entries blocking clean commits.',
        actionTransport: 'git_diff',
        actionPayload: ''
      });
    }
  }
  if (gitRadar && Array.isArray(gitRadar.conflicts)) {
    for (const c of gitRadar.conflicts.slice(0, 6)) {
      const seatId = (c.workspaces && c.workspaces[0] && c.workspaces[0].seatIds && c.workspaces[0].seatIds[0]) || '';
      if (!matchesRigFilter(rigFilter, null, seatId)) continue;
      const dirs = (c.workspaces || []).map(w => w.dirName).join(' vs ');
      openAttentionNow.push({
        severity: c.severity === 'high' ? 'p1' : 'p2',
        kind: 'git_overlap',
        seatId,
        title: `Overlap on ${c.filePath}`,
        detail: `Modified across ${dirs}.`,
        actionTransport: 'git_diff',
        actionPayload: c.filePath
      });
    }
  }

  const sevRank = { p0: 0, p1: 1, p2: 2 };
  openAttentionNow.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));

  // 5. Operator actions inside the window (from ActionAuditLog + persisted operator_action events)
  const auditInWindow = (Array.isArray(actionAudit) ? actionAudit : []).filter(a => {
    if (!a) return false;
    const t = toMs(a.executedAt);
    if (t < cutoffMs) return false;
    return matchesRigFilter(rigFilter, null, a.targetSeatId);
  });
  const persistedActions = nonCheckpointEvents.filter(e => e.kind === 'operator_action');
  const seenExecIds = new Set(auditInWindow.map(a => a.execId).filter(Boolean));
  const mergedActionsCount = auditInWindow.length + persistedActions.filter(e => !(e.meta && seenExecIds.has(e.meta.execId))).length;
  const verifiedActionsCount =
    auditInWindow.filter(a => a.postconditionStatus === 'verified').length +
    persistedActions.filter(e => !(e.meta && seenExecIds.has(e.meta.execId)) && e.meta && e.meta.postconditionStatus === 'verified').length;

  // 6. Spend & token delta calculation (checkpoint delta preferred; honest 24h fallback when freshly booted)
  let spendUsd = 0;
  let totalTokens = 0;
  let spendSource = 'usage_24h';
  if (checkpoints.length >= 2) {
    const first = checkpoints[0].meta || {};
    const last = checkpoints[checkpoints.length - 1].meta || {};
    const dUsd = (Number(last.estUsd) || 0) - (Number(first.estUsd) || 0);
    const dTok = (Number(last.totalTokens) || 0) - (Number(first.totalTokens) || 0);
    if (dUsd >= 0 && dTok >= 0 && (dUsd > 0 || dTok > 0)) {
      spendUsd = Math.round(dUsd * 100) / 100;
      totalTokens = dTok;
      spendSource = 'checkpoints';
    }
  }
  if (spendSource === 'usage_24h') {
    let sumUsd = 0;
    let sumTok = 0;
    for (const [sid, u] of Object.entries(seatUsage || {})) {
      if (!u || !matchesRigFilter(rigFilter, null, sid)) continue;
      const win = (u.windows && u.windows.h24) || u;
      sumUsd += Number(win.estUsd) || 0;
      sumTok += Number(win.totalTokens) || 0;
    }
    if (sumUsd === 0 && sumTok === 0 && rigFilter === 'all' && fleetUsageSummary) {
      sumUsd = Number(fleetUsageSummary.totalEstUsd) || 0;
      sumTok = Number(fleetUsageSummary.totalTokens) || 0;
    }
    spendUsd = Math.round(sumUsd * 100) / 100;
    totalTokens = sumTok;
  }

  // 7. Merge & sort timeline (newest first, capped at 60)
  const timelineRaw = [...nonCheckpointEvents];
  for (const a of auditInWindow) {
    const alreadyPersisted = persistedActions.some(e => e.meta && e.meta.execId && e.meta.execId === a.execId);
    if (alreadyPersisted) continue;
    timelineRaw.push({
      ts: a.executedAt,
      tsMs: toMs(a.executedAt),
      kind: 'operator_action',
      severity: a.postconditionStatus === 'verified' ? 'success' : (a.postconditionStatus === 'failed' ? 'critical' : 'info'),
      rigId: rigFromSeat(a.targetSeatId) || 'all',
      seatId: a.targetSeatId,
      key: `audit:${a.execId}`,
      title: `${a.actionId} → ${shortSeatLabel(a.targetSeatId)}`,
      detail: `${a.payloadPreview || ''} (${a.postconditionStatus}: ${a.postconditionDetail || ''})`.trim(),
      meta: { execId: a.execId, postconditionStatus: a.postconditionStatus }
    });
  }
  timelineRaw.sort((a, b) => toMs(b.tsMs || b.ts) - toMs(a.tsMs || a.ts));
  const timeline = timelineRaw.slice(0, 60);

  const compactionsCount = nonCheckpointEvents.filter(e => e.kind === 'ctx_event' && e.meta && e.meta.eventType === 'compacted').length;
  const incidentsCount = nonCheckpointEvents.filter(e => e.severity === 'critical' || e.severity === 'warn').length;

  return {
    windowHours: usedSinceVisit ? Math.round((actualDurationMs / 3600000) * 10) / 10 : safeHours,
    usedSinceVisit,
    rigFilter,
    cutoffIso: new Date(cutoffMs).toISOString(),
    nowIso: new Date(nowMs).toISOString(),
    healthScore: intelligence && typeof intelligence.healthScore === 'number' ? intelligence.healthScore : null,
    kpis: {
      completedSlicesCount: completedSlices.length,
      activeSlicesCount: activeSlices.length,
      openAttentionNowCount: openAttentionNow.length,
      p0NowCount: openAttentionNow.filter(x => x.severity === 'p0').length,
      incidentsCount,
      actionsCount: mergedActionsCount,
      verifiedActionsCount,
      compactionsCount,
      decisionsCount: recentDecisions.length,
      spendUsd,
      totalTokens,
      spendSource,
      eventsCount: timeline.length,
      openQueueCount: Array.isArray(activeQueue) ? activeQueue.length : 0
    },
    openAttentionNow,
    completedSlices: completedSlices.slice(0, 12),
    activeSlices: activeSlices.slice(0, 12),
    recentDecisions,
    timeline,
    historyMeta: historyMeta || null
  };
}

/**
 * Formats a Shift Catch-Up Digest into clean standup/handoff Markdown.
 */
export function formatShiftDigestMarkdown(digest, lang = 'en') {
  if (!digest) return '';
  const ru = lang === 'ru';
  const k = digest.kpis || {};
  const lines = [];
  const winTxt = digest.usedSinceVisit
    ? (ru ? `с последнего визита (~${digest.windowHours}ч)` : `since last visit (~${digest.windowHours}h)`)
    : (ru ? `последние ${digest.windowHours}ч` : `last ${digest.windowHours}h`);

  lines.push(ru
    ? `# 🌅 Сводка смены RigCommander (${winTxt})`
    : `# 🌅 RigCommander Shift Catch-Up Digest (${winTxt})`);
  lines.push(`- ${ru ? 'Период' : 'Window'}: ${digest.cutoffIso} → ${digest.nowIso}`);
  lines.push(`- ${ru ? 'Сдано слайсов' : 'Completed slices'}: **${k.completedSlicesCount || 0}** | ${ru ? 'В работе' : 'Active'}: **${k.activeSlicesCount || 0}**`);
  lines.push(`- ${ru ? 'Требуют внимания сейчас' : 'Needs attention now'}: **${k.openAttentionNowCount || 0}** (P0: ${k.p0NowCount || 0})`);
  lines.push(`- ${ru ? 'Инцидентов за период' : 'Incidents'}: **${k.incidentsCount || 0}** | ${ru ? 'Компакций CTX' : 'Compactions'}: **${k.compactionsCount || 0}** | ${ru ? 'Действий' : 'Actions'}: **${k.actionsCount || 0}** (${k.verifiedActionsCount || 0} verified)`);
  lines.push(`- ${ru ? 'Расход API-экв.' : 'Est. API-eq spend'}: **$${(k.spendUsd || 0).toFixed(2)}** (${k.spendSource === 'checkpoints' ? (ru ? 'дельта окна' : 'window delta') : '24h'})`);
  lines.push('');

  if (Array.isArray(digest.openAttentionNow) && digest.openAttentionNow.length > 0) {
    lines.push(ru ? '## 🚨 Требует внимания СЕЙЧАС' : '## 🚨 Needs Attention NOW');
    for (const item of digest.openAttentionNow) {
      lines.push(`- **[${String(item.severity || 'p1').toUpperCase()}]** ${item.title} — ${item.detail}`);
    }
    lines.push('');
  }

  if (Array.isArray(digest.completedSlices) && digest.completedSlices.length > 0) {
    lines.push(ru ? '## ✅ Закрыто за период' : '## ✅ Completed in Window');
    for (const s of digest.completedSlices) {
      lines.push(`- **${s.slice}** (${s.doneCount} ${ru ? 'шаг.' : 'handoffs'}${s.seats && s.seats.length ? `, ${s.seats.join(', ')}` : ''})${s.latestSummary ? `: ${s.latestSummary}` : ''}`);
    }
    lines.push('');
  }

  if (Array.isArray(digest.timeline) && digest.timeline.length > 0) {
    lines.push(ru ? '## 🕒 Ключевые события смены' : '## 🕒 Key Shift Events');
    for (const ev of digest.timeline.slice(0, 15)) {
      const hhmm = String(ev.ts || '').slice(11, 16) || '--:--';
      lines.push(`- \`${hhmm}Z\` [${ev.kind}] ${ev.title}${ev.detail ? ` — ${ev.detail}` : ''}`);
    }
  }

  return lines.join('\n').trim() + '\n';
}
