/**
 * Advisory Engine: Deduplicates, scores, and ranks intelligence findings.
 * Compiles composite FleetIntelligenceReport with severity-capped health score,
 * transparent scoreBreakdown, and actionable Top-3 recommendations.
 */

export const HEALTH_WEIGHTS = {
  p0: { perItem: 22, cap: 55 },
  p1: { perItem: 10, cap: 30 },
  p2: { perItem: 3, cap: 15 },
  p3: { perItem: 1, cap: 5 }
};

export function computeHealthScore(counts = {}) {
  const p0 = Math.max(0, Number(counts.p0) || 0);
  const p1 = Math.max(0, Number(counts.p1) || 0);
  const p2 = Math.max(0, Number(counts.p2) || 0);
  const p3 = Math.max(0, Number(counts.p3) || 0);

  const p0Penalty = Math.min(HEALTH_WEIGHTS.p0.cap, p0 * HEALTH_WEIGHTS.p0.perItem);
  const p1Penalty = Math.min(HEALTH_WEIGHTS.p1.cap, p1 * HEALTH_WEIGHTS.p1.perItem);
  const p2Penalty = Math.min(HEALTH_WEIGHTS.p2.cap, p2 * HEALTH_WEIGHTS.p2.perItem);
  const p3Penalty = Math.min(HEALTH_WEIGHTS.p3.cap, p3 * HEALTH_WEIGHTS.p3.perItem);
  const totalPenalty = Math.min(85, p0Penalty + p1Penalty + p2Penalty + p3Penalty);
  const healthScore = Math.max(15, Math.min(100, 100 - totalPenalty));

  return {
    healthScore,
    scoreBreakdown: {
      base: 100,
      p0Penalty,
      p1Penalty,
      p2Penalty,
      p3Penalty,
      totalPenalty
    }
  };
}

export function compileAdvisoryReport(findings = [], rigId = 'all') {
  // 1. Deduplicate findings by target seat / slice and detector ID
  const dedupMap = new Map();
  for (const f of findings) {
    const key = `${f.detectorId}:${f.metrics?.affectedSeats?.[0] || 'all'}:${f.metrics?.affectedSlices?.[0] || 'all'}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, f);
    } else {
      // Keep higher confidence
      const existing = dedupMap.get(key);
      if (f.confidence > existing.confidence) {
        dedupMap.set(key, f);
      }
    }
  }

  const deduped = Array.from(dedupMap.values());

  // 2. Rank findings: P0 > P1 > P2 > P3, then by riskScore descending
  const severityOrder = { p0_urgent: 0, p1_high: 1, p2_medium: 2, p3_info: 3 };
  deduped.sort((a, b) => {
    const sevA = severityOrder[a.severity] ?? 9;
    const sevB = severityOrder[b.severity] ?? 9;
    if (sevA !== sevB) return sevA - sevB;
    return (b.metrics?.riskScore || 0) - (a.metrics?.riskScore || 0);
  });

  // 3. Compute Composite Fleet Health Score (0 - 100) with severity caps
  // Low/medium retrospective findings can NEVER falsely drag a healthy fleet into Critical Risk.
  const counts = {
    total: deduped.length,
    p0: deduped.filter(x => x.severity === 'p0_urgent').length,
    p1: deduped.filter(x => x.severity === 'p1_high').length,
    p2: deduped.filter(x => x.severity === 'p2_medium').length,
    p3: deduped.filter(x => x.severity === 'p3_info').length
  };
  const { healthScore, scoreBreakdown } = computeHealthScore(counts);

  // 4. Extract Top-3 high-impact live recommendations for the top strip (exclude pure P3 retro info)
  // Prefer seat diversity so one agent doesn't eat 2 of 3 top triage cards (Inspector shows ALL findings for that seat).
  const liveCandidates = deduped.filter(x => x.severity !== 'p3_info');
  const topRecommendations = [];
  const seenSeats = new Set();
  const deferred = [];
  for (const item of liveCandidates) {
    const seat = item.actionPlan?.seatTarget || item.metrics?.affectedSeats?.[0] || '';
    if (seat && seenSeats.has(seat)) {
      deferred.push(item);
      continue;
    }
    if (seat) seenSeats.add(seat);
    topRecommendations.push(item);
    if (topRecommendations.length >= 3) break;
  }
  for (const item of deferred) {
    if (topRecommendations.length >= 3) break;
    topRecommendations.push(item);
  }

  return {
    generatedAt: new Date().toISOString(),
    rigId,
    healthScore,
    scoreBreakdown,
    topRecommendations,
    allFindings: deduped,
    counts
  };
}
