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
 * Identifies automated watchdog / sweep noise rows that should not inflate
 * real user task bottleneck counts.
 */
export function isQueueSystemNoise(q = {}) {
  const src = String(q.sourceSession || q.from || '').toLowerCase();
  const sum = String(q.summary || '').toLowerCase();
  const tags = Array.isArray(q.tags) ? q.tags.map(t => String(t || '').toLowerCase()) : [];
  if (src.includes('change-detector') || src.includes('context-guardian-observer') || src.includes('opgate')) {
    return true;
  }
  if (tags.some(t => t.startsWith('stuck-sweep') || t.startsWith('recovery-for:') || t.startsWith('wake-'))) {
    return true;
  }
  if (sum.includes('undelivered-wake') || sum.includes('stalled-after-claim') || sum.includes('stuck-sweep')) {
    return true;
  }
  return false;
}

function extractShortSliceTag(q = {}) {
  if (q.slice) return String(q.slice).replace(/^slice:/, '');
  const tags = Array.isArray(q.tags) ? q.tags : [];
  const sliceTag = tags.find(t => typeof t === 'string' && t.startsWith('slice:'));
  if (sliceTag) return sliceTag.slice('slice:'.length);
  const meaningful = tags.find(t => typeof t === 'string' && t.trim() && !/^(project:|stuck-sweep|recovery-for:|wake-|prompt-)/.test(t));
  return meaningful || '';
}

/**
 * Calculates Wait-to-Work Ratio and queue lead times per seat.
 * Deduplicates by qitemId/id and separates real tasks from system sweep noise.
 */
export function computeQueueKinetics(queueItems = [], nowMs = Date.now()) {
  const seatStats = {};
  const seenIds = new Set();

  for (const q of queueItems) {
    if (!q || typeof q !== 'object') continue;
    const itemId = q.qitemId || q.id || '';
    if (itemId) {
      if (seenIds.has(itemId)) continue;
      seenIds.add(itemId);
    }

    const dest = q.destinationSession || q.to || 'unknown';
    if (!seatStats[dest]) {
      seatStats[dest] = {
        totalItems: 0,
        completedItems: 0,
        waitSampleCount: 0,
        inboxWaitSumMs: 0,
        workDurationSumMs: 0,
        pendingCount: 0,
        noisePendingCount: 0,
        inProgressCount: 0,
        pendingSamples: []
      };
    }
    const stat = seatStats[dest];
    const isNoise = isQueueSystemNoise(q);
    const state = String(q.state || '').toLowerCase();
    const created = q.tsCreated || q.createdAt ? new Date(q.tsCreated || q.createdAt).getTime() : 0;
    const claimed = q.claimedAt ? new Date(q.claimedAt).getTime() : 0;
    const updated = q.tsUpdated || q.updatedAt || q.endAt ? new Date(q.tsUpdated || q.updatedAt || q.endAt).getTime() : 0;

    if (isNoise) {
      if (state === 'pending' || state === 'open' || state === 'claimed') {
        stat.noisePendingCount++;
      }
      continue;
    }

    stat.totalItems++;

    if (state === 'pending' || state === 'open') {
      stat.pendingCount++;
      const ageMin = created > 0 && nowMs >= created ? Math.round((nowMs - created) / 60000) : 0;
      if (stat.pendingSamples.length < 4) {
        stat.pendingSamples.push({
          id: String(itemId),
          from: String(q.sourceSession || q.from || ''),
          slice: extractShortSliceTag(q),
          summary: String(q.summary || q.title || '').trim().slice(0, 140),
          state,
          ageMin
        });
      }
      if (created > 0 && nowMs >= created) {
        // Cap single open item wait at 24h so ancient stale rows don't explode averages
        stat.inboxWaitSumMs += Math.min(nowMs - created, 24 * 3600 * 1000);
        stat.waitSampleCount++;
      }
    } else if (state === 'in-progress') {
      stat.inProgressCount++;
    }

    if (created > 0 && claimed >= created) {
      stat.inboxWaitSumMs += (claimed - created);
      stat.waitSampleCount++;
    }
    if (claimed > 0 && updated >= claimed && (state === 'done' || state === 'handed-off')) {
      stat.workDurationSumMs += (updated - claimed);
      stat.completedItems++;
    }
  }

  const results = {};
  for (const [seat, stat] of Object.entries(seatStats)) {
    const waitDenom = stat.waitSampleCount > 0 ? stat.waitSampleCount : Math.max(1, stat.totalItems);
    const avgWaitMin = stat.waitSampleCount > 0 ? (stat.inboxWaitSumMs / waitDenom) / 60000 : 0;
    const avgWorkMin = stat.completedItems > 0 ? (stat.workDurationSumMs / stat.completedItems) / 60000 : 0;
    const wwr = avgWorkMin > 0
      ? Number((avgWaitMin / avgWorkMin).toFixed(2))
      : (avgWaitMin > 10 ? 2.0 : 0);

    results[seat] = {
      seat,
      avgWaitMin: Number(avgWaitMin.toFixed(1)),
      avgWorkMin: Number(avgWorkMin.toFixed(1)),
      wwr,
      pendingCount: stat.pendingCount,
      noisePendingCount: stat.noisePendingCount,
      inProgressCount: stat.inProgressCount,
      totalCount: stat.totalItems,
      pendingSamples: stat.pendingSamples
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
