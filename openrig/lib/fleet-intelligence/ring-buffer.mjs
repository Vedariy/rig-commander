/**
 * RingBuffer: Bounded slim time-series storage for OpenRig telemetry.
 * Strips giant static/historical blobs (history, seatGuidance, seatCompactions,
 * intelligence, decisions, actionAudit) so long-running daemons stay < 3 MB RAM.
 */
function slimSnapshot(snapshot) {
  const nodes = Array.isArray(snapshot.nodes)
    ? snapshot.nodes.map(n => ({
        canonicalSessionName: n && n.canonicalSessionName,
        logicalId: n && n.logicalId,
        runtime: n && n.runtime,
        model: n && n.model,
        modelObservation: n && n.modelObservation ? { model: n.modelObservation.model } : null,
        activityState: n && n.activityState ? {
          activity: n.activityState.activity,
          display: n.activityState.display,
          needsInput: n.activityState.needsInput || null
        } : null,
        contextUsage: n && n.contextUsage ? {
          usedPercent: n.contextUsage.usedPercent,
          usedTokens: n.contextUsage.usedTokens,
          windowSize: n.contextUsage.windowSize
        } : null,
        assignedWorkCount: n && n.assignedWorkCount,
        inProgressWorkCount: n && n.inProgressWorkCount,
        shellExited: Boolean(n && n.shellExited)
      }))
    : [];
  const activeQueue = Array.isArray(snapshot.activeQueue)
    ? snapshot.activeQueue.slice(0, 120).map(q => ({
        qitemId: q && (q.qitemId || q.id),
        state: q && q.state,
        sourceSession: q && q.sourceSession,
        destinationSession: q && q.destinationSession,
        tsCreated: q && (q.tsCreated || q.createdAt),
        tsUpdated: q && (q.tsUpdated || q.updatedAt),
        tags: Array.isArray(q && q.tags) ? q.tags.slice(0, 8) : []
      }))
    : [];
  return {
    timestamp: snapshot.timestamp,
    requestedRig: snapshot.requestedRig || 'all',
    nodes,
    activeQueue,
    parkedSeats: snapshot.parkedSeats || {},
    fleetUsageSummary: snapshot.fleetUsageSummary || null,
    _receivedAt: Date.now()
  };
}

export class TelemetryRingBuffer {
  constructor(maxItems = 30) {
    this.maxItems = Math.max(1, Number(maxItems) || 30);
    this.buffer = [];
  }

  push(snapshot) {
    if (!snapshot || !snapshot.timestamp) return;
    this.buffer.push(slimSnapshot(snapshot));
    if (this.buffer.length > this.maxItems) {
      this.buffer.shift();
    }
  }

  getRecent(windowMinutes = 60) {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    return this.buffer.filter(s => s._receivedAt >= cutoff);
  }

  getLatest() {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
  }

  size() {
    return this.buffer.length;
  }

  clear() {
    this.buffer = [];
  }
}
