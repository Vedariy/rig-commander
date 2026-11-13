/**
 * FleetIntelligenceEngine — Public Facade of the Fleet Intelligence Modular Monolith.
 * Zero-dependency, thread-safe within Node.js event loop, fault-isolated.
 */

import { TelemetryRingBuffer } from './ring-buffer.mjs';
import { compileAdvisoryReport } from './advisory.mjs';
import { BottleneckDetector } from './detectors/bottleneck.mjs';
import { ContextEntropyDetector } from './detectors/context-entropy.mjs';
import { ModelMismatchDetector } from './detectors/model-mismatch.mjs';
import { CeremonyAmplifierDetector } from './detectors/ceremony.mjs';
import { ZombieSeatDetector } from './detectors/zombie-seat.mjs';

export class FleetIntelligenceEngine {
  constructor(options = {}) {
    this.buffer = new TelemetryRingBuffer(options.maxSnapshots || 300);
    this.detectors = [
      new ContextEntropyDetector(),
      new BottleneckDetector(),
      new ModelMismatchDetector(),
      new CeremonyAmplifierDetector(),
      new ZombieSeatDetector()
    ];
    this.cachedReport = null;
    this.lastEvaluationTs = 0;
    this.evalThrottleMs = options.evalThrottleMs || 3000;
  }

  /**
   * Ingest a fresh snapshot of telemetry. Non-blocking and fault-isolated.
   */
  ingestSnapshot(snapshot) {
    if (!snapshot) return;
    try {
      this.buffer.push(snapshot);
      const now = Date.now();
      if (now - this.lastEvaluationTs >= this.evalThrottleMs) {
        this.evaluate(snapshot);
        this.lastEvaluationTs = now;
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
      recentQueue: snapshot.recentQueue || snapshot.history?.sliceStats ? [] : [],
      usageSeries: snapshot.usageSeries || [],
      healthFindings: snapshot.healthFindings || [],
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

    this.cachedReport = compileAdvisoryReport(rawFindings, context.rigId);
    return this.cachedReport;
  }

  /**
   * Returns latest cached advisory report, or generates a default if empty
   */
  getLatestReport(rigId = 'all') {
    if (this.cachedReport) return this.cachedReport;
    const latestSnapshot = this.buffer.getLatest();
    if (latestSnapshot) {
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
