import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetIntelligenceEngine } from '../openrig/lib/fleet-intelligence/index.mjs';
import {
  parseInteractivePromptOptions,
  getContextThermal,
  formatTokensShort,
  computeBurn,
  getAgentAudioProfile,
  ganttChainColor,
  ganttRoleRank
} from '../openrig/assets/domain/index.js';

test('FleetIntelligenceEngine passes recentQueue and isolates reports per rigId', () => {
  const engine = new FleetIntelligenceEngine({ evalThrottleMs: 0 });
  let capturedRecent = null;
  engine.registerDetector({
    id: 'test-probe',
    evaluate(ctx) {
      capturedRecent = ctx.recentQueue;
      return [];
    }
  });

  engine.ingestSnapshot({
    requestedRig: 'rig-alpha',
    nodes: [],
    activeQueue: [],
    history: { ganttItems: [{ id: 'qitem-1', chain: 'slice:x' }] }
  });
  assert.equal(Array.isArray(capturedRecent), true);
  assert.equal(capturedRecent.length, 1);

  engine.ingestSnapshot({
    requestedRig: 'rig-beta',
    nodes: [],
    activeQueue: [],
    history: { ganttItems: [] }
  });

  const repAlpha = engine.getLatestReport('rig-alpha');
  const repBeta = engine.getLatestReport('rig-beta');
  const repUnknown = engine.getLatestReport('rig-unknown');
  assert.equal(repAlpha.rigId, 'rig-alpha');
  assert.equal(repBeta.rigId, 'rig-beta');
  assert.equal(repUnknown.rigId, 'rig-unknown');
});

test('parseInteractivePromptOptions extracts Codex and inline options cleanly', () => {
  const codexSample = [
    'Would you like to run the following command?',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again (p)',
    '  3. No, and tell Codex what to do differently (esc)'
  ].join('\n');
  const parsed = parseInteractivePromptOptions(codexSample);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].keyStroke, '1 Enter');
  assert.equal(parsed[1].keyStroke, '2 Enter');
  assert.equal(parsed[2].isCancel, true);

  const inlineSample = 'Allow action?\n[1] Allow once   [2] Always allow   [n] Cancel\n› _';
  const inlineParsed = parseInteractivePromptOptions(inlineSample);
  assert.equal(inlineParsed.length, 3);
  assert.equal(inlineParsed[2].isCancel, true);
});

test('domain thermal, audio and gantt helpers work deterministically', () => {
  assert.equal(getContextThermal(null, 475000).label, '— (no reader)');
  assert.equal(getContextThermal(80, 475000).color, '#ff0055');
  assert.equal(formatTokensShort(1_250_000), '1.25M');
  assert.equal(formatTokensShort(42_300), '42K');

  const burn = computeBurn({ ctxHistory: [{ t: 0, pct: 20 }, { t: 3600_000, pct: 45 }] });
  assert.equal(burn.perHour, 25);

  const p1 = getAgentAudioProfile('dev-check@rig');
  const p2 = getAgentAudioProfile('dev-check-argon@rig');
  const pDyn = getAgentAudioProfile('custom-agent-99@rig');
  assert.notDeepEqual(p1.freqs, p2.freqs);
  assert.equal(pDyn.freqs.length, 3);

  assert.equal(ganttChainColor('slice:abc'), ganttChainColor('slice:abc'));
  assert.ok(ganttRoleRank('dev-owner@rig') < ganttRoleRank('dev-coder@rig'));
  assert.ok(ganttRoleRank('dev-coder@rig') < ganttRoleRank('dev-check@rig'));
});
