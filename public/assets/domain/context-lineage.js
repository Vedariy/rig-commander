/**
 * Shared Context Lineage — Pure Domain Module (zero DOM, zero dependencies).
 * Extracts cross-task shared context bindings from OpenRig queue items:
 *   - Scope & provenance tags: slice:*, mission:*, project:*, parent:*, gate:*, body-context:*, recovery-for:*
 *   - Dependency & handoff links: blockedOn, handedOffFrom, handedOffTo, replyTo, chainOfRecord, waiting
 *   - Artifact references extracted from qitem bodies & evidenceRef (specs, ADRs, PROOF.md, commits, qitems)
 *   - Context drift signals across a chain (mismatched context packs, targetRepos, active cross-seat blockers)
 */

const QITEM_ID_RE = /\bqitem-[a-z0-9-]{6,}\b/gi;
const SEAT_ID_RE = /\b[a-z][a-z0-9_-]*@[a-z0-9._-]+\b/gi;
const DOC_PATH_RE = /\b(?:docs\/[A-Za-z0-9._/-]+\.(?:md|json|yaml|yml|tsv)|(?:[A-Za-z0-9._/-]+\/)?(?:PROOF|RECAP|AGENTS|CLAUDE|README|CHANGELOG)\.md)\b/g;
const ADR_REF_RE = /\bADR-\d{3,4}\b/gi;
const COMMIT_SHA_RE = /\b(?:commit\s+|код\s+|приёмк[уа]\s+|коммит\s+|sha[:=]\s*|\()([0-9a-f]{7,12})\b/gi;

function firstTagValue(tags, prefix) {
  if (!Array.isArray(tags)) return '';
  const hit = tags.find(t => typeof t === 'string' && t.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : '';
}

function allTagValues(tags, prefix) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith(prefix)) {
      const val = t.slice(prefix.length).trim();
      if (val && !out.includes(val)) out.push(val);
    }
  }
  return out;
}

/**
 * Extracts normalized shared-context metadata from a raw OpenRig queue item (list or full show).
 */
export function extractItemContextMeta(item) {
  const q = item && typeof item === 'object' ? item : {};
  const tags = Array.isArray(q.tags) ? q.tags.filter(t => typeof t === 'string') : [];
  const id = String(q.qitemId || q.id || '').trim();
  const from = String(q.sourceSession || q.from || '').trim();
  const to = String(q.destinationSession || q.to || '').trim();
  const state = String(q.state || 'pending').trim();
  const slice = String(q.slice || firstTagValue(tags, 'slice:') || '').trim();
  const mission = String(q.mission || firstTagValue(tags, 'mission:') || '').trim();
  const project = String(q.project || firstTagValue(tags, 'project:') || '').trim();
  const parent = String(q.parent || firstTagValue(tags, 'parent:') || '').trim();
  const gate = String(q.gate || firstTagValue(tags, 'gate:') || '').trim();
  const bodyContextRef = String(q.bodyContextRef || firstTagValue(tags, 'body-context:') || '').trim();
  const recoveryFor = String(q.recoveryFor || firstTagValue(tags, 'recovery-for:') || '').trim();

  const blockedOnRaw = typeof q.blockedOn === 'string'
    ? q.blockedOn.trim()
    : (Array.isArray(q.blockedOn) ? q.blockedOn.filter(Boolean).join(', ') : '');
  const waitingObj = q.waiting && typeof q.waiting === 'object' ? q.waiting : null;
  const waitingBlocker = String(
    (waitingObj && (waitingObj.blocker || waitingObj.obligation)) || ''
  ).trim();
  const waitingNextBackstop = String((waitingObj && waitingObj.nextBackstop) || '').trim();

  const combinedBlockerText = blockedOnRaw || waitingBlocker;
  const blockedQitemMatch = combinedBlockerText.match(/\bqitem-[a-z0-9-]{6,}\b/i);
  const blockedOnQitemId = blockedQitemMatch ? blockedQitemMatch[0] : '';
  const blockedSeatMatch = combinedBlockerText.match(/\b[a-z][a-z0-9_-]*@[a-z0-9._-]+\b/i);
  const blockedOnSeat = blockedSeatMatch ? blockedSeatMatch[0] : '';

  const handedOffFrom = typeof q.handedOffFrom === 'string' ? q.handedOffFrom.trim() : '';
  const handedOffTo = typeof q.handedOffTo === 'string' ? q.handedOffTo.trim() : '';
  const replyTo = typeof q.replyTo === 'string' ? q.replyTo.trim() : '';
  const evidenceRef = typeof q.evidenceRef === 'string' ? q.evidenceRef.trim() : '';
  const targetRepo = typeof q.targetRepo === 'string' ? q.targetRepo.trim() : '';
  const closureTarget = typeof q.closureTarget === 'string' ? q.closureTarget.trim() : '';
  const closureReason = typeof q.closureReason === 'string' ? q.closureReason.trim() : '';
  const chainOfRecord = typeof q.chainOfRecord === 'string' ? q.chainOfRecord.trim() : '';
  const body = typeof q.body === 'string' ? q.body : '';
  const resolution = typeof q.resolution === 'string' ? q.resolution : '';
  const summary = String(q.summary || q.title || q.subject || '').trim();

  const hasSharedContext = Boolean(
    mission || project || parent || gate || bodyContextRef || evidenceRef ||
    blockedOnRaw || waitingBlocker || handedOffFrom || handedOffTo || targetRepo || chainOfRecord
  );

  return {
    id,
    from,
    to,
    state,
    priority: String(q.priority || 'routine'),
    summary,
    slice,
    mission,
    project,
    parent,
    gate,
    bodyContextRef,
    allBodyContextRefs: allTagValues(tags, 'body-context:'),
    recoveryFor,
    blockedOn: blockedOnRaw,
    blockedOnQitemId,
    blockedOnSeat,
    waitingBlocker,
    waitingNextBackstop,
    handedOffFrom,
    handedOffTo,
    replyTo,
    evidenceRef,
    targetRepo,
    closureTarget,
    closureReason,
    chainOfRecord,
    body,
    resolution,
    tags,
    createdAt: q.tsCreated || q.createdAt || null,
    updatedAt: q.tsUpdated || q.updatedAt || q.claimedAt || q.tsCreated || q.createdAt || null,
    hasSharedContext
  };
}

/**
 * Extracts structured shared-context artifact references from a qitem body / summary / evidenceRef
 * (spec docs, ADRs, PROOF/RECAP files, commit SHAs, linked qitem IDs).
 */
export function extractContextArtifacts(text = '', extra = {}) {
  const src = String(text || '');
  const docs = new Set();
  const adrs = new Set();
  const commits = new Set();
  const linkedQitems = new Set();
  const mentionedSeats = new Set();

  if (extra.evidenceRef) docs.add(String(extra.evidenceRef).trim());

  let m;
  DOC_PATH_RE.lastIndex = 0;
  while ((m = DOC_PATH_RE.exec(src)) !== null) {
    docs.add(m[0]);
    if (docs.size >= 12) break;
  }

  ADR_REF_RE.lastIndex = 0;
  while ((m = ADR_REF_RE.exec(src)) !== null) {
    adrs.add(m[0].toUpperCase());
    if (adrs.size >= 8) break;
  }

  COMMIT_SHA_RE.lastIndex = 0;
  while ((m = COMMIT_SHA_RE.exec(src)) !== null) {
    const sha = m[1].toLowerCase();
    if (/[a-f]/.test(sha) && /\d/.test(sha)) commits.add(sha);
    if (commits.size >= 8) break;
  }

  QITEM_ID_RE.lastIndex = 0;
  const selfId = String(extra.selfId || '').trim();
  while ((m = QITEM_ID_RE.exec(src)) !== null) {
    if (m[0] !== selfId) linkedQitems.add(m[0]);
    if (linkedQitems.size >= 10) break;
  }

  SEAT_ID_RE.lastIndex = 0;
  while ((m = SEAT_ID_RE.exec(src)) !== null) {
    mentionedSeats.add(m[0]);
    if (mentionedSeats.size >= 10) break;
  }

  return {
    docs: Array.from(docs),
    adrs: Array.from(adrs),
    commits: Array.from(commits),
    linkedQitems: Array.from(linkedQitems),
    mentionedSeats: Array.from(mentionedSeats)
  };
}

/**
 * Builds an indexed cross-task lineage graph from queue rows (active + history)
 * so any qitem can resolve its ancestors (handedOffFrom / parent), descendants (handedOffTo),
 * blockers (blockedOn), dependents (other items waiting on this qitem), and sibling slice rows.
 */
export function buildSharedContextGraph(queueRows = []) {
  const rows = Array.isArray(queueRows) ? queueRows : [];
  const byId = new Map();
  const dependentsById = new Map(); // blockerId -> Set<qitemId>
  const childrenByParent = new Map(); // parentId -> Set<qitemId>
  const bySlice = new Map(); // slice -> meta[]

  for (const raw of rows) {
    const meta = raw && raw.hasSharedContext !== undefined ? raw : extractItemContextMeta(raw);
    if (!meta.id) continue;
    const prev = byId.get(meta.id);
    if (!prev || (!prev.body && meta.body) || (meta.updatedAt && (!prev.updatedAt || meta.updatedAt > prev.updatedAt))) {
      byId.set(meta.id, meta);
    }
  }

  for (const meta of byId.values()) {
    if (meta.blockedOnQitemId) {
      if (!dependentsById.has(meta.blockedOnQitemId)) dependentsById.set(meta.blockedOnQitemId, new Set());
      dependentsById.get(meta.blockedOnQitemId).add(meta.id);
    }
    if (meta.parent) {
      if (!childrenByParent.has(meta.parent)) childrenByParent.set(meta.parent, new Set());
      childrenByParent.get(meta.parent).add(meta.id);
    }
    if (meta.slice) {
      if (!bySlice.has(meta.slice)) bySlice.set(meta.slice, []);
      bySlice.get(meta.slice).push(meta);
    }
  }

  function compactRef(metaOrId) {
    if (!metaOrId) return null;
    if (typeof metaOrId === 'string') {
      const hit = byId.get(metaOrId);
      if (hit) {
        return {
          id: hit.id,
          from: hit.from,
          to: hit.to,
          state: hit.state,
          slice: hit.slice,
          summary: hit.summary
        };
      }
      return { id: metaOrId, from: '', to: '', state: 'unknown', slice: '', summary: '' };
    }
    return {
      id: metaOrId.id,
      from: metaOrId.from,
      to: metaOrId.to,
      state: metaOrId.state,
      slice: metaOrId.slice,
      summary: metaOrId.summary
    };
  }

  function getLineage(targetIdOrMeta, maxHops = 6) {
    const seed = typeof targetIdOrMeta === 'string'
      ? byId.get(targetIdOrMeta)
      : (targetIdOrMeta ? extractItemContextMeta(targetIdOrMeta) : null);
    if (!seed || !seed.id) {
      return {
        ancestors: [],
        descendants: [],
        blocker: null,
        dependents: [],
        parentRef: null,
        siblings: [],
        driftSignals: []
      };
    }

    const ancestors = [];
    const seenUp = new Set([seed.id]);
    let curUp = seed.handedOffFrom || seed.recoveryFor || seed.replyTo;
    let hops = 0;
    while (curUp && !seenUp.has(curUp) && hops < maxHops) {
      seenUp.add(curUp);
      const hit = byId.get(curUp);
      ancestors.unshift(compactRef(hit || curUp));
      curUp = hit ? (hit.handedOffFrom || hit.recoveryFor || hit.replyTo) : '';
      hops++;
    }

    const descendants = [];
    const seenDown = new Set([seed.id]);
    let curDown = seed.handedOffTo;
    hops = 0;
    while (curDown && !seenDown.has(curDown) && hops < maxHops) {
      seenDown.add(curDown);
      const hit = byId.get(curDown);
      descendants.push(compactRef(hit || curDown));
      curDown = hit ? hit.handedOffTo : '';
      hops++;
    }

    const blocker = seed.blockedOnQitemId
      ? compactRef(seed.blockedOnQitemId)
      : (seed.blockedOn ? { id: '', from: '', to: seed.blockedOnSeat || '', state: 'blocked', slice: '', summary: seed.blockedOn } : null);

    const depIds = Array.from(dependentsById.get(seed.id) || []);
    const dependents = depIds.map(id => compactRef(id)).filter(Boolean);

    const parentRef = seed.parent ? compactRef(seed.parent) : null;
    const siblingPool = seed.slice ? (bySlice.get(seed.slice) || []) : [];
    const siblings = siblingPool
      .filter(s => s.id !== seed.id)
      .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
      .slice(0, 6)
      .map(s => compactRef(s));

    const chainItems = [
      ...ancestors.map(a => byId.get(a.id)).filter(Boolean),
      seed,
      ...descendants.map(d => byId.get(d.id)).filter(Boolean),
      ...siblingPool.filter(s => s.id !== seed.id)
    ];
    const driftSignals = getContextDriftSignals(chainItems);

    return {
      ancestors,
      descendants,
      blocker,
      dependents,
      parentRef,
      siblings,
      driftSignals
    };
  }

  return {
    byId,
    dependentsById,
    childrenByParent,
    bySlice,
    getLineage
  };
}

/**
 * Detects shared-context inconsistencies across tasks belonging to the same chain / slice:
 * - Multiple distinct body-context:<ref> packs across handoffs (context pack drift)
 * - Multiple distinct targetRepo bindings in the same slice
 * - Open upstream blockers still holding downstream work
 */
export function getContextDriftSignals(chainItems = []) {
  const items = Array.isArray(chainItems) ? chainItems : [];
  const signals = [];
  const contextPacks = new Set();
  const repos = new Set();
  const activeBlockers = [];

  for (const raw of items) {
    const m = raw && raw.hasSharedContext !== undefined ? raw : extractItemContextMeta(raw);
    if (m.bodyContextRef) contextPacks.add(m.bodyContextRef);
    if (m.targetRepo) repos.add(m.targetRepo);
    if ((m.blockedOn || m.blockedOnQitemId) && m.state !== 'done' && m.state !== 'canceled' && m.state !== 'terminal') {
      activeBlockers.push({ id: m.id, blockedOn: m.blockedOn || m.blockedOnQitemId, to: m.to });
    }
  }

  if (contextPacks.size > 1) {
    signals.push({
      kind: 'context_pack_drift',
      severity: 'warn',
      values: Array.from(contextPacks)
    });
  }
  if (repos.size > 1) {
    signals.push({
      kind: 'multi_repo_scope',
      severity: 'info',
      values: Array.from(repos)
    });
  }
  if (activeBlockers.length > 0) {
    signals.push({
      kind: 'active_blocker_chain',
      severity: 'warn',
      count: activeBlockers.length,
      items: activeBlockers.slice(0, 4)
    });
  }

  return signals;
}

/**
 * Filters rig decisions (*.tsv rows) relevant to a given slice / mission / project.
 */
export function matchRelatedDecisions(decisions = [], meta = {}) {
  if (!Array.isArray(decisions) || !decisions.length) return [];
  const tokens = [meta.slice, meta.mission, meta.project]
    .map(s => String(s || '').trim().toLowerCase())
    .filter(s => s.length >= 3);
  if (!tokens.length) return [];
  return decisions.filter(d => {
    const hay = `${d.slice || ''} ${d.decision || ''} ${d.reason || ''}`.toLowerCase();
    return tokens.some(tok => hay.includes(tok));
  }).slice(0, 5);
}
