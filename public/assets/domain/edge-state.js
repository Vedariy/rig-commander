/**
 * Operational semantics & visual differentiation for Call Highway edges (Pure Domain Module).
 * Separates live animated execution from static non-flowing queue states:
 *   - live     (📨 emerald, animated):  in-progress execution or active recipient working on pending task
 *   - blocked  (🚧 orange,  static):    hard stop awaiting decision/dependency (state === 'blocked')
 *   - parked   (🅿️ amber,   static):    parked obligation without active wake (pickup.state === 'parked')
 *   - held     (⏸️ purple,  static):    deliberately deferred/held with wake condition (state/pickup === 'held')
 *   - pending  (⏳ sky,     static):    queued & waiting for idle recipient pickup (state === 'pending')
 *   - ghost    (⚡ slate,   static):    historical / structural highway with no open queue row
 */

export const EDGE_STATUS_META = Object.freeze({
  live: {
    status: 'live',
    icon: '📨',
    color: '#00ff9d',
    marker: 'arr-emerald',
    cssClass: 'is-live',
    animated: true,
    labelEn: 'in progress',
    labelRu: 'в работе'
  },
  blocked: {
    status: 'blocked',
    icon: '🚧',
    color: '#f97316',
    marker: 'arr-orange',
    cssClass: 'is-blocked',
    animated: false,
    labelEn: 'blocked',
    labelRu: 'заблокировано'
  },
  parked: {
    status: 'parked',
    icon: '🅿️',
    color: '#f59e0b',
    marker: 'arr-amber',
    cssClass: 'is-parked',
    animated: false,
    labelEn: 'parked',
    labelRu: 'на парковке'
  },
  held: {
    status: 'held',
    icon: '⏸️',
    color: '#a78bfa',
    marker: 'arr-purple',
    cssClass: 'is-held',
    animated: false,
    labelEn: 'held',
    labelRu: 'придержано'
  },
  pending: {
    status: 'pending',
    icon: '⏳',
    color: '#38bdf8',
    marker: 'arr-cyan',
    cssClass: 'is-pending',
    animated: false,
    labelEn: 'pending',
    labelRu: 'ждёт взятия'
  },
  ghost: {
    status: 'ghost',
    icon: '⚡',
    color: '#475569',
    marker: 'arr-cyan',
    cssClass: 'is-ghost',
    animated: false,
    labelEn: 'history',
    labelRu: 'история'
  }
});

function extractPrimaryTag(row) {
  const tags = Array.isArray(row && row.tags) ? row.tags : [];
  const slice = tags.find(t => typeof t === 'string' && t.startsWith('slice:'));
  if (slice) return slice.slice('slice:'.length);
  const meaningful = tags.find(t => typeof t === 'string' && t.trim() && !/^(recovery-for:|prompt-|stuck-sweep|wake-)/.test(t));
  return meaningful || '';
}

function classifySingleRow(row, seatStatesById = null) {
  const state = String((row && row.state) || '').toLowerCase();
  const pickupState = String((row && row.pickup && row.pickup.state) || '').toLowerCase();
  const destId = row && row.destinationSession;
  const destState = (seatStatesById && destId && seatStatesById[destId]) || '';

  if (state === 'in-progress') return { rank: 5, status: 'live' };
  if (state === 'blocked') return { rank: 4, status: 'blocked' };
  // Pending/claimed row whose recipient is actively working or awaiting HITL counts as live work
  if ((state === 'pending' || state === 'claimed') && (destState === 'working' || destState === 'urgent')) {
    return { rank: 5, status: 'live' };
  }
  if (state === 'parked' || pickupState === 'parked') return { rank: 3, status: 'parked' };
  if (state === 'held' || pickupState === 'held') return { rank: 2, status: 'held' };
  if (state === 'pending' || state === 'claimed' || state === 'open') return { rank: 1, status: 'pending' };
  return { rank: 1, status: 'pending' };
}

/**
 * Classifies an edge given all currently open queue rows between its two endpoints.
 */
export function classifyEdgeQueueStatus(directRows = [], { seatStatesById = null, isDispatchToWorkingCoder = false } = {}) {
  const rows = Array.isArray(directRows) ? directRows.filter(Boolean) : [];
  let best = null;
  let bestRow = null;

  for (const row of rows) {
    const c = classifySingleRow(row, seatStatesById);
    if (!best || c.rank > best.rank) {
      best = c;
      bestRow = row;
    }
  }

  if (best) {
    const meta = EDGE_STATUS_META[best.status] || EDGE_STATUS_META.pending;
    const pickupState = String((bestRow && bestRow.pickup && bestRow.pickup.state) || '').toLowerCase();
    return {
      ...meta,
      rowState: String((bestRow && bestRow.state) || best.status),
      pickupState,
      tag: extractPrimaryTag(bestRow),
      summary: String((bestRow && bestRow.summary) || ''),
      qitemId: String((bestRow && (bestRow.qitemId || bestRow.id)) || ''),
      sourceSession: String((bestRow && bestRow.sourceSession) || ''),
      destinationSession: String((bestRow && bestRow.destinationSession) || '')
    };
  }

  if (isDispatchToWorkingCoder) {
    return {
      ...EDGE_STATUS_META.live,
      color: '#00f0ff',
      marker: 'arr-cyan',
      rowState: 'working',
      pickupState: '',
      tag: '',
      summary: '',
      qitemId: '',
      sourceSession: '',
      destinationSession: ''
    };
  }

  return {
    ...EDGE_STATUS_META.ghost,
    rowState: '',
    pickupState: '',
    tag: '',
    summary: '',
    qitemId: '',
    sourceSession: '',
    destinationSession: ''
  };
}
