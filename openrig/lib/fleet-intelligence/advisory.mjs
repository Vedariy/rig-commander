/**
 * Advisory Engine: Deduplicates, scores, and ranks intelligence findings.
 * Compiles composite FleetIntelligenceReport with health score and Top-3 recommendations.
 */

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

  // 3. Compute Composite Fleet Health Score (0 - 100)
  // 100 is pristine; deductions for critical and high findings
  let penalty = 0;
  for (const f of deduped) {
    if (f.severity === 'p0_urgent') penalty += 25;
    else if (f.severity === 'p1_high') penalty += 12;
    else if (f.severity === 'p2_medium') penalty += 5;
    else penalty += 1;
  }
  const healthScore = Math.max(15, Math.min(100, 100 - penalty));

  // 4. Extract Top-3 high-impact recommendations for the top strip
  const topRecommendations = deduped.slice(0, 3);

  return {
    generatedAt: new Date().toISOString(),
    rigId,
    healthScore,
    topRecommendations,
    allFindings: deduped,
    counts: {
      total: deduped.length,
      p0: deduped.filter(x => x.severity === 'p0_urgent').length,
      p1: deduped.filter(x => x.severity === 'p1_high').length,
      p2: deduped.filter(x => x.severity === 'p2_medium').length,
      p3: deduped.filter(x => x.severity === 'p3_info').length
    }
  };
}
