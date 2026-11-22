/**
 * FinOps Subscription vs PAYG API Comparison Engine (Pure Domain Module).
 * Compares real amortized subscription cost against API-equivalent token spend
 * across selectable windows (24h, 7d, session) per exclusive model pool.
 */

export const BUDGET_WINDOWS = Object.freeze(['h24', 'd7', 'session']);

export const DEFAULT_BILLING_PLANS = Object.freeze({
  'codex-gpt': { mode: 'sub', monthlyUsd: 200, label: 'ChatGPT Pro / Codex' },
  'claude': { mode: 'sub', monthlyUsd: 100, label: 'Claude Max / Pro' },
  'fast-open': { mode: 'sub', monthlyUsd: 20, label: 'GLM / DeepSeek Plan' },
  'terminal-agy': { mode: 'sub', monthlyUsd: 20, label: 'Google AI / CLI Plan' },
  'other': { mode: 'payg', monthlyUsd: 0, label: 'Pay-As-You-Go API' }
});

export function sanitizeBillingPlans(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const [poolId, def] of Object.entries(DEFAULT_BILLING_PLANS)) {
    const patch = src[poolId] && typeof src[poolId] === 'object' ? src[poolId] : {};
    const mode = patch.mode === 'sub' || patch.mode === 'payg' ? patch.mode : def.mode;
    const rawPrice = Number(patch.monthlyUsd);
    const monthlyUsd = Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice <= 10_000
      ? Math.round(rawPrice * 100) / 100
      : def.monthlyUsd;
    result[poolId] = {
      mode,
      monthlyUsd,
      label: def.label
    };
  }
  return result;
}

/**
 * Extracts token & API-equivalent USD metrics for the requested window ('h24' | 'd7' | 'session').
 * Gracefully falls back to full session usage when windowed breakdown is absent.
 */
export function getUsageForWindow(usage, windowKey = 'h24') {
  if (!usage || typeof usage !== 'object') {
    return {
      inputTokens: 0,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedPct: 0,
      estUsd: 0,
      spanDays: 1
    };
  }
  const win = (usage.windows && typeof usage.windows === 'object') ? usage.windows[windowKey] : null;
  const src = (win && typeof win === 'object') ? win : usage;
  const uncached = Number(src.uncachedInputTokens) || 0;
  const cached = Number(src.cachedInputTokens) || 0;
  const output = Number(src.outputTokens) || 0;
  const totalInput = Number(src.inputTokens) || (uncached + cached);
  const totalTokens = Number(src.totalTokens) || (totalInput + output);
  const cachedPct = typeof src.cachedPct === 'number'
    ? src.cachedPct
    : (totalInput > 0 ? Math.round((cached / totalInput) * 100) : 0);
  const estUsd = Number(src.estUsd) || 0;
  const spanDays = Math.max(1, Number(usage.spanDays) || 1);

  return {
    inputTokens: totalInput,
    uncachedInputTokens: uncached,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens,
    cachedPct,
    estUsd: Math.round(estUsd * 10000) / 10000,
    spanDays
  };
}

/**
 * Computes amortized subscription cost for the active comparison window.
 */
export function getWindowAmortizedPlanUsd(monthlyUsd, windowKey = 'h24', spanDays = 1) {
  const m = Number(monthlyUsd);
  if (!Number.isFinite(m) || m <= 0) return 0;
  if (windowKey === 'h24') return Math.round((m / 30) * 100) / 100;
  if (windowKey === 'd7') return Math.round((m * (7 / 30)) * 100) / 100;
  const effectiveDays = Math.min(30, Math.max(1, Number(spanDays) || 1));
  return Math.round((m * (effectiveDays / 30)) * 100) / 100;
}

/**
 * Projects a window's API spend onto a 30-day monthly run-rate for apples-to-apples plan comparison.
 */
export function projectMonthlyApiUsd(apiEqUsd, windowKey = 'h24', spanDays = 1) {
  const v = Number(apiEqUsd) || 0;
  if (v <= 0) return 0;
  if (windowKey === 'h24') return Math.round(v * 30 * 100) / 100;
  if (windowKey === 'd7') return Math.round(v * (30 / 7) * 100) / 100;
  const effectiveDays = Math.min(30, Math.max(1, Number(spanDays) || 1));
  return Math.round(v * (30 / effectiveDays) * 100) / 100;
}

export function evaluatePoolBilling({ pool, agents = [], plan = null, windowKey = 'h24' }) {
  const safePlan = plan && typeof plan === 'object'
    ? plan
    : (DEFAULT_BILLING_PLANS[pool && pool.id] || DEFAULT_BILLING_PLANS.other);

  let totalTokens = 0;
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let apiEqUsd = 0;
  let maxSpanDays = 1;
  let hasUsage = false;

  for (const a of agents) {
    if (!a || !a.usage) continue;
    const w = getUsageForWindow(a.usage, windowKey);
    if (w.totalTokens > 0 || (a.usage.totalTokens || 0) > 0) hasUsage = true;
    totalTokens += w.totalTokens;
    totalInput += w.inputTokens;
    totalCached += w.cachedInputTokens;
    totalOutput += w.outputTokens;
    apiEqUsd += w.estUsd;
    if (w.spanDays > maxSpanDays) maxSpanDays = w.spanDays;
  }

  apiEqUsd = Math.round(apiEqUsd * 100) / 100;
  const subWindowUsd = getWindowAmortizedPlanUsd(safePlan.monthlyUsd, windowKey, maxSpanDays);
  const actualUsd = safePlan.mode === 'sub' ? subWindowUsd : apiEqUsd;
  const paygCashUsd = safePlan.mode === 'payg' ? apiEqUsd : 0;
  const subShareUsd = safePlan.mode === 'sub' ? subWindowUsd : 0;
  const savingsVsApiUsd = Math.round((apiEqUsd - actualUsd) * 100) / 100;
  const roiRatio = subWindowUsd > 0 ? Math.round((apiEqUsd / subWindowUsd) * 10) / 10 : null;
  const projectedMonthlyApiUsd = projectMonthlyApiUsd(apiEqUsd, windowKey, maxSpanDays);
  const cachedPct = totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0;

  let verdict = 'no_meter';
  if (hasUsage) {
    if (safePlan.mode === 'sub') {
      verdict = apiEqUsd >= subWindowUsd ? 'sub_wins' : 'sub_underused';
    } else {
      verdict = (safePlan.monthlyUsd > 0 && apiEqUsd > subWindowUsd) ? 'switch_to_sub' : 'payg_optimal';
    }
  }

  return {
    poolId: pool.id,
    poolName: pool.name,
    color: pool.color,
    seatNames: pool.seatNames || [],
    seatCount: pool.seatCount || agents.length,
    plan: safePlan,
    windowKey,
    spanDays: maxSpanDays,
    hasUsage,
    totalTokens,
    totalInput,
    totalCached,
    totalOutput,
    cachedPct,
    apiEqUsd,
    subWindowUsd,
    actualUsd: Math.round(actualUsd * 100) / 100,
    paygCashUsd: Math.round(paygCashUsd * 100) / 100,
    subShareUsd: Math.round(subShareUsd * 100) / 100,
    savingsVsApiUsd,
    roiRatio,
    projectedMonthlyApiUsd,
    verdict
  };
}

export function computeFleetFinOpsReport({
  agents = [],
  rigFilter = 'all',
  billingPlans = {},
  windowKey = 'h24',
  classifyPoolFn,
  computePoolsFn
}) {
  const safeWindow = BUDGET_WINDOWS.includes(windowKey) ? windowKey : 'h24';
  const plans = sanitizeBillingPlans(billingPlans);
  const scopedAgents = (Array.isArray(agents) ? agents : []).filter(a => {
    if (!a || !a.id) return false;
    return !rigFilter || rigFilter === 'all' || String(a.id).endsWith('@' + rigFilter);
  });

  const basePools = typeof computePoolsFn === 'function' ? computePoolsFn(agents, rigFilter) : [];
  const agentsByPool = new Map();
  for (const a of scopedAgents) {
    const pid = typeof classifyPoolFn === 'function' ? classifyPoolFn(a) : 'other';
    if (!agentsByPool.has(pid)) agentsByPool.set(pid, []);
    agentsByPool.get(pid).push(a);
  }

  const pools = basePools.map(pool =>
    evaluatePoolBilling({
      pool,
      agents: agentsByPool.get(pool.id) || [],
      plan: plans[pool.id] || DEFAULT_BILLING_PLANS.other,
      windowKey: safeWindow
    })
  );

  let apiEqUsd = 0;
  let subShareUsd = 0;
  let paygCashUsd = 0;
  let actualUsd = 0;
  let totalTokens = 0;
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let monthlySubCommitUsd = 0;
  let projectedMonthlyApiUsd = 0;

  for (const p of pools) {
    apiEqUsd += p.apiEqUsd;
    subShareUsd += p.subShareUsd;
    paygCashUsd += p.paygCashUsd;
    actualUsd += p.actualUsd;
    totalTokens += p.totalTokens;
    totalInput += p.totalInput;
    totalCached += p.totalCached;
    totalOutput += p.totalOutput;
    if (p.plan.mode === 'sub') monthlySubCommitUsd += p.plan.monthlyUsd;
    projectedMonthlyApiUsd += p.projectedMonthlyApiUsd;
  }

  apiEqUsd = Math.round(apiEqUsd * 100) / 100;
  subShareUsd = Math.round(subShareUsd * 100) / 100;
  paygCashUsd = Math.round(paygCashUsd * 100) / 100;
  actualUsd = Math.round(actualUsd * 100) / 100;
  const savingsVsApiUsd = Math.round((apiEqUsd - actualUsd) * 100) / 100;
  const savingsPct = apiEqUsd > 0 ? Math.round((savingsVsApiUsd / apiEqUsd) * 100) : 0;
  const cachedPct = totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0;

  return {
    windowKey: safeWindow,
    plans,
    pools,
    totals: {
      apiEqUsd,
      subShareUsd,
      paygCashUsd,
      actualUsd,
      savingsVsApiUsd,
      savingsPct,
      totalTokens,
      totalOutput,
      cachedPct,
      monthlySubCommitUsd: Math.round(monthlySubCommitUsd * 100) / 100,
      projectedMonthlyApiUsd: Math.round(projectedMonthlyApiUsd * 100) / 100
    }
  };
}
