import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseTmuxPaneLines,
  detectUniversalPaneState,
  discoverUniversalFleet,
  isValidTmuxTarget
} from '../openrig/lib/universal-discovery.mjs';

test('parseTmuxPaneLines extracts panes and validates tmux target format', () => {
  const sample = [
    'dev-work\t0\t0\t%12\tclaude\t/tmp/demo-repo\tClaude Code\t1',
    'dev-work\t0\t1\t%13\tzsh\t/tmp/demo-repo\tzsh\t0',
    'bad-inject\t0\t0\t;rm -rf /\tcodex\t/tmp/x\tcodex\t0'
  ].join('\n');

  const panes = parseTmuxPaneLines(sample);
  assert.equal(panes.length, 3);
  assert.equal(panes[0].target, '%12');
  assert.equal(panes[0].command, 'claude');
  assert.equal(panes[2].target, 'bad-inject:0.0');
  assert.equal(isValidTmuxTarget('%12'), true);
  assert.equal(isValidTmuxTarget('bad;cmd'), false);
});

test('detectUniversalPaneState recognizes HITL numbered menu, active spinner, and idle state', () => {
  const hitl = detectUniversalPaneState(
    'Allow running pytest?\n› 1. Yes, allow once (y)\n  2. Always allow\n  3. No, cancel (esc)',
    60_000
  );
  assert.equal(hitl.display, 'needs-input');
  assert.equal(hitl.needsInput.count, 1);

  const working = detectUniversalPaneState('⠋ Thinking through refactor...', 60_000);
  assert.equal(working.display, 'working');

  const recentFile = detectUniversalPaneState('› ', 5_000);
  assert.equal(recentFile.display, 'working');

  const idle = detectUniversalPaneState('nothing to commit, working tree clean\n› ', 120_000);
  assert.equal(idle.display, 'idle');
});

test('discoverUniversalFleet matches tmux panes to Claude/Codex JSONL and includes standalone transcripts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigcmd-univ-'));
  const claudeDir = path.join(root, 'claude', '-tmp-web-app');
  const codexDir = path.join(root, 'codex', '2026', '11', '21');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(codexDir, { recursive: true });

  const claudeFile = path.join(claudeDir, 'session-1.jsonl');
  await fs.writeFile(claudeFile, [
    JSON.stringify({
      type: 'assistant',
      cwd: '/tmp/web-app',
      message: {
        id: 'm1',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 20_000, cache_read_input_tokens: 60_000, output_tokens: 1_500 }
      }
    })
  ].join('\n') + '\n');

  const codexFile = path.join(codexDir, 'rollout-1.jsonl');
  await fs.writeFile(codexFile, [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/api-service', model: 'gpt-6.2-sol' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 142_500, cached_input_tokens: 90_000, output_tokens: 4_000 } }
      }
    })
  ].join('\n') + '\n');

  const mockExecTmux = async (args) => {
    if (args[0] === 'list-panes') {
      return 'swarm\t0\t0\t%7\tclaude\t/tmp/web-app\tClaude Code\t1\n';
    }
    if (args[0] === 'capture-pane') {
      return 'Run migration?\n› 1. Yes, allow once (y)\n  2. No, cancel (esc)\n';
    }
    return '';
  };

  const result = await discoverUniversalFleet({
    claudeDir: path.join(root, 'claude'),
    codexDir: path.join(root, 'codex'),
    execTmux: mockExecTmux
  });

  assert.equal(result.nodes.length, 2);
  const tmuxClaude = result.nodes.find(n => n.runtime === 'claude-code');
  const standaloneCodex = result.nodes.find(n => n.runtime === 'codex');

  assert.ok(tmuxClaude, 'should discover tmux-backed Claude seat');
  assert.equal(tmuxClaude.activityState.display, 'needs-input');
  assert.equal(tmuxClaude.contextUsage.usedPercentage, 40);
  assert.equal(tmuxClaude.contextUsage.transcriptPath, claudeFile);
  assert.equal(result.tmuxTargets.get(tmuxClaude.canonicalSessionName), '%7');

  assert.ok(standaloneCodex, 'should discover standalone Codex JSONL seat');
  assert.equal(standaloneCodex.model, 'gpt-6.2-sol');
  assert.equal(standaloneCodex.contextUsage.usedPercentage, 30);
  assert.equal(standaloneCodex.contextUsage.transcriptPath, codexFile);

  assert.equal(result.availableRigs.length, 2);
  await fs.rm(root, { recursive: true, force: true });
});
