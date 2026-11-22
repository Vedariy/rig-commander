/**
 * LiveBlockerDetector: Detects immediate operational blockers requiring human or operator action.
 * - P0: Any seat waiting on an interactive HITL terminal permission/confirmation prompt.
 * - P1: Any parked seat still holding assigned or open queue obligations.
 */
export class LiveBlockerDetector {
  id = 'topology.live_blocker';
  name = 'Детектор активных HITL-блокеров и запаркованных узлов';

  evaluate({ nodes = [], activeQueue = [], parkedSeats = {} }) {
    const findings = [];

    for (const node of nodes) {
      const seat = node.canonicalSessionName || node.logicalId || '';
      if (!seat) continue;
      const shortName = seat.split('@')[0];

      const display = node.activityState?.display || '';
      const activity = node.activityState?.activity || '';
      const needsCount = node.activityState?.needsInput?.count ?? node.needsInputCount ?? 0;
      const isHitlBlocked = display === 'needs-input' || activity === 'waiting-human' || needsCount > 0;

      if (isHitlBlocked) {
        const reason = String(node.activityState?.needsInput?.reason || node.needsInputReason || 'Остановлен на подтверждении в терминале').replace(/\.+$/, '');
        findings.push({
          id: `hitl-${seat}`,
          detectorId: this.id,
          category: 'topology',
          severity: 'p0_urgent',
          confidence: 0.96,
          title: `🚨 ${shortName} ждёт подтверждения человека (HITL)`,
          summary: `${reason}. Откройте живой экран tmux, выберите вариант подтверждения (или отправьте ответ) — агент сразу продолжит работу.`,
          metrics: {
            roiEstimate: 'Мгновенное снятие простоя узла',
            riskScore: 98,
            affectedSeats: [seat],
            affectedSlices: []
          },
          actionPlan: {
            actionId: `open-hitl-${seat}`,
            kind: 'open_modal',
            label: '🖥️ Ответить в tmux',
            seatTarget: seat,
            commandPreview: '',
            params: { targetSeat: seat },
            reversibility: 'fully_reversible',
            safetyLevel: 'safe_auto'
          },
          detectedAt: new Date().toISOString()
        });
      }

      const parkedInfo = parkedSeats[seat] || node.parkedData || null;
      const isParked = Boolean(parkedInfo && parkedInfo.parked);
      const hasOpenWork = (node.assignedWorkCount || 0) > 0 ||
        activeQueue.some(q => q.destinationSession === seat && q.state !== 'done' && q.state !== 'terminal');

      if (isParked && hasOpenWork) {
        const reason = String(parkedInfo.reason || 'Узел запаркован, но удерживает незавершённые задачи в очереди').replace(/\.+$/, '');
        findings.push({
          id: `parked-work-${seat}`,
          detectorId: this.id,
          category: 'topology',
          severity: 'p1_high',
          confidence: 0.90,
          title: `🟠 ${shortName} запаркован с открытыми задачами`,
          summary: `${reason}. Отправьте Enter для пробуждения сессии или перераспределите задачи на свободного агента.`,
          metrics: {
            roiEstimate: 'Разблокировка очереди узла',
            riskScore: 76,
            affectedSeats: [seat],
            affectedSlices: []
          },
          actionPlan: {
            actionId: `wake-${seat}`,
            kind: 'wake_seat',
            label: '⚡ Разбудить (Enter)',
            seatTarget: seat,
            commandPreview: '',
            params: { targetSeat: seat },
            reversibility: 'fully_reversible',
            safetyLevel: 'safe_auto'
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    return findings;
  }
}
