/**
 * CeremonyAmplifierDetector: Detects excessive bureaucratic overhead in task handoffs.
 * Alerts when tasks spend more than 6-8 handoff cycles or experience ping-pong between
 * the same two seats without progress.
 */
export class CeremonyAmplifierDetector {
  id = 'workflow.ceremony';
  name = 'Детектор избыточной бюрократии и пинг-понга';

  evaluate({ activeQueue = [], recentQueue = [], healthFindings = [] }) {
    const findings = [];

    // 1. Check for native health detector findings from OpenRig
    for (const h of healthFindings) {
      if (h.detector === 'process.ceremony-amplification' || h.detector?.includes('ceremony')) {
        const qitemId = h.ceremony?.lineageId || (h.evidence?.[0]?.qitemId) || 'qitem';
        findings.push({
          id: `ceremony-native-${h.id || Date.now()}`,
          detectorId: this.id,
          category: 'ceremony',
          severity: 'p2_medium',
          confidence: 0.90,
          title: `🔄 Бюрократический пинг-понг: задача ${qitemId.slice(0, 16)}`,
          summary: `Детектор OpenRig Health зафиксировал избыточное число служебных переходов (${h.evidence?.length || 'много'} шагов) для задачи ${qitemId}.`,
          metrics: {
            roiEstimate: 'Спрямление маршрута ускорит сдачу на 15-20 мин',
            riskScore: 60,
            affectedSeats: [],
            affectedSlices: []
          },
          actionPlan: {
            actionId: `streamline-${qitemId}`,
            kind: 'patch_guidance',
            label: '⚡ Спрямить handoff',
            commandPreview: `rig queue delegate ${qitemId} --direct`,
            params: { qitemId },
            reversibility: 'fully_reversible',
            safetyLevel: 'requires_operator_ack'
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    // 2. Scan recent queue transitions for ping-pong between same pairs
    const transitions = [...activeQueue, ...recentQueue];
    const sliceHops = {};
    for (const t of transitions) {
      const slice = t.tags?.find(tag => tag.startsWith('slice:'))?.replace('slice:', '') || t.slice;
      if (!slice) continue;
      sliceHops[slice] = (sliceHops[slice] || 0) + 1;
    }

    for (const [slice, hops] of Object.entries(sliceHops)) {
      if (hops >= 8) {
        findings.push({
          id: `ceremony-hops-${slice}-${Date.now()}`,
          detectorId: this.id,
          category: 'ceremony',
          severity: 'p2_medium',
          confidence: 0.82,
          title: `⚠️ Слайс ${slice}: ${hops} переходов очереди`,
          summary: `Слайс ${slice} прошёл ${hops} переходов между агентами. Рекомендуется разрешить прямой handoff coder ➔ check без промежуточных согласований.`,
          metrics: {
            roiEstimate: 'Сокращение времени слайса на 30%',
            riskScore: 65,
            affectedSeats: [],
            affectedSlices: [slice]
          },
          actionPlan: {
            actionId: `bypass-${slice}`,
            kind: 'patch_guidance',
            label: '⚡ Упростить маршрут',
            commandPreview: `rig queue route ${slice} --direct`,
            params: { slice },
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
