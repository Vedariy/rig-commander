#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { FleetIntelligenceEngine } from './lib/fleet-intelligence/index.mjs';
import { ActionAuditLog, extractSeatBaseline } from './lib/action-audit.mjs';
import { discoverUniversalFleet, buildUniversalGanttItems, isValidTmuxTarget } from './lib/universal-discovery.mjs';
import { BudgetCircuitBreaker } from './lib/circuit-breaker.mjs';
import { TelegramHitlBridge } from './lib/telegram-bridge.mjs';
import { RemoteAccessGuard, buildLiveManifest, detectTailscaleServeUrl } from './lib/remote-access.mjs';
import { SelfUpdater, RESTART_FOR_UPDATE_EXIT_CODE, readInstalledVersion } from './lib/self-update.mjs';
import { AiEvaluatorService } from './lib/ai-evaluator/index.mjs';
import { ServerIdempotencyCache, buildSeatSendKey } from './assets/domain/action-guard.js';
import { isPiHarness } from './assets/ontology/actions.js';
import { detectLiveHitlPrompt, detectTerminalIdleAtPrompt, classifyTerminalScreen, hasDirtyTerminalInputBox } from './assets/domain/prompt-parser.js';
import {
  extractItemContextMeta,
  extractContextArtifacts,
  buildSharedContextGraph,
  matchRelatedDecisions
} from './assets/domain/context-lineage.js';
import { collectFleetGitRadar } from './lib/git-radar.mjs';
import { ShiftHistoryStore } from './lib/shift-history.mjs';
import { SsePushHub, formatSseFrame } from './lib/sse-hub.mjs';
import { SafePlaybookEngine } from './lib/playbook-engine.mjs';
import { AutoConsentEngine, deriveSeatSessionEpoch } from './lib/auto-consent-engine.mjs';
import { stripAnsiAndRedact } from './lib/ai-evaluator/redactor.mjs';
import { FleetResilienceService } from './lib/resilience/index.mjs';
import { OpenRigResilienceProvider } from './lib/resilience/openrig-provider.mjs';
import { registerResilienceRoutes } from './lib/routes/resilience.mjs';
import { registerTelemetryRoutes } from './lib/routes/telemetry.mjs';
import { registerGuardrailRoutes } from './lib/routes/guardrails.mjs';
import { registerPlaybookRoutes } from './lib/routes/playbooks.mjs';
import { registerAutoConsentRoutes } from './lib/routes/auto-consent.mjs';
import { registerGitShiftRoutes } from './lib/routes/git-shift.mjs';

function resolveReadOnlyMode(env = process.env, argv = process.argv) {
  const rawEnv = String((env && env.RIGCOMMANDER_READ_ONLY) || '').trim().toLowerCase();
  return rawEnv === '1' || rawEnv === 'true' || (Array.isArray(argv) && argv.includes('--read-only'));
}

const READ_ONLY_MODE = resolveReadOnlyMode();
const READ_ONLY_ERROR_BODY = Object.freeze({
  ok: false,
  code: 'READ_ONLY_MODE',
  error: 'RigCommander is running in --read-only mode (terminal writes and mutations are disabled)'
});

// Per-process secret: injected into index.html on load, required on /api/send.
const DECK_TOKEN = crypto.randomBytes(24).toString('hex');
const fleetIntelligence = new FleetIntelligenceEngine({ maxSnapshots: 30, evalThrottleMs: 3000 });
const shiftHistory = new ShiftHistoryStore({ readOnly: READ_ONLY_MODE });
const actionAudit = new ActionAuditLog({
  maxRecords: 100,
  onRecordChange: (entry) => {
    // Resilience records the provider's final receipt in shift history itself.
    if (entry.transport !== 'resilience') shiftHistory.recordOperatorAction(entry);
  }
});
const aiEvaluator = new AiEvaluatorService();
const sendIdempotency = new ServerIdempotencyCache();
const latestSeatBaselines = new Map();
const universalTmuxTargets = new Map();
const terminalPromptProbeCache = new Map(); // seatId -> { ts, blocked, working, idleAtPrompt, reason, harness }
const TERMINAL_PROMPT_PROBE_ACTIVE_TTL_MS = 4000;
const TERMINAL_PROMPT_PROBE_TTL_MS = 10000;
const TERMINAL_PROMPT_PROBE_STALE_MAX_MS = 35000;
const TERMINAL_PROMPT_PROBE_CONCURRENCY = 3;
let terminalPromptProbeInFlight = null;
let latestFleetSnapshot = null;

async function captureSeatScreen(seat, lines = 38) {
  const lineCount = Math.min(200, Math.max(10, Number(lines) || 38));
  const universalTarget = universalTmuxTargets.get(seat);
  return universalTarget && isValidTmuxTarget(universalTarget)
    ? safeTextExec(TMUX_BIN, ['capture-pane', '-p', '-t', universalTarget, '-S', `-${lineCount}`])
    : safeTextExec(RIG_BIN, ['capture', seat, '--lines', String(lineCount)]);
}

const sseHub = new SsePushHub({ captureFn: captureSeatScreen });

function broadcastAutoConsentSse(eventName, data, rigId = 'all') {
  if (!sseHub || sseHub.eventClients.size === 0) return 0;
  const frame = formatSseFrame(eventName, data, String(++sseHub.eventSeq));
  let sent = 0;
  for (const c of Array.from(sseHub.eventClients)) {
    if (c.rigKey === 'all' || !rigId || rigId === 'all' || rigId === c.rigKey) {
      if (c.res && !c.res.writableEnded && !c.res.destroyed) {
        try {
          c.res.write(frame);
          sent++;
        } catch {
          sseHub._removeEventClient(c);
        }
      } else {
        sseHub._removeEventClient(c);
      }
    }
  }
  return sent;
}

function schedulePostActionSseRefresh(seatId, reason = 'send') {
  sseHub.notifyInvalidated(reason, seatId);
  if (seatId) {
    setTimeout(() => { sseHub.triggerSeatCaptureNow(seatId); }, 120).unref();
    setTimeout(() => { sseHub.triggerSeatCaptureNow(seatId); }, 520).unref();
  }
}

async function executeSeatKeyAction(seatId, keyStroke, actionId = '', evalId = null) {
  if (READ_ONLY_MODE) {
    return { ok: false, code: 'READ_ONLY_MODE', error: READ_ONLY_ERROR_BODY.error };
  }
  if (!/^[a-zA-Z0-9._@-]+$/.test(String(seatId || ''))) {
    return { ok: false, error: 'Invalid seat identifier' };
  }
  const keyArgs = parseAllowedTmuxKeys(keyStroke);
  const baseline = latestSeatBaselines.get(seatId) || null;
  if (!keyArgs) {
    actionAudit.record({ actionId, evalId, seatId, type: 'key', payload: keyStroke, httpStatus: 400, ok: false, baseline });
    return { ok: false, error: 'Disallowed tmux keystroke' };
  }
  const universalTarget = universalTmuxTargets.get(seatId);
  const tmuxTarget = universalTarget && isValidTmuxTarget(universalTarget) ? universalTarget : seatId;
  autoConsent.cancelPending({ seatId, recordOperatorCancel: true });
  const output = await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, ...keyArgs]);
  terminalPromptProbeCache.delete(seatId);
  invalidateTelemetryCache();
  const rec = actionAudit.record({ actionId, evalId, seatId, type: 'key', payload: keyStroke, httpStatus: 200, ok: true, baseline });
  schedulePostActionSseRefresh(seatId, 'key');
  return { ok: true, execId: rec.execId, output: (output || '').trim() };
}

/**
 * Pure helper: overlays live tmux prompt & idle probe results onto OpenRig daemon nodes.
 * 1) Catches terminal/agy/Gemini confirmation prompts where daemon still reports 'working'.
 * 2) Demotes false 'working' terminal seats (e.g. Antigravity CLI idle at empty prompt with 0 queue work) to 'idle'.
 */
function applyTerminalPromptProbes(nodes, probeResultsBySeat) {
  if (!Array.isArray(nodes) || !probeResultsBySeat) return nodes;
  return nodes.map(node => {
    const seatId = node && node.canonicalSessionName;
    if (!seatId) return node;
    const probe = probeResultsBySeat instanceof Map ? probeResultsBySeat.get(seatId) : probeResultsBySeat[seatId];
    if (!probe) return node;
    const curNeeds = (node.activityState && node.activityState.needsInput && node.activityState.needsInput.count) || 0;
    const curDisp = (node.activityState && node.activityState.display) || '';

    // Enrich terminal-hosted seats (e.g. Antigravity CLI) with detected harness & model when missing
    const enrichIdentity = (base) => {
      if (base.runtime !== 'terminal') return base;
      const nextHarness = (!base.detectedHarness && probe.harness && probe.harness !== 'generic')
        ? probe.harness
        : base.detectedHarness;
      const nextModel = (!base.model && probe.detectedModel)
        ? probe.detectedModel
        : base.model;
      if (nextHarness === base.detectedHarness && nextModel === base.model) return base;
      return {
        ...base,
        ...(nextHarness ? { detectedHarness: nextHarness } : {}),
        ...(nextModel ? { model: nextModel } : {})
      };
    };

    if (probe.blocked) {
      if (curNeeds > 0 || curDisp === 'needs-input') return enrichIdentity(node);
      return enrichIdentity({
        ...node,
        activityState: {
          ...(node.activityState || {}),
          activity: 'waiting-human',
          display: 'needs-input',
          needsInput: {
            count: 1,
            reason: probe.reason || 'permission_prompt',
            source: 'tmux-prompt-probe',
            harness: probe.harness || node.runtime || 'generic'
          }
        }
      });
    }

    if ((curNeeds > 0 || curDisp === 'needs-input') && !probe.blocked && (probe.idleAtPrompt || probe.working || probe.shellExited)) {
      const nextDisplay = probe.working ? 'working' : 'idle';
      const prevReason = (node.activityState && node.activityState.needsInput && node.activityState.needsInput.reason) || null;
      return enrichIdentity({
        ...node,
        ...(probe.shellExited ? { shellExited: true } : {}),
        needsAttention: false,
        arbitratedNeedsInput: false,
        activityState: {
          ...(node.activityState || {}),
          activity: probe.working ? 'working' : 'idle-at-prompt',
          display: nextDisplay,
          source: 'tmux-live-verify',
          needsInput: {
            count: 0,
            reason: null,
            clearedBy: 'tmux-live-verify',
            previousReason: prevReason
          }
        },
        agentActivity: node.agentActivity
          ? { ...node.agentActivity, state: probe.working ? 'running' : 'idle' }
          : node.agentActivity
      });
    }

    if (probe.working && curNeeds === 0 && curDisp === 'idle') {
      const hasWork = (Number(node.inProgressWorkCount) || 0) > 0 || (Number(node.assignedWorkCount) || 0) > 0;
      if (hasWork || node.runtime === 'terminal') {
        return enrichIdentity({
          ...node,
          activityState: {
            ...(node.activityState || {}),
            activity: 'working',
            display: 'working',
            source: 'tmux-work-probe'
          },
          agentActivity: node.agentActivity ? { ...node.agentActivity, state: 'running' } : node.agentActivity
        });
      }
    }

    if (probe.idleAtPrompt && node.runtime === 'terminal') {
      const hasWork = (Number(node.inProgressWorkCount) || 0) > 0 || (Number(node.assignedWorkCount) || 0) > 0;
      const looksWorking = curDisp === 'working' || curDisp === 'running' || (node.agentActivity && node.agentActivity.state === 'running');
      if (!hasWork && looksWorking && curNeeds === 0) {
        return enrichIdentity({
          ...node,
          activityState: {
            ...(node.activityState || {}),
            display: 'idle',
            source: 'tmux-idle-probe'
          },
          agentActivity: node.agentActivity ? { ...node.agentActivity, state: 'idle' } : node.agentActivity
        });
      }
    }

    if (probe.shellExited) {
      return enrichIdentity({
        ...node,
        shellExited: true
      });
    }

    return enrichIdentity(node);
  });
}

async function runWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const cap = Math.max(1, Math.min(limit || 3, items.length));
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: cap }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await worker(items[idx], idx);
      }
    })
  );
  return results;
}

function refreshTerminalProbesBackground(staleCandidates) {
  if (!staleCandidates.length || terminalPromptProbeInFlight) return terminalPromptProbeInFlight;
  const runTs = Date.now();
  terminalPromptProbeInFlight = runWithConcurrency(staleCandidates, TERMINAL_PROMPT_PROBE_CONCURRENCY, async (n) => {
    const seatId = n.canonicalSessionName;
    try {
      const screen = await captureSeatScreen(seatId, 72);
      const verdict = classifyTerminalScreen(screen || '', n.runtime || n.harness || '');
      const entry = {
        ts: Date.now() || runTs,
        blocked: verdict.blocked,
        working: verdict.working,
        idleAtPrompt: verdict.idleAtPrompt,
        shellExited: Boolean(verdict.shellExited),
        reason: verdict.reason,
        harness: verdict.harness,
        detectedModel: verdict.detectedModel || ''
      };
      boundedMapSet(terminalPromptProbeCache, seatId, entry, MAX_GUIDANCE_CACHE);
    } catch {
      // non-blocking probe failure
    }
  }).finally(() => {
    terminalPromptProbeInFlight = null;
  });
  return terminalPromptProbeInFlight;
}

async function enrichOpenRigTerminalPrompts(nodes, { allowBackgroundSWR = true } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes;
  const now = Date.now();
  const candidates = nodes
    .filter(n => {
      const id = n && n.canonicalSessionName;
      if (!id || id.includes('operator-human') || id.includes('queue-worker') || id.includes('context-guardian')) return false;
      const curNeeds = (n.activityState && n.activityState.needsInput && n.activityState.needsInput.count) || 0;
      const curDisp = (n.activityState && n.activityState.display) || '';
      const isClaimedNeedsInput = curNeeds > 0 || curDisp === 'needs-input';
      const isTerminalRuntime = n.runtime === 'terminal';
      const isActive = curDisp === 'working' || curDisp === 'running' || (n.agentActivity && n.agentActivity.state === 'running');
      const hasOpenWork = (Number(n.assignedWorkCount) || 0) > 0 || (Number(n.inProgressWorkCount) || 0) > 0;
      const isRunningSession = n.sessionStatus === 'running' || n.lifecycleState === 'running';
      return isClaimedNeedsInput || isTerminalRuntime || isActive || hasOpenWork || isRunningSession;
    })
    .sort((a, b) => {
      const score = n => {
        const d = (n.activityState && n.activityState.display) || '';
        const needs = ((n.activityState && n.activityState.needsInput && n.activityState.needsInput.count) || 0) > 0 || d === 'needs-input' ? 6 : 0;
        const act = (d === 'working' || d === 'running' || (n.agentActivity && n.agentActivity.state === 'running')) ? 4 : 0;
        const work = ((Number(n.inProgressWorkCount) || 0) > 0 || (Number(n.assignedWorkCount) || 0) > 0) ? 3 : 0;
        const term = n.runtime === 'terminal' ? 2 : 0;
        return needs + act + work + term;
      };
      return score(b) - score(a);
    })
    .slice(0, 16);

  if (candidates.length === 0) return nodes;

  const probeMap = new Map();
  const staleCandidates = [];
  let cachedCount = 0;
  for (const n of candidates) {
    const seatId = n.canonicalSessionName;
    const curDisp = (n.activityState && n.activityState.display) || '';
    const curNeeds = (n.activityState && n.activityState.needsInput && n.activityState.needsInput.count) || 0;
    const isHotSeat =
      curNeeds > 0 ||
      curDisp === 'needs-input' ||
      n.runtime === 'terminal' ||
      curDisp === 'working' ||
      curDisp === 'running' ||
      (n.agentActivity && n.agentActivity.state === 'running');
    const seatTtlMs = isHotSeat ? TERMINAL_PROMPT_PROBE_ACTIVE_TTL_MS : TERMINAL_PROMPT_PROBE_TTL_MS;
    const cached = terminalPromptProbeCache.get(seatId);
    if (cached && now - cached.ts < TERMINAL_PROMPT_PROBE_STALE_MAX_MS) {
      cachedCount++;
      if (cached.blocked || cached.working || cached.idleAtPrompt || cached.shellExited || (n.runtime === 'terminal' && (cached.detectedModel || (cached.harness && cached.harness !== 'generic')))) {
        probeMap.set(seatId, cached);
      }
      if (now - cached.ts >= seatTtlMs) {
        staleCandidates.push(n);
      }
    } else {
      staleCandidates.push(n);
    }
  }

  if (staleCandidates.length > 0) {
    const bg = refreshTerminalProbesBackground(staleCandidates);
    // On cold start (no cached probes at all) and when caller opts out of SWR, wait; otherwise never block HTTP!
    if (!allowBackgroundSWR && cachedCount === 0 && bg) {
      await bg;
      for (const n of staleCandidates) {
        const entry = terminalPromptProbeCache.get(n.canonicalSessionName);
        if (entry && (entry.blocked || entry.working || entry.idleAtPrompt || entry.shellExited || (n.runtime === 'terminal' && (entry.detectedModel || (entry.harness && entry.harness !== 'generic'))))) {
          probeMap.set(n.canonicalSessionName, entry);
        }
      }
    }
  }

  return probeMap.size > 0 ? applyTerminalPromptProbes(nodes, probeMap) : nodes;
}

function formatTelegramFleetSummary(kind = 'status') {
  const snap = latestFleetSnapshot;
  const br = circuitBreaker.getState();
  if (!snap) return '💠 *RigCommander*\nNo live telemetry snapshot yet.';
  const nodes = snap.nodes || [];
  const urgent = nodes.filter(n => n.activityState && n.activityState.display === 'needs-input').length;
  const working = nodes.filter(n => n.activityState && (n.activityState.display === 'working' || n.activityState.display === 'running')).length;
  const usd = Number(snap.fleetUsageSummary && snap.fleetUsageSummary.totalEstUsd) || 0;
  const cachePct = Number(snap.fleetUsageSummary && snap.fleetUsageSummary.cachedPct) || 0;

  if (kind === 'budget') {
    const rows = Object.entries(snap.seatUsage || {})
      .sort((a, b) => (b[1].estUsd || 0) - (a[1].estUsd || 0))
      .slice(0, 6)
      .map(([id, u]) => `• \`${id}\`: ~$${(u.estUsd || 0).toFixed(2)} (${u.cachedPct || 0}% cache)`);
    return [
      `💰 *RigCommander FinOps Budget*`,
      `• Session Total: *~$${usd.toFixed(2)}* (burn: $${br.burnUsdPerHour.toFixed(2)}/h, cache: ${cachePct}%)`,
      `• Circuit-Breaker: \`${br.status.toUpperCase()}\` (${br.config.mode})`,
      `• Limits: session $${br.config.maxSessionUsd} · seat $${br.config.maxSeatUsd} · $${br.config.maxUsdPerHour}/h`,
      ...(rows.length ? ['', ...rows] : [])
    ].join('\n');
  }

  return [
    `💠 *RigCommander Fleet Status* (${snap.discoveryMode || 'live'})`,
    `• Seats: *${nodes.length}* (🟢 working: ${working}, 🚨 HITL: ${urgent})`,
    `• Spend: *~$${usd.toFixed(2)}* ($${br.burnUsdPerHour.toFixed(2)}/h · ${cachePct}% cache)`,
    `• Guardrail: \`${br.status.toUpperCase()}\` (${br.config.mode})`
  ].join('\n');
}

const telegramBridge = new TelegramHitlBridge({
  onExecuteAction: ({ seatId, keyStroke, actionId }) =>
    READ_ONLY_MODE
      ? Promise.resolve({ ok: false, code: 'READ_ONLY_MODE', error: READ_ONLY_ERROR_BODY.error })
      : executeSeatKeyAction(seatId, keyStroke, actionId),
  getFleetSummary: (kind) => formatTelegramFleetSummary(kind),
  onBreakerModeToggle: (mode) => (READ_ONLY_MODE ? circuitBreaker.getState() : circuitBreaker.updateConfig({ mode })),
  onPauseAutoConsent: () => (READ_ONLY_MODE ? { ok: false, code: 'READ_ONLY_MODE' } : autoConsent.pauseAll(true))
});

const circuitBreaker = new BudgetCircuitBreaker(
  {
    mode: (!READ_ONLY_MODE && process.env.RIG_BREAKER_MODE === 'auto_stop') ? 'auto_stop' : 'alert_only',
    maxSessionUsd: process.env.RIG_MAX_SESSION_USD ? Number(process.env.RIG_MAX_SESSION_USD) : undefined,
    maxSeatUsd: process.env.RIG_MAX_SEAT_USD ? Number(process.env.RIG_MAX_SEAT_USD) : undefined,
    maxUsdPerHour: process.env.RIG_MAX_USD_PER_HOUR ? Number(process.env.RIG_MAX_USD_PER_HOUR) : undefined,
    maxQaRounds: process.env.RIG_MAX_QA_ROUNDS ? Number(process.env.RIG_MAX_QA_ROUNDS) : undefined
  },
  {
    onAutoInterrupt: async (seatId) => {
      if (READ_ONLY_MODE) return false;
      const res = await executeSeatKeyAction(seatId, 'C-c', 'circuit_breaker_interrupt');
      return Boolean(res && res.ok);
    },
    onTrip: async (trip) => {
      if (READ_ONLY_MODE) return;
      await telegramBridge.notifyCircuitBreakerTrip(trip);
    }
  }
);

async function executePlaybookRawAction(cand) {
  if (READ_ONLY_MODE) {
    return { ok: false, code: 'READ_ONLY_MODE', detail: READ_ONLY_ERROR_BODY.error };
  }
  const seat = String((cand && cand.seatId) || '').trim();
  const cleanText = String((cand && cand.payload) || '').replace(/[\r\n]+/g, ' ').trim();
  if (!/^[a-zA-Z0-9._@-]+$/.test(seat) || !cleanText) {
    return { ok: false, detail: 'Invalid seat or payload' };
  }
  const baseline = latestSeatBaselines.get(seat) || null;
  const universalTarget = universalTmuxTargets.get(seat) || null;
  const rawRes = await dispatchRawCommand({ seat, cleanText, universalTarget });
  const evalId = `playbook:${cand.ruleId}`;
  if (!rawRes.ok) {
    actionAudit.record({
      actionId: cand.actionId,
      evalId,
      seatId: seat,
      type: 'raw',
      payload: cleanText,
      httpStatus: rawRes.statusCode || 409,
      ok: false,
      baseline
    });
    return { ok: false, detail: rawRes.error || `Rejected (${rawRes.statusCode || 409})` };
  }
  terminalPromptProbeCache.delete(seat);
  invalidateTelemetryCache();
  actionAudit.record({
    actionId: cand.actionId,
    evalId,
    seatId: seat,
    type: 'raw',
    payload: cleanText,
    httpStatus: 200,
    ok: true,
    baseline
  });
  schedulePostActionSseRefresh(seat, 'playbook');
  shiftHistory.recordGuardrailEvent({
    severity: 'info',
    rigId: 'all',
    seatId: seat,
    key: `playbook:${cand.ruleId}:${seat}:${Date.now()}`,
    title: `Playbook ${cand.ruleId} -> ${seat}`,
    detail: cand.reason || cleanText,
    meta: { ruleId: cand.ruleId, actionId: cand.actionId, via: rawRes.via || 'raw' }
  });
  return { ok: true, detail: `${cleanText.slice(0, 48)} (${rawRes.via || 'raw'})` };
}

const playbookEngine = new SafePlaybookEngine({
  ...(READ_ONLY_MODE ? { configPath: null, initialConfig: { enabled: false, mode: 'dry_run' } } : {}),
  onCompact: (cand) => executePlaybookRawAction(cand),
  onWake: async (cand) => {
    const res = await executeSeatKeyAction(cand.seatId, 'Enter', 'wake_parked_seat', `playbook:${cand.ruleId}`);
    if (res && res.ok) {
      shiftHistory.recordGuardrailEvent({
        severity: 'info',
        rigId: 'all',
        seatId: cand.seatId,
        key: `playbook:${cand.ruleId}:${cand.seatId}:${Date.now()}`,
        title: `Playbook wake -> ${cand.seatId}`,
        detail: cand.reason || 'Woke stale PARKED seat',
        meta: { ruleId: cand.ruleId, actionId: cand.actionId }
      });
    }
    return { ok: Boolean(res && res.ok), detail: (res && res.ok) ? 'Sent Enter (wake)' : ((res && res.error) || 'Wake failed') };
  },
  onNudge: (cand) => executePlaybookRawAction(cand),
  onNotify: async (cand) => {
    const ev = {
      severity: 'critical',
      rigId: 'all',
      seatId: cand.seatId || null,
      key: `playbook_sa:${cand.cooldownKey || cand.seatId}:${Date.now()}`,
      title: `🚨 Critical SA (${cand.seatId || 'fleet'})`,
      detail: cand.reason || 'Critical situational awareness alert',
      meta: { ruleId: cand.ruleId, source: 'playbook' }
    };
    shiftHistory.recordGuardrailEvent(ev);
    sseHub.publishShiftEvent(ev);
    if (!READ_ONLY_MODE && cand.notifyTelegram && telegramBridge.isConfigured()) {
      await telegramBridge.notifyCircuitBreakerTrip({
        rule: cand.ruleId,
        seatId: cand.seatId || 'fleet',
        severity: 'P0',
        title: `🚨 Critical SA: ${cand.seatId || 'fleet'}`,
        detail: cand.reason || 'Critical SA alert escalated',
        mode: 'alert_only',
        actionTaken: 'escalated'
      }).catch(() => {});
    }
    return {
      ok: true,
      detail: 'Escalated to Shift History + SSE' + (!READ_ONLY_MODE && cand.notifyTelegram && telegramBridge.isConfigured() ? ' + Telegram' : '')
    };
  }
});

function tokenMatches(got) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(DECK_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(zlib.gzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, '..');
const APP_VERSION = readInstalledVersion(INSTALL_ROOT, '3.2.0');
const PORT = Number(process.env.PORT || process.env.RIGCOMMANDER_PORT || 7440);
const BIND_HOST = process.env.RIGCOMMANDER_HOST || '127.0.0.1';
const remoteAccess = new RemoteAccessGuard({
  port: PORT,
  publicUrl: process.env.RIGCOMMANDER_PUBLIC_URL || '',
  readOnly: READ_ONLY_MODE
});
const selfUpdater = new SelfUpdater({
  currentVersion: APP_VERSION,
  installRoot: INSTALL_ROOT,
  onRestart: ({ installMode }) => {
    const finishExit = () => {
      if (process.env.RIGCOMMANDER_SUPERVISED === '1') {
        process.exit(RESTART_FOR_UPDATE_EXIT_CODE);
        return;
      }
      try {
        if (installMode === 'npx-cache') {
          const npxArgs = ['--yes', 'rig-commander@latest', '--no-open', '-p', String(PORT), '--host', BIND_HOST];
          if (READ_ONLY_MODE) npxArgs.push('--read-only');
          const child = spawn('npx', npxArgs, { detached: true, stdio: 'ignore', env: process.env });
          child.unref();
        } else {
          const respawnArgs = READ_ONLY_MODE
            ? [fileURLToPath(import.meta.url), '--read-only']
            : [fileURLToPath(import.meta.url)];
          const child = spawn(process.execPath, respawnArgs, {
            detached: true,
            stdio: 'ignore',
            env: process.env
          });
          child.unref();
        }
      } catch {
        // ignore detached respawn error
      }
      process.exit(0);
    };
    try {
      server.close(finishExit);
      setTimeout(finishExit, 1500).unref();
    } catch {
      finishExit();
    }
  }
});
const RIG_BIN = process.env.RIG_BIN || (process.env.HOME ? path.join(process.env.HOME, '.local/bin/rig') : 'rig');
const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const DAEMON_URL = process.env.OPENRIG_DAEMON_URL || 'http://127.0.0.1:7437';
const DECISIONS_DIR = process.env.OPENRIG_DECISIONS_DIR || (process.env.HOME ? path.join(process.env.HOME, 'openrig-lab/core-platform/decisions') : path.join(process.cwd(), 'decisions'));
const RIGS_TOPOLOGY_DIR = process.env.OPENRIG_TOPOLOGY_DIR || (process.env.HOME ? path.join(process.env.HOME, '.openrig/topology/rigs') : path.join(process.cwd(), '.openrig/topology/rigs'));

const DEFAULT_SEAT_GUIDANCE = {
  'dev-owner@core-platform': {
    roleName: 'Архитектор и Оркестратор',
    specRef: 'orchestration/orchestrator',
    duties: [
      'Ведёт продуктовые цели CorePlatform через слайсы очереди rig queue',
      'Оркестрация и декомпозиция задач (docs/tasks/<slice>.md)',
      'Локальная приёмка готовых кандидатов после вердикта dev-check (GREEN)',
      'Финальный прогон npm run e2e, git pull --rebase, коммит и git push в origin/dev'
    ],
    boundaries: [
      'Запрещён push в dev без зелёных тестов и независимого отчёта QA',
      'Запрещено передавать в работу слайс без согласованной постановки',
      'Не коммитит напрямую чужую недопроверенную работу'
    ],
    harness: 'codex (gpt-6.1-sol medium)',
    profile: 'sd-owner-chatgpt (ChatGPT OAuth Pro 100)',
    fallbackRoute: 'При исчерпании квоты: tools/owner-provider.sh -> APIKO Sol medium (prepaid)'
  },
  'dev-senior-architect@core-platform': {
    roleName: 'Старший Архитектор (Spec & Arch)',
    specRef: 'agents/senior-architect',
    duties: [
      'Проектирование схем БД, API и доменной декомпозиции (docs/adr/)',
      'Применение методологии arch-insight-analyzer и паттернов api-gateway',
      'Конвенции: TimeTick BIGINT primary keys, database-first, minimal tables',
      'Ревью интеграционных контрактов и архитектурных границ модулей'
    ],
    boundaries: [
      'Запрещено накатывать DDL/миграции или выполнять реальные записи в БД',
      'Запрещены бекенд-деплои, манипуляции с платежами и смена custody очереди',
      'Не коммитит и не пушит код'
    ],
    harness: 'codex (gpt-6.1-sol)',
    profile: 'default (OpenAI subscription)',
    fallbackRoute: 'Резерв: claude-code Sonnet / APIKO Terra'
  },
  'dev-operator@core-platform': {
    roleName: 'Оператор рига • Watchdog 15m',
    specRef: 'orchestration/orchestrator',
    duties: [
      'Периодический обход очереди и здоровья агентов каждые 15 минут',
      'Наблюдение за context-usage: превентивный компакт свободных агентов',
      'Контроль watchdog 75% на dev-check и маршрутизация задач',
      'Сверка зависших обязательств (parked seats diagnosis)'
    ],
    boundaries: [
      'Только чтение и координация: не пишет продуктовый код',
      'Не меняет статус задач в обход владельца очереди'
    ],
    harness: 'codex (gpt-6.1-sol medium)',
    profile: 'default',
    fallbackRoute: 'Watchdog scheduler в OpenRig daemon'
  },
  'dev-check@core-platform': {
    roleName: 'Доказательный QA • Проверяющий',
    specRef: 'development/qa',
    duties: [
      'Доказательная независимая проверка (proof, not code reading)',
      'Свой негативный контроль: временно ломает поведение, доказывая реакцию теста',
      'Обязательная таблица границ ввода (empty, negative, huge, wrong type, framing)',
      'Каждая находка P1–P3 воспроизводится падающим тестом в отчёте'
    ],
    boundaries: [
      'Браузерные прогоны — ТОЛЬКО через обёртку tools/check-pw (вне песочницы)',
      'Запрещены конвейеры shell (| && ;) — только одиночные команды',
      'Не правит код слайса сам — только findings с падающими тестами'
    ],
    harness: 'codex (deepseek-v4-pro / gpt-6.1-terra)',
    profile: 'sd-check (APIKO prepaid Terra high / Direct DeepSeek)',
    fallbackRoute: 'tools/check-provider.sh apiko|chatgpt (переключение за секунду)'
  },
  'dev-coder@core-platform': {
    roleName: 'Основной кодер (Main Copy)',
    specRef: 'development/implementer',
    duties: [
      'Реализация слайса строго по постановке docs/tasks/<slice>.md',
      'Локальные точечные тесты (npx vitest <file>, npx playwright test <spec>)',
      'Сдача через rig queue handoff на dev-check с описанием диффа',
      'Новый чистый контекст (/clear) на каждый новый слайс'
    ],
    boundaries: [
      'НЕ коммитит и НЕ пушит (это делает dev-owner после приёмки)',
      'Без shell-конвейеров (| && ;) — команды запускать по одной',
      'Запрещено читать и трогать .env*, ~/.ssh, секреты'
    ],
    harness: 'claude-code (glm-5.3-flash, 1M окно)',
    profile: 'GLM Coding Plan (flat)',
    fallbackRoute: 'Claude Sonnet 5.5 / Codex gpt-6.1-sol'
  },
  'dev-coder3@core-platform': {
    roleName: 'Кодер 3 (Pi Isolated)',
    specRef: 'development/implementer',
    duties: [
      'Параллельная реализация изолированных слайсов в core-platform-coder3',
      'Работа в рантайме Pi на DeepSeek flash',
      'Сдача диффа на dev-check по процедуре рига'
    ],
    boundaries: [
      'Не коммитит, не пушит, не трогает секреты',
      'Без shell конвейеров'
    ],
    harness: 'pi (deepseek-flash)',
    profile: 'DeepSeek API direct (Keychain key)',
    fallbackRoute: 'z.ai PAYG резервная запись в Pi'
  },
  'dev-coder4@core-platform': {
    roleName: 'Кодер 4 (Parallel Worktree)',
    specRef: 'development/implementer',
    duties: [
      'Параллельная реализация задач в core-platform-coder4',
      'Строгая TDD-разработка, локальные тесты vitest',
      'Handoff на dev-check'
    ],
    boundaries: [
      'Не коммитит, не пушит, не трогает секреты',
      'Без shell конвейеров'
    ],
    harness: 'codex (gpt-6.1-sol)',
    profile: 'default (OpenAI ChatGPT plan)',
    fallbackRoute: 'Делит квоту ChatGPT Pro 100 / резерв Sonnet'
  },
  'dev-coder5@core-platform': {
    roleName: 'Кодер 5 • Terminal Seat (AGY)',
    specRef: 'builtin:terminal',
    duties: [
      'Интерактивное терминальное сиденье agy (Antigravity CLI)',
      'Быстрая реализация и правка слайсов (режим accept-edits)',
      'Локальная верификация и handoff на dev-check'
    ],
    boundaries: [
      'Не коммитит напрямую, сдаёт через очередь на dev-check',
      'Не выходит за границы рабочей копии'
    ],
    harness: 'terminal / agy (Gemini 3.8 Flash / Gemini 4 Argon)',
    profile: 'Google AI Pro (OAuth via Antigravity)',
    fallbackRoute: 'Переключение моделей через agy /effort или /model'
  },
  'operator-agent@kernel': {
    roleName: 'Диспетчер ядра OpenRig',
    specRef: 'orchestration/orchestrator',
    duties: [
      'Координация уровня ядра OpenRig и мост между ригами',
      'Помощь человеку-оператору в формулировании команд рига',
      'Взаимодействие с dev-owner и queue-worker'
    ],
    boundaries: [
      'Не правит код сервисов продуктов',
      'Соблюдает границы ядра OpenRig'
    ],
    harness: 'codex (gpt-6.1-sol)',
    profile: 'default',
    fallbackRoute: 'TUI / operator-human'
  }
};

const seatGuidanceCache = new Map();
const transcriptUsageCache = new Map();
const MAX_GUIDANCE_CACHE = 200;
const MAX_TRANSCRIPT_CACHE = 100;

function boundedMapSet(map, key, value, maxSize) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

const MODEL_PRICING_PER_M = [
  { match: /opus/i, in: 15.0, cached: 1.5, out: 75.0, tier: 'Tier 3' },
  { match: /sonnet/i, in: 3.0, cached: 0.3, out: 15.0, tier: 'Tier 2' },
  { match: /haiku/i, in: 0.8, cached: 0.08, out: 4.0, tier: 'Tier 1' },
  { match: /gpt-6\.1-terra|terra|mini/i, in: 1.5, cached: 0.15, out: 6.0, tier: 'Tier 2' },
  { match: /gpt-6|gpt-5|codex|sol/i, in: 2.5, cached: 0.25, out: 15.0, tier: 'Tier 3' },
  { match: /glm|flash/i, in: 0.5, cached: 0.1, out: 2.0, tier: 'Tier 1' },
  { match: /deepseek|qwen/i, in: 0.28, cached: 0.03, out: 0.42, tier: 'Tier 1' }
];

function getModelPricing(modelName) {
  const m = String(modelName || '');
  return MODEL_PRICING_PER_M.find(p => p.match.test(m)) || { in: 2.0, cached: 0.2, out: 10.0, tier: 'Tier 2' };
}

function parseLineTimestampMs(obj) {
  const raw = (obj && (obj.timestamp || (obj.payload && obj.payload.timestamp))) || null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string' && raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function ingestTranscriptLine(line, state) {
  if (!line) return;
  if (!line.includes('token_count') && !line.includes('"usage"')) return;
  try {
    const obj = JSON.parse(line);
    const tsMs = parseLineTimestampMs(obj);
    if (tsMs) {
      if (!state.firstTsMs || tsMs < state.firstTsMs) state.firstTsMs = tsMs;
      if (!state.lastTsMs || tsMs > state.lastTsMs) state.lastTsMs = tsMs;
    }
    if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count' && obj.payload.info && obj.payload.info.total_token_usage) {
      const tot = obj.payload.info.total_token_usage;
      state.codexTotals = tot;
      if (tsMs) {
        const sample = {
          t: tsMs,
          in: Number(tot.input_tokens) || 0,
          cached: Number(tot.cached_input_tokens) || 0,
          out: Number(tot.output_tokens) || 0
        };
        const samples = state.codexSamples;
        const prev = samples[samples.length - 1];
        if (!prev || tsMs - prev.t >= 300_000) {
          samples.push(sample);
          if (samples.length > 400) samples.shift();
        } else {
          samples[samples.length - 1] = sample;
        }
      }
    } else if (obj.message && obj.message.usage) {
      const msgId = obj.message.id || `line-${state.claudeByMsgId.size}`;
      if (obj.message.model) state.lastModel = obj.message.model;
      state.claudeByMsgId.set(msgId, { ...obj.message.usage, _tsMs: tsMs });
    }
  } catch {
    // ignore malformed JSONL line
  }
}

function computeCodexWindowDelta(totals, samples, cutoffMs) {
  const curIn = Number(totals.input_tokens) || 0;
  const curCached = Number(totals.cached_input_tokens) || 0;
  const curOut = Number(totals.output_tokens) || 0;
  if (!Array.isArray(samples) || samples.length === 0) {
    const uncached = Math.max(0, curIn - curCached);
    return { inputTokens: curIn, uncachedInputTokens: uncached, cachedInputTokens: curCached, outputTokens: curOut, totalTokens: curIn + curOut };
  }
  const latest = samples[samples.length - 1];
  if (latest.t < cutoffMs) {
    return { inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  let base = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].t < cutoffMs) {
      base = samples[i];
      break;
    }
  }
  const dIn = base ? Math.max(0, curIn - base.in) : curIn;
  const dCached = base ? Math.max(0, Math.min(dIn, curCached - base.cached)) : curCached;
  const dUncached = Math.max(0, dIn - dCached);
  const dOut = base ? Math.max(0, curOut - base.out) : curOut;
  return { inputTokens: dIn, uncachedInputTokens: dUncached, cachedInputTokens: dCached, outputTokens: dOut, totalTokens: dIn + dOut };
}

function summarizeTranscriptState(state, nowMs = Date.now()) {
  const cut24h = nowMs - 86_400_000;
  const cut7d = nowMs - 7 * 86_400_000;
  const spanDays = (state.firstTsMs && state.lastTsMs && state.lastTsMs > state.firstTsMs)
    ? Math.max(1, Math.round(((state.lastTsMs - state.firstTsMs) / 86_400_000) * 10) / 10)
    : 1;

  if (state.codexTotals) {
    const totalInput = Number(state.codexTotals.input_tokens) || 0;
    const cachedInput = Number(state.codexTotals.cached_input_tokens) || 0;
    const uncachedInput = Math.max(0, totalInput - cachedInput);
    const output = Number(state.codexTotals.output_tokens) || 0;
    const sessionWin = { inputTokens: totalInput, uncachedInputTokens: uncachedInput, cachedInputTokens: cachedInput, outputTokens: output, totalTokens: totalInput + output };
    return {
      source: 'codex_jsonl',
      model: state.lastModel,
      ...sessionWin,
      spanDays,
      windows: {
        h24: computeCodexWindowDelta(state.codexTotals, state.codexSamples, cut24h),
        d7: computeCodexWindowDelta(state.codexTotals, state.codexSamples, cut7d),
        session: sessionWin
      }
    };
  }
  if (state.claudeByMsgId.size > 0) {
    const sumClaude = (minTs) => {
      let uncachedInput = 0;
      let cachedInput = 0;
      let output = 0;
      for (const u of state.claudeByMsgId.values()) {
        if (minTs > 0 && u._tsMs && u._tsMs < minTs) continue;
        uncachedInput += (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
        cachedInput += Number(u.cache_read_input_tokens) || 0;
        output += Number(u.output_tokens) || 0;
      }
      const totalInput = uncachedInput + cachedInput;
      return { inputTokens: totalInput, uncachedInputTokens: uncachedInput, cachedInputTokens: cachedInput, outputTokens: output, totalTokens: totalInput + output };
    };
    const sessionWin = sumClaude(0);
    return {
      source: 'claude_jsonl',
      model: state.lastModel,
      ...sessionWin,
      spanDays,
      windows: {
        h24: sumClaude(cut24h),
        d7: sumClaude(cut7d),
        session: sessionWin
      }
    };
  }
  return null;
}

async function readTranscriptTokenUsage(transcriptPath, nowMs = Date.now()) {
  if (!transcriptPath) return null;
  let fh = null;
  try {
    const stat = await fs.stat(transcriptPath);
    const cached = transcriptUsageCache.get(transcriptPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.data;
    }

    const canResume = Boolean(cached && stat.size >= cached.size && cached.offset <= stat.size);
    const state = canResume
      ? {
          codexTotals: cached.codexTotals,
          codexSamples: Array.isArray(cached.codexSamples) ? cached.codexSamples : [],
          claudeByMsgId: cached.claudeByMsgId,
          lastModel: cached.lastModel,
          firstTsMs: cached.firstTsMs || null,
          lastTsMs: cached.lastTsMs || null
        }
      : {
          codexTotals: null,
          codexSamples: [],
          claudeByMsgId: new Map(),
          lastModel: null,
          firstTsMs: null,
          lastTsMs: null
        };
    let readOffset = canResume ? cached.offset : 0;
    const bytesToRead = stat.size - readOffset;

    let tailLine = '';
    if (bytesToRead > 0) {
      const CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB bounded chunk avoids 100 MB single-buffer spikes
      fh = await fs.open(transcriptPath, 'r');
      const chunkBuf = Buffer.allocUnsafe(Math.min(bytesToRead, CHUNK_BYTES));
      let pos = readOffset;
      let remaining = bytesToRead;
      let remainder = Buffer.alloc(0);

      while (remaining > 0) {
        const toRead = Math.min(remaining, chunkBuf.length);
        const { bytesRead } = await fh.read(chunkBuf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        remaining -= bytesRead;

        const slice = chunkBuf.subarray(0, bytesRead);
        const combined = remainder.length > 0 ? Buffer.concat([remainder, slice]) : slice;
        const lastNl = combined.lastIndexOf(0x0a);
        if (lastNl !== -1) {
          const completeText = combined.subarray(0, lastNl + 1).toString('utf-8');
          for (const line of completeText.split('\n')) {
            ingestTranscriptLine(line, state);
          }
          readOffset += lastNl + 1;
          remainder = Buffer.from(combined.subarray(lastNl + 1));
        } else {
          remainder = Buffer.from(combined);
        }
      }
      if (remainder.length > 0) {
        tailLine = remainder.toString('utf-8').trim();
      }
    }

    let data;
    if (tailLine) {
      const snapState = {
        codexTotals: state.codexTotals,
        codexSamples: state.codexSamples.slice(),
        claudeByMsgId: new Map(state.claudeByMsgId),
        lastModel: state.lastModel,
        firstTsMs: state.firstTsMs,
        lastTsMs: state.lastTsMs
      };
      ingestTranscriptLine(tailLine, snapState);
      data = summarizeTranscriptState(snapState, nowMs);
    } else {
      data = summarizeTranscriptState(state, nowMs);
    }

    boundedMapSet(transcriptUsageCache, transcriptPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      offset: readOffset,
      codexTotals: state.codexTotals,
      codexSamples: state.codexSamples,
      claudeByMsgId: state.claudeByMsgId,
      lastModel: state.lastModel,
      firstTsMs: state.firstTsMs,
      lastTsMs: state.lastTsMs,
      data
    }, MAX_TRANSCRIPT_CACHE);
    return data;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function priceWindowUsage(win, pricing) {
  const uncached = Number(win && win.uncachedInputTokens) || 0;
  const cached = Number(win && win.cachedInputTokens) || 0;
  const output = Number(win && win.outputTokens) || 0;
  const totalInput = uncached + cached;
  const totalTokens = totalInput + output;
  const cachedPct = totalInput > 0 ? Math.round((cached / totalInput) * 100) : 0;
  const estUsd = (uncached / 1e6) * pricing.in + (cached / 1e6) * pricing.cached + (output / 1e6) * pricing.out;
  return {
    inputTokens: totalInput,
    uncachedInputTokens: uncached,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens,
    cachedPct,
    estUsd: Number(estUsd.toFixed(4))
  };
}

async function buildSeatUsageReport(nodes) {
  const seatUsage = {};
  let totalUncached = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalUsd = 0;
  const fleetWinAcc = {
    h24: { uncached: 0, cached: 0, output: 0, usd: 0 },
    d7: { uncached: 0, cached: 0, output: 0, usd: 0 },
    session: { uncached: 0, cached: 0, output: 0, usd: 0 }
  };

  await Promise.all((nodes || []).map(async (node) => {
    const seatId = node.canonicalSessionName || node.logicalId;
    if (!seatId) return;
    const cu = node.contextUsage || {};
    const parsed = await readTranscriptTokenUsage(cu.transcriptPath);
    const modelName = (node.modelObservation && node.modelObservation.model) || node.model || (parsed && parsed.model) || '';
    const pricing = getModelPricing(modelName);

    let uncached = 0;
    let cached = 0;
    let output = 0;
    let source = 'none';
    let spanDays = 1;
    let rawWindows = null;

    if (parsed) {
      uncached = parsed.uncachedInputTokens;
      cached = parsed.cachedInputTokens;
      output = parsed.outputTokens;
      source = parsed.source;
      spanDays = parsed.spanDays || 1;
      rawWindows = parsed.windows || null;
    } else if (typeof cu.totalInputTokens === 'number' || typeof cu.totalOutputTokens === 'number') {
      uncached = Number(cu.totalInputTokens) || 0;
      output = Number(cu.totalOutputTokens) || 0;
      source = 'daemon_ctx';
    } else {
      return;
    }

    const sessionPriced = priceWindowUsage({ uncachedInputTokens: uncached, cachedInputTokens: cached, outputTokens: output }, pricing);
    const h24Priced = rawWindows ? priceWindowUsage(rawWindows.h24, pricing) : sessionPriced;
    const d7Priced = rawWindows ? priceWindowUsage(rawWindows.d7, pricing) : sessionPriced;

    const profStr = `${node.codexConfigProfile || ''} ${node.profile || ''}`.toLowerCase();
    const inferredBillingMode = /(apiko|payg|direct|api-key)/i.test(profStr) ? 'payg' : 'sub';

    seatUsage[seatId] = {
      model: modelName || 'unknown',
      tier: pricing.tier,
      source,
      spanDays,
      inferredBillingMode,
      ...sessionPriced,
      windows: {
        h24: h24Priced,
        d7: d7Priced,
        session: sessionPriced
      }
    };

    totalUncached += uncached;
    totalCached += cached;
    totalOutput += output;
    totalUsd += sessionPriced.estUsd;
    for (const [wk, wObj] of [['h24', h24Priced], ['d7', d7Priced], ['session', sessionPriced]]) {
      fleetWinAcc[wk].uncached += wObj.uncachedInputTokens;
      fleetWinAcc[wk].cached += wObj.cachedInputTokens;
      fleetWinAcc[wk].output += wObj.outputTokens;
      fleetWinAcc[wk].usd += wObj.estUsd;
    }
  }));

  const summarizeFleetWin = (a) => {
    const inp = a.uncached + a.cached;
    return {
      totalTokens: inp + a.output,
      totalInputTokens: inp,
      totalUncachedInputTokens: a.uncached,
      totalCachedInputTokens: a.cached,
      totalOutputTokens: a.output,
      cachedPct: inp > 0 ? Math.round((a.cached / inp) * 100) : 0,
      totalEstUsd: Number(a.usd.toFixed(2))
    };
  };

  const totalInput = totalUncached + totalCached;
  const fleetUsageSummary = {
    totalTokens: totalInput + totalOutput,
    totalInputTokens: totalInput,
    totalUncachedInputTokens: totalUncached,
    totalCachedInputTokens: totalCached,
    totalOutputTokens: totalOutput,
    cachedPct: totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0,
    totalEstUsd: Number(totalUsd.toFixed(2)),
    seatCount: Object.keys(seatUsage).length,
    windows: {
      h24: summarizeFleetWin(fleetWinAcc.h24),
      d7: summarizeFleetWin(fleetWinAcc.d7),
      session: summarizeFleetWin(fleetWinAcc.session)
    }
  };

  return { seatUsage, fleetUsageSummary };
}

async function parseAgentsDoc(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    const lines = text.split('\n');
    const sections = {};
    let curRole = null;
    let curType = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const hMatch = line.match(/^##+\s+(.+)$/i);
      if (hMatch) {
        curRole = hMatch[1].toLowerCase();
        sections[curRole] = sections[curRole] || { duties: [], boundaries: [] };
        curType = 'duties';
        continue;
      }
      if (line.includes('Границы') || line.includes('Запрещено') || line.includes('Нельзя') || line.includes('boundaries')) {
        curType = 'boundaries';
      } else if (line.includes('Обязанности') || line.includes('duties')) {
        curType = 'duties';
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const item = line.replace(/^[-*]\s+/, '').trim();
        if (curRole && curType && item) {
          sections[curRole][curType].push(item);
        }
      }
    }
    return sections;
  } catch {
    return null;
  }
}

async function resolveSeatGuidance(seatId, liveNode) {
  if (DEFAULT_SEAT_GUIDANCE[seatId]) {
    return DEFAULT_SEAT_GUIDANCE[seatId];
  }
  if (seatGuidanceCache.has(seatId)) {
    return seatGuidanceCache.get(seatId);
  }

  const shortName = seatId.split('@')[0];
  const modelName = (liveNode && liveNode.modelObservation && liveNode.modelObservation.model) ||
                    (liveNode && liveNode.model) || 'unknown';
  const harnessName = (liveNode && liveNode.runtime) || 'terminal';

  let docDuties = [];
  let docBoundaries = [];
  if (liveNode && liveNode.cwd) {
    const candidates = [
      path.join(liveNode.cwd, 'AGENTS.md'),
      path.join(liveNode.cwd, 'CULTURE.md'),
      path.join(liveNode.cwd, 'docs', 'AGENTS.md')
    ];
    for (const cPath of candidates) {
      const parsed = await parseAgentsDoc(cPath);
      if (parsed) {
        for (const [key, sec] of Object.entries(parsed)) {
          if (key.includes(shortName.toLowerCase()) || 
              (shortName.includes('coder') && key.includes('кодер')) ||
              (shortName.includes('check') && key.includes('check')) ||
              (shortName.includes('owner') && (key.includes('owner') || key.includes('архитектор')))) {
            docDuties = sec.duties;
            docBoundaries = sec.boundaries;
            break;
          }
        }
        if (docDuties.length || docBoundaries.length) break;
      }
    }
  }

  let roleName = shortName;
  const duties = docDuties.length ? [...docDuties] : [];
  const boundaries = docBoundaries.length ? [...docBoundaries] : [];

  if (shortName.includes('owner') || shortName.includes('architect')) {
    roleName = 'Архитектор и Оркестратор';
    if (!duties.length) duties.push('Оркестрация и ведение задач через очередь rig queue', 'Приёмка готовых кандидатов', 'Контроль архитектурной целостности');
    if (!boundaries.length) boundaries.push('Запрещён push без зелёных тестов и проверки', 'Действует в рамках согласованных постановок');
  } else if (shortName.includes('check') || shortName.includes('qa')) {
    roleName = 'Доказательный QA • Проверяющий';
    if (!duties.length) duties.push('Доказательная независимая проверка гипотез', 'Негативный контроль и проверка граничных условий', 'Воспроизведение находок падающими тестами');
    if (!boundaries.length) boundaries.push('Не правит код слайса сам — только findings', 'Одиночные команды без неконтролируемых конвейеров');
  } else if (shortName.includes('coder')) {
    roleName = `Кодер (${shortName})`;
    if (!duties.length) duties.push('Реализация задач строго по постановке', 'Локальные точечные тесты перед сдачей', 'Handoff на проверяющего');
    if (!boundaries.length) boundaries.push('Не коммитит напрямую в прод-ветку', 'Не трогает секреты и файлы вне рабочей директории');
  } else if (shortName.includes('operator')) {
    roleName = 'Оператор рига';
    if (!duties.length) duties.push('Мониторинг очереди и здоровья агентов', 'Контроль context usage и триаж ситуаций', 'Сверка зависших обязательств (parked seats)');
    if (!boundaries.length) boundaries.push('Только чтение и координация: не пишет продуктовый код');
  } else {
    if (!duties.length) duties.push('Штатные обязанности агента OpenRig');
    if (!boundaries.length) boundaries.push('Действует в рамках прав своего воркспейса');
  }

  const result = {
    roleName,
    specRef: `rig/${shortName}`,
    duties,
    boundaries,
    harness: `${harnessName} (${modelName})`,
    profile: 'active-session',
    fallbackRoute: 'OpenRig daemon auto-rotation'
  };

  boundedMapSet(seatGuidanceCache, seatId, result, MAX_GUIDANCE_CACHE);
  return result;
}

async function sendJson(req, res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (acceptEncoding.includes('gzip')) {
    try {
      const gzipped = await gzipAsync(Buffer.from(jsonStr));
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-store'
      });
      res.end(gzipped);
      return;
    } catch {}
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(jsonStr);
}

async function readSeatCompactions() {
  const result = {};
  try {
    const rigs = await fs.readdir(RIGS_TOPOLOGY_DIR);
    for (const rigName of rigs) {
      if (rigName.startsWith('.')) continue;
      const seatsDir = path.join(RIGS_TOPOLOGY_DIR, rigName, 'seats');
      try {
        const seats = await fs.readdir(seatsDir);
        for (const seatName of seats) {
          if (seatName.startsWith('.')) continue;
          const fullSeatId = `${seatName}@${rigName}`;
          const seatPath = path.join(seatsDir, seatName);
          try {
            const files = await fs.readdir(seatPath);
            let count = 0;
            let recapSnippet = '';
            let recapText = '';
            if (files.includes('recap-superseded')) {
              try {
                const sup = await fs.readdir(path.join(seatPath, 'recap-superseded'));
                count += sup.filter(f => !f.startsWith('.')).length;
              } catch {}
            }
            if (files.includes('RECAP.md')) {
              count += 1;
              try {
                const content = await fs.readFile(path.join(seatPath, 'RECAP.md'), 'utf-8');
                const firstLine = content.split('\n').find(l => l.trim().length > 0 && !l.startsWith('#')) || '';
                recapSnippet = firstLine.slice(0, 160);
                recapText = content.trim().slice(0, 2400);
              } catch {}
            }
            result[fullSeatId] = {
              compactionsCount: count,
              recapSnippet: recapSnippet,
              recapText: recapText
            };
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return result;
}

let cachedRigs = { ts: 0, data: [] };
let rigsRefreshInFlight = null;
async function getRunningRigs() {
  const now = Date.now();
  const hasData = Array.isArray(cachedRigs.data) && cachedRigs.data.length > 0;
  if (hasData && now - cachedRigs.ts < 15000) {
    return cachedRigs.data;
  }
  const trigger = () => {
    if (!rigsRefreshInFlight) {
      rigsRefreshInFlight = safeJsonExec(RIG_BIN, ['ps', '--json'])
        .then(rigs => {
          if (Array.isArray(rigs) && rigs.length > 0) {
            cachedRigs = { ts: Date.now(), data: rigs };
          }
          return cachedRigs.data || [];
        })
        .finally(() => { rigsRefreshInFlight = null; });
    }
    return rigsRefreshInFlight;
  };
  if (hasData) {
    void trigger(); // stale-while-revalidate
    return cachedRigs.data;
  }
  return trigger();
}

const cachedParkedByKey = new Map(); // rigNamesKey -> { ts, data }
const parkedRefreshInFlight = new Map();
async function getParkedForRigs(rigs) {
  if (!Array.isArray(rigs) || rigs.length === 0) return [];
  const rigNames = rigs.map(r => r.name || r.rigName).filter(Boolean);
  const key = rigNames.slice().sort().join(',');
  const cached = cachedParkedByKey.get(key);
  const now = Date.now();
  if (cached && now - cached.ts < 10000) {
    return cached.data;
  }
  const trigger = () => {
    if (!parkedRefreshInFlight.has(key)) {
      const p = runWithConcurrency(rigNames, 2, (name) =>
        safeJsonExec(RIG_BIN, ['parked', '--rig', name, '--json'])
      )
        .then(data => {
          boundedMapSet(cachedParkedByKey, key, { ts: Date.now(), data }, 20);
          return data;
        })
        .finally(() => { parkedRefreshInFlight.delete(key); });
      parkedRefreshInFlight.set(key, p);
    }
    return parkedRefreshInFlight.get(key);
  };
  if (cached) {
    void trigger(); // stale-while-revalidate: never stall HTTP 1s for rig parked
    return cached.data;
  }
  return trigger();
}

let cachedCompactions = { ts: 0, data: null };
let compactionsRefreshInFlight = null;
async function getSeatCompactionsCached() {
  const now = Date.now();
  if (cachedCompactions.data && now - cachedCompactions.ts < 15000) {
    return cachedCompactions.data;
  }
  const trigger = () => {
    if (!compactionsRefreshInFlight) {
      compactionsRefreshInFlight = readSeatCompactions()
        .then(data => {
          cachedCompactions = { ts: Date.now(), data };
          return data;
        })
        .finally(() => { compactionsRefreshInFlight = null; });
    }
    return compactionsRefreshInFlight;
  };
  if (cachedCompactions.data) {
    void trigger();
    return cachedCompactions.data;
  }
  return trigger();
}

let cachedDecisions = { ts: 0, data: null };
let decisionsRefreshInFlight = null;
async function getRecentDecisionsCached(limit = 15, nodes = []) {
  const now = Date.now();
  if (cachedDecisions.data && now - cachedDecisions.ts < 15000) {
    return cachedDecisions.data;
  }
  const trigger = () => {
    if (!decisionsRefreshInFlight) {
      decisionsRefreshInFlight = readRecentDecisions(limit, nodes)
        .then(data => {
          cachedDecisions = { ts: Date.now(), data };
          return data;
        })
        .finally(() => { decisionsRefreshInFlight = null; });
    }
    return decisionsRefreshInFlight;
  };
  if (cachedDecisions.data) {
    void trigger();
    return cachedDecisions.data;
  }
  return trigger();
}

async function fetchDaemonJson(endpoint) {
  try {
    const res = await fetch(`${DAEMON_URL}${endpoint}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function safeJsonExec(bin, args) {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 10000, maxBuffer: 15 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

async function safeTextExec(bin, args) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 8000, maxBuffer: 5 * 1024 * 1024 });
    return stdout || stderr || '';
  } catch (err) {
    return (err && err.stdout) || (err && err.stderr) || (err && err.message) || '';
  }
}

async function execWithStatus(bin, args, timeoutMs = 20000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
    const output = (stdout || stderr || '').trim();
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '', output };
  } catch (err) {
    const stdout = (err && err.stdout) || '';
    const stderr = (err && err.stderr) || '';
    const output = (stdout || stderr || (err && err.message) || 'Command failed').trim();
    return { ok: false, code: typeof err?.code === 'number' ? err.code : 1, stdout, stderr, output };
  }
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const WRAPPER_REFUSAL_RE = /behind a wrapper|could not verify its expected .* agent/i;
const STALE_PROMPT_REFUSAL_RE = /is at an interactive prompt\b[^.\n]*(?:pane unrecognized|permission_request_unverified|PermissionPromptConfirmed|stale)/i;

async function sendPacedTmuxRaw({ target, cleanText, execFn, waitFn, tmuxBin }) {
  // Paced TUI-safe sequence (prevents Codex/Claude slash autocomplete race & partial C-u truncation)
  const escRes = await execFn(tmuxBin, ['send-keys', '-t', target, 'Escape'], 8000);
  if (!escRes.ok) {
    return { ok: false, statusCode: 409, output: escRes.output, error: escRes.output || 'tmux target unavailable' };
  }
  await waitFn(80);
  await execFn(tmuxBin, ['send-keys', '-t', target, 'C-e'], 8000);
  await execFn(tmuxBin, ['send-keys', '-t', target, 'C-u'], 8000);
  await waitFn(80);
  const literalRes = await execFn(tmuxBin, ['send-keys', '-t', target, '-l', cleanText], 8000);
  if (!literalRes.ok) {
    return { ok: false, statusCode: 409, output: literalRes.output, error: literalRes.output || 'tmux literal send failed' };
  }
  await waitFn(cleanText.startsWith('/') ? 320 : 240);
  const enterRes = await execFn(tmuxBin, ['send-keys', '-t', target, 'Enter'], 8000);
  if (!enterRes.ok) {
    return { ok: false, statusCode: 409, output: enterRes.output, error: enterRes.output || 'tmux Enter send failed' };
  }
  return { ok: true, statusCode: 200, output: enterRes.output };
}

/**
 * Safely dispatches raw slash commands & prompts (e.g. /compact, nudge_queue):
 * - For OpenRig-managed seats: delegates to native `rig send --raw <seat> <text>`, which handles
 *   two-step paste -> wait -> Enter and input-box / permission guards.
 *   If OpenRig refuses ONLY because the agent runs behind a bash wrapper script ("running behind a wrapper"),
 *   verifies via live screen capture that the pane is NOT a bare OS shell and NOT blocked on HITL, then
 *   delivers through the paced TUI-safe tmux sequence.
 * - For standalone universal tmux panes: runs the paced TUI-safe tmux sequence directly.
 */
async function dispatchRawCommand({
  seat,
  cleanText,
  universalTarget = null,
  execFn = execWithStatus,
  waitFn = sleepMs,
  captureScreenFn = (s) => captureSeatScreen(s, 36),
  rigBin = RIG_BIN,
  tmuxBin = TMUX_BIN
}) {
  if (READ_ONLY_MODE) {
    return {
      ok: false,
      statusCode: 403,
      code: 'READ_ONLY_MODE',
      output: '',
      error: READ_ONLY_ERROR_BODY.error
    };
  }
  if (!universalTarget) {
    const res = await execFn(rigBin, ['send', '--raw', seat, cleanText], 20000);
    if (res.ok) {
      return { ok: true, statusCode: 200, output: res.output, via: 'rig_raw' };
    }
    if (WRAPPER_REFUSAL_RE.test(res.output || '')) {
      const screen = await Promise.resolve(captureScreenFn(seat)).catch(() => '');
      const verdict = classifyTerminalScreen(screen || '');
      if (String(screen || '').trim() && !verdict.shellExited && !verdict.blocked) {
        const fb = await sendPacedTmuxRaw({ target: seat, cleanText, execFn, waitFn, tmuxBin });
        return { ...fb, via: 'tmux_wrapper_fallback' };
      }
      const guardReason = verdict.shellExited
        ? 'Live screen shows a bare OS shell (agent exited) — refusing to send prompt.'
        : verdict.blocked
          ? 'Live screen shows an active HITL permission prompt — resolve it first.'
          : res.output;
      return { ok: false, statusCode: 409, output: res.output, error: guardReason || res.output };
    }
    if (STALE_PROMPT_REFUSAL_RE.test(res.output || '')) {
      const screen = await Promise.resolve(captureScreenFn(seat)).catch(() => '');
      const verdict = classifyTerminalScreen(screen || '');
      if (String(screen || '').trim() && verdict.idleAtPrompt && !verdict.blocked && !verdict.shellExited && !verdict.working) {
        if (hasDirtyTerminalInputBox(screen)) {
          return {
            ok: false,
            statusCode: 409,
            output: res.output,
            error: `Input box on ${seat} already contains unsent text — clear it in tmux before sending ${cleanText}.`
          };
        }
        const fb = await sendPacedTmuxRaw({ target: seat, cleanText, execFn, waitFn, tmuxBin });
        return { ...fb, via: 'tmux_verified_idle_fallback' };
      }
      const guardReason = verdict.shellExited
        ? 'Live screen shows a bare OS shell (agent exited) — refusing to send prompt.'
        : verdict.blocked
          ? 'Live screen shows an active HITL permission prompt — resolve it first.'
          : res.output;
      return { ok: false, statusCode: 409, output: res.output, error: guardReason || res.output };
    }
    return {
      ok: false,
      statusCode: 409,
      output: res.output,
      error: res.output || `rig send --raw failed for ${seat}`
    };
  }

  const res = await sendPacedTmuxRaw({ target: universalTarget, cleanText, execFn, waitFn, tmuxBin });
  return { ...res, via: 'tmux_universal' };
}

async function readRecentDecisions(limit = 12, nodes = []) {
  try {
    let decisionsDir = process.env.OPENRIG_DECISIONS_DIR;
    if (!decisionsDir) {
      for (const n of nodes) {
        if (n && n.cwd) {
          const candidate = path.join(n.cwd, 'decisions');
          try {
            const st = await fs.stat(candidate);
            if (st.isDirectory()) { decisionsDir = candidate; break; }
          } catch {}
        }
      }
    }
    if (!decisionsDir) {
      decisionsDir = DECISIONS_DIR;
    }
    const files = (await fs.readdir(decisionsDir))
      .filter(f => f.endsWith('.tsv'))
      .sort()
      .reverse();
    const rows = [];
    for (const file of files.slice(0, 2)) {
      const content = await fs.readFile(path.join(decisionsDir, file), 'utf-8');
      const lines = content.trim().split('\n').reverse();
      for (const line of lines) {
        if (!line.trim() || line.startsWith('время\t')) continue;
        const cols = line.split('\t');
        if (cols.length >= 4) {
          rows.push({
            dateFile: file.replace('.tsv', ''),
            time: cols[0] || '',
            slice: cols[1] || '',
            decision: cols[2] || '',
            reason: cols[3] || '',
            evidence: cols[4] || '',
            outcome: cols[5] || ''
          });
          if (rows.length >= limit) return rows;
        }
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function extractTsFromQitemId(id) {
  const m = String(id || '').match(/^qitem-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

function computeHistoryStats(allQueue) {
  if (!Array.isArray(allQueue)) return { pairCounts: {}, pairEnvelopes: {}, coderStats: {}, sliceStats: {}, nodeTraffic: {} };
  const pairCounts = {};
  const pairEnvelopes = {};
  const sliceMap = {};
  const nodeTraffic = {};

  for (const q of allQueue) {
    const src = q.sourceSession || 'unknown';
    const dst = q.destinationSession || 'unknown';
    const sliceTag = (q.tags || []).find(t => t.startsWith('slice:'));
    const sName = sliceTag ? sliceTag.replace('slice:', '') : '';

    if (src && src !== 'unknown') {
      if (!nodeTraffic[src]) nodeTraffic[src] = { in: 0, out: 0 };
      nodeTraffic[src].out += 1;
    }
    if (dst && dst !== 'unknown') {
      if (!nodeTraffic[dst]) nodeTraffic[dst] = { in: 0, out: 0 };
      nodeTraffic[dst].in += 1;
    }

    if (src !== dst) {
      const key = [src, dst].sort().join(' <-> ');
      pairCounts[key] = (pairCounts[key] || 0) + 1;
      if (!pairEnvelopes[key]) pairEnvelopes[key] = [];
      if (pairEnvelopes[key].length < 20) {
        const qId = q.qitemId || q.id || '';
        const createdIso = q.tsCreated || q.createdAt || extractTsFromQitemId(qId);
        const updatedIso = q.tsUpdated || q.updatedAt || q.tsClosed || q.tsClaimed || createdIso;
        const ctxMeta = extractItemContextMeta(q);
        pairEnvelopes[key].push({
          id: qId,
          from: src,
          to: dst,
          slice: sName,
          state: q.state || 'done',
          pickupState: (q.pickup && q.pickup.state) || '',
          summary: q.summary || q.title || q.subject || '',
          createdAt: createdIso,
          updatedAt: updatedIso,
          blockedOn: ctxMeta.blockedOn,
          blockedOnQitemId: ctxMeta.blockedOnQitemId,
          handedOffFrom: ctxMeta.handedOffFrom,
          handedOffTo: ctxMeta.handedOffTo,
          parent: ctxMeta.parent,
          project: ctxMeta.project,
          mission: ctxMeta.mission,
          gate: ctxMeta.gate,
          bodyContextRef: ctxMeta.bodyContextRef,
          evidenceRef: ctxMeta.evidenceRef,
          targetRepo: ctxMeta.targetRepo
        });
      }
    }
    if (sliceTag) {
      if (!sliceMap[sName]) {
        sliceMap[sName] = { slice: sName, turns: 0, checkRounds: 0, coders: new Set(), rigs: new Set(), lastTs: '', lastSummary: q.summary || '' };
      }
      sliceMap[sName].turns += 1;
      if (dst.startsWith('dev-check@')) sliceMap[sName].checkRounds += 1;
      if (src.startsWith('dev-coder')) sliceMap[sName].coders.add(src);
      if (dst.startsWith('dev-coder')) sliceMap[sName].coders.add(dst);
      for (const sessId of [src, dst]) {
        const atIdx = sessId.lastIndexOf('@');
        if (atIdx > 0) {
          const rigKey = sessId.slice(atIdx + 1);
          if (rigKey && rigKey !== 'external' && rigKey !== 'human') {
            sliceMap[sName].rigs.add(rigKey);
          }
        }
      }
      const rowTs = q.tsUpdated || q.tsCreated || extractTsFromQitemId(q.qitemId) || '';
      if (rowTs && (!sliceMap[sName].lastTs || rowTs > sliceMap[sName].lastTs)) {
        sliceMap[sName].lastTs = rowTs;
        if (q.summary) sliceMap[sName].lastSummary = q.summary;
      }
    }
  }

  const coderSlices = {};
  for (const s of Object.values(sliceMap)) {
    const rounds = Math.max(1, s.checkRounds);
    for (const c of s.coders) {
      if (!coderSlices[c]) coderSlices[c] = [];
      coderSlices[c].push({ slice: s.slice, rounds, turns: s.turns });
    }
  }

  const coderStats = {};
  for (const [coder, list] of Object.entries(coderSlices)) {
    const roundsArr = list.slice(0, 6).map(x => x.rounds);
    const avg = roundsArr.length
      ? Number((roundsArr.reduce((a, b) => a + b, 0) / roundsArr.length).toFixed(1))
      : 1.0;
    const firstPass = roundsArr.length
      ? Math.round((roundsArr.filter(r => r === 1).length / roundsArr.length) * 100)
      : 100;
    const returnCount = roundsArr.filter(r => r > 1).length;
    coderStats[coder] = {
      avgRounds: avg,
      firstPassPct: `${firstPass}%`,
      recentRounds: roundsArr,
      sliceCount: list.length,
      returnCount
    };
  }

  return {
    pairCounts,
    pairEnvelopes,
    coderStats,
    nodeTraffic,
    ganttItems: buildGanttItems(allQueue),
    sliceStats: Object.fromEntries(
      Object.entries(sliceMap).map(([k, v]) => [k, { ...v, coders: Array.from(v.coders), rigs: Array.from(v.rigs || []) }])
    )
  };
}

const GANTT_OPEN_STATES = new Set(['pending', 'in-progress', 'claimed']);
const GANTT_STALE_OPEN_MS = 6 * 3600 * 1000;

function isGanttSystemNoise(q) {
  const id = q.qitemId || q.id || '';
  if (id.startsWith('qitem-opgate-')) return true;
  if (q.sourceSession === 'operator-change-detector@external') return true;
  if (Array.isArray(q.tags) && q.tags.includes('stuck-sweep-finding')) return true;
  return false;
}

function buildGanttItems(allQueue) {
  if (!Array.isArray(allQueue)) return [];
  const rows = allQueue.filter(q => q && q.destinationSession && (q.tsCreated || q.createdAt) && !isGanttSystemNoise(q));

  // Union-find over qitem links (handoff / recovery-for) to group untagged rows into chains
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const union = (a, b) => {
    if (!a || !b) return;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const q of rows) {
    const id = q.qitemId || q.id;
    if (!id) continue;
    if (!parent.has(id)) parent.set(id, id);
    for (const ref of [q.handedOffFrom, q.handedOffTo]) {
      if (typeof ref === 'string' && ref.startsWith('qitem-')) union(ref, id);
    }
    for (const t of (q.tags || [])) {
      const m = /^recovery-for:(qitem-[\w-]+)$/.exec(t);
      if (m) union(m[1], id);
    }
  }

  // Track next task createdAt per destinationSession to cap stale superseded open rows
  const byDestTimes = new Map();
  for (const q of rows) {
    const t = Date.parse(q.tsCreated || q.createdAt || '');
    if (!Number.isFinite(t)) continue;
    if (!byDestTimes.has(q.destinationSession)) byDestTimes.set(q.destinationSession, []);
    byDestTimes.get(q.destinationSession).push(t);
  }
  for (const arr of byDestTimes.values()) arr.sort((a, b) => a - b);

  const nowMs = Date.now();
  return rows.map(q => {
    const id = q.qitemId || q.id || '';
    const sliceTag = (q.tags || []).find(t => typeof t === 'string' && t.startsWith('slice:'));
    const slice = sliceTag ? sliceTag.slice('slice:'.length) : '';
    const state = q.state || 'done';
    const createdStr = q.tsCreated || q.createdAt || null;
    const createdMs = Date.parse(createdStr || '');
    const updatedStr = q.closedAt || q.tsUpdated || q.updatedAt || null;
    const lastTouchMs = Date.parse(updatedStr || q.claimedAt || createdStr || '');

    const destTimes = byDestTimes.get(q.destinationSession) || [];
    const nextCreatedMs = Number.isFinite(createdMs) ? destTimes.find(t => t > createdMs) : undefined;
    const hasLaterTask = Number.isFinite(nextCreatedMs);
    const isStaleOpen = Number.isFinite(lastTouchMs) && (nowMs - lastTouchMs > GANTT_STALE_OPEN_MS);

    let endAt = null;
    if (!GANTT_OPEN_STATES.has(state)) {
      endAt = updatedStr || q.claimedAt || createdStr;
    } else if (hasLaterTask || isStaleOpen) {
      endAt = updatedStr || (hasLaterTask ? new Date(nextCreatedMs).toISOString() : null) || q.claimedAt || createdStr;
    }

    const ctxMeta = extractItemContextMeta(q);
    return {
      id,
      from: q.sourceSession || '',
      to: q.destinationSession,
      chain: slice ? `slice:${slice}` : `q:${id ? find(id) : id}`,
      slice,
      summary: (q.summary || '').slice(0, 240),
      state,
      createdAt: createdStr,
      claimedAt: q.claimedAt || null,
      endAt,
      blockedOn: ctxMeta.blockedOn,
      blockedOnQitemId: ctxMeta.blockedOnQitemId,
      handedOffFrom: ctxMeta.handedOffFrom,
      handedOffTo: ctxMeta.handedOffTo,
      parent: ctxMeta.parent,
      project: ctxMeta.project,
      mission: ctxMeta.mission,
      gate: ctxMeta.gate,
      bodyContextRef: ctxMeta.bodyContextRef,
      evidenceRef: ctxMeta.evidenceRef,
      targetRepo: ctxMeta.targetRepo
    };
  });
}

let cachedHistory = { ts: 0, rev: '', data: null, rawQueue: [] };
let historyRefreshInFlight = null;
const queueItemDetailCache = new Map(); // qitemId -> { ts, payload }
const QUEUE_ITEM_DETAIL_TTL_MS = 8000;
const EMPTY_HISTORY = { pairCounts: {}, pairEnvelopes: {}, coderStats: {}, nodeTraffic: {}, sliceStats: {}, ganttItems: [] };

function computeHistoryFingerprint(allQueue) {
  if (!Array.isArray(allQueue) || allQueue.length === 0) return 'empty';
  const h = crypto.createHash('sha1');
  h.update(String(allQueue.length));
  for (let i = 0; i < allQueue.length; i++) {
    const q = allQueue[i];
    if (!q) continue;
    h.update('|');
    h.update(String(q.qitemId || q.id || ''));
    h.update(':');
    h.update(String(q.state || ''));
    h.update(':');
    h.update(String(q.closedAt || q.tsUpdated || q.updatedAt || q.claimedAt || q.tsCreated || ''));
  }
  return `h:${allQueue.length}:${h.digest('hex').slice(0, 12)}`;
}

async function getHistoryStats({ allowBackgroundSWR = true } = {}) {
  const now = Date.now();
  if (cachedHistory.data && now - cachedHistory.ts < 25000) {
    return { data: cachedHistory.data, rev: cachedHistory.rev };
  }
  const trigger = () => {
    if (!historyRefreshInFlight) {
      historyRefreshInFlight = safeJsonExec(RIG_BIN, ['queue', 'list', '-a', '-A', '--limit', '2500', '--json'])
        .then(allQueue => {
          const list = Array.isArray(allQueue) ? allQueue : [];
          const fp = computeHistoryFingerprint(list);
          if (cachedHistory.data && cachedHistory.rev === fp) {
            cachedHistory.ts = Date.now();
            return { data: cachedHistory.data, rev: cachedHistory.rev };
          }
          const data = computeHistoryStats(list);
          cachedHistory = { ts: Date.now(), rev: fp, data, rawQueue: list };
          return { data, rev: fp };
        })
        .finally(() => { historyRefreshInFlight = null; });
    }
    return historyRefreshInFlight;
  };
  if (cachedHistory.data && allowBackgroundSWR) {
    void trigger(); // stale-while-revalidate: never stall HTTP 4.4s on 2500-row history!
    return { data: cachedHistory.data, rev: cachedHistory.rev };
  }
  return trigger();
}

const telemetryCacheByRig = new Map(); // rigKey -> { ts, payload, historyRev, guidanceRev, gitRadarRev, variants }
const telemetryInFlightByRig = new Map();
const TELEMETRY_FRESH_TTL_MS = 2200;
const TELEMETRY_SWR_MAX_MS = 12000;
const GIT_RADAR_FRESH_TTL_MS = 12000;
const GIT_RADAR_SWR_MAX_MS = 60000;
const gitRadarCacheByKey = new Map(); // rigKey -> { ts, rev, data }
const gitRadarInFlightByKey = new Map();
const EMPTY_GIT_RADAR = {
  workspaces: [],
  bySeatId: {},
  conflicts: [],
  sharedWriteHazards: [],
  staleWorkspaces: [],
  unmergedWorkspaces: [],
  kpis: {
    totalWorkspaces: 0,
    dirtyWorkspaces: 0,
    totalDirtyFiles: 0,
    totalInsertions: 0,
    totalDeletions: 0,
    conflictFileCount: 0,
    highConflictCount: 0,
    unmergedCount: 0,
    sharedHazardCount: 0,
    staleBehindCount: 0
  },
  rev: 'git:empty',
  sampledAt: null
};
const staticAssetCache = new Map(); // filePath -> { mtimeMs, raw, gzip }
const STATIC_GZIP_EXTS = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.md', '.txt']);
let lastTelemetryClientAt = 0;

function getGitRadarCached(rigKey, nodes, { forceRefresh = false } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return Promise.resolve({ rev: EMPTY_GIT_RADAR.rev, data: EMPTY_GIT_RADAR });
  }
  const key = rigKey || 'all';
  const now = Date.now();
  const cached = gitRadarCacheByKey.get(key);
  if (!forceRefresh && cached && now - cached.ts < GIT_RADAR_FRESH_TTL_MS) {
    return Promise.resolve(cached);
  }
  const trigger = () => {
    if (!gitRadarInFlightByKey.has(key)) {
      const p = collectFleetGitRadar(nodes)
        .then(radar => {
          const entry = { ts: Date.now(), rev: radar.rev || 'git:empty', data: radar };
          boundedMapSet(gitRadarCacheByKey, key, entry, 12);
          return entry;
        })
        .catch(() => cached || { ts: Date.now(), rev: EMPTY_GIT_RADAR.rev, data: EMPTY_GIT_RADAR })
        .finally(() => { gitRadarInFlightByKey.delete(key); });
      gitRadarInFlightByKey.set(key, p);
    }
    return gitRadarInFlightByKey.get(key);
  };
  if (!forceRefresh && cached && now - cached.ts < GIT_RADAR_SWR_MAX_MS) {
    void trigger();
    return Promise.resolve(cached);
  }
  return trigger();
}

function invalidateTelemetryCache() {
  telemetryCacheByRig.clear();
  cachedParkedByKey.clear();
}

async function serializeTelemetryVariant(obj) {
  const json = JSON.stringify(obj);
  const gzip = await gzipAsync(Buffer.from(json, 'utf8')).catch(() => null);
  return { json, gzip };
}

async function assembleTelemetryBundle(requestedRig = 'all', { forceGit = false } = {}) {
  const rigKey = requestedRig || 'all';
  const allRigs = await getRunningRigs();

  const targetRigs = (rigKey === 'all')
    ? allRigs
    : allRigs.filter(r => r.rigId === rigKey || r.name === rigKey || r.rigName === rigKey);

  let effectiveRigs = targetRigs;
  if (effectiveRigs.length === 0) {
    const daemonRigs = await fetchDaemonJson('/api/rigs');
    if (Array.isArray(daemonRigs)) {
      const mapped = daemonRigs
        .filter(r => r && (r.id || r.rigId))
        .map(r => ({
          rigId: r.id || r.rigId,
          name: r.name || r.rigName || r.id,
          rigName: r.name || r.rigName || r.id
        }));
      effectiveRigs = (rigKey === 'all')
        ? mapped
        : mapped.filter(r => r.rigId === rigKey || r.name === rigKey);
    }
  }

  const forceUniversal = process.env.RIGCOMMANDER_FORCE_UNIVERSAL === '1';
  const nodesPromises = forceUniversal ? [] : effectiveRigs.map(r => fetchDaemonJson(`/api/rigs/${r.rigId}/nodes`));

  const [
    nodesArrays,
    parkedArrays,
    activeQueue,
    historyBundle,
    seatCompactions
  ] = await Promise.all([
    Promise.all(nodesPromises),
    forceUniversal ? Promise.resolve([]) : getParkedForRigs(effectiveRigs),
    forceUniversal ? Promise.resolve([]) : safeJsonExec(RIG_BIN, ['queue', 'list', '-A', '--json']),
    forceUniversal ? Promise.resolve({ data: EMPTY_HISTORY, rev: 'empty' }) : getHistoryStats({ allowBackgroundSWR: true }),
    forceUniversal ? Promise.resolve({}) : getSeatCompactionsCached()
  ]);

  const history = (historyBundle && historyBundle.data) || EMPTY_HISTORY;
  const historyRev = (historyBundle && historyBundle.rev) || 'empty';

  let nodes = nodesArrays.flatMap(arr => Array.isArray(arr) ? arr : []);
  let discoveryMode = nodes.length > 0 ? 'openrig' : 'none';
  let resolvedAvailableRigs = forceUniversal ? [] : allRigs.map(r => ({
    id: r.rigId,
    name: r.name || r.rigName,
    status: r.status,
    nodeCount: r.nodeCount,
    runningCount: r.runningCount,
    activeCount: r.activeCount,
    hasWorkCount: r.hasWorkCount
  }));

  let resolvedHistory = history || EMPTY_HISTORY;
  let resolvedHistoryRev = historyRev;
  if (nodes.length === 0) {
    const universal = await discoverUniversalFleet({ tmuxBin: TMUX_BIN });
    if (universal.nodes.length > 0) {
      discoveryMode = 'universal';
      universalTmuxTargets.clear();
      for (const [seatId, target] of universal.tmuxTargets.entries()) {
        if (isValidTmuxTarget(target)) {
          boundedMapSet(universalTmuxTargets, seatId, target, MAX_GUIDANCE_CACHE);
        }
      }
      resolvedAvailableRigs = universal.availableRigs;
      nodes = (rigKey === 'all')
        ? universal.nodes
        : universal.nodes.filter(n => n.rigId === rigKey);
      if (!Array.isArray(resolvedHistory.ganttItems) || resolvedHistory.ganttItems.length === 0) {
        resolvedHistory = {
          ...resolvedHistory,
          ganttItems: buildUniversalGanttItems(nodes)
        };
        resolvedHistoryRev = `univ:${resolvedHistory.ganttItems.length}`;
      }
    }
  }

  if (discoveryMode === 'openrig' && nodes.length > 0) {
    nodes = await enrichOpenRigTerminalPrompts(nodes, { allowBackgroundSWR: true });
  }

  const [decisions, usageReport, gitRadarBundle] = await Promise.all([
    getRecentDecisionsCached(15, nodes),
    buildSeatUsageReport(nodes),
    getGitRadarCached(rigKey, nodes, { forceRefresh: forceGit })
  ]);

  const guidanceMap = Object.assign({}, DEFAULT_SEAT_GUIDANCE);
  for (const node of nodes) {
    const seatName = node.canonicalSessionName || node.logicalId;
    if (seatName && !guidanceMap[seatName]) {
      guidanceMap[seatName] = await resolveSeatGuidance(seatName, node);
    }
  }
  const guidanceRev = 'g:' + crypto
    .createHash('sha1')
    .update(Object.keys(guidanceMap).sort().join('|'))
    .digest('hex')
    .slice(0, 12);

  const parkedSeats = {};
  for (const p of parkedArrays) {
    if (p && p.rig && Array.isArray(p.rig.seats)) {
      for (const s of p.rig.seats) {
        if (s.sessionName) {
          parkedSeats[s.sessionName] = {
            parked: s.parked === true,
            reason: s.reason || '',
            heldCount: (s.obligations && s.obligations.heldCount) || 0,
            openCount: (s.obligations && s.obligations.openCount) || 0,
            unhealthyHeldCount: (s.obligations && s.obligations.unhealthyHeldCount) || 0
          };
        }
      }
    }
  }

  for (const node of nodes) {
    const seatId = node && node.canonicalSessionName;
    if (seatId) {
      boundedMapSet(latestSeatBaselines, seatId, extractSeatBaseline(node, parkedSeats[seatId] || null), MAX_GUIDANCE_CACHE);
    }
  }
  actionAudit.reconcileWithTelemetry(nodes, parkedSeats);

  const payload = {
    timestamp: new Date().toISOString(),
    requestedRig: rigKey,
    discoveryMode,
    readOnlyMode: Boolean(READ_ONLY_MODE),
    historyRev: resolvedHistoryRev,
    guidanceRev,
    gitRadarRev: (gitRadarBundle && gitRadarBundle.rev) || EMPTY_GIT_RADAR.rev,
    availableRigs: resolvedAvailableRigs,
    nodes,
    activeQueue: Array.isArray(activeQueue) ? activeQueue : [],
    decisions,
    history: resolvedHistory,
    parkedSeats,
    seatCompactions: seatCompactions || {},
    seatGuidance: guidanceMap,
    seatUsage: usageReport.seatUsage,
    fleetUsageSummary: usageReport.fleetUsageSummary,
    gitRadar: (gitRadarBundle && gitRadarBundle.data) || EMPTY_GIT_RADAR,
    actionAudit: actionAudit.list(30),
    guardrails: {
      breaker: circuitBreaker.getState(),
      telegram: telegramBridge.getStatus(),
      playbooks: playbookEngine.getState()
    },
    autoConsent: autoConsent.getState(),
    update: selfUpdater.getStatus(),
    evaluator: aiEvaluator.getTelemetrySummary(),
    intelligence: null
  };

  fleetIntelligence.ingestSnapshot(payload);
  payload.intelligence = fleetIntelligence.getLatestReport(rigKey);
  if (rigKey === 'all') {
    const newShiftEvents = shiftHistory.ingestTelemetry(payload);
    for (const ev of newShiftEvents) {
      if (ev && ev.kind !== 'checkpoint') {
        sseHub.publishShiftEvent(ev);
      }
    }
  }
  payload.shiftHistoryMeta = shiftHistory.getSummaryMeta();
  latestFleetSnapshot = payload;
  if (!READ_ONLY_MODE && (sseHub.hasActiveSubscribers() || Date.now() - lastTelemetryClientAt < 25000)) {
    void resilience.observeTelemetry(payload).catch(err => console.warn('Resilience observation failed:', err.code || err.name));
  }
  sseHub.publishTelemetryBundle(rigKey, payload);

  setImmediate(async () => {
    try {
      const prevEventsLen = (circuitBreaker.getState().events || []).length;
      await circuitBreaker.evaluate({
        nodes,
        seatUsage: usageReport.seatUsage,
        fleetUsageSummary: usageReport.fleetUsageSummary,
        sliceStats: (history && history.sliceStats) || {}
      });
      const nextBreaker = circuitBreaker.getState();
      const nextEvents = nextBreaker.events || [];
      if (nextEvents.length > prevEventsLen) {
        const latestTrip = nextEvents[0];
        if (latestTrip) {
          shiftHistory.recordGuardrailEvent({
            severity: 'critical',
            rigId: 'all',
            seatId: latestTrip.seatId || null,
            key: `breaker:${latestTrip.ts || Date.now()}`,
            title: `Budget Circuit-Breaker: ${latestTrip.reason || latestTrip.rule || 'tripped'}`,
            detail: latestTrip.detail || latestTrip.actionTaken || 'Guardrail triggered.',
            meta: { rule: latestTrip.rule || null, armed: Boolean(nextBreaker.armed) }
          });
        }
      }
    } catch {
      // non-blocking breaker error
    }
    if (!READ_ONLY_MODE) {
      try {
        await playbookEngine.evaluateAndRun({
          nodes,
          parkedSeats,
          activeQueue,
          gitRadar: payload.gitRadar,
          actionAudit: actionAudit.list(40),
          breakerState: circuitBreaker.getState()
        });
      } catch {
        // non-blocking playbook error
      }
    }
    const hasActiveClient = sseHub.hasActiveSubscribers() || Date.now() - lastTelemetryClientAt < 25000;
    const autoConsentActive = !READ_ONLY_MODE && hasActiveClient && autoConsent.isObservingActive();
    const allowTelegramNotify = !READ_ONLY_MODE && telegramBridge.isConfigured();
    if (allowTelegramNotify || aiEvaluator.canAutoRunLocalS1() || autoConsentActive) {
      const liveBreaker = circuitBreaker.getState();
      const liveConflicts = payload.gitRadar
        ? {
            conflicts: payload.gitRadar.conflicts || [],
            unmergedWorkspaces: payload.gitRadar.unmergedWorkspaces || []
          }
        : null;
      if (autoConsentActive) {
        autoConsent.reconcileSeatStates(nodes);
      }
      for (const n of nodes) {
        const disp = (n && n.activityState && n.activityState.display) || '';
        const needsCount = (n && n.activityState && n.activityState.needsInput && n.activityState.needsInput.count) || 0;
        if ((disp === 'needs-input' || needsCount > 0) && n.canonicalSessionName) {
          try {
            const scr = await captureSeatScreen(n.canonicalSessionName, 64);
            if (autoConsentActive) {
              await autoConsent.observeSeat({
                seat: n,
                seatId: n.canonicalSessionName,
                rigId: n.rigName || n.rigId || '',
                screenText: scr,
                breakerState: liveBreaker,
                gitConflicts: liveConflicts
              });
            }
            if (allowTelegramNotify) {
              await telegramBridge.notifyHitlPrompt(n.canonicalSessionName, scr);
            }
            if (aiEvaluator.canAutoRunLocalS1()) {
              await aiEvaluator.runEvaluation({
                scope: 'seat',
                targetId: n.canonicalSessionName,
                requestedTier: 'auto',
                seat: n,
                nodes,
                openQueue: activeQueue,
                findings: (payload.intelligence && payload.intelligence.allFindings) || [],
                screenText: scr,
                auditRecords: actionAudit.list(15, n.canonicalSessionName),
                lang: 'ru'
              });
            }
          } catch {
            // ignore capture/auto-consent/telegram/evaluator transient failure
          }
        }
      }
    }
  });

  const bundle = {
    ts: Date.now(),
    payload,
    historyRev: resolvedHistoryRev,
    guidanceRev,
    gitRadarRev: payload.gitRadarRev,
    variants: new Map() // variantKey -> Promise<{ json, gzip }>
  };
  boundedMapSet(telemetryCacheByRig, rigKey, bundle, 12);
  return bundle;
}

function getTelemetryBundle(requestedRig = 'all', { forceRefresh = false } = {}) {
  const rigKey = requestedRig || 'all';
  const cached = telemetryCacheByRig.get(rigKey);
  const now = Date.now();

  if (!forceRefresh && cached && now - cached.ts < TELEMETRY_FRESH_TTL_MS) {
    return Promise.resolve(cached);
  }

  const trigger = () => {
    if (!telemetryInFlightByRig.has(rigKey)) {
      const p = assembleTelemetryBundle(rigKey, { forceGit: forceRefresh })
        .finally(() => { telemetryInFlightByRig.delete(rigKey); });
      telemetryInFlightByRig.set(rigKey, p);
    }
    return telemetryInFlightByRig.get(rigKey);
  };

  if (!forceRefresh && cached && now - cached.ts < TELEMETRY_SWR_MAX_MS) {
    void trigger(); // Stale-while-revalidate: serve instant warm snapshot while refreshing once in background
    return Promise.resolve(cached);
  }

  return trigger();
}

async function getSerializedTelemetryVariant(bundle, { skipHistory = false, skipGuidance = false, skipGitRadar = false } = {}) {
  const key = `${skipHistory ? 'nh' : 'h'}:${skipGuidance ? 'ng' : 'g'}:${skipGitRadar ? 'nr' : 'r'}`;
  if (!bundle.variants.has(key)) {
    const obj = (!skipHistory && !skipGuidance && !skipGitRadar)
      ? bundle.payload
      : {
          ...bundle.payload,
          ...(skipHistory ? { history: undefined, historyUnchanged: true } : {}),
          ...(skipGuidance ? { seatGuidance: undefined, guidanceUnchanged: true } : {}),
          ...(skipGitRadar ? { gitRadar: undefined, gitRadarUnchanged: true } : {})
        };
    bundle.variants.set(key, serializeTelemetryVariant(obj));
  }
  return bundle.variants.get(key);
}

async function fetchQueueItemContextDetail(qitemId, { execFn = execWithStatus, rigBin = RIG_BIN } = {}) {
  const safeId = String(qitemId || '').trim();
  if (!safeId || !/^[a-zA-Z0-9._:-]{3,120}$/.test(safeId)) {
    return { ok: false, statusCode: 400, error: 'Invalid qitem identifier' };
  }
  const cached = queueItemDetailCache.get(safeId);
  if (cached && Date.now() - cached.ts < QUEUE_ITEM_DETAIL_TTL_MS) {
    return { ok: true, statusCode: 200, ...cached.payload, cached: true };
  }

  let rawItem = null;
  const res = await execFn(rigBin, ['queue', 'show', safeId, '--full', '--json'], 12000);
  if (res.ok && res.stdout) {
    try {
      const parsed = JSON.parse(res.stdout);
      rawItem = Array.isArray(parsed) ? (parsed[0] || null) : parsed;
    } catch {
      rawItem = null;
    }
  }

  const combinedQueue = [
    ...(Array.isArray(cachedHistory.rawQueue) ? cachedHistory.rawQueue : []),
    ...(Array.isArray(latestFleetSnapshot?.activeQueue) ? latestFleetSnapshot.activeQueue : [])
  ];
  if (!rawItem) {
    rawItem = combinedQueue.find(q => (q && (q.qitemId || q.id)) === safeId) || null;
  }
  if (!rawItem) {
    return { ok: false, statusCode: 404, error: `Queue item ${safeId} not found` };
  }

  const item = extractItemContextMeta(rawItem);
  const graph = buildSharedContextGraph([...combinedQueue, rawItem]);
  const lineage = graph.getLineage(item);
  const artifacts = extractContextArtifacts(`${item.summary}\n${item.body}\n${item.resolution}`, {
    selfId: item.id,
    evidenceRef: item.evidenceRef
  });
  const relatedDecisions = matchRelatedDecisions(latestFleetSnapshot?.decisions || [], item);

  const payload = { item, artifacts, lineage, relatedDecisions };
  boundedMapSet(queueItemDetailCache, safeId, { ts: Date.now(), payload }, 80);
  return { ok: true, statusCode: 200, ...payload, cached: false };
}

async function sendToSeat({ req, json, body: payload }) {
  if (READ_ONLY_MODE) {
    await json(403, READ_ONLY_ERROR_BODY);
    return;
  }
  const seat = String(payload.seat || '').trim();
  const text = String(payload.text || '');
  const type = String(payload.type || 'msg').trim(); // 'msg' | 'raw' | 'key' | 'interact'
  const actionId = String(payload.actionId || '').trim();
  const evalId = String(payload.evalId || '').trim() || null;
  const baseline = latestSeatBaselines.get(seat) || null;

  if (!/^[a-zA-Z0-9._@-]+$/.test(seat)) {
    await json(400, { ok: false, error: 'Invalid seat identifier' });
    return;
  }

  // Server-side duplicate-dispatch / double-click idempotency guard
  const idempotencyKey = String(req.headers['x-idempotency-key'] || payload.idempotencyKey || '').trim();
  const semanticKey = buildSeatSendKey(seat, type, text);
  const idem = sendIdempotency.begin({ idempotencyKey, seatId: seat, semanticKey });
  if (idem.action === 'replay') {
    await json(idem.status, idem.body);
    return;
  }
  if (idem.action === 'reject') {
    await json(idem.status, { ok: false, deduplicated: true, error: idem.reason });
    return;
  }

  // Cancel any pending/in-flight auto-consent timer immediately before manual dispatch
  autoConsent.cancelPending({ seatId: seat, recordOperatorCancel: true });

  const universalTarget = universalTmuxTargets.get(seat);
  const tmuxTarget = universalTarget && isValidTmuxTarget(universalTarget) ? universalTarget : seat;

  let output = '';
  try {
    if (type === 'key') {
      // Specific tmux keystrokes validated against strict allowlist (prevents flag injection)
      const keyArgs = parseAllowedTmuxKeys(text);
      if (!keyArgs) {
        actionAudit.record({ actionId, seatId: seat, type, payload: text, httpStatus: 400, ok: false, baseline });
        const errBody = { ok: false, error: 'Disallowed tmux keystroke' };
        idem.complete(400, errBody);
        await json(400, errBody);
        return;
      }
      output = await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, ...keyArgs]);
      terminalPromptProbeCache.delete(seat);
    } else if (type === 'raw') {
      // Harness-aware hygiene and deduplication:
      // 1. Normalize and deduplicate repeated slash commands (e.g. /compact/compact -> /compact)
      let cleanText = text.trim();
      cleanText = cleanText.replace(/(\/[a-zA-Z0-9_-]+)\1+/g, '$1');

      // 2. Pi harness guard: Pi (DeepSeek) does not support slash commands (check actual runtime/model, not seat name)
      const targetNode = (latestFleetSnapshot?.nodes || []).find(n => n && n.canonicalSessionName === seat) || null;
      const isPiSeat = targetNode
        ? isPiHarness({ id: seat, harness: targetNode.runtime || targetNode.harness || '', model: targetNode.model || '' })
        : /(?:^|[-_@])pi(?:[-_@]|$)/i.test(seat);
      if (isPiSeat && cleanText.startsWith('/compact')) {
        actionAudit.record({ actionId, seatId: seat, type, payload: cleanText, httpStatus: 400, ok: false, baseline });
        const errBody = { ok: false, error: 'Харнес Pi (DeepSeek) не поддерживает команду /compact. Используйте ротацию сиденья.' };
        idem.complete(400, errBody);
        await json(400, errBody);
        return;
      }

      // 3. Deliver cleanly via native `rig send --raw` (two-step paste + input-box guard)
      //    for OpenRig seats, or paced TUI-safe tmux sequence for standalone universal panes.
      const rawRes = await dispatchRawCommand({
        seat,
        cleanText,
        universalTarget: universalTarget && isValidTmuxTarget(universalTarget) ? universalTarget : null
      });
      if (!rawRes.ok) {
        actionAudit.record({ actionId, evalId, seatId: seat, type, payload: cleanText, httpStatus: rawRes.statusCode, ok: false, baseline });
        const errBody = { ok: false, error: rawRes.error };
        idem.complete(rawRes.statusCode, errBody);
        await json(rawRes.statusCode, errBody);
        return;
      }
      output = rawRes.output;
    } else if (type === 'interact') {
      if (universalTarget) {
        await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, '-l', text]);
        output = await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, 'Enter']);
      } else {
        output = await safeTextExec(RIG_BIN, [
          'send',
          '--dangerously-interact',
          '--reason', 'Dashboard interactive prompt answer',
          seat,
          text
        ]);
        if (!output || output.includes('Error') || output.includes('refused')) {
          await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, '-l', text]);
          output += '\n' + await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, 'Enter']);
        }
      }
    } else {
      // Standard rig send (or direct tmux send-keys for universal standalone tmux panes)
      if (universalTarget) {
        await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, '-l', text]);
        output = await safeTextExec(TMUX_BIN, ['send-keys', '-t', tmuxTarget, 'Enter']);
      } else {
        output = await safeTextExec(RIG_BIN, ['send', seat, text]);
      }
    }

    const auditRec = actionAudit.record({ actionId, evalId, seatId: seat, type, payload: text, httpStatus: 200, ok: true, baseline });
    aiEvaluator.invalidateSeat(seat);
    terminalPromptProbeCache.delete(seat);
    invalidateTelemetryCache();
    schedulePostActionSseRefresh(seat, 'send');
    const okBody = { ok: true, execId: auditRec.execId, seat, type, text, output: (output || '').trim() };
    idem.complete(200, okBody);
    await json(200, okBody);
  } catch (innerErr) {
    idem.abort();
    throw innerErr;
  }
}

const apiRoutes = new Map();
const registry = {
  get: (path, handler) => apiRoutes.set(path, { method: 'GET', handler }),
  post: (path, handler) => apiRoutes.set(path, { method: 'POST', handler })
};
const getFleetSnapshot = () => latestFleetSnapshot;
const getPort = () => server.address()?.port || PORT;
const guardrailStatus = ({ json }) => json(200, {
  timestamp: new Date().toISOString(),
  breaker: circuitBreaker.getState(),
  telegram: telegramBridge.getStatus(),
  playbooks: playbookEngine.getState()
});

const stateDirArg = process.argv.indexOf('--state-dir');
const resolvedStateDir = stateDirArg >= 0 ? process.argv[stateDirArg + 1] : process.env.RIGCOMMANDER_STATE_DIR;

const seatPaneEpochCache = new Map();
async function resolveLiveSeatSessionEpoch(seatId, seatNode = null, { fresh = false } = {}) {
  const node = seatNode || (latestFleetSnapshot?.nodes || []).find(
    n => n && (n.canonicalSessionName || n.seatId || n.id) === seatId
  ) || null;
  if (seatId && /^[a-zA-Z0-9._@-]+$/.test(seatId)) {
    const universalTarget = universalTmuxTargets.get(seatId);
    const hasLiveTarget = Boolean((universalTarget && isValidTmuxTarget(universalTarget)) || node);
    if (hasLiveTarget) {
      const cached = seatPaneEpochCache.get(seatId);
      if (!fresh && cached && Date.now() - cached.ts < 3000) {
        return cached.epoch;
      }
      const tmuxTarget = universalTarget && isValidTmuxTarget(universalTarget) ? universalTarget : seatId;
      const res = await execWithStatus(TMUX_BIN, ['display-message', '-p', '-t', tmuxTarget, '#{pane_id}:#{pane_pid}'], 3000);
      const out = (res.ok && res.stdout) ? res.stdout.trim() : '';
      if (/^%\d+:\d+$/.test(out)) {
        const epoch = `tmux:${out}`;
        boundedMapSet(seatPaneEpochCache, seatId, { ts: Date.now(), epoch }, MAX_GUIDANCE_CACHE);
        return epoch;
      }
    }
  }
  return deriveSeatSessionEpoch(node);
}

async function executeAutoConsentOptionOne({
  seatId, rigId, keyStroke, evalId, commandPreview, matchedProfile, sourceScope, grantId, promptHash
}) {
  if (READ_ONLY_MODE) {
    return { ok: false, code: 'READ_ONLY_MODE', error: READ_ONLY_ERROR_BODY.error };
  }
  if (keyStroke !== '1 Enter') {
    return { ok: false, error: 'Auto-consent strictly permits Option 1 ("1 Enter") only' };
  }
  if (!/^[a-zA-Z0-9._@-]+$/.test(String(seatId || ''))) {
    return { ok: false, error: 'Invalid seat identifier' };
  }

  // Share per-seat single-flight lock & 1.5s semantic dedupe with /api/send
  const semanticKey = buildSeatSendKey(seatId, 'key', '1 Enter');
  const idem = sendIdempotency.begin({ seatId, semanticKey });
  if (idem.action !== 'proceed') {
    return {
      ok: false,
      deduplicated: true,
      auditRecorded: true,
      shiftRecorded: true,
      error: idem.reason || `Another command to ${seatId} is already in flight`
    };
  }

  try {
    const baseline = latestSeatBaselines.get(seatId) || null;
    const universalTarget = universalTmuxTargets.get(seatId);
    const tmuxTarget = universalTarget && isValidTmuxTarget(universalTarget) ? universalTarget : seatId;
    const sendRes = await execWithStatus(TMUX_BIN, ['send-keys', '-t', tmuxTarget, '1', 'Enter'], 8000);
    const ok = Boolean(sendRes && sendRes.ok);
    const safePreview = stripAnsiAndRedact(String(commandPreview || ''), { redactPaths: true }).text
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 96);
    const safeErr = ok
      ? ''
      : stripAnsiAndRedact(String((sendRes && sendRes.output) || 'tmux send-keys failed'), { redactPaths: true }).text
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 140);
    const rec = actionAudit.record({
      actionId: 'answer_prompt_option',
      evalId: evalId || `auto_consent:${matchedProfile || 'policy'}:${sourceScope || 'scope'}`,
      seatId,
      type: 'auto_consent',
      payload: `1 Enter${safePreview ? ` (${safePreview})` : ''}`,
      httpStatus: ok ? 200 : 502,
      ok,
      baseline
    });
    shiftHistory.recordGuardrailEvent({
      severity: ok ? 'info' : 'warn',
      rigId: rigId || 'all',
      seatId,
      key: `auto_consent:${seatId}:${String(promptHash || '').slice(0, 18)}:${Date.now()}`,
      title: `Auto-Consent (${matchedProfile || 'policy'}/${sourceScope || 'scope'}) → ${seatId}`,
      detail: ok
        ? `Dispatched 1 Enter${safePreview ? `: ${safePreview}` : ''}`
        : `Dispatch failed: ${safeErr || 'tmux error'}`,
      meta: {
        profile: matchedProfile || null,
        sourceScope: sourceScope || null,
        grantId: grantId || null,
        promptHash: String(promptHash || '').slice(0, 23),
        keyStroke: '1 Enter',
        execId: rec.execId
      }
    });
    if (ok) {
      terminalPromptProbeCache.delete(seatId);
      aiEvaluator.invalidateSeat(seatId);
      invalidateTelemetryCache();
      schedulePostActionSseRefresh(seatId, 'auto_consent');
      idem.complete(200, { ok: true, execId: rec.execId });
    } else {
      idem.abort();
    }
    return {
      ok,
      execId: rec.execId,
      auditRecorded: true,
      shiftRecorded: true,
      output: (sendRes && sendRes.output) || '',
      error: ok ? undefined : (safeErr || 'tmux send-keys failed')
    };
  } catch (err) {
    idem.abort();
    throw err;
  }
}

const autoConsent = new AutoConsentEngine({
  ...(READ_ONLY_MODE
    ? { configPath: null, initialConfig: { enabled: false, mode: 'dry_run', masterPaused: false } }
    : { stateDir: resolvedStateDir }),
  captureSeatScreen: (seatId, lines = 64) => captureSeatScreen(seatId, lines),
  getSeatSessionEpoch: (seatId, seatNode, opts) => resolveLiveSeatSessionEpoch(seatId, seatNode, opts),
  getLiveContext: async (seatId) => {
    const snap = latestFleetSnapshot || {};
    const node = (snap.nodes || []).find(n => n && (n.canonicalSessionName || n.seatId || n.id) === seatId) || null;
    const epoch = await resolveLiveSeatSessionEpoch(seatId, node, { fresh: true });
    return {
      seat: node,
      breakerState: circuitBreaker.getState(),
      gitConflicts: snap.gitRadar
        ? {
            conflicts: snap.gitRadar.conflicts || [],
            unmergedWorkspaces: snap.gitRadar.unmergedWorkspaces || []
          }
        : null,
      seatSessionEpoch: epoch
    };
  },
  dispatchOptionOne: (args) => executeAutoConsentOptionOne(args),
  actionAudit,
  shiftHistory,
  onEvent: (eventName, data, rigId) => {
    invalidateTelemetryCache();
    broadcastAutoConsentSse(eventName, data, rigId);
  }
});

if (READ_ONLY_MODE) {
  const baseGetState = autoConsent.getState.bind(autoConsent);
  autoConsent.isObservingActive = () => false;
  autoConsent.observeSeat = async () => ({ decision: 'skipped', reason: 'read_only_mode' });
  autoConsent.getState = (nowMs) => {
    const st = baseGetState(nowMs);
    return {
      ...st,
      status: 'disabled',
      readOnlyMode: true,
      config: { ...st.config, enabled: false, mode: 'dry_run' },
      sessionGrants: [],
      pendingApprovals: [],
      activeSummary: {
        ...(st.activeSummary || {}),
        hasActiveScopes: false,
        activeProjectCount: 0,
        activeSeatCount: 0,
        activeSessionGrantCount: 0
      }
    };
  };
}

const resilience = new FleetResilienceService({
  stateDir: resolvedStateDir,
  providers: [new OpenRigResilienceProvider({ rigBin: RIG_BIN, daemonUrl: DAEMON_URL })],
  actionAudit, shiftHistory,
  notify: async advisory => {
    sseHub.publishShiftEvent(advisory);
    if (!READ_ONLY_MODE && telegramBridge.isConfigured()) {
      await telegramBridge.sendText(
        'Fleet status after wake / Состояние флота после пробуждения: ' + advisory.tier
      );
    }
  }
});
registerResilienceRoutes(registry, resilience);
registerTelemetryRoutes(registry, {
  getTelemetryBundle, getSerializedTelemetryVariant, fleetIntelligence, fetchQueueItemContextDetail,
  sseHub, captureSeatScreen, markTelemetryClient: () => { lastTelemetryClientAt = Date.now(); }
});
registerGuardrailRoutes(registry, {
  guardrailStatus, actionAudit, circuitBreaker, telegramBridge, aiEvaluator, getFleetSnapshot, captureSeatScreen
});
registerPlaybookRoutes(registry, { guardrailStatus, playbookEngine, sseHub, getFleetSnapshot, actionAudit, circuitBreaker });
registerAutoConsentRoutes(registry, { autoConsent, invalidateTelemetryCache });
registerGitShiftRoutes(registry, {
  getPort, remoteAccess, selfUpdater, getFleetSnapshot, boundedMapSet, getTelemetryBundle, shiftHistory, actionAudit
});
registry.post('/api/send', sendToSeat);

async function dispatchApi(req, res, url, isRemote) {
  const route = apiRoutes.get(url.pathname);
  const json = (code, data) => sendJson(req, res, code, data);
  const deny = (code, error) => json(code, { ok: false, error });
  const method = String(req.method || 'GET').toUpperCase();
  if (READ_ONLY_MODE && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    return json(403, READ_ONLY_ERROR_BODY);
  }
  const remoteSettings = url.pathname.startsWith('/api/remote/');
  if (isRemote && remoteSettings) {
    return deny(403, 'Remote pairing settings can only be managed locally on the host machine.');
  }
  const updateAction = route?.method === 'POST' && url.pathname.startsWith('/api/update/');
  if (isRemote && updateAction) {
    return deny(403, 'Updates can only be triggered locally on the host machine.');
  }
  if (!route) return deny(404, 'Not found');
  if (req.method !== route.method) return deny(405, 'Method not allowed');

  const context = { req, res, url, isRemote, json };
  try {
    if (req.method === 'POST') {
      if (!remoteAccess.isAllowedOrigin(req.headers.origin)) return deny(403, 'Forbidden origin');
      if (!tokenMatches(req.headers['x-deck-token'])) return deny(403, 'Bad or missing deck token');
      const [mediaType] = String(req.headers['content-type'] || '').split(';');
      if (mediaType.trim().toLowerCase() !== 'application/json') return deny(415, 'JSON only');

      const limit = remoteSettings ? 16 * 1024 : 64 * 1024;
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        // The same reader consumes the rest of a rejected request so the connection can be reused.
        if (bytes > limit) continue;
        bytes += chunk.length;
        if (bytes > limit) {
          chunks.length = 0;
          await deny(413, 'Payload too large');
          continue;
        }
        // Update actions have no input fields. Drain and bound their bodies without interpreting them.
        if (!updateAction) chunks.push(chunk);
      }
      if (bytes > limit) return;
      if (!updateAction) {
        try { context.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch (error) {
          if (url.pathname.startsWith('/api/resilience/') || url.pathname.startsWith('/api/auto-consent/')) {
            return deny(400, 'invalid_json');
          }
          throw error;
        }
      }
    }
    await route.handler(context);
  } catch (err) {
    if (!res.destroyed && !res.headersSent) await deny(remoteSettings ? 400 : 500, err.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const isRemote = remoteAccess.isRemoteRequest(req);

  // 0.1 Dynamic Live PWA Manifest (always points to Live Deck "/" instead of static "/demo")
  if (url.pathname === '/manifest.webmanifest' && req.method === 'GET') {
    const manifestJson = JSON.stringify(buildLiveManifest(), null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(manifestJson);
    return;
  }

  // 0.2 Public pairing endpoint: exchanges one-time QR token or 8-char PIN for HttpOnly session cookie
  if (url.pathname === '/pair') {
    if (READ_ONLY_MODE) {
      await sendJson(req, res, 403, READ_ONLY_ERROR_BODY);
      return;
    }
    if (req.method === 'GET') {
      const code = url.searchParams.get('code') || '';
      const result = remoteAccess.consumePairingCode(code, {
        secure: remoteAccess.isHttpsRequest(req),
        userAgent: req.headers['user-agent'] || ''
      });
      if (result.ok) {
        res.writeHead(302, {
          Location: '/?source=qr',
          'Set-Cookie': result.cookieHeader,
          'Cache-Control': 'no-store'
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(remoteAccess.renderPairRequiredHtml({ error: result.error }));
      return;
    }
    if (req.method === 'POST') {
      let bodyStr = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (tooLarge) return;
        bodyStr += chunk;
        if (bodyStr.length > 8 * 1024) {
          tooLarge = true;
          sendJson(req, res, 413, { ok: false, error: 'Payload too large' }).catch(() => {});
          req.resume();
        }
      });
      req.on('end', async () => {
        if (tooLarge) return;
        const ctype = String(req.headers['content-type'] || '').toLowerCase();
        let code = '';
        const isJson = ctype.includes('application/json');
        if (isJson) {
          try {
            code = String((JSON.parse(bodyStr || '{}')).code || '');
          } catch {
            code = '';
          }
        } else {
          code = String(new URLSearchParams(bodyStr).get('code') || '');
        }
        const result = remoteAccess.consumePairingCode(code, {
          secure: remoteAccess.isHttpsRequest(req),
          userAgent: req.headers['user-agent'] || ''
        });
        if (result.ok) {
          if (isJson) {
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Set-Cookie': result.cookieHeader,
              'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify({ ok: true, redirect: '/?source=qr' }));
          } else {
            res.writeHead(302, {
              Location: '/?source=qr',
              'Set-Cookie': result.cookieHeader,
              'Cache-Control': 'no-store'
            });
            res.end();
          }
          return;
        }
        if (isJson) {
          await sendJson(req, res, 401, { ok: false, error: result.error });
        } else {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(remoteAccess.renderPairRequiredHtml({ error: result.error }));
        }
      });
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  // 0.3 Remote access gate: unpaired remote clients can only fetch PWA metadata/icons (/sw.js, /assets/icons/*)
  const isPublicPwaAsset =
    req.method === 'GET' &&
    (url.pathname === '/sw.js' || url.pathname.startsWith('/assets/icons/'));
  if (isRemote && !isPublicPwaAsset && !remoteAccess.isAuthenticatedRequest(req)) {
    if (url.pathname.startsWith('/api/')) {
      await sendJson(req, res, 401, { ok: false, error: 'Device pairing required' });
      return;
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(remoteAccess.renderPairRequiredHtml());
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    await dispatchApi(req, res, url, isRemote);
    return;
  }

  // 3. Static files (strictly contained within __dirname, safe extensions only)
  const staticTarget = resolveSafeStaticPath(__dirname, url.pathname);
  if (!staticTarget) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  const { resolved: filePath, rel: safeRel, ext } = staticTarget;
  try {
    const stat = await fs.stat(filePath);
    const cacheKey = safeRel === 'index.html' ? `${filePath}:${DECK_TOKEN}` : filePath;
    let entry = staticAssetCache.get(cacheKey);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      let raw = await fs.readFile(filePath);
      if (safeRel === 'index.html') {
        let html = raw.toString('utf-8');
        html = html.replace(/<meta\s+name="app-version"\s+content="[^"]*"\s*\/?>/i, `<meta name="app-version" content="${APP_VERSION}" />`);
        html = html.replace('<head>', `<head>\n  <meta name="deck-token" content="${DECK_TOKEN}">`);
        raw = Buffer.from(html);
      }
      const gzip = STATIC_GZIP_EXTS.has(ext) && raw.length >= 1024
        ? await gzipAsync(raw).catch(() => null)
        : null;
      entry = { mtimeMs: stat.mtimeMs, raw, gzip };
      boundedMapSet(staticAssetCache, cacheKey, entry, 60);
    }
    const mime =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.md' ? 'text/markdown; charset=utf-8' :
      ext === '.js' ? 'text/javascript; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.webmanifest' ? 'application/manifest+json; charset=utf-8' :
      ext === '.svg' ? 'image/svg+xml' :
      ext === '.png' ? 'image/png' :
      'text/plain; charset=utf-8';
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (entry.gzip && acceptEncoding.includes('gzip')) {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
      res.end(entry.gzip);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(entry.raw);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

const ALLOWED_TMUX_KEY_RE = /^([1-9]|[a-zA-Z]|Enter|Escape|Tab|Space|BSpace|Up|Down|Left|Right|C-c|C-u|C-d|C-z|C-l)$/;
const ALLOWED_STATIC_EXTS = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.png', '.ico', '.md', '.txt']);

function parseAllowedTmuxKeys(text) {
  const keys = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (keys.length === 0 || keys.length > 6) return null;
  for (const k of keys) {
    if (k.startsWith('-') || !ALLOWED_TMUX_KEY_RE.test(k)) return null;
  }
  return keys;
}

function resolveSafeStaticPath(baseDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || '/'));
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel =
    decoded === '/' ? 'index.html' :
    (decoded === '/passport' || decoded === '/passport/') ? 'passport.html' :
    (decoded === '/guide' || decoded === '/guide/') ? 'guide.html' :
    decoded.replace(/^\/+/, '');
  const segments = rel.split(/[\\/]+/);
  if (segments.some(s => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
    return null;
  }
  const baseResolved = path.resolve(baseDir);
  const resolved = path.resolve(baseResolved, rel);
  const rootPrefix = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
  if (!resolved.startsWith(rootPrefix)) return null;
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_STATIC_EXTS.has(ext)) return null;
  return { resolved, rel, ext };
}

server.on('listening', () => { remoteAccess.port = getPort(); });
server.on('close', () => { autoConsent.dispose(); });

export {
  server, resilience, autoConsent,
  READ_ONLY_MODE,
  READ_ONLY_ERROR_BODY,
  resolveReadOnlyMode,
  buildGanttItems,
  isGanttSystemNoise,
  computeHistoryStats,
  extractTsFromQitemId,
  readTranscriptTokenUsage,
  buildSeatUsageReport,
  getModelPricing,
  boundedMapSet,
  parseAllowedTmuxKeys,
  resolveSafeStaticPath,
  applyTerminalPromptProbes,
  dispatchRawCommand,
  fetchQueueItemContextDetail,
  runWithConcurrency,
  computeHistoryFingerprint,
  buildLiveManifest,
  transcriptUsageCache,
  seatGuidanceCache
};

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  shiftHistory.loadSync();
  if (!READ_ONLY_MODE && telegramBridge.isConfigured()) {
    telegramBridge.startPolling();
  }
  server.listen(PORT, BIND_HOST, () => {
    console.log(`💠 RigCommander // Neural Command Deck v${APP_VERSION} at http://${BIND_HOST}:${getPort()}${READ_ONLY_MODE ? ' [READ-ONLY]' : ''}`);
    // Warm the initial telemetry snapshot in background so first browser load is instant
    setTimeout(() => {
      void getTelemetryBundle('all', { forceRefresh: true }).catch(() => {});
    }, 150).unref();
    // Keep telemetry warm strictly while at least one SSE subscriber is open OR a client polled within 25s (zero idle CPU!)
    setInterval(() => {
      if (sseHub.hasActiveSubscribers() || Date.now() - lastTelemetryClientAt < 25000) {
        void resilience.checkWallClockJump().catch(err => console.warn('Resilience advisory failed:', err.code || err.name));
        const rigsToWarm = new Set(telemetryCacheByRig.keys());
        for (const c of sseHub.eventClients) rigsToWarm.add(c.rigKey || 'all');
        if (rigsToWarm.size === 0) rigsToWarm.add('all');
        for (const rigKey of rigsToWarm) {
          void getTelemetryBundle(rigKey, { forceRefresh: false }).catch(() => {});
        }
      }
    }, 2600).unref();
    setTimeout(() => {
      selfUpdater.check().then(st => {
        if (st && st.updateAvailable) {
          console.log(`⬆️  Update available on npmjs: v${st.currentVersion} -> v${st.latestVersion} (click Update in the deck)`);
        }
      }).catch(() => {});
    }, 2500).unref();
    setInterval(() => {
      selfUpdater.check().catch(() => {});
    }, 30 * 60 * 1000).unref();
    if (remoteAccess.getStatus().enabled) {
      console.log(`📱 Live Mobile PWA pairing active: ${remoteAccess.getStatus().publicOrigin}`);
    } else if (!READ_ONLY_MODE) {
      detectTailscaleServeUrl(getPort()).then(tsUrl => {
        if (tsUrl && !remoteAccess.getStatus().enabled) {
          const out = remoteAccess.setPublicUrl(tsUrl);
          if (out.ok) {
            console.log(`📱 Auto-detected Tailscale Serve HTTPS for Live Mobile PWA: ${tsUrl}`);
          }
        }
      }).catch(() => {});
    }
    if (!READ_ONLY_MODE && telegramBridge.isConfigured()) {
      console.log('📱 Telegram HITL bridge active (authorized chat polling)');
    }
  });
}
