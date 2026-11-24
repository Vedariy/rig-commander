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
          shortTitle: `${shortName}: ждёт ответ`,
          title: `🚨 ${shortName} ждёт подтверждения человека (HITL)`,
          summary: `${reason}. Откройте живой экран tmux, выберите вариант подтверждения (или отправьте ответ) — агент сразу продолжит работу.`,
          remediation: `Нажмите «🖥️ Ответить в tmux», проверьте запрос разрешения и кликните нужный вариант ответа.`,
          metrics: {
            roiEstimate: 'Мгновенное снятие простоя узла',
            riskScore: 98,
            affectedSeats: [seat],
            affectedSlices: []
          },
          actionPlan: {
            actionId: `open-hitl-${seat}`,
            kind: 'open_modal',
            label: '🖥️ Экран',
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
      const isShellExited = Boolean(node.shellExited);
      const openForSeat = activeQueue.filter(q => q.destinationSession === seat && q.state !== 'done' && q.state !== 'terminal');
      const openCount = Math.max(Number(node.assignedWorkCount) || 0, openForSeat.length);
      const hasOpenWork = openCount > 0;

      if (isParked && hasOpenWork) {
        const rawReason = String(parkedInfo.reason || '').trim();
        const isIdlePrompt = /idle-at-prompt/i.test(rawReason);
        const heldMatch = rawReason.match(/(\d+)\s+unhealthy\s+HELD/i);
        const heldCount = heldMatch ? Number(heldMatch[1]) : 0;

        let cleanSummary;
        let remediation;
        if (isShellExited) {
          cleanSummary = `Процесс агента ${shortName} вышел в голый shell при ${openCount} открытых задачах в очереди.`;
          remediation = `Перезапустите сессию командой rig restart ${seat} (пустой Enter в shell не запустит агента).`;
        } else if (isIdlePrompt) {
          cleanSummary = `${shortName} сидит на пустом промпте с ${openCount} открытыми обязательствами${heldCount > 0 ? ` и ${heldCount} незакрытыми HELD-строками` : ''} без активного wake.`;
          remediation = `Пустой Enter на чистом промпте обычно не запускает агента — нажмите «📨 Разобрать очередь», чтобы отправить явную инструкцию проверить rig queue list --owned, или закройте лишние HELD-строки.`;
        } else {
          const shortReason = (rawReason.split('Remedy:')[0] || rawReason || 'Узел запаркован с открытыми задачами').replace(/[\s—.-]+$/, '');
          cleanSummary = `${shortReason}.`;
          remediation = `Нажмите «📨 Разобрать очередь» (явный промпт в tmux) или «⚡ Enter», если агент ждёт подтверждения.`;
        }

        findings.push({
          id: `parked-work-${seat}`,
          detectorId: this.id,
          category: 'topology',
          severity: 'p1_high',
          confidence: 0.90,
          shortTitle: isShellExited ? `${shortName}: SHELL (${openCount})` : `${shortName}: PARKED (${openCount})`,
          title: isShellExited ? `⚠️ ${shortName} вышел в shell (${openCount} задач)` : `🟠 ${shortName} запаркован (${openCount} задач)`,
          summary: cleanSummary,
          remediation,
          metrics: {
            roiEstimate: 'Разблокировка очереди узла',
            riskScore: 76,
            affectedSeats: [seat],
            affectedSlices: [],
            openCount,
            heldCount,
            idleAtPrompt: isIdlePrompt
          },
          actionPlan: {
            actionId: `wake-${seat}`,
            kind: 'wake_seat',
            label: isShellExited ? '🔄 Restart' : '⚡ Разбудить',
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
