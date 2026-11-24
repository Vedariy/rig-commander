import crypto from 'node:crypto';

const POSTCONDITION_TIMEOUT_MS = 45_000;

export function inferActionId(type, payload) {
  const t = String(type || 'msg').trim();
  const p = String(payload || '').trim();
  if (t === 'raw' && p.startsWith('/compact')) return 'compact_context';
  if (t === 'raw' && /rig queue list\s+--owned/i.test(p)) return 'nudge_queue';
  if (t === 'key') {
    if (p === 'C-c') return 'interrupt_execution';
    if (p === 'Escape') return 'cancel_prompt';
    if (p === 'Enter') return 'wake_parked_seat';
    if (/^[1-9y]\s+Enter$/i.test(p)) return 'answer_prompt_option';
  }
  return 'send_message';
}

export function extractSeatBaseline(liveNode, parkedData) {
  if (!liveNode && !parkedData) return null;
  const cu = (liveNode && liveNode.contextUsage) || null;
  const act = (liveNode && liveNode.activityState) || {};
  const disp = act.display || (liveNode && liveNode.agentActivity && liveNode.agentActivity.state) || 'idle';
  return {
    ctxPct: cu && typeof cu.usedPercentage === 'number' ? cu.usedPercentage : null,
    displayState: disp,
    needsInputCount: (act.needsInput && act.needsInput.count) || 0,
    parked: Boolean(parkedData && parkedData.parked),
    lastActivityAt: (liveNode && liveNode.lastActivityAt) || null
  };
}

function evaluatePostcondition(rec, cur) {
  const base = rec.baseline || {};
  const id = rec.actionId;

  if (id === 'compact_context') {
    if (
      typeof cur.ctxPct === 'number' &&
      typeof base.ctxPct === 'number' &&
      (cur.ctxPct <= base.ctxPct - 10 || (base.ctxPct >= 65 && cur.ctxPct < 50))
    ) {
      return { verified: true, detail: `Контекст снизился: ${base.ctxPct}% → ${cur.ctxPct}%` };
    }
    return { verified: false };
  }

  if (id === 'answer_prompt_option' || id === 'proceed_prompt' || id === 'confirm_yes' || id === 'cancel_prompt') {
    if (cur.needsInputCount === 0 && cur.displayState !== 'needs-input') {
      return { verified: true, detail: `Вышел из NEEDS INPUT (${cur.displayState})` };
    }
    return { verified: false };
  }

  if (id === 'wake_parked_seat') {
    if (!cur.parked || (cur.lastActivityAt && cur.lastActivityAt !== base.lastActivityAt)) {
      return { verified: true, detail: !cur.parked ? 'Снят с PARKED' : 'Активность возобновлена' };
    }
    return { verified: false };
  }

  if (id === 'nudge_queue') {
    if (
      cur.displayState === 'working' ||
      cur.displayState === 'running' ||
      (base.parked && !cur.parked) ||
      (cur.lastActivityAt && cur.lastActivityAt !== base.lastActivityAt)
    ) {
      return { verified: true, detail: `Сиденье взяло очередь (${cur.displayState})` };
    }
    return { verified: false };
  }

  if (id === 'interrupt_execution') {
    if (cur.displayState !== 'working' && cur.displayState !== 'running') {
      return { verified: true, detail: `Выполнение остановлено (${cur.displayState})` };
    }
    return { verified: false };
  }

  // Generic message / manual command: verified if activity timestamp advances or state changes
  if (
    (cur.lastActivityAt && cur.lastActivityAt !== base.lastActivityAt) ||
    (cur.displayState && base.displayState && cur.displayState !== base.displayState)
  ) {
    return { verified: true, detail: `Сиденье отреагировало (${cur.displayState})` };
  }
  return { verified: false };
}

export class ActionAuditLog {
  constructor(options = {}) {
    this.maxRecords = options.maxRecords || 100;
    this.timeoutMs = options.timeoutMs || POSTCONDITION_TIMEOUT_MS;
    this.records = [];
  }

  record({ actionId, seatId, type, payload, httpStatus, ok, baseline = null, nowMs = Date.now() }) {
    const resolvedActionId = actionId || inferActionId(type, payload);
    const execId = `act-${nowMs.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const entry = {
      execId,
      actionId: resolvedActionId,
      targetSeatId: String(seatId || ''),
      transport: String(type || 'msg'),
      payloadPreview: String(payload || '').slice(0, 120),
      executedAt: new Date(nowMs).toISOString(),
      executedMs: nowMs,
      httpStatus: Number(httpStatus) || (ok ? 200 : 500),
      ok: Boolean(ok),
      baseline,
      postconditionStatus: ok ? 'pending' : 'failed',
      postconditionDetail: ok ? 'Ожидание подтверждения телеметрией…' : `Отклонено (HTTP ${httpStatus || 500})`,
      verifiedAt: null
    };
    this.records.unshift(entry);
    if (this.records.length > this.maxRecords) {
      this.records.length = this.maxRecords;
    }
    return entry;
  }

  reconcileWithTelemetry(nodes = [], parkedSeats = {}, nowMs = Date.now()) {
    if (this.records.length === 0) return;
    const nodeBySeat = new Map();
    for (const n of nodes) {
      if (n && n.canonicalSessionName) nodeBySeat.set(n.canonicalSessionName, n);
    }

    for (const rec of this.records) {
      if (rec.postconditionStatus !== 'pending') continue;
      const liveNode = nodeBySeat.get(rec.targetSeatId) || null;
      const parkedData = (parkedSeats && parkedSeats[rec.targetSeatId]) || null;
      if (liveNode || parkedData) {
        const cur = extractSeatBaseline(liveNode, parkedData);
        const check = evaluatePostcondition(rec, cur);
        if (check.verified) {
          rec.postconditionStatus = 'verified';
          rec.postconditionDetail = check.detail;
          rec.verifiedAt = new Date(nowMs).toISOString();
          continue;
        }
      }
      if (nowMs - rec.executedMs >= this.timeoutMs) {
        rec.postconditionStatus = 'unchanged';
        rec.postconditionDetail = `Состояние узла не изменилось за ${Math.round(this.timeoutMs / 1000)}с`;
      }
    }
  }

  list(limit = 30, seatId = null) {
    const filtered = seatId
      ? this.records.filter(r => r.targetSeatId === seatId)
      : this.records;
    return filtered.slice(0, Math.max(1, limit)).map(r => ({
      execId: r.execId,
      actionId: r.actionId,
      targetSeatId: r.targetSeatId,
      transport: r.transport,
      payloadPreview: r.payloadPreview,
      executedAt: r.executedAt,
      httpStatus: r.httpStatus,
      ok: r.ok,
      postconditionStatus: r.postconditionStatus,
      postconditionDetail: r.postconditionDetail,
      verifiedAt: r.verifiedAt
    }));
  }
}
