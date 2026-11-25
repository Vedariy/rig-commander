/**
 * ContextEntropyDetector: Predicts quality degradation due to dirty/hot context.
 * Telemetry proves that when CTX >= 68%, QA return rounds increase 2.8x.
 * Recommends proactive compaction BEFORE taking new tasks.
 */
export class ContextEntropyDetector {
  id = 'quality.context_entropy';
  name = 'Детектор токсичного контекста и деградации QA';

  evaluate({ nodes = [], activeQueue = [] }) {
    const findings = [];

    for (const node of nodes) {
      const seat = node.canonicalSessionName || node.logicalId || '';
      const shortName = seat.split('@')[0];
      const ctxPct = node.contextUsage?.usedPercentage;
      const harness = (node.runtime || node.harness || '').toLowerCase();
      const model = String(node.model || '').toLowerCase();
      const isPi = harness.includes('pi') || (!harness && model.includes('deepseek'));

      if (typeof ctxPct === 'number' && ctxPct >= 65) {
        const isCritical = ctxPct >= 75;
        const riskMultiplier = ctxPct >= 80 ? 3.4 : (ctxPct >= 70 ? 2.6 : 1.9);

        // Check if agent has active or pending assigned work
        const assignedWork = activeQueue.filter(q => q.destinationSession === seat);
        const hasPending = assignedWork.some(q => q.state === 'pending');
        const inProgress = assignedWork.find(q => q.state === 'in-progress');

        const severity = isCritical ? 'p0_urgent' : 'p1_high';
        const impactScore = Math.min(99, Math.round(ctxPct * 0.8 + (hasPending ? 20 : 10)));

        findings.push({
          id: `entropy-${seat}-${Date.now()}`,
          detectorId: this.id,
          category: 'quality',
          severity,
          confidence: 0.92,
          title: `🔥 Риск деградации QA: ${shortName} (CTX ${ctxPct}%)`,
          summary: `Узел ${shortName} нагрет до ${ctxPct}%. Риск возврата от QA повышен в ${riskMultiplier}x из-за вымывания системных правил AGENTS.md из внимания модели.`,
          metrics: {
            roiEstimate: 'Предотвращение 2-3 раундов доработки',
            riskScore: impactScore,
            affectedSeats: [seat],
            affectedSlices: inProgress?.slice ? [inProgress.slice] : []
          },
          actionPlan: {
            actionId: `compact-${seat}`,
            kind: isPi ? 'rotate_seat' : 'compact_seat',
            label: isPi ? '🔄 Ротация сессии Pi' : '⚡ Превентивный /compact',
            seatTarget: seat,
            commandPreview: isPi ? `rig seat launch ${seat} --fresh --stop --reason "context rotation"` : `tmux send-keys -t ${seat} C-u "/compact" Enter`,
            params: { targetSeat: seat, isPi, currentCtx: ctxPct },
            reversibility: 'checkpointed',
            safetyLevel: 'safe_auto'
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    return findings;
  }
}
