/**
 * Privacy, Secret Redaction, Nonce Framing & Context Bundle Builder.
 * Strips ANSI escape sequences, API keys, JWTs, .env secrets, PEM blocks,
 * and optional user paths BEFORE any telemetry enters System 1 or System 2.
 */

import crypto from 'node:crypto';

const SECRET_PATTERNS = [
  {
    name: 'pem_block',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    mask: '[REDACTED:PEM]'
  },
  {
    name: 'api_key',
    re: /\b(sk-(?:proj-|live-|test-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[a-zA-Z0-9-]{16,}|ts_[a-zA-Z0-9_-]{16,})\b/g,
    mask: '[REDACTED:KEY]'
  },
  {
    name: 'bearer_or_jwt',
    re: /\b(Bearer\s+[A-Za-z0-9._~+/-]{12,}=*|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    mask: '[REDACTED:TOKEN]'
  },
  {
    name: 'env_assignment',
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH_KEY)[A-Z0-9_]*)\s*[:=]\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;]+)/gi,
    mask: '$1=[REDACTED:SECRET]'
  },
  {
    name: 'ipv4_ssh',
    re: /\b[a-zA-Z0-9._-]+@(?:\d{1,3}\.){3}\d{1,3}\b/g,
    mask: '[REDACTED:SSH_HOST]'
  }
];

export function stripAnsiAndRedact(rawText, { redactPaths = true } = {}) {
  let text = String(rawText || '').replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '');
  let redactionCount = 0;

  for (const rule of SECRET_PATTERNS) {
    text = text.replace(rule.re, (...args) => {
      redactionCount++;
      if (rule.mask.includes('$1') && args[1]) {
        return rule.mask.replace('$1', args[1]);
      }
      return rule.mask;
    });
  }

  if (redactPaths) {
    text = text.replace(/(?:\/Users|\/home)\/[^\s:'"`)\],]+/g, () => {
      redactionCount++;
      return '[REDACTED:USER_PATH]';
    });
  }

  return { text, redactionCount };
}

export function computeContextHash(obj) {
  return crypto
    .createHash('sha256')
    .update(typeof obj === 'string' ? obj : JSON.stringify(obj))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Wraps untrusted telemetry JSON in a per-call random-nonce tag so hostile terminal
 * output cannot close </UNTRUSTED_TELEMETRY_DATA> early.
 */
export function wrapUntrustedTelemetry(payloadObj, explicitNonce = null) {
  const nonce = explicitNonce || crypto.randomBytes(6).toString('hex');
  const rawJson = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj, null, 2);
  // Neutralize any accidental occurrence of the exact nonce tag inside payload
  const safeJson = rawJson.replaceAll(nonce, '[NONCE_REDACTED]');
  return {
    nonce,
    wrapped: `<UNTRUSTED_TELEMETRY_DATA nonce="${nonce}">\n${safeJson}\n</UNTRUSTED_TELEMETRY_DATA>`
  };
}

function clipLines(text, maxLines, maxChars) {
  const lines = String(text || '').split(/\r?\n/).slice(-maxLines);
  const joined = lines.join('\n').trim();
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/**
 * Builds compact sanitized state payload for System 1 (<= 2.2 KB).
 */
export function buildSystem1State({
  scope = 'seat',
  targetId = '',
  seat = null,
  screenText = '',
  openQueue = [],
  tier0 = null,
  redactPaths = true
} = {}) {
  const seatId = seat?.id || seat?.canonicalSessionName || targetId;
  const screenRedacted = stripAnsiAndRedact(clipLines(screenText, 45, 1300), { redactPaths });
  let redactionCount = screenRedacted.redactionCount;

  const queueItems = (Array.isArray(openQueue) ? openQueue : [])
    .filter(q => !seatId || q.destinationSession === seatId || q.to === seatId)
    .slice(0, 5)
    .map(q => {
      const s = stripAnsiAndRedact(String(q.summary || q.title || '').slice(0, 110), { redactPaths });
      redactionCount += s.redactionCount;
      return {
        id: q.qitemId || q.id || '',
        from: q.sourceSession || q.from || '',
        state: q.state || 'pending',
        summary: s.text
      };
    });

  const stateObj = {
    scope,
    targetId: seatId,
    seat: seat ? {
      id: seatId,
      harness: seat.harness || seat.runtime || '',
      state: seat.state || seat.activityState?.display || 'unknown',
      ctxPct: seat.ctxPct ?? seat.contextUsage?.usedPercentage ?? null,
      isParked: Boolean(seat.parkedData?.parked || seat.isParked),
      shellExited: Boolean(seat.shellExited)
    } : null,
    tier0Rules: tier0?.firedRules || [],
    failedActions: tier0?.failedActionIds || [],
    queueTop5: queueItems,
    tmuxTail45L: screenRedacted.text
  };

  const stateText = [
    `SEAT=${seatId} STATE=${stateObj.seat?.state || 'unknown'} CTX=${stateObj.seat?.ctxPct ?? 'n/a'}% PARKED=${Boolean(stateObj.seat?.isParked)} SHELL_EXITED=${Boolean(stateObj.seat?.shellExited)}`,
    `TIER0_RULES=${(stateObj.tier0Rules || []).join(',') || 'none'} FAILED_PREV=${(stateObj.failedActions || []).join(',') || 'none'}`,
    queueItems.length > 0 ? `QUEUE:\n${queueItems.map(q => `- [${q.state}] ${q.id} from ${q.from}: ${q.summary}`).join('\n')}` : 'QUEUE: empty',
    screenRedacted.text ? `TMUX_TAIL:\n${screenRedacted.text}` : 'TMUX_TAIL: empty'
  ].join('\n').slice(0, 2200);

  return {
    stateObj,
    stateText,
    redactionCount,
    contextHash: computeContextHash(stateObj)
  };
}

/**
 * Builds rich multi-entity sanitized bundle for System 2 (<= 14 KB)
 * plus ground-truth sets (allowedSeatIds, allowedRefIds) for anti-hallucination validation.
 */
export function buildSystem2Bundle({
  scope = 'seat',
  targetId = '',
  nodes = [],
  openQueue = [],
  ganttItems = [],
  handoffSequence = null,
  screenBySeat = {},
  auditRecords = [],
  tier0 = null,
  s1Verdict = null,
  fleetKpis = null,
  redactPaths = true
} = {}) {
  let redactionCount = 0;
  const allowedSeatIds = new Set();
  const allowedRefIds = new Set();

  const participantIds = new Set();
  if (scope === 'seat' && targetId) participantIds.add(targetId);
  if (handoffSequence && Array.isArray(handoffSequence.participants)) {
    for (const p of handoffSequence.participants.slice(0, 5)) participantIds.add(p);
  }
  for (const n of (Array.isArray(nodes) ? nodes : [])) {
    const sid = n?.canonicalSessionName || n?.id || n?.logicalId || '';
    if (sid) allowedSeatIds.add(sid);
  }
  if (participantIds.size === 0 && allowedSeatIds.size > 0) {
    for (const sid of Array.from(allowedSeatIds).slice(0, 4)) participantIds.add(sid);
  }

  const seatsSummary = (Array.isArray(nodes) ? nodes : [])
    .filter(n => {
      const sid = n?.canonicalSessionName || n?.id || '';
      return sid && (participantIds.size === 0 || participantIds.has(sid));
    })
    .slice(0, 5)
    .map(n => {
      const sid = n.canonicalSessionName || n.id;
      const rawScreen = screenBySeat[sid] || '';
      const redScreen = stripAnsiAndRedact(clipLines(rawScreen, 55, 1600), { redactPaths });
      redactionCount += redScreen.redactionCount;
      return {
        seatId: sid,
        harness: n.runtime || n.harness || '',
        model: n.model || n.modelObservation?.model || '',
        state: n.state || n.activityState?.display || 'unknown',
        ctxPct: n.ctxPct ?? n.contextUsage?.usedPercentage ?? null,
        isParked: Boolean(n.parkedData?.parked || n.isParked),
        shellExited: Boolean(n.shellExited),
        tmuxExcerpt: redScreen.text
      };
    });

  const queueRows = (Array.isArray(openQueue) ? openQueue : []).slice(0, 12).map(q => {
    const id = String(q.qitemId || q.id || '');
    if (id) allowedRefIds.add(id);
    const s = stripAnsiAndRedact(String(q.summary || q.title || '').slice(0, 140), { redactPaths });
    redactionCount += s.redactionCount;
    return {
      qitemId: id,
      from: q.sourceSession || q.from || '',
      to: q.destinationSession || q.to || '',
      state: q.state || 'pending',
      slice: q.slice || '',
      summary: s.text
    };
  });

  const flowSteps = (handoffSequence && Array.isArray(handoffSequence.steps) ? handoffSequence.steps : [])
    .slice(-15)
    .map(st => {
      if (st.id) allowedRefIds.add(String(st.id));
      const s = stripAnsiAndRedact(String(st.summary || '').slice(0, 140), { redactPaths });
      redactionCount += s.redactionCount;
      return {
        step: st.stepNum,
        qitemId: st.id || '',
        from: st.from || '',
        to: st.to || '',
        waitMin: Math.round((st.waitMs || 0) / 60_000),
        workMin: Math.round((st.workMs || 0) / 60_000),
        isBounceBack: Boolean(st.isBounceBack),
        summary: s.text
      };
    });

  if (flowSteps.length === 0 && Array.isArray(ganttItems) && ganttItems.length > 0) {
    for (const g of ganttItems.slice(-12)) {
      if (g.id) allowedRefIds.add(String(g.id));
    }
  }

  const auditSummary = (Array.isArray(auditRecords) ? auditRecords : []).slice(0, 10).map(r => ({
    execId: r.execId,
    actionId: r.actionId,
    seatId: r.targetSeatId,
    status: r.postconditionStatus,
    detail: String(r.postconditionDetail || '').slice(0, 100),
    at: r.executedAt
  }));

  const bundleObj = {
    scope,
    targetId,
    fleetKpis: fleetKpis || null,
    tier0: tier0 ? {
      riskLevel: tier0.riskLevel,
      uncertaintyU0: tier0.uncertaintyU0,
      firedRules: tier0.firedRules,
      hardVetoes: tier0.hardVetoes,
      failedActionIds: tier0.failedActionIds
    } : null,
    system1: s1Verdict ? {
      riskLevel: s1Verdict.riskLevel,
      confidence: s1Verdict.confidence,
      riskEntropy: s1Verdict.riskEntropy,
      escalationReasons: s1Verdict.escalationReasons || []
    } : null,
    participantSeats: seatsSummary,
    openQueue: queueRows,
    handoffFlow: flowSteps,
    recentActionAudit: auditSummary
  };

  let serialized = JSON.stringify(bundleObj, null, 2);
  if (serialized.length > 13_500) {
    // Trim tmux excerpts cleanly while preserving structured IDs & flow
    for (const s of bundleObj.participantSeats) {
      s.tmuxExcerpt = String(s.tmuxExcerpt || '').slice(-600);
    }
    serialized = JSON.stringify(bundleObj, null, 2).slice(0, 13_800);
  }

  const { nonce, wrapped } = wrapUntrustedTelemetry(serialized);
  return {
    bundleObj,
    wrapped,
    nonce,
    redactionCount,
    allowedSeatIds,
    allowedRefIds,
    contextHash: computeContextHash(bundleObj)
  };
}
