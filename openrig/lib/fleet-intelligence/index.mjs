/**
 * FleetIntelligenceEngine — Public Facade of the Fleet Intelligence Modular Monolith.
 * Zero-dependency, thread-safe within Node.js event loop, fault-isolated.
 */

import { TelemetryRingBuffer } from './ring-buffer.mjs';
import { compileAdvisoryReport } from './advisory.mjs';
import { LiveBlockerDetector } from './detectors/live-blocker.mjs';
import { BottleneckDetector } from './detectors/bottleneck.mjs';
import { ContextEntropyDetector } from './detectors/context-entropy.mjs';
import { ModelMismatchDetector } from './detectors/model-mismatch.mjs';
import { CeremonyAmplifierDetector } from './detectors/ceremony.mjs';
import { ZombieSeatDetector } from './detectors/zombie-seat.mjs';
import { GitConflictDetector } from './detectors/git-conflict.mjs';
import { ControlPlaneHygieneDetector } from './detectors/control-plane-hygiene.mjs';

export class FleetIntelligenceEngine {
  constructor(options = {}) {
    this.buffer = new TelemetryRingBuffer(options.maxSnapshots || 30);
    this.detectors = [
      new LiveBlockerDetector(),
      new ContextEntropyDetector(),
      new BottleneckDetector(),
      new ModelMismatchDetector(),
      new CeremonyAmplifierDetector(),
      new ZombieSeatDetector(),
      new GitConflictDetector(),
      new ControlPlaneHygieneDetector()
    ];
    this.cachedReport = null;
    this.cachedReports = new Map();
    this.lastEvalByRig = new Map();
    this.evalThrottleMs = options.evalThrottleMs || 3000;
  }

  /**
   * Ingest a fresh snapshot of telemetry. Non-blocking and fault-isolated.
   */
  ingestSnapshot(snapshot) {
    if (!snapshot) return;
    try {
      this.buffer.push(snapshot);
      const rigId = snapshot.requestedRig || 'all';
      const now = Date.now();
      const lastTs = this.lastEvalByRig.get(rigId) || 0;
      if (now - lastTs >= this.evalThrottleMs) {
        this.evaluate(snapshot);
        this.lastEvalByRig.set(rigId, now);
      }
    } catch (err) {
      console.error('[FleetIntelligence] Ingest error (isolated):', err.message);
    }
  }

  /**
   * Run all active detectors across current snapshot and recent history
   */
  evaluate(snapshot) {
    const rawFindings = [];
    const context = {
      nodes: snapshot.nodes || [],
      activeQueue: snapshot.activeQueue || [],
      recentQueue: Array.isArray(snapshot.recentQueue)
        ? snapshot.recentQueue
        : (Array.isArray(snapshot.history?.ganttItems) ? snapshot.history.ganttItems : []),
      usageSeries: snapshot.usageSeries || [],
      healthFindings: snapshot.healthFindings || [],
      parkedSeats: snapshot.parkedSeats || {},
      gitRadar: snapshot.gitRadar || null,
      controlPlane: snapshot.controlPlane || null,
      rigId: snapshot.requestedRig || 'all'
    };

    for (const detector of this.detectors) {
      try {
        const res = detector.evaluate(context);
        if (Array.isArray(res)) {
          rawFindings.push(...res);
        }
      } catch (detErr) {
        console.error(`[FleetIntelligence] Detector ${detector.id} error:`, detErr.message);
      }
    }

    const report = compileAdvisoryReport(rawFindings, context.rigId);
    this.cachedReport = report;
    this.cachedReports.set(context.rigId, report);
    return report;
  }

  /**
   * Returns latest cached advisory report for rigId, or generates one from matching snapshot
   */
  getLatestReport(rigId = 'all') {
    if (this.cachedReports.has(rigId)) return this.cachedReports.get(rigId);
    const latestSnapshot = this.buffer.getLatest();
    if (latestSnapshot && (latestSnapshot.requestedRig || 'all') === rigId) {
      return this.evaluate(latestSnapshot);
    }
    return compileAdvisoryReport([], rigId);
  }

  /**
   * Registers a new custom detector dynamically (Open-Closed Principle)
   */
  registerDetector(detector) {
    if (detector && typeof detector.evaluate === 'function') {
      this.detectors.push(detector);
    }
  }
}
