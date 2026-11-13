import { classifyTaskComplexity, resolveModelTier } from '../metrics.mjs';

/**
 * ModelMismatchDetector: Detects expensive Frontier models (GPT-6, Sonnet)
 * being burned on trivial tasks (linting, formatting, docs sync, comments).
 * Recommends rerouting to Fast/Open-Weights models (DeepSeek, GLM), saving up to 80% cost.
 */
export class ModelMismatchDetector {
  id = 'budget.mismatch';
  name = 'Детектор несоответствия сложности задачи классу модели';

  evaluate({ nodes = [], activeQueue = [] }) {
    const findings = [];

    for (const q of activeQueue) {
      if (q.state === 'terminal' || q.state === 'done') continue;

      const destSeat = q.destinationSession || '';
      const destNode = nodes.find(n => (n.canonicalSessionName || n.logicalId || '') === destSeat);
      if (!destNode) continue;

      const modelName = destNode.model || destNode.modelObservation?.model || '';
      const modelTier = resolveModelTier(modelName);
      const taskComplexity = classifyTaskComplexity(q);

      // Mismatch: Task is Commodity (Tier 1), but Node is Frontier (Tier 3)
      if (taskComplexity.tier === 1 && modelTier.tier === 3) {
        const shortSeat = destSeat.split('@')[0];
        const taskName = q.summary || q.qitemId || 'задача';

        // Find candidate Fast/Open-weights node
        const candidateNode = nodes.find(n => {
          const tier = resolveModelTier(n.model || n.modelObservation?.model || '');
          return tier.tier === 1 && (n.canonicalSessionName || '').includes('coder');
        });
        const candidateSeat = candidateNode ? (candidateNode.canonicalSessionName || candidateNode.logicalId) : 'dev-coder3@core-platform';
        const candidateShort = candidateSeat.split('@')[0];

        findings.push({
          id: `mismatch-${q.qitemId}-${Date.now()}`,
          detectorId: this.id,
          category: 'budget',
          severity: 'p2_medium',
          confidence: 0.85,
          title: `💰 Нецелевой расход квоты: ${shortSeat} (${taskComplexity.label})`,
          summary: `Задача "${taskName.slice(0, 50)}" назначена на дорогую модель ${modelTier.label} (${modelName}). Такие задачи могут выполняться на быстрых Open-Weights моделях без потери качества.`,
          metrics: {
            roiEstimate: 'Экономия до 85% квоты Frontier',
            riskScore: 55,
            affectedSeats: [destSeat, candidateSeat],
            affectedSlices: q.slice ? [q.slice] : []
          },
          actionPlan: {
            actionId: `reroute-${q.qitemId}`,
            kind: 'reroute_task',
            label: `⚡ Направить на ${candidateShort}`,
            seatTarget: candidateSeat,
            taskTarget: q.qitemId,
            commandPreview: `rig queue forward ${q.qitemId} ${candidateSeat}`,
            params: { qitemId: q.qitemId, fromSeat: destSeat, toSeat: candidateSeat },
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
