import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractItemContextMeta,
  extractContextArtifacts,
  buildSharedContextGraph,
  getContextDriftSignals,
  matchRelatedDecisions
} from '../openrig/assets/domain/context-lineage.js';

test('extractItemContextMeta parses OpenRig scope tags, blockedOn, handoff links and evidenceRef', () => {
  const meta = extractItemContextMeta({
    qitemId: 'qitem-20261124120000-aaaa1111',
    sourceSession: 'dev-owner@demo',
    destinationSession: 'dev-senior-architect@demo',
    state: 'blocked',
    summary: 'Track L live-wiring review',
    tags: [
      'slice:0147-live',
      'project:core-v2',
      'mission:m-2026-q4',
      'parent:qitem-20261124090000-00000001',
      'gate:spec-review',
      'body-context:packs/architecture-v3'
    ],
    blockedOn: 'Waiting on qitem-20261124100000-bbbb2222 owned by dev-owner@demo',
    handedOffFrom: 'qitem-20261124110000-cccc3333',
    handedOffTo: 'qitem-20261124130000-dddd4444',
    evidenceRef: 'docs/tasks/qa/0147-live/PROOF.md',
    targetRepo: 'web-app'
  });

  assert.equal(meta.slice, '0147-live');
  assert.equal(meta.project, 'core-v2');
  assert.equal(meta.mission, 'm-2026-q4');
  assert.equal(meta.parent, 'qitem-20261124090000-00000001');
  assert.equal(meta.gate, 'spec-review');
  assert.equal(meta.bodyContextRef, 'packs/architecture-v3');
  assert.equal(meta.blockedOnQitemId, 'qitem-20261124100000-bbbb2222');
  assert.equal(meta.blockedOnSeat, 'dev-owner@demo');
  assert.equal(meta.handedOffFrom, 'qitem-20261124110000-cccc3333');
  assert.equal(meta.handedOffTo, 'qitem-20261124130000-dddd4444');
  assert.equal(meta.evidenceRef, 'docs/tasks/qa/0147-live/PROOF.md');
  assert.equal(meta.targetRepo, 'web-app');
  assert.equal(meta.hasSharedContext, true);
});

test('extractContextArtifacts extracts docs, ADRs, commit SHAs, and linked qitem IDs without self-loops', () => {
  const body = [
    'Implemented per docs/tasks/0147-live.md and ADR-0012.',
    'Verified candidate commit 6512c14 and proof at docs/tasks/qa/0147/PROOF.md.',
    'Depends on qitem-20261124100000-bbbb2222; self is qitem-20261124120000-aaaa1111.',
    'Coord with dev-check@demo.'
  ].join('\n');

  const art = extractContextArtifacts(body, {
    selfId: 'qitem-20261124120000-aaaa1111',
    evidenceRef: 'docs/tasks/qa/0147/PROOF.md'
  });

  assert.ok(art.docs.includes('docs/tasks/0147-live.md'));
  assert.ok(art.docs.includes('docs/tasks/qa/0147/PROOF.md'));
  assert.deepEqual(art.adrs, ['ADR-0012']);
  assert.deepEqual(art.commits, ['6512c14']);
  assert.deepEqual(art.linkedQitems, ['qitem-20261124100000-bbbb2222']);
  assert.deepEqual(art.mentionedSeats, ['dev-check@demo']);
});

test('buildSharedContextGraph resolves ancestors, descendants, blockers, dependents and detects context-pack drift', () => {
  const rows = [
    {
      qitemId: 'qitem-20261124090000-root0001',
      sourceSession: 'dev-owner@demo',
      destinationSession: 'dev-coder@demo',
      state: 'done',
      tags: ['slice:0147-live', 'body-context:packs/v1'],
      handedOffTo: 'qitem-20261124100000-mid00002',
      summary: 'Initial spec handoff'
    },
    {
      qitemId: 'qitem-20261124100000-mid00002',
      sourceSession: 'dev-coder@demo',
      destinationSession: 'dev-check@demo',
      state: 'in-progress',
      tags: ['slice:0147-live', 'body-context:packs/v2'],
      handedOffFrom: 'qitem-20261124090000-root0001',
      handedOffTo: 'qitem-20261124110000-leaf0003',
      summary: 'Candidate submitted to QA'
    },
    {
      qitemId: 'qitem-20261124110000-leaf0003',
      sourceSession: 'dev-check@demo',
      destinationSession: 'dev-owner@demo',
      state: 'blocked',
      tags: ['slice:0147-live'],
      handedOffFrom: 'qitem-20261124100000-mid00002',
      blockedOn: 'qitem-20261124100000-mid00002',
      summary: 'Awaiting QA completion before merge'
    }
  ];

  const graph = buildSharedContextGraph(rows);
  const midLineage = graph.getLineage('qitem-20261124100000-mid00002');
  assert.deepEqual(midLineage.ancestors.map(a => a.id), ['qitem-20261124090000-root0001']);
  assert.deepEqual(midLineage.descendants.map(d => d.id), ['qitem-20261124110000-leaf0003']);
  assert.deepEqual(midLineage.dependents.map(d => d.id), ['qitem-20261124110000-leaf0003']);
  assert.ok(midLineage.driftSignals.some(s => s.kind === 'context_pack_drift'));
  assert.ok(midLineage.driftSignals.some(s => s.kind === 'active_blocker_chain'));

  const leafLineage = graph.getLineage('qitem-20261124110000-leaf0003');
  assert.equal(leafLineage.blocker.id, 'qitem-20261124100000-mid00002');

  const drift = getContextDriftSignals(rows);
  assert.equal(drift.find(d => d.kind === 'context_pack_drift').values.length, 2);
});

test('matchRelatedDecisions links rig decisions by slice, mission or project', () => {
  const decisions = [
    { slice: '0147-live', decision: 'Approve Track L', reason: 'All tests green', time: '21:10' },
    { slice: 'unrelated', decision: 'Other slice', reason: 'n/a', time: '20:00' }
  ];
  const matched = matchRelatedDecisions(decisions, { slice: '0147-live' });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].decision, 'Approve Track L');
});
