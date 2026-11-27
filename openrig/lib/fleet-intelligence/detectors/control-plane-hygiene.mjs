/**
 * ControlPlaneHygieneDetector (Fleet Intelligence Detector #8)
 *
 * Surfaces early control-plane degradation and queue zombie storms:
 *  - P0 DAEMON_DEGRADED: rolling API latency > 1000ms (or >=3 slow probes), daemon.log > 50MB / >5MB/h,
 *    openrig.sqlite > 100MB, stuckSweep >= 5 failures, or unhealthy /healthz.
 *  - P1 QUEUE_ZOMBIE_STORM: >= 20 stale qitem-opgate-* (>24h), detached target seats (>6h),
 *    or >= 2 live idle seats carrying stale_runtime_hook.
 *  - P1 BROKEN_ESCALATION_ROUTE: repeated permanent routing errors / stuckSweep crash loop in daemon.log tail.
 */

import {
  evaluateControlPlaneHealth,
  summarizeQueueAndSeats
} from '../../../assets/domain/control-plane-model.js';

export class ControlPlaneHygieneDetector {
  id = 'control-plane-hygiene';
  name = 'Детектор гигиены и деградации Control-Plane';

  evaluate(context = {}) {
    const cp = context?.controlPlane;
    const nodes = Array.isArray(context?.nodes) ? context.nodes : [];
    const activeQueue = Array.isArray(context?.activeQueue) ? context.activeQueue : [];

    let input = cp;
    if (!input) {
      if (nodes.length === 0 && activeQueue.length === 0) return [];
      input = summarizeQueueAndSeats({ activeQueue, nodes });
    } else if (!input.queue && !input.seats && (nodes.length > 0 || activeQueue.length > 0)) {
      const derived = summarizeQueueAndSeats({ activeQueue, nodes });
      input = { ...input, queue: derived.queue, seats: derived.seats };
    }

    const evaluation = evaluateControlPlaneHealth(input);
    if (!evaluation.findings.length) return [];

    const detectedAt = new Date().toISOString();
    return evaluation.findings.map(finding => {
      const affectedSeats = Array.isArray(finding.metrics?.affectedSeats)
        ? finding.metrics.affectedSeats
        : [];
      return {
        id: `control-plane-${finding.code.toLowerCase()}`,
        code: finding.code,
        detectorId: this.id,
        category: 'control_plane',
        severity: finding.severity,
        confidence: finding.confidence,
        shortTitle: finding.shortTitle,
        title: finding.title,
        summary: finding.summary,
        remediation: finding.remediation,
        metrics: {
          roiEstimate: 'Восстановление стабильности OpenRig daemon и очереди',
          riskScore: finding.riskScore,
          affectedSeats,
          // Distinct slice key prevents compileAdvisoryReport from collapsing P0+P1 control-plane findings into one slot.
          affectedSlices: [finding.code],
          ...finding.metrics,
          reasons: finding.reasons
        },
        actionPlan: finding.actionPlan,
        detectedAt
      };
    });
  }
}
