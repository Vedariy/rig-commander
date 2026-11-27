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
  resolveTmuxSocket,
  resolveTmuxSessionFilter,
  isSeatAllowedByTmuxFilter,
  redactLiveCaptureScreen
} from '../openrig/server.mjs';
import {
  discoverUniversalFleet,
  buildTmuxArgs,
  matchesTmuxSessionFilter,
  sanitizeTmuxSocketName
} from '../openrig/lib/universal-discovery.mjs';
import { renderAutoConsentTabHtml, renderSeatAutoConsentPickerHtml, getAutoConsentModalBadge } from '../openrig/assets/ui/auto-consent-view.js';
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

test('bin/cli.mjs --help documents --no-session-logs, --raw-capture, --tmux-socket and --tmux-session flags', async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'bin/cli.mjs'), '--help']);
  assert.match(stdout, /--no-session-logs\b/);
  assert.match(stdout, /--raw-capture\b/);
  assert.match(stdout, /--tmux-socket\b/);
  assert.match(stdout, /--tmux-session\b/);
});

test('v3.14.0 TMUX isolation: --tmux-socket passes -L and --tmux-session excludes prod SSH panes BEFORE capture-pane', async () => {
  assert.equal(sanitizeTmuxSocketName('agents-sock_1'), 'agents-sock_1');
  assert.equal(sanitizeTmuxSocketName('../bad;rm'), '');
  assert.deepEqual(buildTmuxArgs('agents', ['list-panes', '-a']), ['-L', 'agents', 'list-panes', '-a']);
  assert.deepEqual(buildTmuxArgs('', ['list-panes', '-a']), ['list-panes', '-a']);

  assert.equal(resolveTmuxSocket({}, ['node', 'server.mjs', '--tmux-socket', 'ai-dev']), 'ai-dev');
  assert.equal(resolveTmuxSocket({ RIGCOMMANDER_TMUX_SOCKET: 'env-sock' }, ['node', 'server.mjs']), 'env-sock');
  assert.deepEqual(resolveTmuxSessionFilter({}, ['node', 'server.mjs', '--tmux-session', 'ai,codex-*']), ['ai', 'codex-*']);
  assert.equal(matchesTmuxSessionFilter('ai-payments', ['ai', 'codex-*']), true);
  assert.equal(matchesTmuxSessionFilter('codex-tests', ['ai', 'codex-*']), true);
  assert.equal(matchesTmuxSessionFilter('prod-ssh-db', ['ai', 'codex-*']), false);
  assert.equal(isSeatAllowedByTmuxFilter('prod-ssh-db@ops', { filterList: ['ai', 'codex-*'], knownTargets: new Map() }), false);
  assert.equal(isSeatAllowedByTmuxFilter('codex-tests@payments', { filterList: ['ai', 'codex-*'], knownTargets: new Map() }), true);

  const calls = [];
  const execTmux = async (argv) => {
    calls.push(argv);
    if (argv.includes('list-panes')) {
      return [
        'prod-ssh\t0\t0\t%1\tclaude\t/srv/prod\tprod-db\t1',
        'codex-tests\t0\t0\t%2\tcodex\t/tmp/payments\tcodex-tests\t1'
      ].join('\n');
    }
    return 'Working...\n';
  };
  const res = await discoverUniversalFleet({
    tmuxSocket: 'agents',
    tmuxSessionFilter: ['codex-*'],
    readSessionLogs: false,
    execTmux
  });
  assert.equal(res.nodes.length, 1, 'Only allowlisted session is discovered');
  assert.ok(res.nodes[0].canonicalSessionName.startsWith('codex-tests@'));
  assert.equal(res.nodes[0].tmuxAttachCommand, 'tmux -L agents attach -t codex-tests');
  assert.ok(calls.every(c => c[0] === '-L' && c[1] === 'agents'), 'Every tmux invocation must target -L agents');
  assert.ok(!calls.some(c => c.includes('%1')), 'Non-allowlisted prod-ssh pane %1 must NEVER be passed to capture-pane');
  assert.ok(calls.some(c => c.includes('capture-pane') && c.includes('%2')), 'Allowlisted pane %2 is captured');
});

test('v3.13.0–v3.14.0 Dark Cockpit UI contracts: monochrome master-OFF, collapsed inherited rows, standalone tmux WORK & quiet urgent strip', () => {
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
  assert.match(offHtml, /class="ac-master-off-note"/);
  assert.match(offHtml, /class="ac-switch-note"/, 'Pre-armed CTX switch shows quiet inline pending text without button-like pill');
  assert.ok(!offHtml.includes('ac-switch-pill'), 'No bordered button-like switch status pills in master-OFF modal');
  assert.match(offHtml, /class="ac-inherit-disclosure"/, 'Identical inherited OFF agent rows collapse into disclosure so session grants stay unclipped');
  assert.match(offHtml, /class="ac-veto-caveat"/, 'Hard Veto strip includes honest wrapper-script boundary caveat');
  assert.ok(!offHtml.includes('ac-cmd-summary-kicker'), 'No defensive "NOT BUTTONS" kicker needed for flat inline legend');
  assert.ok(!offHtml.includes('ac-eff-chip is-off'), 'Inherited OFF rows omit redundant global-off chip');

  const offBadge = getAutoConsentModalBadge({ config: { enabled: false, mode: 'dry_run', masterPaused: false } }, td);
  assert.equal(offBadge.text, 'АВТО-СОГЛАСИЕ ВЫКЛ');

  const compactSeatHtml = renderSeatAutoConsentPickerHtml({
    seat: { id: 'codex-tests' },
    state: { config: { enabled: false, mode: 'dry_run', masterPaused: false, projects: {}, seats: {} }, sessionGrants: [] },
    td,
    lang: 'ru'
  });
  assert.match(compactSeatHtml, /class="ac-inspector-strip is-compact-off"/, 'Unconfigured master-OFF inspector auto-consent strip collapses cleanly');

  const escapeHtml = (s) => String(s ?? '');
  const standaloneInd = renderStateIndicatorHtml({ id: 'claude-api', state: 'working', assignedWorkCount: 1 }, { escapeHtml, deckLang: 'ru', td });
  assert.ok(standaloneInd.includes('РАБОТАЕТ'), 'Standalone tmux working node shows clear status instead of cryptic "1"');

  const urgentWarn = renderWarningSignsHtml({ deckLang: 'ru', escapeHtml, ageLabel: () => '', td }, { id: 'codex-tests', state: 'urgent', compactionsCount: 0 });
  assert.equal(urgentWarn, '', 'Urgent P0 HITL seat omits contradictory "Seat: nominal" strip');

  const landingSrc = fs.readFileSync(path.join(root, 'landing/index.html'), 'utf8');
  assert.ok(landingSrc.includes('npx rig-commander@{{APP_VERSION}} --read-only --no-session-logs'), 'Hero CLI command matches /guide with --no-session-logs');
  assert.ok(landingSrc.includes('class="sim-panes-grid"'), 'Desktop hero simulator mirrors /demo 2x2 tmux panes layout');
});
