/**
 * TieredEvaluatorRouter — Cognitive Cascade Orchestrator:
 *   Tier 0 (Heuristic + Symbolic Expert System)
 *   -> LRU Cache & Budget/Concurrency Guard
 *   -> Tier 1 (System1Port: Non-Autoregressive Single-Pass + Shannon Entropy Gate)
 *   -> Tier 2 (System2Port: Deliberative Reasoner + Evidence Grounding + Expert Veto)
 *
 * Graceful degradation: S2 timeout/error -> S1 -> Tier 0 (never HTTP 500 on offline providers).
 */

import crypto from 'node:crypto';
import {
  EVAL_TIERS,
  EVAL_RISK_LEVELS,
  evaluateS1EscalationGate,
  renderS1TemplateSummary,
  validateAndNormalizeVerdict,
  buildSystem2Prompts
} from '../../assets/domain/evaluator-model.js';
import { evaluateTier0 } from './expert-rules.mjs';
import { buildSystem1State, buildSystem2Bundle } from './redactor.mjs';
import { invokeSystem1Slot } from './s1-adapters.mjs';
import { invokeSystem2Slot } from './s2-adapters.mjs';

const CACHE_TTL_MS = 120_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_HISTORY_ENTRIES = 50;

export class TieredEvaluatorRouter {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.cache = new Map(); // cacheKey -> { verdict, expiresAt, targetSeatId }
    this.latestByTarget = new Map(); // `${scope}:${targetId}` -> verdict
    this.history = [];
    this.callTimestamps = []; // last 60 min
    this.dailySpend = { dayKey: this._dayKey(), usd: 0 };
    this.inFlightS1 = 0;
    this.inFlightS2 = 0;
    this.tierCounts = { heuristic: 0, system1: 0, system2: 0 };
  }

  _dayKey(nowMs = Date.now()) {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  _pruneUsage(nowMs = Date.now()) {
    const cutoff = nowMs - 3_600_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }
    const day = this._dayKey(nowMs);
    if (this.dailySpend.dayKey !== day) {
      this.dailySpend = { dayKey: day, usd: 0 };
    }
  }

  _checkBudget(config, nowMs = Date.now()) {
    this._pruneUsage(nowMs);
    if (this.callTimestamps.length >= (config.maxCallsPerHour || 60)) {
      return { ok: false, reason: 'hourly_call_cap_reached' };
    }
    if (this.dailySpend.usd >= (config.maxDailyUsd || 2.0)) {
      return { ok: false, reason: 'daily_usd_cap_reached' };
    }
    return { ok: true };
  }

  _recordUsage(estUsd = 0, nowMs = Date.now()) {
    this._pruneUsage(nowMs);
    this.callTimestamps.push(nowMs);
    this.dailySpend.usd = +(this.dailySpend.usd + (Number(estUsd) || 0)).toFixed(6);
  }

  getUsageStats(nowMs = Date.now()) {
    this._pruneUsage(nowMs);
    return {
      callsLastHour: this.callTimestamps.length,
      estDailyUsd: +this.dailySpend.usd.toFixed(4),
      inFlightS1: this.inFlightS1,
      inFlightS2: this.inFlightS2,
      tierCounts: { ...this.tierCounts }
    };
  }

  invalidateSeat(seatId) {
    if (!seatId) return;
    for (const [k, entry] of this.cache.entries()) {
      if (entry.targetSeatId === seatId || k.includes(seatId)) {
        this.cache.delete(k);
      }
    }
  }

  getLatestByTargetMap() {
    const out = {};
    for (const [k, v] of this.latestByTarget.entries()) {
      out[k] = v;
    }
    return out;
  }

  _storeVerdict(verdict, cacheKey, nowMs) {
    const targetKey = `${verdict.scope}:${verdict.targetId}`;
    this.latestByTarget.set(targetKey, verdict);
    if (this.latestByTarget.size > MAX_CACHE_ENTRIES) {
      const oldest = this.latestByTarget.keys().next().value;
      if (oldest) this.latestByTarget.delete(oldest);
    }
    if (cacheKey) {
      this.cache.set(cacheKey, { verdict, expiresAt: nowMs + CACHE_TTL_MS, targetSeatId: verdict.targetSeatId });
      if (this.cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
    }
    this.history.unshift(verdict);
    if (this.history.length > MAX_HISTORY_ENTRIES) this.history.length = MAX_HISTORY_ENTRIES;
    if (this.tierCounts[verdict.highestTier] !== undefined) {
      this.tierCounts[verdict.highestTier]++;
    }
  }

  async evaluate({
    scope = 'seat',
    targetId = '',
    requestedTier = 'auto', // 'auto' | 'heuristic' | 'system1' | 'system2'
    forceRefresh = false,
    config,
    seat = null,
    nodes = [],
    openQueue = [],
    ganttItems = [],
    handoffSequence = null,
    findings = [],
    screenText = '',
    screenBySeat = {},
    auditRecords = [],
    seatCompactions = {},
    decisions = [],
    sliceMetrics = null,
    fleetKpis = null,
    lang = 'ru',
    nowMs = Date.now()
  } = {}) {
    const cfg = config;
    const evalId = `eval-${nowMs.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const trace = [];
    let totalUsage = { inputTokens: 0, outputTokens: 0, estUsd: 0 };
    let redactionCount = 0;

    // --- TIER 0: Heuristic + Symbolic Expert System (Always Synchronous) ---
    const tier0 = evaluateTier0({
      scope,
      targetId,
      seat,
      screenText,
      findings,
      auditRecords,
      sliceMetrics,
      lang,
      nowMs
    });

    const allowedSeatIds = new Set(
      (Array.isArray(nodes) ? nodes : [])
        .map(n => n?.canonicalSessionName || n?.id || n?.logicalId || '')
        .filter(Boolean)
    );
    if (tier0.targetSeatId) allowedSeatIds.add(tier0.targetSeatId);
    const failedActionIds = new Set(tier0.failedActionIds || []);

    trace.push({
      tier: EVAL_TIERS.HEURISTIC,
      status: tier0.stopCascade && requestedTier === 'auto' ? 'resolved' : 'evaluated',
      durationMs: tier0.durationMs,
      uncertaintyU0: tier0.uncertaintyU0,
      firedRules: tier0.firedRules,
      triggers: tier0.escalationTriggers
    });

    // Fast-path: requestedTier='heuristic' OR Tier 0 fast-resolved cleanly under 'auto'
    if (requestedTier === EVAL_TIERS.HEURISTIC || (requestedTier === 'auto' && tier0.stopCascade)) {
      const l0Verdict = {
        evalId,
        scope,
        targetId: tier0.targetId,
        targetSeatId: tier0.targetSeatId,
        highestTier: EVAL_TIERS.HEURISTIC,
        providerStatus: 'tier0_resolved',
        trace,
        riskLevel: tier0.riskLevel,
        vetoedByExpert: tier0.hardVetoes.length > 0,
        hardVetoes: tier0.hardVetoes,
        firedRules: tier0.firedRules,
        uncertaintyU0: tier0.uncertaintyU0,
        confidence: tier0.confidence,
        headline: tier0.headline,
        rootCause: tier0.summary,
        suggestedActions: tier0.suggestedActions,
        draftPrompt: null,
        rulePatchSuggestion: null,
        hypothesesChecked: [],
        evidenceRefs: tier0.firedRules.map(r => ({ source: 'rule', ref: r, quote: tier0.summary })),
        unknowns: [],
        s1Signals: null,
        redactionCount: 0,
        usage: totalUsage,
        cached: false,
        createdAt: new Date(nowMs).toISOString()
      };
      this._storeVerdict(l0Verdict, null, nowMs);
      return l0Verdict;
    }

    // Build sanitized System 1 state + context hash for cache deduplication
    const s1Prep = buildSystem1State({
      scope,
      targetId: tier0.targetId,
      seat,
      screenText,
      openQueue,
      tier0,
      redactPaths: cfg.redactPaths !== false
    });
    redactionCount += s1Prep.redactionCount;

    const effectiveRequestTier = requestedTier === 'auto' ? tier0.recommendedTier : requestedTier;
    const cacheKey = `${scope}:${tier0.targetId}:${effectiveRequestTier}:${s1Prep.contextHash}:${lang}`;
    if (!forceRefresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > nowMs) {
        return { ...hit.verdict, cached: true };
      }
    }

    // --- TIER 1: System1Port (Non-Autoregressive Probabilistic Classifier) ---
    let s1Normalized = null;
    let s1Gate = { shouldEscalateS2: false, riskEntropy: 0, reasons: [] };
    let providerStatus = 'ok';
    const shouldRunS1 = effectiveRequestTier === EVAL_TIERS.SYSTEM1 ||
      (effectiveRequestTier === EVAL_TIERS.SYSTEM2 && cfg.system1?.enabled && cfg.system1?.dialect !== 'disabled');

    if (shouldRunS1) {
      const budget = this._checkBudget(cfg, nowMs);
      if (!budget.ok) {
        providerStatus = budget.reason;
        trace.push({ tier: EVAL_TIERS.SYSTEM1, status: 'skipped', durationMs: 0, reason: budget.reason });
      } else if (this.inFlightS1 >= 2) {
        providerStatus = 's1_busy';
        trace.push({ tier: EVAL_TIERS.SYSTEM1, status: 'skipped', durationMs: 0, reason: 'max_inflight_s1' });
      } else {
        this.inFlightS1++;
        let s1Res;
        try {
          s1Res = await invokeSystem1Slot(cfg.system1, {
            stateText: s1Prep.stateText,
            tier0,
            privacyMode: cfg.privacyMode,
            fetchImpl: this.fetchImpl
          });
        } finally {
          this.inFlightS1--;
        }

        if (s1Res.ok && s1Res.vector) {
          this._recordUsage(s1Res.usage?.estUsd || 0, nowMs);
          totalUsage.inputTokens += s1Res.usage?.inputTokens || 0;
          totalUsage.outputTokens += s1Res.usage?.outputTokens || 0;
          totalUsage.estUsd = +(totalUsage.estUsd + (s1Res.usage?.estUsd || 0)).toFixed(6);

          s1Gate = evaluateS1EscalationGate(s1Res.vector);
          const tpl = renderS1TemplateSummary(s1Res.vector, tier0.facts, lang);
          const rawS1Obj = {
            riskLevel: s1Res.vector.riskLevel?.choice || EVAL_RISK_LEVELS.REVIEW,
            confidence: s1Res.vector.situationalIntent?.confidence ?? s1Res.vector.riskLevel?.confidence ?? 0.65,
            headline: tpl.headline,
            tacticalReason: tpl.summary,
            suggestedActionId: s1Res.vector.recommendedAction?.choice || 'none',
            recommendedOptionKey: s1Res.vector.recommendedAction?.choice === 'proceed_prompt' ? '1' : null,
            needsSystem2: s1Gate.shouldEscalateS2
          };

          s1Normalized = validateAndNormalizeVerdict(rawS1Obj, {
            tier: EVAL_TIERS.SYSTEM1,
            expertBaseline: tier0,
            allowedSeatIds,
            failedActionIds,
            promptInjectionProb: s1Res.vector.promptInjection?.prob || 0
          });
          s1Normalized.riskEntropy = s1Gate.riskEntropy;
          s1Normalized.escalationReasons = s1Gate.reasons;
          s1Normalized.rawVector = s1Res.vector;

          trace.push({
            tier: EVAL_TIERS.SYSTEM1,
            status: s1Gate.shouldEscalateS2 ? 'escalated' : 'resolved',
            model: s1Res.model,
            dialect: cfg.system1.dialect,
            durationMs: s1Res.durationMs,
            confidence: s1Normalized.confidence,
            entropy: s1Gate.riskEntropy,
            escalationReasons: s1Gate.reasons
          });
        } else {
          providerStatus = s1Res.blocked ? 'privacy_local_only' : (s1Res.skipped ? s1Res.reason : 's1_offline');
          trace.push({
            tier: EVAL_TIERS.SYSTEM1,
            status: s1Res.skipped || s1Res.blocked ? 'skipped' : 'degraded',
            dialect: cfg.system1?.dialect || 'disabled',
            durationMs: s1Res.durationMs || 0,
            reason: s1Res.reason || s1Res.error || 'unavailable'
          });
        }
      }
    }

    // --- TIER 2: System2Port (Deliberative Multi-Hop Reasoner) ---
    let s2Normalized = null;
    const shouldRunS2 =
      effectiveRequestTier === EVAL_TIERS.SYSTEM2 ||
      (requestedTier === 'auto' && cfg.autoEscalateS2 && s1Gate.shouldEscalateS2);

    if (shouldRunS2) {
      const budget = this._checkBudget(cfg, nowMs);
      if (!budget.ok) {
        providerStatus = budget.reason;
        trace.push({ tier: EVAL_TIERS.SYSTEM2, status: 'skipped', durationMs: 0, reason: budget.reason });
      } else if (this.inFlightS2 >= 1) {
        providerStatus = 's2_busy';
        trace.push({ tier: EVAL_TIERS.SYSTEM2, status: 'skipped', durationMs: 0, reason: 'max_inflight_s2' });
      } else {
        const screensMap = { ...screenBySeat };
        if (tier0.targetSeatId && screenText && !screensMap[tier0.targetSeatId]) {
          screensMap[tier0.targetSeatId] = screenText;
        }
        const s2Bundle = buildSystem2Bundle({
          scope,
          targetId: tier0.targetId,
          nodes,
          openQueue,
          ganttItems,
          handoffSequence,
          screenBySeat: screensMap,
          auditRecords,
          seatCompactions,
          decisions,
          tier0,
          s1Verdict: s1Normalized,
          fleetKpis,
          redactPaths: cfg.redactPaths !== false
        });
        redactionCount += s2Bundle.redactionCount;

        const { systemPrompt, userPrompt } = buildSystem2Prompts(s2Bundle.wrapped, {
          lang,
          failedActionIds: tier0.failedActionIds
        });

        this.inFlightS2++;
        let s2Res;
        try {
          s2Res = await invokeSystem2Slot(cfg.system2, {
            systemPrompt,
            userPrompt,
            bundleObj: s2Bundle.bundleObj,
            tier0,
            lang,
            privacyMode: cfg.privacyMode,
            fetchImpl: this.fetchImpl
          });
        } finally {
          this.inFlightS2--;
        }

        if (s2Res.ok && s2Res.parsed) {
          this._recordUsage(s2Res.usage?.estUsd || 0, nowMs);
          totalUsage.inputTokens += s2Res.usage?.inputTokens || 0;
          totalUsage.outputTokens += s2Res.usage?.outputTokens || 0;
          totalUsage.estUsd = +(totalUsage.estUsd + (s2Res.usage?.estUsd || 0)).toFixed(6);

          s2Normalized = validateAndNormalizeVerdict(s2Res.parsed, {
            tier: EVAL_TIERS.SYSTEM2,
            expertBaseline: tier0,
            allowedSeatIds: s2Bundle.allowedSeatIds.size > 0 ? s2Bundle.allowedSeatIds : allowedSeatIds,
            allowedRefIds: s2Bundle.allowedRefIds,
            failedActionIds,
            promptInjectionProb: s1Normalized?.promptInjectionProb || 0
          });
          providerStatus = 'ok';
          trace.push({
            tier: EVAL_TIERS.SYSTEM2,
            status: 'resolved',
            model: s2Res.model,
            dialect: cfg.system2.dialect,
            durationMs: s2Res.durationMs,
            confidence: s2Normalized.confidence,
            ungroundedRefsStripped: s2Normalized.ungroundedRefsStripped
          });
        } else {
          providerStatus = s2Res.blocked ? 'privacy_local_only' : (s2Res.skipped ? s2Res.reason : 's2_offline');
          trace.push({
            tier: EVAL_TIERS.SYSTEM2,
            status: s2Res.skipped || s2Res.blocked ? 'skipped' : 'degraded',
            dialect: cfg.system2?.dialect || 'disabled',
            durationMs: s2Res.durationMs || 0,
            reason: s2Res.reason || s2Res.error || 'unavailable'
          });
        }
      }
    }

    // Select highest successful layer (graceful degradation: S2 -> S1 -> L0)
    const winner = s2Normalized || s1Normalized || null;
    const highestTier = s2Normalized
      ? EVAL_TIERS.SYSTEM2
      : (s1Normalized ? EVAL_TIERS.SYSTEM1 : EVAL_TIERS.HEURISTIC);

    const finalVerdict = {
      evalId,
      scope,
      targetId: tier0.targetId,
      targetSeatId: tier0.targetSeatId,
      highestTier,
      providerStatus,
      trace,
      riskLevel: winner ? winner.riskLevel : tier0.riskLevel,
      vetoedByExpert: winner ? winner.vetoedByExpert : tier0.hardVetoes.length > 0,
      hardVetoes: tier0.hardVetoes,
      firedRules: tier0.firedRules,
      uncertaintyU0: tier0.uncertaintyU0,
      confidence: winner ? winner.confidence : tier0.confidence,
      headline: winner ? winner.headline : tier0.headline,
      rootCause: winner ? winner.rootCause : tier0.summary,
      recommendedOptionKey: winner ? winner.recommendedOptionKey : null,
      suggestedActions: winner ? winner.suggestedActions : tier0.suggestedActions,
      draftPrompt: winner ? winner.draftPrompt : null,
      rulePatchSuggestion: winner ? winner.rulePatchSuggestion : null,
      hypothesesChecked: winner ? winner.hypothesesChecked : [],
      evidenceRefs: (winner && winner.evidenceRefs.length > 0)
        ? winner.evidenceRefs
        : tier0.firedRules.map(r => ({ source: 'rule', ref: r, quote: tier0.summary })),
      unknowns: winner ? winner.unknowns : [],
      s1Signals: s1Normalized ? {
        riskProbs: s1Normalized.rawVector?.riskLevel?.probs || null,
        intentChoice: s1Normalized.rawVector?.situationalIntent?.choice || null,
        intentConf: s1Normalized.rawVector?.situationalIntent?.confidence ?? null,
        riskEntropy: s1Normalized.riskEntropy ?? null,
        promptInjectionProb: s1Normalized.promptInjectionProb ?? 0,
        escalateToS2Prob: s1Normalized.rawVector?.escalateToS2?.prob ?? 0,
        shouldEscalateS2: s1Gate.shouldEscalateS2,
        escalationReasons: s1Gate.reasons
      } : null,
      redactionCount,
      usage: totalUsage,
      cached: false,
      createdAt: new Date(nowMs).toISOString()
    };

    const shouldCache = highestTier !== EVAL_TIERS.HEURISTIC || requestedTier === EVAL_TIERS.HEURISTIC;
    this._storeVerdict(finalVerdict, shouldCache ? cacheKey : null, nowMs);
    return finalVerdict;
  }
}
