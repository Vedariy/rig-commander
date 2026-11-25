import { computeQueueKinetics } from '../metrics.mjs';

/**
 * BottleneckDetector: Identifies REAL queue congestion and separates synthetic
 * stuck-sweep / undelivered-wake noise from actual user tasks.
 * Emits structured pendingSamples & concrete remediation steps so the Node Inspector
 * immediately explains WHAT is stuck and HOW to fix it.
 */
export class BottleneckDetector {
  id = 'topology.bottleneck';
  name = 'Детектор бутылочных горлышек очереди';

  evaluate({ nodes = [], activeQueue = [], recentQueue = [] }) {
    const findings = [];
    const allQueue = [...activeQueue, ...recentQueue];
    const kinetics = computeQueueKinetics(allQueue);

    for (const [seat, stat] of Object.entries(kinetics)) {
      if (!seat || seat === 'unknown' || seat.endsWith('@external')) continue;

      const node = nodes.find(n => (n.canonicalSessionName || n.logicalId || '') === seat) || null;
      if (nodes.length > 0 && !node) continue;
      const shortName = seat.split('@')[0];
      const isCheck = seat.includes('check') || seat.includes('qa');
      const isShellExited = Boolean(node && node.shellExited);
      const isWorking = Boolean(node && (node.activityState?.display === 'working' || node.state === 'working'));

      // 1. Real user task congestion (deduped, noise-filtered)
      const isRealCongested =
        (stat.pendingCount >= 3) ||
        (stat.pendingCount >= 2 && stat.avgWaitMin >= 5) ||
        (stat.wwr >= 1.8 && stat.pendingCount >= 1);

      if (isRealCongested) {
        const impactScore = Math.min(95, Math.round((stat.wwr || 1) * 20 + stat.pendingCount * 16));
        const estimatedDelayMin = Math.round(stat.pendingCount * (stat.avgWorkMin || 12));
        const noiseNote = stat.noisePendingCount > 0
          ? ` (+ ${stat.noisePendingCount} служебных stuck-sweep)`
          : '';
        const wwrNote = stat.wwr >= 1.3
          ? ` Ожидание в очереди в ${stat.wwr}× дольше самой работы.`
          : (stat.avgWaitMin >= 1 ? ` Среднее ожидание ~${Math.round(stat.avgWaitMin)} мин.` : '');

        const remediation = isShellExited
          ? `Сессия вышла в голый shell — перезапустите узел командой rig seat launch ${seat} --fresh --stop --reason "shell exited", чтобы он разобрал очередь.`
          : (!isWorking
            ? `Узел сейчас простаивает с открытой очередью. Нажмите «📨 Разобрать очередь» (отправит агенту конкретную задачу проверить rig queue list --owned, вместо пустого Enter) или закройте устаревшие строки.`
            : `Узел сейчас занят, но очередь растёт. Проверьте Гант задач и при необходимости переназначьте часть ожидающих задач на свободного агента.`);

        findings.push({
          id: `bottleneck-${seat}`,
          detectorId: this.id,
          category: 'topology',
          severity: stat.pendingCount >= 4 ? 'p0_urgent' : 'p1_high',
          confidence: 0.90,
          shortTitle: `${shortName}: очередь (${stat.pendingCount})`,
          title: `🚨 Горлышко очереди: ${shortName} (${stat.pendingCount} задач, ~${estimatedDelayMin} мин)`,
          summary: `У ${shortName} ждут взятия ${stat.pendingCount} реальных задач(и)${noiseNote}.${wwrNote}`,
          remediation,
          metrics: {
            roiEstimate: isCheck ? 'Ускорение ревью QA' : 'Разбор затора очереди',
            riskScore: impactScore,
            affectedSeats: [seat],
            affectedSlices: stat.pendingSamples.map(s => s.slice).filter(Boolean),
            pendingCount: stat.pendingCount,
            noisePendingCount: stat.noisePendingCount,
            avgWaitMin: stat.avgWaitMin,
            wwr: stat.wwr,
            pendingSamples: stat.pendingSamples
          },
          actionPlan: {
            actionId: `inspect-bottleneck-${seat}`,
            kind: 'select_seat',
            label: '🔍 Диагноз',
            seatTarget: seat,
            commandPreview: `rig queue list --owned`,
            params: { targetSeat: seat, role: isCheck ? 'qa' : 'orchestrator' },
            reversibility: 'fully_reversible',
            safetyLevel: 'safe_auto'
          },
          detectedAt: new Date().toISOString()
        });
        continue;
      }

      // 2. Pure system noise backlog (stuck-sweep / undelivered-wake only, 0 real pending tasks) -> P2 info/cleanup, NEVER P0 alarm!
      if (stat.pendingCount === 0 && stat.noisePendingCount >= 3) {
        findings.push({
          id: `queue-noise-${seat}`,
          detectorId: this.id,
          category: 'topology',
          severity: 'p2_medium',
          confidence: 0.85,
          shortTitle: `${shortName}: шум очереди (${stat.noisePendingCount})`,
          title: `🧹 Служебный шум в очереди ${shortName}: ${stat.noisePendingCount} записей`,
          summary: `Реальных задач в ожидании нет — в очереди ${shortName} накопились ${stat.noisePendingCount} служебных записей (stuck-sweep / undelivered-wake).`,
          remediation: `Не является критическим застоем. Нажмите «📨 Разобрать очередь» чтобы агент закрыл устаревшие stuck-sweep записи, или очистите их через rig queue.`,
          metrics: {
            roiEstimate: 'Очистка служебного шума',
            riskScore: 42,
            affectedSeats: [seat],
            affectedSlices: [],
            pendingCount: 0,
            noisePendingCount: stat.noisePendingCount,
            pendingSamples: []
          },
          actionPlan: {
            actionId: `inspect-noise-${seat}`,
            kind: 'select_seat',
            label: '🔍 Диагноз',
            seatTarget: seat,
            commandPreview: `rig queue list --owned`,
            params: { targetSeat: seat, role: 'cleanup' },
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
