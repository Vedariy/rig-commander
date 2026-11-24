import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildGanttItems,
  isGanttSystemNoise,
  computeHistoryStats,
  extractTsFromQitemId,
  readTranscriptTokenUsage,
  boundedMapSet,
  parseAllowedTmuxKeys,
  resolveSafeStaticPath,
  applyTerminalPromptProbes,
  dispatchRawCommand,
  fetchQueueItemContextDetail,
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

test('PWA manifest.webmanifest, sw.js and icons are valid and allowed by static path guard', async () => {
  const openrigDir = path.resolve(process.cwd(), 'openrig');
  const manifestGuard = resolveSafeStaticPath(openrigDir, '/manifest.webmanifest');
  assert.ok(manifestGuard && manifestGuard.ext === '.webmanifest');
  const swGuard = resolveSafeStaticPath(openrigDir, '/sw.js');
  assert.ok(swGuard && swGuard.ext === '.js');

  const manifest = JSON.parse(await fs.readFile(manifestGuard.resolved, 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.short_name, 'RigCommander');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.some(i => i.sizes === '192x192') && manifest.icons.some(i => i.sizes === '512x512'));
  for (const icon of manifest.icons) {
    const iconGuard = resolveSafeStaticPath(openrigDir, icon.src);
    assert.ok(iconGuard, `Manifest icon must be statically servable: ${icon.src}`);
    const st = await fs.stat(iconGuard.resolved);
    assert.ok(st.size > 1000, `Icon file must be non-empty: ${icon.src}`);
  }
  const swText = await fs.readFile(swGuard.resolved, 'utf8');
  assert.ok(swText.includes("startsWith('/api/')"), 'Service Worker must never cache /api/* routes');
});

test('computeHistoryStats extracts tsUpdated/tsCreated/qitemId timestamps and preserves up to 20 pair envelopes', () => {
  assert.equal(extractTsFromQitemId('qitem-20261122230703-6646a255e35a6e0d'), '2026-11-22T23:07:03Z');
  const rows = Array.from({ length: 12 }, (_, i) => ({
    qitemId: `qitem-2026112223${String(i).padStart(2, '0')}00-deadbeef`,
    sourceSession: 'dev-owner@demo',
    destinationSession: 'dev-check-argon@demo',
    state: i === 0 ? 'in-progress' : (i === 1 ? 'canceled' : 'done'),
    tags: ['slice:0147-a1'],
    tsCreated: i < 2 ? '' : `2026-11-22T23:${String(i).padStart(2, '0')}:00Z`,
    summary: i === 0 ? '' : `Round ${i}`
  }));
  const stats = computeHistoryStats(rows);
  const key = 'dev-check-argon@demo <-> dev-owner@demo';
  assert.equal(stats.pairEnvelopes[key].length, 12);
  assert.equal(stats.pairEnvelopes[key][0].createdAt, '2026-11-22T23:00:00Z');
  assert.equal(stats.pairEnvelopes[key][1].updatedAt, '2026-11-22T23:01:00Z');
});

test('dispatchRawCommand uses native rig send --raw for OpenRig seats and paced TUI sequence for standalone tmux panes', async () => {
  // 1) OpenRig seat: delegates cleanly to `rig send --raw` (no direct raw tmux race into Codex autocomplete)
  const rigCalls = [];
  const rigOk = await dispatchRawCommand({
    seat: 'dev-senior-architect@demo-rig',
    cleanText: '/compact',
    universalTarget: null,
    execFn: async (bin, args) => {
      rigCalls.push({ bin, args });
      return { ok: true, code: 0, output: 'Delivered' };
    },
    waitFn: async () => {},
    rigBin: 'rig',
    tmuxBin: 'tmux'
  });
  assert.equal(rigOk.ok, true);
  assert.deepEqual(rigCalls, [{ bin: 'rig', args: ['send', '--raw', 'dev-senior-architect@demo-rig', '/compact'] }]);

  // 2) OpenRig refusal (e.g. dirty input box or permission prompt): returns 409 without blind tmux concatenation
  const refusalCalls = [];
  const rigRefused = await dispatchRawCommand({
    seat: 'dev-senior-architect@demo-rig',
    cleanText: '/compact',
    universalTarget: null,
    execFn: async (bin, args) => {
      refusalCalls.push({ bin, args });
      return { ok: false, code: 1, output: 'Refused: visible input box already contains text' };
    },
    waitFn: async () => {},
    rigBin: 'rig',
    tmuxBin: 'tmux'
  });
  assert.equal(rigRefused.ok, false);
  assert.equal(rigRefused.statusCode, 409);
  assert.match(rigRefused.error, /already contains text/);
  assert.equal(refusalCalls.length, 1);

  // 3) Standalone universal tmux pane: runs Escape -> wait -> C-e -> C-u -> wait -> -l -> wait(>=250ms) -> Enter
  const tmuxSeq = [];
  const tmuxOk = await dispatchRawCommand({
    seat: 'codex-11-24@codex-local',
    cleanText: '/compact',
    universalTarget: 'main:0.1',
    execFn: async (bin, args) => {
      tmuxSeq.push({ type: 'exec', bin, args });
      return { ok: true, code: 0, output: '' };
    },
    waitFn: async (ms) => { tmuxSeq.push({ type: 'wait', ms }); },
    rigBin: 'rig',
    tmuxBin: 'tmux'
  });
  assert.equal(tmuxOk.ok, true);
  assert.deepEqual(tmuxSeq, [
    { type: 'exec', bin: 'tmux', args: ['send-keys', '-t', 'main:0.1', 'Escape'] },
    { type: 'wait', ms: 80 },
    { type: 'exec', bin: 'tmux', args: ['send-keys', '-t', 'main:0.1', 'C-e'] },
    { type: 'exec', bin: 'tmux', args: ['send-keys', '-t', 'main:0.1', 'C-u'] },
    { type: 'wait', ms: 80 },
    { type: 'exec', bin: 'tmux', args: ['send-keys', '-t', 'main:0.1', '-l', '/compact'] },
    { type: 'wait', ms: 320 },
    { type: 'exec', bin: 'tmux', args: ['send-keys', '-t', 'main:0.1', 'Enter'] }
  ]);

  // 4) OpenRig wrapper false-refusal ("running behind a wrapper") with live Codex prompt -> paced tmux fallback succeeds
  const wrapCalls = [];
  const wrapOk = await dispatchRawCommand({
    seat: 'dev-owner@demo-rig',
    cleanText: 'Check queue (`rig queue list --owned`)',
    universalTarget: null,
    captureScreenFn: async () => '› Ask Codex to do anything\n  GPT-6.2-Sol medium · Ready · Ask for approval · Context 37% used',
    execFn: async (bin, args) => {
      wrapCalls.push({ bin, args });
      if (bin === 'rig') {
        return {
          ok: false,
          code: 1,
          output: "Refused: 'dev-owner@demo-rig' reports bash as the foreground command, but OpenRig could not verify its expected codex agent in the bound pane. The agent may still be running behind a wrapper. No text was sent."
        };
      }
      return { ok: true, code: 0, output: '' };
    },
    waitFn: async () => {},
    rigBin: 'rig',
    tmuxBin: 'tmux'
  });
  assert.equal(wrapOk.ok, true);
  assert.equal(wrapOk.via, 'tmux_wrapper_fallback');
  assert.equal(wrapCalls[0].bin, 'rig');
  assert.equal(wrapCalls[wrapCalls.length - 1].bin, 'tmux');
  assert.deepEqual(wrapCalls[wrapCalls.length - 1].args, ['send-keys', '-t', 'dev-owner@demo-rig', 'Enter']);

  // 5) OpenRig wrapper refusal when live screen actually IS a bare bash shell -> MUST still refuse 409!
  const shellBlocked = await dispatchRawCommand({
    seat: 'dev-owner@demo-rig',
    cleanText: 'Check queue',
    universalTarget: null,
    captureScreenFn: async () => 'user@host ~/repo % \nbash-5.2$ ',
    execFn: async (bin) => ({
      ok: false,
      code: 1,
      output: "Refused: 'dev-owner@demo-rig' reports bash as the foreground command. The agent may still be running behind a wrapper."
    }),
    waitFn: async () => {},
    rigBin: 'rig',
    tmuxBin: 'tmux'
  });
  assert.equal(shellBlocked.ok, false);
  assert.equal(shellBlocked.statusCode, 409);
  assert.match(shellBlocked.error, /bare OS shell/);
});

test('fetchQueueItemContextDetail validates qitemId, loads full body, extracts artifacts and lineage', async () => {
  const bad = await fetchQueueItemContextDetail('../etc/passwd');
  assert.equal(bad.ok, false);
  assert.equal(bad.statusCode, 400);

  const detail = await fetchQueueItemContextDetail('qitem-20261124150000-ctx00001', {
    execFn: async (bin, args) => {
      assert.equal(args[0], 'queue');
      assert.equal(args[1], 'show');
      assert.equal(args[2], 'qitem-20261124150000-ctx00001');
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          qitemId: 'qitem-20261124150000-ctx00001',
          sourceSession: 'dev-coder@demo',
          destinationSession: 'dev-check@demo',
          state: 'pending',
          tags: ['slice:0147-live', 'gate:qa', 'body-context:packs/qa-v2'],
          blockedOn: 'qitem-20261124140000-blk00000',
          evidenceRef: 'docs/tasks/qa/0147/PROOF.md',
          summary: 'Submit candidate for QA',
          body: 'Implemented per docs/tasks/0147-live.md and ADR-0012 (commit 6512c14).'
        })
      };
    }
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.item.slice, '0147-live');
  assert.equal(detail.item.gate, 'qa');
  assert.equal(detail.item.bodyContextRef, 'packs/qa-v2');
  assert.equal(detail.lineage.blocker.id, 'qitem-20261124140000-blk00000');
  assert.ok(detail.artifacts.docs.includes('docs/tasks/0147-live.md'));
  assert.deepEqual(detail.artifacts.adrs, ['ADR-0012']);
  assert.deepEqual(detail.artifacts.commits, ['6512c14']);
});
