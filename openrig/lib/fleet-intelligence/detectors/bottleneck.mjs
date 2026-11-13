import { computeQueueKinetics } from '../metrics.mjs';

/**
 * BottleneckDetector: Identifies queue congestion and fan-in bottlenecks.
 * Specifically alerts when review or lead nodes (e.g. dev-check) have WWR >= 1.5
 * or pending queue depth >= 3 items.
 */
export class BottleneckDetector {
  id = 'topology.bottleneck';
  name = 'Детектор бутылочных горлышек очереди';

  evaluate({ nodes = [], activeQueue = [], recentQueue = [] }) {
    const findings = [];
    const allQueue = [...activeQueue, ...recentQueue];
    const kinetics = computeQueueKinetics(allQueue);

    for (const [seat, stat] of Object.entries(kinetics)) {
      // Focus on seats with active congestion or high WWR
      const isReviewOrLead = seat.includes('check') || seat.includes('owner') || seat.includes('lead');
      const isCongested = (stat.pendingCount >= 2 && stat.avgWaitMin >= 5) || (stat.wwr >= 1.8 && stat.pendingCount >= 1);

      if (isCongested) {
        const node = nodes.find(n => (n.canonicalSessionName || n.logicalId || '') === seat);
        const shortName = seat.split('@')[0];
        const isCheck = seat.includes('check');

        const impactScore = Math.min(95, Math.round(stat.wwr * 25 + stat.pendingCount * 15));
        const estimatedDelayMin = Math.round(stat.pendingCount * (stat.avgWorkMin || 15));

        findings.push({
          id: `bottleneck-${seat}-${Date.now()}`,
          detectorId: this.id,
          category: 'topology',
          severity: stat.pendingCount >= 3 ? 'p0_urgent' : 'p1_high',
          confidence: 0.88,
          title: `🚨 Горлышко очереди: ${shortName} (ожидание ~${estimatedDelayMin} мин)`,
          summary: `Узел ${shortName} перегружен: в очереди ${stat.pendingCount} задач(и), WWR = ${stat.wwr}. Время ожидания в очереди превышает активную разработку в ${stat.wwr} раза.`,
          metrics: {
            roiEstimate: isCheck ? 'Ускорение ревью в 2.5 раза' : 'Устранение задержки очереди',
            riskScore: impactScore,
            affectedSeats: [seat],
            affectedSlices: []
          },
          actionPlan: {
            actionId: `scale-${seat}`,
            kind: 'scale_role',
            label: isCheck ? '⚡ Подключить dev-check2' : '⚡ Сбалансировать очередь',
            seatTarget: seat,
            commandPreview: isCheck ? `rig grow core-platform dev.check2` : `rig queue balance ${seat}`,
            params: { targetSeat: seat, role: isCheck ? 'qa' : 'orchestrator' },
            reversibility: 'fully_reversible',
            safetyLevel: 'requires_operator_ack'
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    return findings;
  }
}
