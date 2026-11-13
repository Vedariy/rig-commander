/**
 * ZombieSeatDetector: Identifies idle or abandoned tmux sessions holding memory
 * and provider subscription slots without active or pending work.
 * Recommends parking the seat with `rig seat park <seat>`.
 */
export class ZombieSeatDetector {
  id = 'topology.zombie';
  name = 'Детектор неактивных (Zombie / Idle) сидений';

  evaluate({ nodes = [], activeQueue = [] }) {
    const findings = [];

    for (const node of nodes) {
      const seat = node.canonicalSessionName || node.logicalId || '';
      const shortName = seat.split('@')[0];

      // Ignore critical orchestration nodes
      if (seat.includes('owner') || seat.includes('operator') || seat.includes('kernel') || seat.includes('guardian')) {
        continue;
      }

      const isRunning = node.sessionStatus === 'running' || node.lifecycleState === 'running';
      const isIdle = node.activityState?.display === 'idle' || node.activityState?.activity === 'idle-at-prompt';
      const hasWork = (node.assignedWorkCount || 0) > 0 || activeQueue.some(q => q.destinationSession === seat && q.state !== 'done');

      // Check if last activity was a long time ago (e.g. > 3 hours or unknown)
      const lastAct = node.lastActivityAt ? new Date(node.lastActivityAt).getTime() : 0;
      const hoursIdle = lastAct > 0 ? (Date.now() - lastAct) / 3600000 : 4;

      if (isRunning && isIdle && !hasWork && hoursIdle >= 3) {
        findings.push({
          id: `zombie-${seat}-${Date.now()}`,
          detectorId: this.id,
          category: 'topology',
          severity: 'p3_info',
          confidence: 0.80,
          title: `💤 Неактивное сиденье: ${shortName} (простой ~${Math.round(hoursIdle)} ч)`,
          summary: `Узел ${shortName} запущен в tmux и удерживает сессию, но не имеет задач в очереди более ${Math.round(hoursIdle)} ч. Рекомендуется запарковать сиденье для освобождения памяти хоста.`,
          metrics: {
            roiEstimate: 'Высвобождение памяти и квот хоста',
            riskScore: 30,
            affectedSeats: [seat],
            affectedSlices: []
          },
          actionPlan: {
            actionId: `park-${seat}`,
            kind: 'park_seat',
            label: `💤 Запарковать ${shortName}`,
            seatTarget: seat,
            commandPreview: `rig seat park ${seat}`,
            params: { targetSeat: seat },
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
