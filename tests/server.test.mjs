import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildGanttItems,
  isGanttSystemNoise,
  readTranscriptTokenUsage,
  boundedMapSet,
  parseAllowedTmuxKeys,
  resolveSafeStaticPath,
  applyTerminalPromptProbes,
  transcriptUsageCache
} from '../openrig/server.mjs';

test('isGanttSystemNoise filters opgate, change-detector and stuck-sweep', () => {
  assert.equal(isGanttSystemNoise({ qitemId: 'qitem-opgate-123' }), true);
  assert.equal(isGanttSystemNoise({ qitemId: 'qitem-1', sourceSession: 'operator-change-detector@external' }), true);
  assert.equal(isGanttSystemNoise({ qitemId: 'qitem-2', tags: ['stuck-sweep-finding'] }), true);
  assert.equal(isGanttSystemNoise({ qitemId: 'qitem-3', sourceSession: 'dev-owner@rig', tags: ['slice:auth'] }), false);
});

test('buildGanttItems closes blocked/held rows and caps superseded open rows', () => {
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const items = buildGanttItems([
    {
      qitemId: 'qitem-opgate-999',
      sourceSession: 'operator-change-detector@external',
      destinationSession: 'dev-operator@rig',
      state: 'pending',
      tsCreated: iso(120)
    },
    {
      qitemId: 'qitem-blocked-1',
      sourceSession: 'lead@ext',
      destinationSession: 'dev-owner@rig',
      state: 'blocked',
      tags: ['slice:old-slice'],
      tsCreated: iso(1000),
      claimedAt: iso(995),
      tsUpdated: iso(900)
    },
    {
      qitemId: 'qitem-old-open',
      sourceSession: 'dev-owner@rig',
      destinationSession: 'dev-coder@rig',
      state: 'in-progress',
      tags: ['slice:feat-a'],
      tsCreated: iso(90),
      claimedAt: iso(88),
      tsUpdated: iso(70)
    },
    {
      qitemId: 'qitem-current',
      sourceSession: 'dev-owner@rig',
      destinationSession: 'dev-coder@rig',
      state: 'in-progress',
      tags: ['slice:feat-b'],
      tsCreated: iso(20),
      claimedAt: iso(18),
      tsUpdated: iso(15)
    }
  ]);

  assert.equal(items.length, 3);
  const blocked = items.find(i => i.id === 'qitem-blocked-1');
  assert.equal(blocked.endAt, iso(900));

  const superseded = items.find(i => i.id === 'qitem-old-open');
  assert.equal(superseded.endAt, iso(70));

  const current = items.find(i => i.id === 'qitem-current');
  assert.equal(current.endAt, null);
  assert.equal(current.chain, 'slice:feat-b');
});

test('buildGanttItems groups untagged handoff rows into one chain', () => {
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const items = buildGanttItems([
    {
      qitemId: 'qitem-a',
      sourceSession: 'dev-owner@rig',
      destinationSession: 'dev-coder@rig',
      state: 'done',
      tsCreated: iso(40),
      tsUpdated: iso(25)
    },
    {
      qitemId: 'qitem-b',
      sourceSession: 'dev-coder@rig',
      destinationSession: 'dev-check@rig',
      handedOffFrom: 'qitem-a',
      state: 'done',
      tsCreated: iso(24),
      tsUpdated: iso(10)
    }
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].chain, items[1].chain);
});

test('readTranscriptTokenUsage supports incremental Codex and Claude JSONL reads and truncation reset', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rig-cmd-test-'));
  try {
    // 1. Codex incremental append + truncation
    const codexFile = path.join(tmpDir, 'codex.jsonl');
    const line1 = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } }
    }) + '\n';
    await fs.writeFile(codexFile, line1, 'utf-8');

    const res1 = await readTranscriptTokenUsage(codexFile);
    assert.equal(res1.source, 'codex_jsonl');
    assert.equal(res1.uncachedInputTokens, 200);
    assert.equal(res1.cachedInputTokens, 800);
    assert.equal(res1.outputTokens, 50);

    const line2 = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2500, cached_input_tokens: 2000, output_tokens: 120 } } }
    }) + '\n';
    await fs.appendFile(codexFile, line2, 'utf-8');

    const res2 = await readTranscriptTokenUsage(codexFile);
    assert.equal(res2.uncachedInputTokens, 500);
    assert.equal(res2.cachedInputTokens, 2000);
    assert.equal(res2.outputTokens, 120);
    assert.equal(transcriptUsageCache.get(codexFile).offset, Buffer.byteLength(line1 + line2));

    // Truncate file to smaller size -> should reset cleanly
    await fs.writeFile(codexFile, line1, 'utf-8');
    const res3 = await readTranscriptTokenUsage(codexFile);
    assert.equal(res3.inputTokens, 1000);

    // 2. Claude deduplication by message.id + incremental append
    const claudeFile = path.join(tmpDir, 'claude.jsonl');
    const c1 = JSON.stringify({
      message: { id: 'msg_1', model: 'glm-5.3-flash', usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 400, output_tokens: 10 } }
    }) + '\n';
    const c1Dup = JSON.stringify({
      message: { id: 'msg_1', model: 'glm-5.3-flash', usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 400, output_tokens: 25 } }
    }) + '\n';
    await fs.writeFile(claudeFile, c1 + c1Dup, 'utf-8');

    const cres1 = await readTranscriptTokenUsage(claudeFile);
    assert.equal(cres1.source, 'claude_jsonl');
    assert.equal(cres1.uncachedInputTokens, 150);
    assert.equal(cres1.cachedInputTokens, 400);
    assert.equal(cres1.outputTokens, 25);

    const c2 = JSON.stringify({
      message: { id: 'msg_2', model: 'glm-5.3-flash', usage: { input_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 30 } }
    }) + '\n';
    await fs.appendFile(claudeFile, c2, 'utf-8');

    const cres2 = await readTranscriptTokenUsage(claudeFile);
    assert.equal(cres2.uncachedInputTokens, 210);
    assert.equal(cres2.cachedInputTokens, 900);
    assert.equal(cres2.outputTokens, 55);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('boundedMapSet evicts oldest key once capacity is reached', () => {
  const m = new Map();
  boundedMapSet(m, 'a', 1, 2);
  boundedMapSet(m, 'b', 2, 2);
  boundedMapSet(m, 'c', 3, 2);
  assert.equal(m.size, 2);
  assert.equal(m.has('a'), false);
  assert.equal(m.get('b'), 2);
  assert.equal(m.get('c'), 3);
});

test('resolveSafeStaticPath blocks path traversal, dotfiles and .mjs server files', () => {
  const base = '/tmp/fake-openrig';
  const okRoot = resolveSafeStaticPath(base, '/');
  assert.equal(okRoot.rel, 'index.html');
  assert.equal(okRoot.resolved, path.resolve(base, 'index.html'));

  const okPassport = resolveSafeStaticPath(base, '/passport');
  assert.equal(okPassport.rel, 'passport.html');
  assert.equal(okPassport.resolved, path.resolve(base, 'passport.html'));

  const okDoc = resolveSafeStaticPath(base, '/docs/architecture.md');
  assert.equal(okDoc.ext, '.md');

  assert.equal(resolveSafeStaticPath(base, '/../../etc/passwd'), null);
  assert.equal(resolveSafeStaticPath(base, '/%2e%2e/package.json'), null);
  assert.equal(resolveSafeStaticPath(base, '/server.mjs'), null);
  assert.equal(resolveSafeStaticPath(base, '/.env'), null);
  assert.equal(resolveSafeStaticPath(base, '/index.html%00.txt'), null);
});

test('parseAllowedTmuxKeys accepts valid keystrokes and rejects flags/injection', () => {
  assert.deepEqual(parseAllowedTmuxKeys('1 Enter'), ['1', 'Enter']);
  assert.deepEqual(parseAllowedTmuxKeys('y Enter'), ['y', 'Enter']);
  assert.deepEqual(parseAllowedTmuxKeys('C-c'), ['C-c']);
  assert.deepEqual(parseAllowedTmuxKeys('Escape'), ['Escape']);

  assert.equal(parseAllowedTmuxKeys(''), null);
  assert.equal(parseAllowedTmuxKeys('-X copy-mode'), null);
  assert.equal(parseAllowedTmuxKeys('-l rm'), null);
  assert.equal(parseAllowedTmuxKeys('1; ls'), null);
  assert.equal(parseAllowedTmuxKeys('1 2 3 4 5 6 7'), null);
});

test('applyTerminalPromptProbes promotes working terminal seat to needs-input when live prompt is detected', () => {
  const rawNodes = [
    {
      canonicalSessionName: 'dev-check-argon@rig',
      runtime: 'terminal',
      activityState: { display: 'working', needsInput: { count: 0, reason: null }, decidedBy: 'window-sampling' }
    },
    {
      canonicalSessionName: 'dev-coder@rig',
      runtime: 'codex',
      activityState: { display: 'working', needsInput: { count: 0, reason: null } }
    }
  ];
  const probes = new Map([
    ['dev-check-argon@rig', { blocked: true, reason: 'permission_prompt' }],
    ['dev-coder@rig', { blocked: false, reason: '' }]
  ]);

  const enriched = applyTerminalPromptProbes(rawNodes, probes);
  assert.equal(enriched[0].activityState.display, 'needs-input');
  assert.equal(enriched[0].activityState.needsInput.count, 1);
  assert.equal(enriched[0].activityState.needsInput.reason, 'permission_prompt');
  assert.equal(enriched[0].activityState.needsInput.source, 'tmux-prompt-probe');
  // Original node was not mutated and unblocked seat stayed working
  assert.equal(rawNodes[0].activityState.display, 'working');
  assert.equal(enriched[1].activityState.display, 'working');
});

test('applyTerminalPromptProbes demotes false working terminal seat sitting idle at empty prompt with 0 queue work', () => {
  const rawNodes = [
    {
      canonicalSessionName: 'dev-coder5@rig',
      runtime: 'terminal',
      inProgressWorkCount: 0,
      assignedWorkCount: 0,
      activityState: { display: 'working', needsInput: { count: 0, reason: null }, decidedBy: 'window-sampling' },
      agentActivity: { state: 'running' }
    },
    {
      canonicalSessionName: 'dev-check-argon@rig',
      runtime: 'terminal',
      inProgressWorkCount: 0,
      assignedWorkCount: 1,
      activityState: { display: 'working', needsInput: { count: 0, reason: null } }
    }
  ];
  const probes = new Map([
    ['dev-coder5@rig', { blocked: false, idleAtPrompt: true }],
    ['dev-check-argon@rig', { blocked: false, idleAtPrompt: true }]
  ]);

  const enriched = applyTerminalPromptProbes(rawNodes, probes);
  assert.equal(enriched[0].activityState.display, 'idle');
  assert.equal(enriched[0].activityState.source, 'tmux-idle-probe');
  assert.equal(enriched[0].agentActivity.state, 'idle');
  // Seat with assigned queue work must NOT be demoted prematurely
  assert.equal(enriched[1].activityState.display, 'working');
});
