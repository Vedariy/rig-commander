import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEdgeQueueStatus } from '../openrig/assets/domain/edge-state.js';
import { renderTopologyEdgesHtml } from '../openrig/assets/ui/topology-view.js';

const row = { sourceSession: 'sender', destinationSession: 'recipient', state: 'in-progress', qitemId: 'row-a' };

test('in-progress uses the activity of the directed row and distinguishes recipient parking', () => {
  for (const [sender, recipient, parked, pickup, expected] of [
    ['idle', 'working', true, 'parked', 'live'],
    ['idle', 'urgent', true, '', 'live'],
    ['working', 'waiting', true, '', 'live'],
    ['idle', 'waiting', true, '', 'parked'],
    ['idle', 'idle', false, 'parked', 'parked'],
    ['idle', 'idle', false, '', 'pending'],
    ['urgent', 'waiting', false, '', 'pending']
  ]) {
    const result = classifyEdgeQueueStatus([{ ...row, pickup: { state: pickup } }], {
      seatStatesById: { sender, recipient },
      parkedSeatsById: { sender: true, recipient: parked },
      isDispatchToWorkingCoder: true
    });
    assert.equal(result.status, expected, [sender, recipient, parked, pickup].join('/'));
    assert.equal(result.animated, expected === 'live');
    assert.equal(Boolean(result.stalledInProgress), expected === 'pending');
    assert.equal(result.qitemId, row.qitemId);
  }
});

test('missing or unknown activity at either endpoint preserves the legacy in-progress display', () => {
  assert.equal(classifyEdgeQueueStatus([row]).status, 'live');
  for (const states of [null, {}, { other: 'idle' }, { sender: 'idle' }, { recipient: 'waiting' },
    { sender: 'unknown', recipient: 'waiting' }, { sender: 'idle', recipient: null }]) {
    const result = classifyEdgeQueueStatus([row], { seatStatesById: states, parkedSeatsById: { recipient: true } });
    assert.equal(result.status, 'live');
    assert.equal(result.animated, true);
  }
});

test('a stalled row yields to a higher-priority row and keeps its metadata on the right edge', () => {
  const options = { seatStatesById: { sender: 'idle', recipient: 'idle' }, isDispatchToWorkingCoder: true };
  const blocked = { ...row, qitemId: 'row-b', state: 'blocked' };
  for (const rows of [[row, blocked], [blocked, row]]) {
    const result = classifyEdgeQueueStatus(rows, options);
    assert.equal(result.qitemId, 'row-b');
    assert.equal(result.status, 'blocked');
    assert.equal(Boolean(result.stalledInProgress), false);
  }
  assert.equal(classifyEdgeQueueStatus([], options).status, 'live');
});

test('high-volume resting edges render thin static SVG trunks; working edges have a stream', () => {
  for (const [recipient, parked, status, color, icon] of [
    ['waiting', true, 'parked', '#f59e0b', '🅿️'],
    ['idle', false, 'pending', '#38bdf8', '⏳'],
    ['working', false, 'live', '#00ff9d', '📨']
  ]) {
    const result = classifyEdgeQueueStatus([row], {
      seatStatesById: { sender: 'idle', recipient },
      parkedSeatsById: { recipient: parked }
    });
    const html = renderTopologyEdgesHtml({
      edges: [{ from: 'sender', to: 'recipient', calls: 1024, queueStatus: result.status, color: result.color,
        statusIcon: result.icon, marker: result.marker, slice: 'example' }],
      nodeMap: { sender: { id: 'sender', x: 15, y: 25 }, recipient: { id: 'recipient', x: 90, y: 75 } },
      collapsedIdleIds: new Set(), currentRigFilter: 'all', cw: 1100, ch: 700, boxSizes: {},
      layoutResult: { tiers: {} }, deckLang: 'en', shortSeat: String, escapeHtml: String
    });
    assert.ok(html.includes('data-edge-status="' + status + '"'));
    assert.ok(html.includes(icon + ' example'));
    assert.ok(html.includes('class="edge-trunk" stroke="' + color + '"'));
    assert.equal(html.includes('class="edge-stream live-active"'), status === 'live');
    if (status !== 'live') assert.ok(html.includes('stroke-width="2.6"'));
  }
});
