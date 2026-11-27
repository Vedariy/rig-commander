/**
 * Multi-Vendor Swarm & Subagent Domain Model (Pure Zero-DOM Module).
 *
 * Normalizes local Antigravity `/swarm`, Claude Code Agent Teams, and Codex CLI
 * subagent sessions into Command Deck-compatible rig clusters, non-tmux seats,
 * Call Highways mention edges, and Task Gantt / Handoff items.
 *
 * Pure native ESM: zero DOM/`window` coupling and zero `node:*` imports.
 */

export const SWARM_PROVIDER_KINDS = Object.freeze({
  ANTIGRAVITY: 'antigravity-swarm',
  CLAUDE_TEAMS: 'claude-teams',
  CODEX_SUBAGENTS: 'codex-subagents'
});

export const SWARM_READONLY_CAPABILITIES = Object.freeze({
  canSendKeys: false,
  canCaptureTmux: false,
  readOnlyBoard: true
});

const DEFAULT_STALL_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_LIVE_EDGE_WINDOW_MS = 5 * 60 * 1000;
const UUID_PREFIX_RE = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENTION_RE = /(?:^|[^A-Za-z0-9._-])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,31})\b/g;
const DONE_MARKER_RE = /^(?:@[a-zA-Z0-9_-]+\s+)*\[done\]\b/i;
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function sanitizeSwarmIdPart(raw, fallback = 'seat', maxLen = 48) {
  let clean = String(raw || '')
    .trim()
    .replace(/\.\.+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean || !/^[A-Za-z0-9]/.test(clean)) {
    clean = clean.replace(/^[^A-Za-z0-9]+/, '');
  }
  if (!clean) clean = fallback;
  return clean.slice(0, maxLen).replace(/-+$/g, '') || fallback;
}

/**
 * Parses timestamps including space-separated local SQLite/board timestamps
 * ("YYYY-MM-DD HH:MM:SS") without cross-browser Safari failures.
 */
export function parseSwarmTimestampMs(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : NaN;
  }
  if (typeof raw !== 'string') return NaN;
  const s = raw.trim();
  if (!s) return NaN;
  if (LOCAL_DATETIME_RE.test(s)) {
    return Date.parse(s.replace(' ', 'T'));
  }
  return Date.parse(s);
}

/**
 * Derives a deterministic Command Deck rigId of the form `swarm-<shortId>`
 * compliant with SAFE_RIG_NAME_RE.
 */
export function deriveSwarmRigSlug(rawTitleOrId = '', explicitId = '') {
  if (rawTitleOrId && typeof rawTitleOrId === 'object') {
    const obj = rawTitleOrId;
    return deriveSwarmRigSlug(obj.title || obj.name || '', obj.swarmId || obj.id || obj.teamName || '');
  }

  const candidateId = String(explicitId || '').trim();
  const candidatePrimary = String(rawTitleOrId || '').trim();
  const idSource = candidateId || candidatePrimary;
  if (!idSource) return 'swarm-local';

  const stripped = idSource.replace(/^swarm-/i, '');
  const uuidMatch = UUID_PREFIX_RE.exec(stripped);
  if (uuidMatch) {
    return `swarm-${uuidMatch[1].toLowerCase()}`;
  }

  // If explicitId wasn't a UUID, check if primary itself is a UUID
  if (!candidateId && candidatePrimary) {
    const pUuid = UUID_PREFIX_RE.exec(candidatePrimary.replace(/^swarm-/i, ''));
    if (pUuid) return `swarm-${pUuid[1].toLowerCase()}`;
  }

  const slug = sanitizeSwarmIdPart(stripped.toLowerCase(), 'local', 40)
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `swarm-${slug || 'local'}`;
}

function normalizeUpper(val) {
  return String(val || '').trim().toUpperCase();
}

function normalizeLower(val) {
  return String(val || '').trim().toLowerCase();
}

/**
 * Projects a raw swarm member/subagent record onto canonical Command Deck status:
 *   - RUNNING + wake_mode === 'working' -> 'working'
 *   - mentions / waiting / anything / idle -> 'idle'
 *   - stalled / parked -> 'parked'
 *   - killed -> filtered out by default unless includeKilled: true
 */
export function projectSwarmMemberStatus(member = {}, {
  nowMs = Date.now(),
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  lastActivityMs = NaN
} = {}) {
  const phase = normalizeUpper(member.phase);
  const desired = normalizeUpper(member.desired_state || member.desiredState);
  const status = normalizeLower(member.status || member.state);
  const wakeMode = normalizeLower(member.wake_mode || member.wakeMode);

  if (
    member.schemaDrift === true ||
    status === 'unknown (schema_drift)' ||
    wakeMode === 'unknown (schema_drift)'
  ) {
    return {
      display: 'unknown (schema_drift)',
      activity: 'unknown (schema_drift)',
      isWorking: false,
      isIdle: false,
      isParked: false,
      isKilled: false,
      schemaDrift: true,
      stalledReason: '',
      sessionStatus: 'unknown (schema_drift)',
      lifecycleState: 'unknown (schema_drift)'
    };
  }

  const isKilled = Boolean(
    member.killed === true ||
    phase === 'KILLED' ||
    desired === 'KILLED' ||
    status === 'killed' ||
    status === 'closed' ||
    status === 'shutdown'
  );

  if (isKilled) {
    return {
      display: 'idle',
      activity: 'killed',
      isWorking: false,
      isIdle: true,
      isParked: false,
      isKilled: true,
      stalledReason: '',
      sessionStatus: 'stopped',
      lifecycleState: 'killed'
    };
  }

  const hasStaleWorkingAge = Boolean(
    wakeMode === 'working' &&
    Number.isFinite(lastActivityMs) &&
    Number.isFinite(nowMs) &&
    stallThresholdMs > 0 &&
    (nowMs - lastActivityMs) > stallThresholdMs
  );

  const explicitStall = Boolean(
    member.stalled === true ||
    phase === 'STALLED' ||
    phase === 'PARKED' ||
    status === 'stalled' ||
    status === 'parked' ||
    (desired === 'RUNNING' && (phase === 'STOPPED' || phase === 'DEAD' || phase === 'FAILED'))
  );

  if (explicitStall || hasStaleWorkingAge) {
    const stalledReason = String(
      member.stalledReason ||
      (hasStaleWorkingAge ? 'stalled swarm worker (no recent activity)' : 'stalled swarm worker')
    );
    return {
      display: 'parked',
      activity: 'stalled',
      isWorking: false,
      isIdle: false,
      isParked: true,
      isKilled: false,
      stalledReason,
      sessionStatus: 'running',
      lifecycleState: 'parked'
    };
  }

  const isExplicitWaiting = Boolean(
    wakeMode === 'mentions' ||
    wakeMode === 'waiting' ||
    wakeMode === 'anything' ||
    wakeMode === 'idle' ||
    phase === 'WAITING' ||
    phase === 'IDLE' ||
    status === 'idle' ||
    status === 'waiting'
  );

  const isWorking = Boolean(
    !isExplicitWaiting && (
      wakeMode === 'working' ||
      status === 'working' ||
      status === 'running' ||
      status === 'in_progress' ||
      (phase === 'RUNNING' && (!wakeMode || wakeMode === 'working'))
    )
  );

  if (isWorking) {
    return {
      display: 'working',
      activity: 'working',
      isWorking: true,
      isIdle: false,
      isParked: false,
      isKilled: false,
      stalledReason: '',
      sessionStatus: 'running',
      lifecycleState: 'running'
    };
  }

  return {
    display: 'idle',
    activity: 'idle-at-prompt',
    isWorking: false,
    isIdle: true,
    isParked: false,
    isKilled: false,
    stalledReason: '',
    sessionStatus: (phase === 'STOPPED' || desired === 'STOPPED') ? 'stopped' : 'running',
    lifecycleState: (phase === 'STOPPED' || desired === 'STOPPED') ? 'stopped' : 'running'
  };
}

function normalizeBoardEntries(boardEntries) {
  if (typeof boardEntries === 'string') {
    const out = [];
    for (const line of boardEntries.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') out.push(obj);
      } catch {
        // ignore partial/corrupt line
      }
    }
    return out;
  }
  return Array.isArray(boardEntries) ? boardEntries.filter(e => e && typeof e === 'object') : [];
}

function toSeatId(name, rigId) {
  const cleanName = sanitizeSwarmIdPart(name, 'agent', 60);
  if (!rigId || cleanName.includes('@')) return cleanName;
  return `${cleanName}@${rigId}`;
}

function summarizeBoardText(text, maxLen = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 1)) + '…';
}

/**
 * Parses `board.jsonl` entries (or raw JSONL string) into Call Highways edges,
 * chronological mention events, and per-seat call counters.
 */
export function parseBoardMentions(boardEntries = [], {
  rigId = '',
  memberNames = null,
  activeMemberNames = null,
  includeAllBroadcast = true,
  nowMs = Date.now(),
  liveWindowMs = DEFAULT_LIVE_EDGE_WINDOW_MS,
  defaultSlice = 'swarm'
} = {}) {
  const entries = normalizeBoardEntries(boardEntries);
  const knownSet = memberNames
    ? new Set(Array.from(memberNames, m => String(m || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const activeSet = activeMemberNames
    ? new Set(Array.from(activeMemberNames, m => String(m || '').trim().toLowerCase()).filter(Boolean))
    : knownSet;

  const edgeMap = new Map();
  const mentions = [];
  const callsBySeat = {};

  const bumpCalls = (seatId, dir) => {
    if (!callsBySeat[seatId]) callsBySeat[seatId] = { in: 0, out: 0 };
    callsBySeat[seatId][dir] += 1;
  };

  for (const entry of entries) {
    const fromRaw = String(entry.agent || entry.from || '').trim();
    const text = String(entry.text || '');
    if (!fromRaw || !text) continue;
    const fromKey = fromRaw.toLowerCase();
    if (activeSet && !activeSet.has(fromKey)) continue;

    const seq = Number.isFinite(Number(entry.seq)) ? Number(entry.seq) : null;
    const tsMs = parseSwarmTimestampMs(entry.time || entry.timestamp || entry.createdAt);
    const isoTime = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : '';
    const isDone = DONE_MARKER_RE.test(text.trim());
    const kind = String(entry.kind || (isDone ? 'done' : 'message'));

    const targets = new Set();
    MENTION_RE.lastIndex = 0;
    let m;
    while ((m = MENTION_RE.exec(text)) !== null) {
      const targetKey = m[1].toLowerCase();
      if (targetKey === 'all') {
        if (includeAllBroadcast && activeSet) {
          for (const candidate of activeSet) {
            if (candidate !== fromKey) targets.add(candidate);
          }
        }
        continue;
      }
      if (targetKey === fromKey) continue;
      if (activeSet && !activeSet.has(targetKey)) continue;
      if (knownSet && !knownSet.has(targetKey)) continue;
      targets.add(targetKey);
    }

    const fromSeat = toSeatId(fromRaw, rigId);
    const summary = summarizeBoardText(text, 120);

    for (const targetKey of targets) {
      const toSeat = toSeatId(targetKey, rigId);
      if (fromSeat === toSeat) continue;

      bumpCalls(fromSeat, 'out');
      bumpCalls(toSeat, 'in');

      mentions.push({
        seq,
        from: fromSeat,
        to: toSeat,
        fromAgent: fromRaw,
        toAgent: targetKey,
        kind,
        isDone,
        time: isoTime || String(entry.time || ''),
        tsMs: Number.isFinite(tsMs) ? tsMs : null,
        summary
      });

      const edgeKey = `${fromSeat}->${toSeat}`;
      const existing = edgeMap.get(edgeKey);
      const isRecent = Number.isFinite(tsMs) && Number.isFinite(nowMs) ? (nowMs - tsMs) <= liveWindowMs : false;
      const isLiveHop = isRecent && !isDone;

      if (!existing) {
        edgeMap.set(edgeKey, {
          from: fromSeat,
          to: toSeat,
          fromAgent: fromRaw,
          toAgent: targetKey,
          calls: 1,
          liveActive: isLiveHop,
          queueStatus: isLiveHop ? 'live' : 'ghost',
          slice: defaultSlice,
          color: isLiveHop ? '#00ff9d' : '#475569',
          marker: isLiveHop ? 'arr-emerald' : 'arr-cyan',
          speed: isLiveHop ? '0.95s' : '1.15s',
          lastSeq: seq,
          lastAt: isoTime || null,
          lastTsMs: Number.isFinite(tsMs) ? tsMs : 0,
          lastKind: kind,
          summary,
          freqLabel: `⚡ 1 msg (${fromRaw} → ${targetKey})`
        });
      } else {
        existing.calls += 1;
        const newer = (Number.isFinite(tsMs) ? tsMs : 0) >= existing.lastTsMs;
        if (newer) {
          existing.lastSeq = seq ?? existing.lastSeq;
          existing.lastAt = isoTime || existing.lastAt;
          existing.lastTsMs = Number.isFinite(tsMs) ? tsMs : existing.lastTsMs;
          existing.lastKind = kind;
          existing.summary = summary;
          existing.liveActive = isLiveHop;
          existing.queueStatus = isLiveHop ? 'live' : 'ghost';
          existing.color = isLiveHop ? '#00ff9d' : '#475569';
          existing.marker = isLiveHop ? 'arr-emerald' : 'arr-cyan';
          existing.speed = isLiveHop ? '0.95s' : '1.15s';
        }
        existing.freqLabel = `⚡ ${existing.calls} msg (${existing.fromAgent} → ${existing.toAgent})`;
      }
    }
  }

  const edges = Array.from(edgeMap.values()).map(({ lastTsMs: _drop, ...edge }) => edge);
  return { edges, mentions, callsBySeat };
}

/**
 * Converts `plan.json` (`goal`, `threads`, `tasks`) + `board.jsonl` timestamps
 * into Command Deck Task Gantt / Handoff items compatible with `normalizeGanttSpans`.
 */
export function buildSwarmGanttItems(plan = {}, boardEntries = [], {
  rigId = '',
  clusterCreatedAt = null,
  activeMemberNames = null,
  members = null,
  nowMs = Date.now()
} = {}) {
  const entries = normalizeBoardEntries(boardEntries);
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const goalTitle = String(safePlan.goal?.title || '').trim();
  const threads = Array.isArray(safePlan.threads) ? safePlan.threads : [];
  const tasksMap = safePlan.tasks && typeof safePlan.tasks === 'object' && !Array.isArray(safePlan.tasks)
    ? safePlan.tasks
    : {};
  const activeSet = activeMemberNames
    ? new Set(Array.from(activeMemberNames, m => String(m || '').trim().toLowerCase()).filter(Boolean))
    : null;

  const fallbackStartMs = (() => {
    const parsedCluster = parseSwarmTimestampMs(clusterCreatedAt);
    if (Number.isFinite(parsedCluster) && parsedCluster <= nowMs) return parsedCluster;
    for (const e of entries) {
      const t = parseSwarmTimestampMs(e.time || e.timestamp || e.createdAt);
      if (Number.isFinite(t) && t <= nowMs) return t;
    }
    return Math.max(0, nowMs - 15 * 60_000);
  })();

  const taskThreadLookup = new Map();
  for (const th of threads) {
    if (!th || typeof th !== 'object') continue;
    const thId = String(th.id || th.title || '').trim();
    const thTitle = String(th.title || th.id || '').trim();
    const thTasks = Array.isArray(th.tasks) ? th.tasks : [];
    for (const tName of thTasks) {
      const k = String(tName || '').trim().toLowerCase();
      if (k && !taskThreadLookup.has(k)) {
        taskThreadLookup.set(k, { id: thId, title: thTitle });
      }
    }
  }

  const parsedMentions = parseBoardMentions(entries, {
    rigId,
    activeMemberNames: activeSet,
    includeAllBroadcast: false,
    nowMs
  });

  // Track first inbound dispatch and completion timestamps per agent from board.jsonl
  const firstDispatchByAgent = new Map();
  const doneByAgent = new Map();
  for (const ev of parsedMentions.mentions) {
    const toKey = String(ev.toAgent || '').toLowerCase();
    const fromKey = String(ev.fromAgent || '').toLowerCase();
    if (toKey && !firstDispatchByAgent.has(toKey) && ev.tsMs) {
      firstDispatchByAgent.set(toKey, ev);
    }
    if (ev.isDone && fromKey && ev.tsMs) {
      doneByAgent.set(fromKey, ev);
    }
  }

  const items = [];
  const emittedTaskKeys = new Set();

  for (const [taskOwner, rawTask] of Object.entries(tasksMap)) {
    const ownerKey = String(taskOwner || '').trim().toLowerCase();
    if (!ownerKey) continue;
    if (activeSet && !activeSet.has(ownerKey)) continue;

    const taskObj = rawTask && typeof rawTask === 'object' ? rawTask : { summary: String(rawTask || '') };
    const summaryText = summarizeBoardText(taskObj.summary || taskObj.title || taskObj.description || `${taskOwner} task`, 140);
    const threadMeta = taskThreadLookup.get(ownerKey) || (threads[0] ? { id: threads[0].id || 'swarm', title: threads[0].title || '' } : null);
    const chainKey = threadMeta?.id ? `swarm:${sanitizeSwarmIdPart(threadMeta.id, 'thread', 40)}` : `swarm:${rigId || 'local'}`;
    const sliceName = threadMeta?.title || goalTitle || rigId || 'swarm';

    const dispatchEv = firstDispatchByAgent.get(ownerKey);
    const doneEv = doneByAgent.get(ownerKey);
    const memberObj = members && typeof members === 'object' ? (members[taskOwner] || members[ownerKey]) : null;
    const isTaskDoneText = /^(?:DONE|COMPLETED|VERIFIED)\b/i.test(summaryText) || normalizeLower(taskObj.status) === 'completed' || normalizeLower(taskObj.status) === 'done';
    const isWaitingText = /^(?:WAITING|PENDING|QUEUED)\b/i.test(summaryText) || normalizeLower(taskObj.status) === 'pending';

    const rawStart = parseSwarmTimestampMs(taskObj.createdAt || taskObj.startedAt) || dispatchEv?.tsMs || fallbackStartMs;
    const startMs = Math.min(rawStart, nowMs);
    const rawEnd = parseSwarmTimestampMs(taskObj.completedAt || taskObj.endAt) || doneEv?.tsMs;
    const isDone = Boolean(doneEv || isTaskDoneText || memberObj?.killed === true);
    const endMs = isDone ? Math.max(startMs + 1000, Math.min(nowMs, Number.isFinite(rawEnd) ? rawEnd : nowMs)) : null;

    const toSeat = toSeatId(taskOwner, rigId);
    const fromSeat = dispatchEv ? dispatchEv.from : (rigId || toSeat);

    emittedTaskKeys.add(ownerKey);
    items.push({
      id: `swarm-task-${rigId || 'local'}-${sanitizeSwarmIdPart(taskOwner, 'task', 36)}`,
      from: fromSeat,
      to: toSeat,
      chain: chainKey,
      slice: sliceName,
      summary: summaryText,
      state: isDone ? 'done' : (isWaitingText ? 'pending' : 'in-progress'),
      createdAt: new Date(startMs).toISOString(),
      claimedAt: isWaitingText && !isDone ? null : new Date(startMs).toISOString(),
      endAt: endMs ? new Date(endMs).toISOString() : null
    });
  }

  // Also include board handoff transitions (e.g. worker -> verifier -> coordinator) so Handoff Flow traces every hop
  for (const ev of parsedMentions.mentions) {
    if (!ev.tsMs || ev.tsMs > nowMs) continue;
    const toKey = String(ev.toAgent || '').toLowerCase();
    if (!ev.isDone && emittedTaskKeys.has(toKey) && firstDispatchByAgent.get(toKey)?.seq === ev.seq) {
      continue; // Already represented as the primary task bar for this worker
    }
    const threadMeta = taskThreadLookup.get(String(ev.fromAgent || '').toLowerCase()) ||
      taskThreadLookup.get(toKey) ||
      (threads[0] ? { id: threads[0].id || 'swarm', title: threads[0].title || '' } : null);
    const chainKey = threadMeta?.id ? `swarm:${sanitizeSwarmIdPart(threadMeta.id, 'thread', 40)}` : `swarm:${rigId || 'local'}`;
    const sliceName = threadMeta?.title || goalTitle || rigId || 'swarm';
    const ts = Math.min(ev.tsMs, nowMs);

    items.push({
      id: `swarm-hop-${rigId || 'local'}-${ev.seq ?? ts}-${sanitizeSwarmIdPart(ev.fromAgent, 'src', 16)}-${sanitizeSwarmIdPart(ev.toAgent, 'dst', 16)}`,
      from: ev.from,
      to: ev.to,
      chain: chainKey,
      slice: sliceName,
      summary: ev.summary,
      state: ev.isDone ? 'done' : 'in-progress',
      createdAt: new Date(ts).toISOString(),
      claimedAt: new Date(ts).toISOString(),
      endAt: ev.isDone ? new Date(Math.min(nowMs, ts + 1000)).toISOString() : null
    });
  }

  return items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function mapProviderRuntime(providerKind, member = {}) {
  if (member.runtime && typeof member.runtime === 'string') return member.runtime;
  if (providerKind === SWARM_PROVIDER_KINDS.CLAUDE_TEAMS) return 'claude-code';
  if (providerKind === SWARM_PROVIDER_KINDS.CODEX_SUBAGENTS) return 'codex';
  return 'antigravity-swarm';
}

function normalizeMembersMap(rawMembers) {
  if (!rawMembers) return [];
  if (Array.isArray(rawMembers)) {
    return rawMembers
      .filter(m => m && typeof m === 'object')
      .map((m, idx) => [String(m.name || m.agentId || m.id || `member-${idx + 1}`), m]);
  }
  if (typeof rawMembers === 'object') {
    return Object.entries(rawMembers).filter(([, m]) => m && typeof m === 'object');
  }
  return [];
}

/**
 * Normalizes a multi-vendor swarm snapshot (`antigravity-swarm`, `claude-teams`, `codex-subagents`)
 * into Command Deck-compatible `{ rig, nodes, edges, ganttItems, callsBySeat, swarmMeta }`.
 *
 * Pure function: caller is responsible for passing redacted text/paths in `rawCluster`
 * (or running `swarm-discovery.mjs` redaction over the returned structure).
 */
export function normalizeSwarmCluster(rawCluster = {}, {
  includeKilled = false,
  nowMs = Date.now(),
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  liveEdgeWindowMs = DEFAULT_LIVE_EDGE_WINDOW_MS
} = {}) {
  const providerKind = Object.values(SWARM_PROVIDER_KINDS).includes(rawCluster.providerKind)
    ? rawCluster.providerKind
    : SWARM_PROVIDER_KINDS.ANTIGRAVITY;

  const swarmJson = rawCluster.swarm && typeof rawCluster.swarm === 'object' ? rawCluster.swarm : {};
  const membersJson = rawCluster.members && typeof rawCluster.members === 'object' ? rawCluster.members : {};
  const planJson = rawCluster.plan && typeof rawCluster.plan === 'object' ? rawCluster.plan : {};

  const rawSwarmId = String(
    rawCluster.swarmId ||
    swarmJson.swarm_id ||
    rawCluster.id ||
    rawCluster.teamName ||
    ''
  ).trim();
  const title = String(
    rawCluster.title ||
    membersJson.title ||
    planJson.goal?.title ||
    rawCluster.teamName ||
    rawSwarmId ||
    'Swarm'
  ).trim();
  const rigId = rawCluster.rigId
    ? deriveSwarmRigSlug(rawCluster.rigId)
    : deriveSwarmRigSlug(title, rawSwarmId);

  const goalTitle = String(planJson.goal?.title || title || '').trim();
  const goalLine = String(planJson.goal?.line || rawCluster.description || '').trim();
  const createdAt = rawCluster.createdAt || swarmJson.created_at || null;
  const boardEntries = normalizeBoardEntries(rawCluster.boardEntries || rawCluster.board || []);
  const boardHeadSeq = boardEntries.reduce((max, e) => {
    const seq = Number(e?.seq);
    return Number.isFinite(seq) && seq > max ? seq : max;
  }, 0);

  const memberEntries = normalizeMembersMap(membersJson.members || rawCluster.membersList || rawCluster.members);
  const transcriptsByName = rawCluster.transcriptsByMember && typeof rawCluster.transcriptsByMember === 'object'
    ? rawCluster.transcriptsByMember
    : {};

  // Pre-compute all member statuses to filter killed members cleanly before mention/edge construction
  const projectedMembers = [];
  const allMemberNames = new Set();
  const includedMemberNames = new Set();

  for (const [memberName, member] of memberEntries) {
    allMemberNames.add(memberName);
    const tr = transcriptsByName[memberName] || member.transcript || null;
    const memberLastMs = (() => {
      const explicit = parseSwarmTimestampMs(member.lastActivityAt || tr?.lastActivityAt);
      if (Number.isFinite(explicit)) return explicit;
      if (typeof tr?.mtimeMs === 'number' && Number.isFinite(tr.mtimeMs)) return tr.mtimeMs;
      return NaN;
    })();

    const projected = projectSwarmMemberStatus(member, {
      nowMs,
      stallThresholdMs,
      lastActivityMs: memberLastMs
    });

    if (projected.isKilled && !includeKilled) continue;
    includedMemberNames.add(memberName);
    projectedMembers.push({ memberName, member, tr, memberLastMs, projected });
  }

  const tasksMap = planJson.tasks && typeof planJson.tasks === 'object' && !Array.isArray(planJson.tasks)
    ? planJson.tasks
    : {};

  const { edges, callsBySeat } = parseBoardMentions(boardEntries, {
    rigId,
    memberNames: allMemberNames,
    activeMemberNames: includedMemberNames,
    includeAllBroadcast: true,
    nowMs,
    liveWindowMs: liveEdgeWindowMs,
    defaultSlice: goalTitle || rigId
  });

  const ganttItems = buildSwarmGanttItems(planJson, boardEntries, {
    rigId,
    clusterCreatedAt: createdAt,
    activeMemberNames: includedMemberNames,
    members: membersJson.members || null,
    nowMs
  });

  const boardTailLimit = 20;
  const boardTail = boardEntries
    .slice(-boardTailLimit)
    .map(e => ({
      seq: Number.isFinite(Number(e.seq)) ? Number(e.seq) : null,
      agent: String(e.agent || e.from || ''),
      kind: String(e.kind || (DONE_MARKER_RE.test(String(e.text || '').trim()) ? 'done' : 'message')),
      time: String(e.time || e.timestamp || ''),
      text: summarizeBoardText(e.text || '', 240)
    }));

  const fallbackCreatedMs = parseSwarmTimestampMs(createdAt);
  const nodes = [];
  let runningCount = 0;
  let workingCount = 0;

  for (const { memberName, member, tr, memberLastMs, projected } of projectedMembers) {
    const cleanMember = sanitizeSwarmIdPart(memberName, 'agent', 60);
    const seatId = `${cleanMember}@${rigId}`;
    const role = String(member.role || member.agentType || (memberName === 'coordinator' ? 'coordinator' : 'worker'));
    const workspaceMode = String(member.workspace_mode || member.workspaceMode || (member.cwd ? 'worktree' : 'inherit'));
    const model = String(tr?.model || member.model || member.applied_model || member.desired_model || 'unknown');
    const runtime = mapProviderRuntime(providerKind, member);

    const firstMs = parseSwarmTimestampMs(member.firstActivityAt) ||
      (typeof tr?.firstTsMs === 'number' && Number.isFinite(tr.firstTsMs) ? tr.firstTsMs : NaN) ||
      (Number.isFinite(fallbackCreatedMs) ? fallbackCreatedMs : Math.max(0, nowMs - 15 * 60_000));
    const lastMs = Number.isFinite(memberLastMs)
      ? memberLastMs
      : (Number.isFinite(fallbackCreatedMs) ? fallbackCreatedMs : nowMs);

    const rawTask = tasksMap[memberName] ?? member.taskSummary ?? '';
    const taskSummary = typeof rawTask === 'string'
      ? rawTask
      : String(rawTask?.summary || rawTask?.title || '');

    const boardCursor = Number.isFinite(Number(member.last_read_seq))
      ? Number(member.last_read_seq)
      : (boardHeadSeq || null);
    const waitSince = member.wait_since !== undefined ? member.wait_since : null;
    const isWorking = projected.isWorking;
    if (!projected.isKilled && projected.sessionStatus === 'running') runningCount += 1;
    if (isWorking) workingCount += 1;

    const calls = callsBySeat[seatId] || { in: 0, out: 0 };
    const memberBoardTail = boardTail
      .filter(b => b.agent === memberName || b.text.toLowerCase().includes(`@${memberName.toLowerCase()}`))
      .slice(-8);

    const contextUsage = tr && (tr.usedPercentage !== undefined || tr.usedTokens !== undefined)
      ? {
          usedPercentage: tr.usedPercentage ?? null,
          usedTokens: tr.usedTokens ?? null,
          contextWindowSize: tr.contextWindowSize ?? 200_000,
          source: tr.source || `${providerKind}-jsonl`,
          sampledAt: new Date(lastMs).toISOString()
        }
      : null;

    nodes.push({
      canonicalSessionName: seatId,
      seatId,
      rigId,
      rigName: rigId,
      runtime,
      providerKind,
      nodeKind: 'agent',
      role,
      resolvedSpecName: `${providerKind} (${role})`,
      cwd: String(member.cwd || member.workspaceLabel || rigId),
      model,
      modelObservation: { model },
      sessionStatus: projected.sessionStatus,
      lifecycleState: projected.lifecycleState,
      killed: projected.isKilled,
      stalled: projected.isParked,
      activityState: {
        display: projected.display,
        activity: projected.activity,
        needsInput: { count: 0, reason: '' }
      },
      ...(projected.isParked ? {
        parkedData: {
          parked: true,
          reason: projected.stalledReason || 'stalled swarm worker'
        }
      } : {}),
      assignedWorkCount: isWorking || Boolean(taskSummary) ? 1 : 0,
      callsIn: calls.in,
      callsOut: calls.out,
      firstActivityAt: new Date(firstMs).toISOString(),
      lastActivityAt: new Date(lastMs).toISOString(),
      tmuxAttachCommand: null,
      capabilities: { ...SWARM_READONLY_CAPABILITIES },
      contextUsage,
      swarmMeta: {
        providerKind,
        title,
        goalTitle,
        goalLine,
        workspaceMode,
        boardCursor,
        waitSince,
        boardTail: memberBoardTail.length > 0 ? memberBoardTail : boardTail.slice(-5),
        role,
        taskSummary,
        wakeMode: String(member.wake_mode || member.wakeMode || ''),
        desiredState: String(member.desired_state || member.desiredState || ''),
        phase: String(member.phase || ''),
        addedBy: member.added_by ? String(member.added_by) : null
      }
    });
  }

  const swarmMeta = {
    providerKind,
    swarmId: rawSwarmId || rigId,
    title,
    goalTitle,
    goalLine,
    workspaceMode: nodes.some(n => n.swarmMeta.workspaceMode === 'share' || n.swarmMeta.workspaceMode === 'branch' || n.swarmMeta.workspaceMode === 'worktree')
      ? 'isolated'
      : 'inherit',
    boardCursor: boardHeadSeq || null,
    boardHeadSeq,
    waitSince: null,
    boardTail,
    createdAt: Number.isFinite(fallbackCreatedMs) ? new Date(fallbackCreatedMs).toISOString() : null
  };

  const rig = {
    id: rigId,
    rigId,
    name: title || rigId,
    providerKind,
    isSwarm: true,
    status: workingCount > 0 ? 'running' : (runningCount > 0 ? 'idle' : 'stopped'),
    nodeCount: nodes.length,
    runningCount,
    activeCount: workingCount,
    hasWorkCount: workingCount,
    swarmMeta
  };

  return {
    rig,
    nodes,
    edges,
    ganttItems,
    callsBySeat,
    swarmMeta
  };
}
