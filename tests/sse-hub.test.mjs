import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SsePushHub, formatSseFrame, computeTelemetrySignature } from '../openrig/lib/sse-hub.mjs';

function makeMockStreamPair() {
  const req = new EventEmitter();
  const chunks = [];
  let statusCode = 0;
  let headers = {};
  let ended = false;
  const res = new EventEmitter();
  res.writeHead = (code, hdrs) => { statusCode = code; headers = hdrs || {}; };
  res.write = (chunk) => { chunks.push(String(chunk)); return true; };
  res.end = (chunk) => { if (chunk) chunks.push(String(chunk)); ended = true; };
  Object.defineProperty(res, 'writableEnded', { get: () => ended });
  return {
    req,
    res,
    chunks,
    getStatus: () => statusCode,
    getHeaders: () => headers,
    getText: () => chunks.join(''),
    close: () => req.emit('close')
  };
}

test('formatSseFrame & computeTelemetrySignature handle multi-line payloads and detect real deltas', () => {
  const frame = formatSseFrame('screen', 'line1\nline2', '42');
  assert.equal(frame, 'id: 42\nevent: screen\ndata: line1\ndata: line2\n\n');

  const p1 = {
    requestedRig: 'all',
    historyRev: 'h1',
    guidanceRev: 'g1',
    gitRadarRev: 'r1',
    nodes: [{ canonicalSessionName: 'dev-coder@core', activityState: { display: 'idle' }, contextUsage: { usedPercentage: 30 } }],
    activeQueue: []
  };
  const s1 = computeTelemetrySignature(p1);
  const s1Again = computeTelemetrySignature({ ...p1 });
  assert.equal(s1, s1Again);

  const s2 = computeTelemetrySignature({
    ...p1,
    nodes: [{ canonicalSessionName: 'dev-coder@core', activityState: { display: 'needs-input', needsInput: { count: 1 } }, contextUsage: { usedPercentage: 30 } }]
  });
  assert.notEqual(s1, s2);
});

test('SsePushHub broadcasts fleet telemetry deltas only on change, enforces maxClients, and cleans up on disconnect', () => {
  const hub = new SsePushHub({ maxClients: 2, heartbeatMs: 60_000 });
  const c1 = makeMockStreamPair();
  const c2 = makeMockStreamPair();
  const c3 = makeMockStreamPair();

  hub.subscribeEvents(c1.req, c1.res, { rigKey: 'core' });
  hub.subscribeEvents(c2.req, c2.res, { rigKey: 'all' });
  assert.equal(c1.getStatus(), 200);
  assert.match(c1.getHeaders()['Content-Type'], /text\/event-stream/);
  assert.match(c1.getText(), /event: ready/);
  assert.equal(hub.totalClients, 2);

  // Third client rejected cleanly with 503
  hub.subscribeEvents(c3.req, c3.res, { rigKey: 'all' });
  assert.equal(c3.getStatus(), 503);

  const snap = {
    requestedRig: 'core',
    historyRev: 'h1',
    guidanceRev: 'g1',
    gitRadarRev: 'r1',
    nodes: [{ canonicalSessionName: 'dev-coder@core', activityState: { display: 'working' } }],
    activeQueue: []
  };
  assert.equal(hub.publishTelemetryBundle('core', snap), 2);
  // Duplicate signature sends 0 frames!
  assert.equal(hub.publishTelemetryBundle('core', snap), 0);
  // Invalidate notifies both
  assert.equal(hub.notifyInvalidated('send', 'dev-coder@core'), 2);
  assert.match(c1.getText(), /event: invalidate/);

  // Disconnect both -> zero active subscribers & stopped heartbeat
  c1.close();
  c2.close();
  assert.equal(hub.totalClients, 0);
  assert.equal(hub.hasActiveSubscribers(), false);
  assert.equal(hub.heartbeatTimer, null);
});

test('SsePushHub deduplicates Live TMUX captures across subscribers, skips identical frames, and responds immediately to triggerSeatCaptureNow', async () => {
  let screenVal = 'initial screen v1';
  let captureCalls = 0;
  const hub = new SsePushHub({
    fastCaptureMs: 120,
    idleCaptureMs: 250,
    heartbeatMs: 60_000,
    captureFn: async () => {
      captureCalls++;
      return screenVal;
    }
  });

  const c1 = makeMockStreamPair();
  const c2 = makeMockStreamPair();

  // Bad seatId rejected with 400
  const bad = makeMockStreamPair();
  hub.subscribeTmux(bad.req, bad.res, { seatId: '../evil', lines: 80 });
  assert.equal(bad.getStatus(), 400);

  hub.subscribeTmux(c1.req, c1.res, { seatId: 'dev-coder@core', lines: 80 });
  await new Promise(r => setTimeout(r, 40));
  assert.match(c1.getText(), /initial screen v1/);
  assert.equal(captureCalls, 1);

  // Second subscriber on same (seat, lines) gets cached screen immediately without extra capture call
  hub.subscribeTmux(c2.req, c2.res, { seatId: 'dev-coder@core', lines: 80 });
  assert.match(c2.getText(), /initial screen v1/);
  assert.equal(hub.getStats().tmuxWatchers, 1);

  // Mutate screen and immediately trigger push
  const beforeCount = (c1.getText().match(/event: screen/g) || []).length;
  screenVal = 'updated screen v2 after send';
  hub.triggerSeatCaptureNow('dev-coder@core');
  await new Promise(r => setTimeout(r, 40));
  assert.match(c1.getText(), /updated screen v2 after send/);
  assert.match(c2.getText(), /updated screen v2 after send/);
  const afterCount = (c1.getText().match(/event: screen/g) || []).length;
  assert.equal(afterCount, beforeCount + 1);

  // Unchanged screen on subsequent poll must NOT emit duplicate screen frames
  await new Promise(r => setTimeout(r, 180));
  assert.equal((c1.getText().match(/event: screen/g) || []).length, afterCount);

  c1.close();
  c2.close();
  assert.equal(hub.getStats().tmuxWatchers, 0);
  assert.equal(hub.totalClients, 0);
});

test('SsePushHub streams shift_event frames cleanly into Node Writable stream and terminates cleanly on closeAll', async () => {
  const hub = new SsePushHub({ heartbeatMs: 60_000 });
  const req = new EventEmitter();
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', buf => chunks.push(buf.toString('utf8')));
  stream.writeHead = (code, hdrs) => {
    assert.equal(code, 200);
    assert.match(String(hdrs['Content-Type']), /text\/event-stream/);
    assert.equal(hdrs['X-Accel-Buffering'], 'no');
  };

  hub.subscribeEvents(req, stream, { rigKey: 'core' });
  // Cross-rig event for unrelated rig must be filtered out
  assert.equal(hub.publishShiftEvent({ kind: 'seat_state', rigId: 'other-rig', severity: 'warn', title: 'Ignored' }), 0);
  // Matching rig event must stream through
  assert.equal(hub.publishShiftEvent({ kind: 'seat_state', rigId: 'core', severity: 'critical', title: 'HITL test' }), 1);

  hub.closeAll();
  const body = chunks.join('');
  assert.match(body, /event: ready/);
  assert.match(body, /event: shift_event/);
  assert.match(body, /HITL test/);
  assert.equal(body.includes('Ignored'), false);
  assert.equal(hub.totalClients, 0);
});
