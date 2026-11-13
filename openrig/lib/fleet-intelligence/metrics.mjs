/**
 * Metrics Calculator for OpenRig Fleet Intelligence
 * Evaluates queue dwell times, wait-to-work ratios, token costs, and context kinetics.
 */

// Approximate blended pricing per 1M tokens ($/M) for ROI calculations
export const MODEL_PRICING_TABLE = {
  // Frontier tier (GPT-6 Sol, Claude 3.7 Sonnet, Opus)
  'gpt-6.1': { input: 10.0, output: 30.0, tier: 3, label: 'Frontier (GPT-6)' },
  'codex': { input: 10.0, output: 30.0, tier: 3, label: 'Frontier (Codex)' },
  'claude-3-7-sonnet': { input: 3.0, output: 15.0, tier: 3, label: 'Frontier (Claude 3.7)' },
  'claude-opus': { input: 15.0, output: 75.0, tier: 3, label: 'Frontier (Claude Opus)' },

  // Standard tier (Claude 3.5 Sonnet, DeepSeek-v4, GLM-4)
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, tier: 2, label: 'Standard (Sonnet 3.5)' },
  'deepseek-v4-pro': { input: 1.5, output: 4.5, tier: 2, label: 'Standard (DeepSeek v4)' },
  'deepseek-chat': { input: 0.14, output: 0.28, tier: 2, label: 'Standard (DeepSeek V3)' },

  // Commodity / Fast tier (DeepSeek flash, GLM-flash, Haiku, Gemini Flash)
  'deepseek-flash': { input: 0.10, output: 0.20, tier: 1, label: 'Fast / Open-Weights (DeepSeek)' },
  'glm-5.3-flash': { input: 0.10, output: 0.20, tier: 1, label: 'Fast / Open-Weights (GLM Flash)' },
  'claude-3-5-haiku': { input: 0.80, output: 4.0, tier: 1, label: 'Fast (Claude Haiku)' },
  'gemini-flash': { input: 0.075, output: 0.30, tier: 1, label: 'Fast (Gemini Flash)' }
};

export function resolveModelTier(modelName = '') {
  const norm = String(modelName || '').toLowerCase();
  for (const [key, data] of Object.entries(MODEL_PRICING_TABLE)) {
    if (norm.includes(key)) return data;
  }
  // Heuristic fallbacks
  if (norm.includes('sol') || norm.includes('opus') || norm.includes('gpt-6') || norm.includes('sonnet')) {
    return { input: 5.0, output: 20.0, tier: 3, label: 'Frontier' };
  }
  if (norm.includes('flash') || norm.includes('deepseek') || norm.includes('glm') || norm.includes('mini') || norm.includes('pi')) {
    return { input: 0.2, output: 0.5, tier: 1, label: 'Fast / Open-Weights' };
  }
  return { input: 2.0, output: 8.0, tier: 2, label: 'Standard' };
}

/**
 * Calculates Wait-to-Work Ratio and queue lead times per seat
 */
export function computeQueueKinetics(queueItems = []) {
  const seatStats = {};

  for (const q of queueItems) {
    const dest = q.destinationSession || 'unknown';
    if (!seatStats[dest]) {
      seatStats[dest] = {
        totalItems: 0,
        completedItems: 0,
        inboxWaitSumMs: 0,
        workDurationSumMs: 0,
        pendingCount: 0,
        inProgressCount: 0
      };
    }
    const stat = seatStats[dest];
    stat.totalItems++;

    if (q.state === 'pending') stat.pendingCount++;
    if (q.state === 'in-progress') stat.inProgressCount++;

    const created = q.tsCreated ? new Date(q.tsCreated).getTime() : 0;
    const claimed = q.claimedAt ? new Date(q.claimedAt).getTime() : 0;
    const updated = q.tsUpdated ? new Date(q.tsUpdated).getTime() : 0;

    if (created > 0 && claimed >= created) {
      stat.inboxWaitSumMs += (claimed - created);
    }
    if (claimed > 0 && updated >= claimed && (q.state === 'done' || q.state === 'handed-off')) {
      stat.workDurationSumMs += (updated - claimed);
      stat.completedItems++;
    }
  }

  const results = {};
  for (const [seat, stat] of Object.entries(seatStats)) {
    const avgWaitMin = stat.totalItems > 0 ? (stat.inboxWaitSumMs / stat.totalItems) / 60000 : 0;
    const avgWorkMin = stat.completedItems > 0 ? (stat.workDurationSumMs / stat.completedItems) / 60000 : 0;
    const wwr = avgWorkMin > 0 ? Number((avgWaitMin / avgWorkMin).toFixed(2)) : (avgWaitMin > 10 ? 2.5 : 1.0);

    results[seat] = {
      seat,
      avgWaitMin: Number(avgWaitMin.toFixed(1)),
      avgWorkMin: Number(avgWorkMin.toFixed(1)),
      wwr,
      pendingCount: stat.pendingCount,
      inProgressCount: stat.inProgressCount,
      totalCount: stat.totalItems
    };
  }
  return results;
}

/**
 * Classifies task algorithmic complexity based on tags, summary and expected scope
 * Returns 1 (Commodity), 2 (Standard), 3 (Frontier)
 */
export function classifyTaskComplexity(task = {}) {
  const text = `${task.summary || ''} ${(task.tags || []).join(' ')} ${task.slice || ''}`.toLowerCase();
  
  // Tier 1: Commodity / Chore
  if (
    text.includes('lint') ||
    text.includes('format') ||
    text.includes('doc') ||
    text.includes('typo') ||
    text.includes('cleanup') ||
    text.includes('comment') ||
    text.includes('readme')
  ) {
    return { tier: 1, label: 'Commodity (Chore/Docs/Lint)' };
  }

  // Tier 3: Frontier
  if (
    text.includes('arch') ||
    text.includes('security') ||
    text.includes('auth') ||
    text.includes('crypto') ||
    text.includes('refactor-core') ||
    text.includes('spec') ||
    text.includes('kernel') ||
    text.includes('protocol')
  ) {
    return { tier: 3, label: 'Frontier (Core Architecture)' };
  }

  // Tier 2: Standard
  return { tier: 2, label: 'Standard Implementation' };
}
