/**
 * Pure zero-DOM domain module for the Command Palette (Cmd/Ctrl+K)
 * and Safe Queue Triage (ADR-0015).
 *
 * Design rules:
 *  - Deterministic fuzzy ranking (no deps), works in Node tests and browser ES modules.
 *  - Queue triage NEVER proposes destructive queue mutations (close / delete / reassign).
 *    Write-back actions are limited to the existing guarded `nudge_queue` prompt and are
 *    deduplicated per destination seat (one nudge per seat, never one per qitem).
 *  - Every palette item declares `risk: 'read' | 'write'`; UI must require explicit
 *    two-step confirmation for `write`.
 */

import { extractItemContextMeta } from './context-lineage.js';
import { isGanttItemNoise } from './gantt-model.js';

export const PALETTE_SCOPES = Object.freeze({
  '>': 'action',
  '@': 'seat',
  '#': 'queue',
  '/': 'nav'
});

export const QUEUE_STALE_PENDING_MS = 30 * 60 * 1000;
export const QUEUE_STUCK_IN_PROGRESS_MS = 2 * 60 * 60 * 1000;
export const PALETTE_RECENT_MAX = 8;
export const PALETTE_GROUP_ORDER = Object.freeze(['triage', 'queue', 'actions', 'seats', 'findings', 'slices', 'navigate']);

const TRIAGE_SEVERITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };

function toMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (!val) return 0;
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortSeat(seatId) {
  const s = String(seatId || '');
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

function fmtAge(ms, lang) {
  const ru = lang === 'ru';
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return ru ? `${min} мин` : `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return ru ? `${h} ч` : `${h}h`;
  return ru ? `${Math.floor(h / 24)} д` : `${Math.floor(h / 24)}d`;
}

/**
 * Splits a raw palette query into an optional scope prefix and free text.
 */
export function parsePaletteQuery(raw = '') {
  const str = String(raw || '').replace(/^\s+/, '');
  const first = str.charAt(0);
  if (first && PALETTE_SCOPES[first]) {
    return { scope: PALETTE_SCOPES[first], text: str.slice(1).trim() };
  }
  return { scope: 'all', text: str.trim() };
}

/**
 * Deterministic fuzzy subsequence score (higher = better, -1 = no match).
 * Bonuses: exact prefix, word-boundary hits, consecutive runs. Penalty: gaps & length.
 */
export function fuzzyScore(query, target) {
  const q = String(query || '').toLowerCase().trim();
  const t = String(target || '').toLowerCase();
  if (!q) return { score: 0, indices: [] };
  if (!t) return { score: -1, indices: [] };

  const directIdx = t.indexOf(q);
  if (directIdx >= 0) {
    const indices = [];
    for (let i = 0; i < q.length; i++) indices.push(directIdx + i);
    const boundary = directIdx === 0 || /[\s@/:._#-]/.test(t.charAt(directIdx - 1));
    return { score: 1000 + (directIdx === 0 ? 400 : 0) + (boundary ? 200 : 0) + q.length * 10 - Math.min(t.length, 200), indices };
  }

  let score = 0;
  let ti = 0;
  let prev = -2;
  const indices = [];
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q.charAt(qi);
    if (ch === ' ') continue;
    let found = -1;
    while (ti < t.length) {
      if (t.charAt(ti) === ch) { found = ti; break; }
      ti++;
    }
    if (found < 0) return { score: -1, indices: [] };
    const boundary = found === 0 || /[\s@/:._#-]/.test(t.charAt(found - 1));
    score += 10;
    if (boundary) score += 25;
    if (found === prev + 1) score += 15;
    else if (prev >= 0) score -= Math.min(10, found - prev - 1);
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  score -= Math.min(t.length, 200) * 0.1;
  return { score, indices };
}

/**
 * Multi-token AND match over title + subtitle + keywords. Returns best score or -1.
 */
function scoreItem(item, text) {
  const tokens = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, indices: [] };
  const title = String(item.title || '');
  const hay = `${title} ${item.subtitle || ''} ${(item.keywords || []).join(' ')}`;
  let total = 0;
  let titleIndices = [];
  for (const tok of tokens) {
    const inTitle = fuzzyScore(tok, title);
    const inHay = inTitle.score >= 0 ? inTitle : fuzzyScore(tok, hay);
    if (inHay.score < 0) return { score: -1, indices: [] };
    total += inTitle.score >= 0 ? inTitle.score * 1.5 : inHay.score;
    if (inTitle.score >= 0) titleIndices = titleIndices.concat(inTitle.indices);
  }
  return { score: total, indices: Array.from(new Set(titleIndices)).sort((a, b) => a - b) };
}

/**
 * Ranks palette items for a raw query (scope prefixes supported).
 * Empty query: contiguous groups in `groupOrder` (no interleaved headers),
 * then priority (triage severity) + MRU inside each group, then declared order.
 * Non-empty query: pure relevance ranking across groups.
 */
export function rankPaletteItems(items = [], rawQuery = '', { limit = 40, recentIds = [], groupOrder = PALETTE_GROUP_ORDER } = {}) {
  const { scope, text } = parsePaletteQuery(rawQuery);
  const recentRank = new Map((Array.isArray(recentIds) ? recentIds : []).map((id, i) => [id, i]));
  const scoped = (Array.isArray(items) ? items : []).filter(it => it && (scope === 'all' || it.kind === scope));
  const groupRank = new Map((Array.isArray(groupOrder) ? groupOrder : []).map((g, i) => [g, i]));

  const ranked = [];
  scoped.forEach((it, order) => {
    const m = scoreItem(it, text);
    if (m.score < 0) return;
    const recentBoost = recentRank.has(it.id) ? (PALETTE_RECENT_MAX - recentRank.get(it.id)) * (text ? 8 : 60) : 0;
    const priorityBoost = typeof it.priority === 'number' ? it.priority : 0;
    ranked.push({ ...it, score: m.score + recentBoost + priorityBoost, matchIndices: m.indices, _order: order });
  });

  if (!text) {
    // Contiguous groups: severity/MRU ordering applies inside each group only
    const gr = (it) => (groupRank.has(it.group) ? groupRank.get(it.group) : groupRank.size);
    ranked.sort((a, b) => (gr(a) - gr(b)) || (b.score - a.score) || (a._order - b._order));
  } else {
    ranked.sort((a, b) => (b.score - a.score) || (a._order - b._order));
  }
  return ranked.slice(0, Math.max(1, limit)).map(({ _order, ...rest }) => rest);
}

/**
 * Updates an MRU list of palette item ids (pure).
 */
export function pushRecentPaletteId(recentIds = [], id = '', max = PALETTE_RECENT_MAX) {
  const clean = String(id || '').trim();
  if (!clean) return Array.isArray(recentIds) ? recentIds.slice(0, max) : [];
  const next = [clean, ...(Array.isArray(recentIds) ? recentIds : []).filter(x => x !== clean)];
  return next.slice(0, max);
}

/**
 * Classifies open queue items into actionable, non-destructive triage findings.
 *
 * @param {Object} p
 * @param {Array} p.openQueue  raw OpenRig queue rows (qitemId, state, destinationSession, tsCreated...)
 * @param {Array} p.seats      ALL known fleet seats, including ones hidden from the graph (infra/kernel):
 *                             [{ id, state, shellExited, parked, needsInputCount, sessionStatus, intentionallyStopped }]
 * @param {number} p.nowMs
 * @param {string} p.lang
 */
export function triageQueueItems({ openQueue = [], seats = [], nowMs = Date.now(), lang = 'en', rigFilter = 'all' } = {}) {
  const ru = lang === 'ru';
  const seatById = new Map();
  for (const s of (Array.isArray(seats) ? seats : [])) {
    if (s && s.id) seatById.set(s.id, s);
  }

  const items = [];
  const seenIds = new Set();
  let noiseCount = 0;
  for (const raw of (Array.isArray(openQueue) ? openQueue : [])) {
    const meta = extractItemContextMeta(raw);
    if (!meta.id || seenIds.has(meta.id)) continue;
    seenIds.add(meta.id);
    const state = String(meta.state || '').toLowerCase();
    if (['done', 'closed', 'completed', 'cancelled', 'canceled'].includes(state)) continue;
    if (rigFilter && rigFilter !== 'all' && !String(meta.to).endsWith(`@${rigFilter}`) && !String(meta.from).endsWith(`@${rigFilter}`)) {
      continue;
    }
    // System sweep / opgate / recovery wake rows are daemon housekeeping, not operator work
    if (isGanttItemNoise(raw)) {
      noiseCount += 1;
      continue;
    }

    const createdMs = toMs(raw.tsCreated || raw.createdAt) || toMs(raw.tsUpdated || raw.updatedAt);
    const updatedMs = toMs(raw.tsUpdated || raw.updatedAt) || createdMs;
    const ageMs = createdMs ? Math.max(0, nowMs - createdMs) : 0;
    const idleMs = updatedMs ? Math.max(0, nowMs - updatedMs) : 0;
    const pickupState = String((raw.pickup && raw.pickup.state) || '').toLowerCase();
    const dest = seatById.get(meta.to) || null;
    const isInProgress = state === 'in-progress' || state === 'claimed' || pickupState === 'claimed' || pickupState === 'working';
    const destSession = String((dest && dest.sessionStatus) || '').toLowerCase();
    const destOffline = Boolean(dest) && ['exited', 'stopped', 'detached', 'dead'].includes(destSession);
    const destWorking = Boolean(dest) && (dest.state === 'working' || dest.state === 'running');

    let reason = null;
    let severity = 'p3';
    if (meta.to && !dest) {
      reason = 'orphan_destination';
      severity = 'p1';
    } else if (dest && dest.shellExited) {
      reason = 'destination_shell_exited';
      severity = 'p0';
    } else if (destOffline && !dest.intentionallyStopped) {
      reason = 'destination_offline';
      severity = 'p1';
    } else if (destOffline && dest.intentionallyStopped) {
      reason = 'destination_stopped';
      severity = 'p2';
    } else if (dest && (dest.state === 'urgent' || Number(dest.needsInputCount) > 0)) {
      reason = 'destination_hitl';
      severity = 'p0';
    } else if (meta.blockedOn || meta.waitingBlocker) {
      reason = 'blocked_on';
      severity = 'p2';
    } else if (dest && dest.parked && !destWorking) {
      reason = 'destination_parked';
      severity = 'p1';
    } else if (isInProgress && idleMs >= QUEUE_STUCK_IN_PROGRESS_MS) {
      reason = 'stuck_in_progress';
      severity = 'p2';
    } else if (!isInProgress && ageMs >= QUEUE_STALE_PENDING_MS) {
      reason = 'stale_pending';
      severity = destWorking ? 'p2' : 'p1';
    }
    if (!reason) continue;

    const ageTxt = fmtAge(ageMs, lang);
    const destShort = shortSeat(meta.to) || '?';
    const reasonText = {
      orphan_destination: ru ? `адресат ${destShort} отсутствует во флоте` : `destination ${destShort} not in fleet`,
      destination_shell_exited: ru ? `${destShort} вылетел в OS shell — очередь не разбирается` : `${destShort} exited to OS shell — queue not consumed`,
      destination_offline: ru ? `сессия ${destShort} не запущена (${destSession}) — очередь копится` : `${destShort} session is ${destSession} — queue piling up`,
      destination_stopped: ru ? `${destShort} остановлен намеренно — задачи ждут его запуска` : `${destShort} intentionally stopped — items wait for restart`,
      destination_hitl: ru ? `${destShort} ждёт HITL — очередь стоит` : `${destShort} waiting on HITL — queue stalled`,
      blocked_on: ru ? `заблокировано: ${meta.blockedOn || meta.waitingBlocker}` : `blocked on: ${meta.blockedOn || meta.waitingBlocker}`,
      destination_parked: ru ? `${destShort} в PARKED без wake-таймера` : `${destShort} parked without wake timer`,
      stuck_in_progress: ru ? `в работе без обновлений ${fmtAge(idleMs, lang)}` : `in progress with no update for ${fmtAge(idleMs, lang)}`,
      stale_pending: ru ? `не взято в работу ${ageTxt}` : `not picked up for ${ageTxt}`
    }[reason];

    items.push({
      qitemId: meta.id,
      from: meta.from,
      to: meta.to,
      slice: meta.slice,
      summary: meta.summary,
      state: meta.state,
      ageMs,
      idleMs,
      reason,
      severity,
      reasonText,
      blockedOnQitemId: meta.blockedOnQitemId || ''
    });
  }

  items.sort((a, b) =>
    (TRIAGE_SEVERITY_RANK[a.severity] - TRIAGE_SEVERITY_RANK[b.severity]) || (b.ageMs - a.ageMs)
  );

  // Seat-level safe remediation (dedup: max one nudge per destination seat, never for HITL/shell/orphan seats)
  const bySeat = new Map();
  for (const it of items) {
    if (!it.to) continue;
    if (!bySeat.has(it.to)) bySeat.set(it.to, { seatId: it.to, count: 0, reasons: new Set(), worst: 'p3' });
    const agg = bySeat.get(it.to);
    agg.count += 1;
    agg.reasons.add(it.reason);
    if (TRIAGE_SEVERITY_RANK[it.severity] < TRIAGE_SEVERITY_RANK[agg.worst]) agg.worst = it.severity;
  }

  const seatRemediations = [];
  for (const agg of bySeat.values()) {
    const reasons = Array.from(agg.reasons);
    let recommended = 'nudge_queue';
    if (reasons.includes('destination_shell_exited') || reasons.includes('destination_offline')) recommended = 'copy_restart';
    else if (reasons.includes('destination_hitl')) recommended = 'open_screen';
    else if (reasons.includes('orphan_destination') || reasons.includes('destination_stopped')) recommended = 'inspect_only';
    else if (reasons.every(r => r === 'blocked_on')) recommended = 'open_context';
    seatRemediations.push({
      seatId: agg.seatId,
      count: agg.count,
      worst: agg.worst,
      reasons,
      recommended,
      risk: recommended === 'nudge_queue' ? 'write' : 'read'
    });
  }
  seatRemediations.sort((a, b) => (TRIAGE_SEVERITY_RANK[a.worst] - TRIAGE_SEVERITY_RANK[b.worst]) || (b.count - a.count));

  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  for (const it of items) counts[it.severity] += 1;

  return { items, seatRemediations, counts, total: items.length, noiseCount };
}

/**
 * Builds the palette item index from the current fleet snapshot (pure data, no DOM).
 * Item: { id, kind, group, icon, title, subtitle, keywords, risk, action:{type, seatId, payload}, priority }
 */
export function buildPaletteIndex({
  seats = [],
  triage = null,
  slices = [],
  findings = [],
  lang = 'en',
  isLive = false
} = {}) {
  const ru = lang === 'ru';
  const out = [];
  const T = (en, rus) => (ru ? rus : en);

  // 1. Queue triage (highest priority when present)
  if (triage && Array.isArray(triage.seatRemediations)) {
    for (const rem of triage.seatRemediations) {
      const sevBoost = rem.worst === 'p0' ? 900 : rem.worst === 'p1' ? 600 : rem.worst === 'p2' ? 300 : 100;
      const sh = shortSeat(rem.seatId);
      if (rem.recommended === 'nudge_queue') {
        out.push({
          id: `triage:nudge:${rem.seatId}`,
          kind: 'queue',
          group: 'triage',
          icon: '📨',
          title: T(`Nudge ${sh} to process ${rem.count} stalled queue item(s)`, `Разбудить ${sh}: разобрать ${rem.count} зависш. задач(и)`),
          subtitle: T('Sends guarded rig queue list --owned prompt (one per seat)', 'Отправит защищённый промпт rig queue list --owned (один на сиденье)'),
          keywords: ['triage', 'nudge', 'queue', 'разбудить', 'очередь', rem.seatId, ...rem.reasons],
          risk: 'write',
          severity: rem.worst,
          action: { type: 'nudge_queue', seatId: rem.seatId, payload: '' },
          priority: sevBoost
        });
      } else if (rem.recommended === 'open_screen') {
        out.push({
          id: `triage:screen:${rem.seatId}`,
          kind: 'queue',
          group: 'triage',
          icon: '📺',
          title: T(`Unblock ${sh}: HITL is stalling ${rem.count} queue item(s)`, `Разблокировать ${sh}: HITL держит ${rem.count} задач(и)`),
          subtitle: T('Open live 80-line TMUX screen to answer the prompt', 'Открыть живой TMUX-экран (80 строк) и ответить на промпт'),
          keywords: ['triage', 'hitl', 'screen', 'экран', rem.seatId],
          risk: 'read',
          severity: rem.worst,
          action: { type: 'open_screen', seatId: rem.seatId, payload: '' },
          priority: sevBoost
        });
      } else if (rem.recommended === 'copy_restart') {
        out.push({
          id: `triage:restart:${rem.seatId}`,
          kind: 'queue',
          group: 'triage',
          icon: '♻️',
          title: T(`Copy restart for ${sh} (${rem.count} item(s) unconsumed)`, `Скопировать рестарт ${sh} (${rem.count} задач не разбираются)`),
          subtitle: `rig restart ${rem.seatId}`,
          keywords: ['triage', 'restart', 'shell', 'рестарт', rem.seatId],
          risk: 'read',
          severity: rem.worst,
          action: { type: 'clipboard', seatId: rem.seatId, payload: `rig restart ${rem.seatId}` },
          priority: sevBoost
        });
      }
    }
  }
  if (triage && Array.isArray(triage.items)) {
    triage.items.slice(0, 30).forEach(it => {
      const sevBoost = it.severity === 'p0' ? 500 : it.severity === 'p1' ? 350 : it.severity === 'p2' ? 150 : 50;
      out.push({
        id: `qitem:${it.qitemId}`,
        kind: 'queue',
        group: 'queue',
        icon: it.severity === 'p0' ? '🚨' : it.severity === 'p1' ? '⚠️' : '🧾',
        title: `${shortSeat(it.from) || '?'} → ${shortSeat(it.to) || '?'}: ${it.summary || it.qitemId.slice(-12)}`.slice(0, 140),
        subtitle: `[${it.severity.toUpperCase()}] ${it.reasonText}${it.slice ? ` • ${it.slice}` : ''} • #${it.qitemId.slice(-8)}`,
        keywords: [it.qitemId, it.slice, it.from, it.to, it.reason, 'qitem'],
        risk: 'read',
        severity: it.severity,
        action: { type: 'open_context', seatId: it.to, payload: it.qitemId },
        priority: sevBoost
      });
    });
  }

  // 2. Seats
  for (const s of (Array.isArray(seats) ? seats : [])) {
    if (!s || !s.id) continue;
    const st = s.shellExited ? 'shell' : (s.state || 'idle');
    const stLabel = {
      urgent: T('needs input', 'ждёт ввода'),
      working: T('working', 'в работе'),
      waiting: T('parked w/ work', 'parked с задачами'),
      shell: T('shell exited', 'shell упал'),
      idle: T('idle', 'спит')
    }[st] || st;
    const ctxTxt = typeof s.ctxPct === 'number' ? ` • CTX ${s.ctxPct}%` : '';
    out.push({
      id: `seat:${s.id}`,
      kind: 'seat',
      group: 'seats',
      icon: s.icon || '🤖',
      title: s.id,
      subtitle: `${stLabel}${ctxTxt}${s.role ? ` • ${s.role}` : ''}`,
      keywords: [shortSeat(s.id), s.role || '', s.harness || '', s.model || '', st],
      risk: 'read',
      action: { type: 'focus_seat', seatId: s.id, payload: '' },
      priority: st === 'urgent' || st === 'shell' ? 120 : (st === 'working' ? 20 : 0)
    });
    if (st === 'urgent') {
      out.push({
        id: `seat-screen:${s.id}`,
        kind: 'action',
        group: 'actions',
        icon: '📺',
        title: T(`Open screen: ${shortSeat(s.id)} (HITL)`, `Открыть экран: ${shortSeat(s.id)} (HITL)`),
        subtitle: T('Live 80-line TMUX + clickable prompt options', 'Живой TMUX (80 строк) + кликабельные опции промпта'),
        keywords: ['screen', 'tmux', 'hitl', 'экран', s.id],
        risk: 'read',
        action: { type: 'open_screen', seatId: s.id, payload: '' },
        priority: 200
      });
    }
    if (isLive && typeof s.ctxPct === 'number' && s.ctxPct >= 75 && st !== 'shell') {
      out.push({
        id: `seat-compact:${s.id}`,
        kind: 'action',
        group: 'actions',
        icon: '🧹',
        title: T(`Compact context: ${shortSeat(s.id)} (${s.ctxPct}%)`, `Сжать контекст: ${shortSeat(s.id)} (${s.ctxPct}%)`),
        subtitle: T('Sends /compact via guarded idempotent dispatch', 'Отправит /compact через защищённую идемпотентную отправку'),
        keywords: ['compact', 'context', 'ctx', 'сжать', s.id],
        risk: 'write',
        action: { type: 'compact_context', seatId: s.id, payload: '/compact' },
        priority: 90
      });
    }
  }

  // 3. Slices (navigate to Gantt)
  for (const sl of (Array.isArray(slices) ? slices : []).slice(0, 25)) {
    const name = String(sl || '').replace(/^slice:/, '').trim();
    if (!name) continue;
    out.push({
      id: `slice:${name}`,
      kind: 'nav',
      group: 'slices',
      icon: '📊',
      title: T(`Gantt: ${name}`, `Гант: ${name}`),
      subtitle: T('Focus slice handoff chain on Task Gantt', 'Фокус цепочки передач слайса на Ганте'),
      keywords: ['gantt', 'slice', 'гант', 'слайс', name],
      risk: 'read',
      action: { type: 'gantt_slice', seatId: '', payload: name },
      priority: 0
    });
  }

  // 4. Top findings (diagnosis)
  for (const f of (Array.isArray(findings) ? findings : []).slice(0, 10)) {
    if (!f || !f.title) continue;
    const seatId = (f.actionPlan && f.actionPlan.seatTarget) || (f.metrics && f.metrics.affectedSeats && f.metrics.affectedSeats[0]) || '';
    out.push({
      id: `finding:${f.id || f.title}`,
      kind: 'action',
      group: 'findings',
      icon: f.severity === 'p0_urgent' ? '🚨' : '💡',
      title: f.title,
      subtitle: String(f.summary || '').slice(0, 140),
      keywords: ['finding', 'advisor', f.category || '', seatId],
      risk: 'read',
      action: seatId ? { type: 'focus_seat', seatId, payload: '' } : { type: 'open_view', seatId: '', payload: 'advisor' },
      priority: f.severity === 'p0_urgent' ? 160 : (f.severity === 'p1_high' ? 80 : 0)
    });
  }

  // 5. Static navigation & view commands
  const NAV = [
    ['view:triage', '🧹', T('Queue triage (stalled & blocked handoffs)', 'Триаж очереди (зависшие и заблокированные передачи)'), 'queue_triage', ['triage', 'queue', 'триаж', 'очередь']],
    ['view:digest', '🌅', T('Shift catch-up digest', 'Сводка смены'), 'digest', ['digest', 'shift', 'catchup', 'смена', 'сводка']],
    ['view:advisor', '💡', T('Fleet Advisor findings', 'Советник флота: находки'), 'advisor', ['advisor', 'findings', 'советник']],
    ['view:health', '🩺', T('Fleet health & action plan', 'Здоровье флота и план действий'), 'health', ['health', 'plan', 'здоровье']],
    ['view:worktrees', '🌿', T('Git worktrees & conflicts', 'Git worktree и конфликты'), 'worktrees', ['git', 'worktree', 'conflict', 'конфликт']],
    ['view:budget', '💰', T('Budget & model pools (FinOps)', 'Бюджет и пулы моделей (FinOps)'), 'budget', ['budget', 'finops', 'cost', 'бюджет']],
    ['view:gantt', '📊', T('Toggle Task Gantt (G)', 'Переключить Гант задач (G)'), 'gantt', ['gantt', 'timeline', 'гант']],
    ['view:guardrails', '🛡️', T('Guardrails: circuit-breaker & Telegram', 'Предохранители: авто-тормоз и Telegram'), 'guardrails', ['guardrails', 'breaker', 'telegram']],
    ['view:calm', '🧘', T('Toggle Calm mode', 'Переключить Calm-режим'), 'calm', ['calm', 'focus', 'тихий']],
    ['view:refresh', '🔄', T('Force refresh telemetry', 'Принудительно обновить телеметрию'), 'refresh', ['refresh', 'reload', 'обновить']],
    ['view:lang', '🌐', T('Switch language EN/RU', 'Переключить язык EN/RU'), 'lang', ['language', 'lang', 'язык', 'en', 'ru']],
    ['view:tour', '🎓', T('SA-DSS guided tour (?)', 'Тур SA-DSS (?)'), 'tour', ['tour', 'help', 'тур', 'помощь']]
  ];
  for (const [id, icon, title, view, kw] of NAV) {
    out.push({
      id,
      kind: 'nav',
      group: 'navigate',
      icon,
      title,
      subtitle: '',
      keywords: kw,
      risk: 'read',
      action: { type: 'open_view', seatId: '', payload: view },
      priority: view === 'queue_triage' && triage && triage.total > 0 ? 140 : 0
    });
  }

  return out;
}
