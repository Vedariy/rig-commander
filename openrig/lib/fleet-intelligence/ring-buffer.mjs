/**
 * RingBuffer: Sliding window time-series storage for OpenRig telemetry.
 * Retains bounded number of snapshots (default: 360 = 24h at 4m sampling or 1h at 10s sampling)
 * Zero external database requirements, 100% memory-safe.
 */
export class TelemetryRingBuffer {
  constructor(maxItems = 300) {
    this.maxItems = maxItems;
    this.buffer = [];
  }

  push(snapshot) {
    if (!snapshot || !snapshot.timestamp) return;
    this.buffer.push({
      ...snapshot,
      _receivedAt: Date.now()
    });
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
