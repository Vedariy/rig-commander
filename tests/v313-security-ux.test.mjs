import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolveNoSessionLogsMode,
  resolveRedactLiveCapture,
  redactLiveCaptureScreen
} from '../openrig/server.mjs';
import { discoverUniversalFleet } from '../openrig/lib/universal-discovery.mjs';
import { renderAutoConsentTabHtml } from '../openrig/assets/ui/auto-consent-view.js';
import { renderStateIndicatorHtml } from '../openrig/assets/ui/topology-view.js';
import { renderWarningSignsHtml } from '../openrig/assets/ui/inspector-view.js';
import { tDeck } from '../openrig/assets/domain/i18n.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('resolveNoSessionLogsMode & resolveRedactLiveCapture parse CLI flags and env vars', () => {
  assert.equal(resolveNoSessionLogsMode({}, ['node', 'server.mjs']), false);
  assert.equal(resolveNoSessionLogsMode({}, ['node', 'server.mjs', '--no-session-logs']), true);
  assert.equal(resolveNoSessionLogsMode({ RIGCOMMANDER_NO_SESSION_LOGS: '1' }, ['node', 'server.mjs']), true);

  assert.equal(resolveRedactLiveCapture({}, ['node', 'server.mjs']), true);
  assert.equal(resolveRedactLiveCapture({}, ['node', 'server.mjs', '--raw-capture']), false);
  assert.equal(resolveRedactLiveCapture({ RIGCOMMANDER_RAW_CAPTURE: '1' }, ['node', 'server.mjs']), false);
});

test('redactLiveCaptureScreen masks API keys, Bearer/JWT, .env secrets and PEM blocks while keeping workspace paths readable', () => {
  const raw = [
    '[tmux: codex-tests] ~/projects/payments-api',
    'OPENAI_API_KEY=sk-proj-abc12345678901234567890',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAtest\n-----END RSA PRIVATE KEY-----',
    '$ npm test'
  ].join('\n');

  const masked = redactLiveCaptureScreen(raw, { enabled: true });
  assert.ok(!masked.includes('sk-proj-abc12345678901234567890'), 'API key must be masked');
  assert.ok(!masked.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT token must be masked');
  assert.ok(!masked.includes('MIIEpAIBAAKCAQEAtest'), 'PEM block must be masked');
  assert.ok(masked.includes('~/projects/payments-api'), 'Local workspace path stays readable for operator');
  assert.ok(masked.includes('$ npm test'), 'Normal command stays readable');

  const unmasked = redactLiveCaptureScreen(raw, { enabled: false });
  assert.equal(unmasked, raw);
});

test('discoverUniversalFleet respects readSessionLogs: false and ignores ~/.claude & ~/.codex directories', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-nologs-'));
  try {
    const claudeDir = path.join(tmpDir, 'claude');
    const codexDir = path.join(tmpDir, 'codex');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'sess.jsonl'),
      JSON.stringify({ cwd: '/tmp/secret-proj', message: { model: 'claude-sonnet-4', usage: { input_tokens: 1000 } } }) + '\n'
    );

    const res = await discoverUniversalFleet({
      claudeDir,
      codexDir,
      readSessionLogs: false,
      execTmux: async () => ''
    });
    assert.equal(res.nodes.length, 0, 'With readSessionLogs: false and 0 tmux panes, zero nodes should be discovered from ~/.claude');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bin/cli.mjs --help documents --no-session-logs and --raw-capture flags', async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'bin/cli.mjs'), '--help']);
  assert.match(stdout, /--no-session-logs\b/);
  assert.match(stdout, /--raw-capture\b/);
});

test('v3.13.0 Dark Cockpit UI contracts: master-OFF dimming, read-only legend, standalone tmux WORK indicator & quiet urgent warning strip', () => {
  const td = (k, vars) => tDeck('ru', k, vars);
  const offHtml = renderAutoConsentTabHtml({
    state: {
      config: { enabled: false, mode: 'dry_run', masterPaused: false, projects: {}, seats: {} },
      sessionGrants: [],
      pendingApprovals: [],
      recentRuns: []
    },
    rigs: ['payments-api'],
    agents: [
      { id: 'claude-api', shortName: 'claude-api' },
      { id: 'codex-tests', shortName: 'codex-tests' }
    ],
    td,
    deckLang: 'ru'
  });
  assert.match(offHtml, /class="ac-tab-wrap is-master-off"/);
  assert.match(offHtml, /class="ac-cmd-summary-kicker"/);
  assert.ok(!offHtml.includes('ac-eff-chip is-off'), 'Inherited OFF rows omit redundant global-off chip');

  const escapeHtml = (s) => String(s ?? '');
  const standaloneInd = renderStateIndicatorHtml({ id: 'claude-api', state: 'working', assignedWorkCount: 1 }, { escapeHtml, deckLang: 'ru', td });
  assert.ok(standaloneInd.includes('РАБОТАЕТ'), 'Standalone tmux working node shows clear status instead of cryptic "1"');

  const urgentWarn = renderWarningSignsHtml({ deckLang: 'ru', escapeHtml, ageLabel: () => '', td }, { id: 'codex-tests', state: 'urgent', compactionsCount: 0 });
  assert.equal(urgentWarn, '', 'Urgent P0 HITL seat omits contradictory "Seat: nominal" strip');
});
