/**
 * Operational Task Gantt & Handoff Sequence Domain Engine (Pure Module, zero DOM).
 *
 * Implements observability best practices (Perfetto/Jaeger/Datadog APM style):
 *   1. Sub-lane interval bin packing (zero overlapping bars on any lane).
 *   2. Dual grouping: By Agent (utilization & concurrency) vs By Chain/Slice (trace waterfall).
 *   3. Signal vs Noise separation (hides Wake escalation / stuck-sweep / opgate by default, toggleable).
 *   4. Wait-vs-Work KPI aggregation, QA bounce-back detection & Top Bottleneck finder.
 *   5. Chronological Handoff Flow (lightweight execution sequence for any selected slice).
 */

export const GANTT_LONG_WAIT_MS = 15 * 60 * 1000;
export const GANTT_MODES = Object.freeze(['timeline', 'sequence']);
export const GANTT_GROUP_MODES = Object.freeze(['agent', 'chain']);

export function ganttChainColor(key) {
  let h = 2166136261;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue}, 78%, 60%)`;
}

export function ganttRoleRank(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('owner') || s.includes('lead')) return 0;
  if (s.includes('senior') || s.includes('architect')) return 1;
  if (s.includes('operator')) return 2;
  if (s.includes('coder')) return 3;
  if (s.includes('check') || s.includes('qa')) return 4;
  return 5;
}

export function isQaSeatId(id) {
  return /(check|qa|verif|audit)/i.test(String(id || ''));
}

/**
 * Classifies automated watchdog / wake-escalation / sweep rows so operators
 * see clean task timelines by default while still being able to toggle noise on.
 */
export function isGanttItemNoise(item) {
  if (!item || typeof item !== 'object') return false;
  const id = String(item.id || item.qitemId || '').toLowerCase();
  const from = String(item.from || item.sourceSession || '').toLowerCase();
  const chain = String(item.chain || '').toLowerCase();
  const sum = String(item.summary || '').toLowerCase();
  const slice = String(item.slice || '').trim();

  if (id.startsWith('qitem-opgate-') || id.startsWith('qitem-cg-') || id.startsWith('qitem-recovery-')) {
    return true;
  }
  if (
    from.includes('change-detector') ||
    from.includes('context-guardian-observer') ||
    from.includes('opgate')
  ) {
    return true;
  }
  if (sum.startsWith('wake escalation:') || sum.includes('undelivered-wake') || sum.includes('stalled-after-claim') || sum.includes('stuck-sweep')) {
    return true;
  }
  if (!slice && chain.startsWith('q:qitem-recovery-')) {
    return true;
  }
  if (!slice && from.endsWith('@external') && (sum.includes('baton(s) stuck') || sum.includes('wake escalation'))) {
    return true;
  }
  return false;
}

export function formatGanttDuration(ms, lang = 'ru') {
  const safe = Math.max(0, Number(ms) || 0);
  if (safe < 60_000) {
    const s = Math.max(1, Math.round(safe / 1000));
    return lang === 'en' ? `${s}s` : `${s}с`;
  }
  const m = Math.round(safe / 60_000);
  if (m < 60) return lang === 'en' ? `${m}m` : `${m}м`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (rem === 0) return lang === 'en' ? `${h}h` : `${h}ч`;
  return lang === 'en' ? `${h}h ${rem}m` : `${h}ч ${rem}м`;
}

/**
 * Normalizes raw Gantt rows into time-bounded spans with wait/work/bounce annotations
 * and computes fleet-level Wait-vs-Work KPIs & Top Bottleneck.
 */
export function normalizeGanttSpans(rawItems = [], {
  nowMs = Date.now(),
  windowH = 6,
  rigFilter = 'all',
  hideNoise = true,
  onlyBottlenecks = false
} = {}) {
  const spanMs = Math.max(0.25, Number(windowH) || 6) * 3600 * 1000;
  const t0 = nowMs - spanMs;
  const rigOk = (id) => rigFilter === 'all' || String(id || '').endsWith('@' + rigFilter);

  const inWindow = [];
  let hiddenNoiseCount = 0;

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || !raw.to) continue;
    const created = Date.parse(raw.createdAt);
    if (!Number.isFinite(created) || created > nowMs) continue;
    if (!rigOk(raw.to)) continue;

    const claimed = raw.claimedAt ? Date.parse(raw.claimedAt) : NaN;
    const endParsed = raw.endAt ? Date.parse(raw.endAt) : NaN;
    const isOpen = !raw.endAt;
    const endT = isOpen ? nowMs : (Number.isFinite(endParsed) ? Math.max(created, endParsed) : created);
    if (endT < t0) continue;

    const isNoise = isGanttItemNoise(raw);
    if (hideNoise && isNoise) {
      hiddenNoiseCount++;
      continue;
    }

    let workStart;
    if (Number.isFinite(claimed) && claimed >= created) {
      workStart = Math.min(claimed, endT);
    } else if (isOpen) {
      workStart = endT; // open & never claimed => pure waiting
    } else {
      workStart = created;
    }

    const waitMs = Math.max(0, workStart - created);
    const workMs = Math.max(0, endT - workStart);
    const totalMs = Math.max(0, endT - created);
    const isLongWait = waitMs > GANTT_LONG_WAIT_MS && waitMs >= workMs;
    const chain = raw.chain || (raw.slice ? `slice:${raw.slice}` : `q:${raw.id || created}`);
    const label = raw.slice || (raw.summary || '').slice(0, 42) || chain;

    inWindow.push({
      ...raw,
      chain,
      label,
      color: ganttChainColor(chain),
      created,
      claimed,
      workStart,
      endT,
      isOpen,
      isNoise,
      waitMs,
      workMs,
      totalMs,
      isLongWait,
      qaRound: 0,
      isQaStep: isQaSeatId(raw.to),
      isBounceBack: false,
      chainQaRounds: 0,
      blockedOn: raw.blockedOn || '',
      blockedOnQitemId: raw.blockedOnQitemId || '',
      handedOffFrom: raw.handedOffFrom || '',
      handedOffTo: raw.handedOffTo || '',
      parent: raw.parent || '',
      project: raw.project || '',
      mission: raw.mission || '',
      gate: raw.gate || '',
      bodyContextRef: raw.bodyContextRef || '',
      evidenceRef: raw.evidenceRef || '',
      targetRepo: raw.targetRepo || ''
    });
  }

  // Annotate per-chain QA rounds and bounce-back rework steps chronologically
  const byChain = new Map();
  for (const sp of inWindow) {
    if (!byChain.has(sp.chain)) byChain.set(sp.chain, []);
    byChain.get(sp.chain).push(sp);
  }

  let qaBounceCount = 0;
  for (const list of byChain.values()) {
    list.sort((a, b) => a.created - b.created);
    let qaCount = 0;
    let seenQa = false;
    for (const sp of list) {
      if (sp.isQaStep) {
        qaCount++;
        sp.qaRound = qaCount;
        seenQa = true;
      } else if (seenQa && isQaSeatId(sp.from)) {
        // Explicit return from QA to dev/owner
        const sumLow = String(sp.summary || '').toLowerCase();
        const isPass = /\b(pass|passed|green|approved|принят|завершена)\b/i.test(sumLow) && !/\b(bounce|fail|p1|rework|возврат|доработ)\b/i.test(sumLow);
        if (!isPass) {
          sp.isBounceBack = true;
          qaBounceCount++;
        }
      }
    }
    if (qaCount > 1 && qaBounceCount === 0) {
      // Multiple QA rounds imply at least qaCount - 1 rework bounces even when summary is empty
      let r = 0;
      for (const sp of list) {
        if (sp.isQaStep) {
          r++;
          if (r > 1) {
            sp.isBounceBack = true;
            qaBounceCount++;
          }
        }
      }
    }
    for (const sp of list) {
      sp.chainQaRounds = qaCount;
    }
  }

  // Compute fleet KPIs over the full (noise-filtered) window before optional bottleneck-only subsetting
  let totalWaitMs = 0;
  let totalWorkMs = 0;
  let longWaitCount = 0;
  let topBottleneck = null;

  for (const sp of inWindow) {
    // Clamp contribution to visible window so ancient pre-window waits don't distort 1h KPIs
    const visStart = Math.max(t0, sp.created);
    const visWorkStart = Math.max(t0, Math.min(nowMs, sp.workStart));
    const visEnd = Math.min(nowMs, sp.endT);
    const visWait = Math.max(0, visWorkStart - visStart);
    const visWork = Math.max(0, visEnd - visWorkStart);
    totalWaitMs += visWait;
    totalWorkMs += visWork;
    if (sp.isLongWait) longWaitCount++;
    if (sp.waitMs > 0 && (!topBottleneck || sp.waitMs > topBottleneck.waitMs)) {
      topBottleneck = {
        id: sp.id,
        chain: sp.chain,
        slice: sp.slice || sp.label,
        to: sp.to,
        from: sp.from,
        waitMs: sp.waitMs,
        workMs: sp.workMs,
        isLongWait: sp.isLongWait
      };
    }
  }

  const combinedMs = totalWaitMs + totalWorkMs;
  const waitPct = combinedMs > 0 ? Math.round((totalWaitMs / combinedMs) * 100) : 0;
  const workPct = combinedMs > 0 ? Math.max(0, 100 - waitPct) : 0;

  const spans = onlyBottlenecks
    ? inWindow.filter(sp => sp.isLongWait || sp.isBounceBack || sp.chainQaRounds > 2 || sp.isOpen)
    : inWindow;

  return {
    t0,
    nowMs,
    spanMs,
    spans,
    allWindowSpans: inWindow,
    kpis: {
      totalSpans: inWindow.length,
      visibleSpans: spans.length,
      chainCount: byChain.size,
      hiddenNoiseCount,
      totalWaitMs,
      totalWorkMs,
      waitPct,
      workPct,
      longWaitCount,
      qaBounceCount,
      topBottleneck
    }
  };
}

/**
 * Greedy interval bin-packing: assigns every span in a lane to the lowest non-overlapping sub-row.
 * Guarantees 0 overlapping bars even when an agent holds multiple concurrent tasks.
 */
export function packLaneIntervals(spans = [], minGapMs = 0, minSpanMs = 0) {
  const sorted = [...spans].sort((a, b) => (a.created - b.created) || (b.endT - a.endT));
  const trackEnds = [];
  const packed = [];
  const floorSpan = Math.max(1000, minSpanMs || 0, minGapMs || 0);

  for (const sp of sorted) {
    const start = sp.created;
    const extraGlyphMs = sp.isBounceBack ? floorSpan : 0;
    const end = Math.max(start + floorSpan, sp.endT) + extraGlyphMs;
    let assigned = -1;
    for (let r = 0; r < trackEnds.length; r++) {
      if (trackEnds[r] + minGapMs <= start) {
        assigned = r;
        trackEnds[r] = end;
        break;
      }
    }
    if (assigned === -1) {
      assigned = trackEnds.length;
      trackEnds.push(end);
    }
    packed.push({ ...sp, subRow: assigned });
  }

  return {
    spans: packed,
    trackCount: Math.max(1, trackEnds.length)
  };
}

/**
 * Builds lane layout for either 'agent' (utilization/load) or 'chain' (trace waterfall) grouping.
 */
export function buildGanttLanes(spans = [], { groupBy = 'agent', minGapMs = 60_000, minSpanMs = 0 } = {}) {
  const mode = groupBy === 'chain' ? 'chain' : 'agent';
  const buckets = new Map();

  for (const sp of spans) {
    const key = mode === 'chain' ? sp.chain : sp.to;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(sp);
  }

  const keys = [...buckets.keys()];
  if (mode === 'agent') {
    keys.sort((a, b) => ganttRoleRank(a) - ganttRoleRank(b) || a.localeCompare(b));
  } else {
    // Chain mode: open / newest chains first, then longest total wait
    keys.sort((a, b) => {
      const la = buckets.get(a);
      const lb = buckets.get(b);
      const openA = la.some(x => x.isOpen) ? 0 : 1;
      const openB = lb.some(x => x.isOpen) ? 0 : 1;
      if (openA !== openB) return openA - openB;
      const maxEndA = Math.max(...la.map(x => x.endT));
      const maxEndB = Math.max(...lb.map(x => x.endT));
      return maxEndB - maxEndA;
    });
  }

  return keys.map(key => {
    const group = buckets.get(key);
    const { spans: packedSpans, trackCount } = packLaneIntervals(group, minGapMs, minSpanMs);
    const totalWaitMs = group.reduce((s, x) => s + x.waitMs, 0);
    const totalWorkMs = group.reduce((s, x) => s + x.workMs, 0);
    const hasLongWait = group.some(x => x.isLongWait);
    const qaRounds = Math.max(0, ...group.map(x => x.chainQaRounds || 0));
    const hasOpen = group.some(x => x.isOpen);
    const label = mode === 'chain'
      ? (group.find(x => x.slice)?.slice || group[0]?.label || key)
      : key;

    return {
      key,
      mode,
      label,
      color: mode === 'chain' ? ganttChainColor(key) : null,
      spans: packedSpans,
      trackCount,
      spanCount: group.length,
      totalWaitMs,
      totalWorkMs,
      hasLongWait,
      qaRounds,
      hasOpen
    };
  });
}

/**
 * Builds a lightweight Chronological Handoff Flow (Sequence Trace) for a selected chain.
 * Lists all selectable chains in the window and scopes columns strictly to the 2..5 agents
 * participating in the active chain so it stays readable for operators & tech leads alike.
 */
export function buildHandoffSequenceModel(allWindowSpans = [], { focusChain = null } = {}) {
  const byChain = new Map();
  for (const sp of Array.isArray(allWindowSpans) ? allWindowSpans : []) {
    if (!byChain.has(sp.chain)) byChain.set(sp.chain, []);
    byChain.get(sp.chain).push(sp);
  }

  const chains = [...byChain.entries()].map(([chain, list]) => {
    const sorted = [...list].sort((a, b) => a.created - b.created);
    const totalWaitMs = sorted.reduce((s, x) => s + x.waitMs, 0);
    const totalWorkMs = sorted.reduce((s, x) => s + x.workMs, 0);
    const qaRounds = Math.max(0, ...sorted.map(x => x.chainQaRounds || 0));
    const bounceCount = sorted.filter(x => x.isBounceBack).length;
    const hasOpen = sorted.some(x => x.isOpen);
    const lastEnd = Math.max(...sorted.map(x => x.endT));
    const label = sorted.find(x => x.slice)?.slice || sorted[0]?.label || chain;
    return {
      chain,
      label,
      color: ganttChainColor(chain),
      stepCount: sorted.length,
      totalWaitMs,
      totalWorkMs,
      qaRounds,
      bounceCount,
      hasOpen,
      lastEnd,
      steps: sorted
    };
  });

  // Sort selectable chains: multi-step open chains first, then multi-step recent chains, then singletons
  chains.sort((a, b) => {
    const multiA = a.stepCount >= 2 ? 0 : 1;
    const multiB = b.stepCount >= 2 ? 0 : 1;
    if (multiA !== multiB) return multiA - multiB;
    if (a.hasOpen !== b.hasOpen) return a.hasOpen ? -1 : 1;
    if (b.stepCount !== a.stepCount) return b.stepCount - a.stepCount;
    return b.lastEnd - a.lastEnd;
  });

  if (chains.length === 0) {
    return { activeChain: null, chains: [], participants: [], steps: [], stats: null };
  }

  const selected = (focusChain && chains.find(c => c.chain === focusChain)) || chains[0];
  const participantSet = new Set();
  for (const st of selected.steps) {
    if (st.from) participantSet.add(st.from);
    if (st.to) participantSet.add(st.to);
  }

  const participants = [...participantSet].sort((a, b) => ganttRoleRank(a) - ganttRoleRank(b) || a.localeCompare(b));
  const idxById = Object.fromEntries(participants.map((id, i) => [id, i]));

  const steps = selected.steps.map((st, idx) => ({
    ...st,
    stepNum: idx + 1,
    fromIdx: st.from && idxById[st.from] !== undefined ? idxById[st.from] : idxById[st.to],
    toIdx: idxById[st.to]
  }));

  const firstCreated = steps[0].created;
  const lastEnd = Math.max(...steps.map(s => s.endT));
  const totalLeadMs = Math.max(0, lastEnd - firstCreated);
  const combined = selected.totalWaitMs + selected.totalWorkMs;
  const waitPct = combined > 0 ? Math.round((selected.totalWaitMs / combined) * 100) : 0;

  return {
    activeChain: selected.chain,
    activeLabel: selected.label,
    activeColor: selected.color,
    chains: chains.slice(0, 12).map(({ steps: _s, ...meta }) => meta),
    participants,
    steps,
    stats: {
      totalLeadMs,
      totalWaitMs: selected.totalWaitMs,
      totalWorkMs: selected.totalWorkMs,
      waitPct,
      workPct: combined > 0 ? Math.max(0, 100 - waitPct) : 0,
      handoffCount: steps.length,
      qaRounds: selected.qaRounds,
      bounceCount: selected.bounceCount
    }
  };
}
