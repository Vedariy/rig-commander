import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetIntelligenceEngine } from '../openrig/lib/fleet-intelligence/index.mjs';
import {
  parseInteractivePromptOptions,
  detectLiveHitlPrompt,
  classifyEdgeQueueStatus,
  getContextThermal,
  formatTokensShort,
  computeBurn,
  getAgentAudioProfile,
  ganttChainColor,
  ganttRoleRank,
  DECK_I18N,
  resolveDeckLang,
  tDeck
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

test('detectLiveHitlPrompt catches terminal/agy & Codex prompts while rejecting normal markdown lists and stale scrollback', () => {
  const agyCapture = [
    'Requesting permission for:',
    '  git -C /tmp/repo cat-file -t abc123',
    'Run this command?',
    '  1. Yes, run command',
    '  2. Yes, and always allow in this',
    'conversation for commands that start with git',
    '> 3. Yes, and always allow for',
    'commands (Persist to settings.json)',
    '  4. No, cancel',
    '  ↑/↓ Navigate · tab Amend · ctrl+g ed',
    'esc to cancel'
  ].join('\n');
  const resAgy = detectLiveHitlPrompt(agyCapture);
  assert.equal(resAgy.blocked, true);
  assert.equal(resAgy.reason, 'permission_prompt');
  assert.equal(resAgy.options.length, 4);

  const markdownSummary = [
    'Completed all changes:',
    '1. Updated node card padding',
    '2. Added unit tests for circuit breaker',
    '3. Synced public directory',
    'Waiting for next task.'
  ].join('\n');
  assert.equal(detectLiveHitlPrompt(markdownSummary).blocked, false);

  const staleScrolledMenu = [
    'Run this command?',
    '1. Yes, run command',
    '2. No, cancel',
    'line 1 after',
    'line 2 after',
    'line 3 after',
    'line 4 after',
    'line 5 after',
    'line 6 after',
    'line 7 after',
    'line 8 after',
    'line 9 after',
    'All 40 tests passed.'
  ].join('\n');
  assert.equal(detectLiveHitlPrompt(staleScrolledMenu).blocked, false);
});

test('classifyEdgeQueueStatus differentiates live, blocked, parked, held, pending and ghost highways', () => {
  // 1. Blocked + parked between sleeping seats -> static orange 🚧 blocked (NOT animated green!)
  const blk = classifyEdgeQueueStatus([
    {
      qitemId: 'q-1',
      sourceSession: 'dev-coder4@rig',
      destinationSession: 'dev-owner@rig',
      state: 'blocked',
      pickup: { state: 'parked' },
      tags: ['ultraplan', 'track-B'],
      summary: 'Waiting for QA GO'
    }
  ], { seatStatesById: { 'dev-coder4@rig': 'idle', 'dev-owner@rig': 'idle' } });
  assert.equal(blk.status, 'blocked');
  assert.equal(blk.icon, '🚧');
  assert.equal(blk.animated, false);
  assert.equal(blk.tag, 'ultraplan');

  // 2. Parked without hard block -> static amber 🅿️ parked
  const prk = classifyEdgeQueueStatus([
    { sourceSession: 'a@rig', destinationSession: 'b@rig', state: 'open', pickup: { state: 'parked' }, tags: ['slice:auth'] }
  ]);
  assert.equal(prk.status, 'parked');
  assert.equal(prk.icon, '🅿️');
  assert.equal(prk.animated, false);
  assert.equal(prk.tag, 'auth');

  // 3. Held with wake condition -> static purple ⏸️ held
  const hld = classifyEdgeQueueStatus([
    { sourceSession: 'a@rig', destinationSession: 'b@rig', state: 'held', pickup: { state: 'held' }, tags: ['slice:deploy'] }
  ]);
  assert.equal(hld.status, 'held');
  assert.equal(hld.icon, '⏸️');
  assert.equal(hld.animated, false);

  // 4. Pending on idle recipient -> static sky ⏳ pending; on working recipient -> animated emerald 📨 live
  const pendIdle = classifyEdgeQueueStatus([
    { sourceSession: 'dev-owner@rig', destinationSession: 'dev-check@rig', state: 'pending', tags: ['gate:qa'] }
  ], { seatStatesById: { 'dev-check@rig': 'idle' } });
  assert.equal(pendIdle.status, 'pending');
  assert.equal(pendIdle.icon, '⏳');
  assert.equal(pendIdle.animated, false);

  const pendWorking = classifyEdgeQueueStatus([
    { sourceSession: 'dev-owner@rig', destinationSession: 'dev-check@rig', state: 'pending', tags: ['gate:qa'] }
  ], { seatStatesById: { 'dev-check@rig': 'working' } });
  assert.equal(pendWorking.status, 'live');
  assert.equal(pendWorking.icon, '📨');
  assert.equal(pendWorking.animated, true);

  // 5. No rows -> ghost
  const ghost = classifyEdgeQueueStatus([]);
  assert.equal(ghost.status, 'ghost');
  assert.equal(ghost.animated, false);
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

test('DECK_I18N maintains full EN/RU key parity and interpolation', () => {
  const enKeys = Object.keys(DECK_I18N.en).sort();
  const ruKeys = Object.keys(DECK_I18N.ru).sort();
  assert.deepEqual(enKeys, ruKeys);
  assert.equal(resolveDeckLang('?lang=en', 'ru', 'ru-RU'), 'en');
  assert.equal(resolveDeckLang('?lang=ru', 'en', 'en-US'), 'ru');
  assert.equal(resolveDeckLang('', 'en', 'ru-RU'), 'en');
  assert.equal(resolveDeckLang('', '', 'en-US'), 'en');
  assert.equal(resolveDeckLang('', '', 'ru-RU'), 'ru');
  assert.equal(tDeck('en', 'triage.ctxEta', { min: 12 }), '~12m to 75%');
  assert.equal(tDeck('ru', 'triage.ctxEta', { min: 12 }), '~12 мин до 75%');
});
