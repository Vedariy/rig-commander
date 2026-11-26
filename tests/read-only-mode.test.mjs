import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveReadOnlyMode, READ_ONLY_ERROR_BODY } from '../openrig/server.mjs';

const execFileAsync = promisify(execFile);
const serverPath = fileURLToPath(new URL('../openrig/server.mjs', import.meta.url));
const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

async function getFreePort() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  srv.close();
  await once(srv, 'close');
  return port;
}

async function startReadOnlyServer(t, { useCliFlag = false, extraEnv = {}, seedArmedAutoConsent = false } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'rigcmd-readonly-'));
  const stateDir = path.join(home, 'state');
  const preload = path.join(home, 'offline.cjs');
  await writeFile(preload, "globalThis.fetch = async () => { throw new Error('Offline test fixture'); };");

  // Fake tmux stub recording every invocation to prove 0 send-keys writes occur
  const tmuxLog = path.join(home, 'tmux.log');
  const fakeTmux = path.join(home, 'tmux');
  await writeFile(tmuxLog, '');
  await writeFile(fakeTmux, `#!/bin/sh
echo "$@" >> ${JSON.stringify(tmuxLog)}
if [ "$1" = "capture-pane" ]; then
  echo "mock terminal screen"
fi
exit 0
`, { mode: 0o755 });

  let seededAutoConsentPath = null;
  let seededRaw = null;
  if (seedArmedAutoConsent) {
    const fs = await import('node:fs/promises');
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    seededAutoConsentPath = path.join(stateDir, 'auto-consent.json');
    seededRaw = JSON.stringify({
      enabled: true,
      mode: 'armed',
      masterPaused: false,
      projects: { sandbox: { profile: 'trusted_dev' } }
    }, null, 2) + '\n';
    await writeFile(seededAutoConsentPath, seededRaw, { mode: 0o600 });
  }

  const argv = ['--require', preload, serverPath, '--state-dir', stateDir];
  if (useCliFlag) argv.push('--read-only');

  const env = {
    HOME: home,
    PATH: `${home}:/bin:/usr/bin`,
    TMUX_BIN: fakeTmux,
    RIGCOMMANDER_PORT: '0',
    RIGCOMMANDER_FORCE_UNIVERSAL: '1',
    ...(useCliFlag ? {} : { RIGCOMMANDER_READ_ONLY: '1' }),
    ...extraEnv
  };

  const child = spawn(process.execPath, argv, {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
    await rm(home, { recursive: true, force: true });
  });

  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
  const startupTimeout = setTimeout(() => child.kill(), 10000);
  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      const m = line.match(/at (http:\/\/127\.0\.0\.1:[1-9]\d*)/);
      if (m) {
        return { origin: m[1], startupLine: line, tmuxLog, seededAutoConsentPath, seededRaw };
      }
    }
    assert.fail('Server exited before listening. ' + stderr);
  } finally {
    clearTimeout(startupTimeout);
    lines.close();
  }
}

test('resolveReadOnlyMode parses RIGCOMMANDER_READ_ONLY env var and --read-only CLI flag', () => {
  assert.equal(resolveReadOnlyMode({}, ['node', 'server.mjs']), false);
  assert.equal(resolveReadOnlyMode({ RIGCOMMANDER_READ_ONLY: '0' }, ['node', 'server.mjs']), false);
  assert.equal(resolveReadOnlyMode({ RIGCOMMANDER_READ_ONLY: 'false' }, ['node', 'server.mjs']), false);
  assert.equal(resolveReadOnlyMode({ RIGCOMMANDER_READ_ONLY: '1' }, ['node', 'server.mjs']), true);
  assert.equal(resolveReadOnlyMode({ RIGCOMMANDER_READ_ONLY: 'true' }, ['node', 'server.mjs']), true);
  assert.equal(resolveReadOnlyMode({}, ['node', 'server.mjs', '--read-only']), true);
});

test('bin/cli.mjs --help documents --read-only flag', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help'], { timeout: 10000 });
  assert.match(stdout, /--read-only\b/);
  assert.match(stdout, /read-only/i);
});

test('server in RIGCOMMANDER_READ_ONLY=1 mode preserves GET observation and blocks all mutating APIs with 403 READ_ONLY_MODE', async t => {
  const { origin, startupLine, tmuxLog, seededAutoConsentPath, seededRaw } = await startReadOnlyServer(t, {
    useCliFlag: false,
    seedArmedAutoConsent: true,
    extraEnv: { RIG_BREAKER_MODE: 'auto_stop' }
  });

  assert.match(startupLine, /\[READ-ONLY\]/);

  // 1. Static pages remain 100% functional
  const pageRes = await fetch(origin + '/');
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  const token = html.match(/<meta name="deck-token" content="([^"]+)">/)?.[1];
  assert.ok(token, 'Expected valid session deck-token in index.html');

  for (const staticPath of ['/guide', '/passport']) {
    const r = await fetch(origin + staticPath);
    assert.equal(r.status, 200, staticPath);
  }

  // 2. GET /api/telemetry returns 200 with readOnlyMode: true and safe disabled autoConsent/breaker
  const telRes = await fetch(origin + '/api/telemetry?force=1');
  assert.equal(telRes.status, 200);
  const tel = await telRes.json();
  assert.equal(tel.readOnlyMode, true);
  assert.equal(tel.autoConsent.status, 'disabled');
  assert.equal(tel.autoConsent.readOnlyMode, true);
  assert.equal(tel.autoConsent.config.enabled, false);
  assert.equal(tel.autoConsent.config.mode, 'dry_run');
  assert.equal(tel.guardrails.breaker.config.mode, 'alert_only');

  // 3. GET /api/auto-consent/state returns 200 with forced disabled/read-only status (ignoring armed disk file)
  const acRes = await fetch(origin + '/api/auto-consent/state');
  assert.equal(acRes.status, 200);
  const ac = await acRes.json();
  assert.equal(ac.ok, true);
  assert.equal(ac.state.status, 'disabled');
  assert.equal(ac.state.readOnlyMode, true);
  assert.equal(ac.state.config.enabled, false);
  assert.equal(ac.state.config.mode, 'dry_run');
  assert.deepEqual(ac.state.sessionGrants, []);
  assert.deepEqual(ac.state.pendingApprovals, []);

  // 4. Other GET observation endpoints remain functional
  assert.equal((await fetch(origin + '/api/resilience/status')).status, 200);
  assert.equal((await fetch(origin + '/api/capture?seat=dev-coder@sandbox')).status, 200);
  const gitDiffRes = await fetch(origin + '/api/git/diff?seat=dev-coder@sandbox');
  assert.notEqual(gitDiffRes.status, 403, 'GET /api/git/diff must not be blocked by read-only gate');

  const sseRes = await fetch(origin + '/api/events?rig=all');
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get('content-type'), /text\/event-stream/);
  const sseReader = sseRes.body.getReader();
  try {
    let chunkText = '';
    while (!chunkText.includes('event: ready')) {
      const { value, done } = await sseReader.read();
      assert.equal(done, false);
      chunkText += Buffer.from(value).toString();
    }
    assert.match(chunkText, /event: ready/);
  } finally {
    await sseReader.cancel();
  }

  const capStreamRes = await fetch(origin + '/api/capture/stream?seat=dev-coder@sandbox');
  assert.equal(capStreamRes.status, 200);
  assert.match(capStreamRes.headers.get('content-type'), /text\/event-stream/);
  await capStreamRes.body.cancel();

  // 5. ALL mutating endpoints return 403 READ_ONLY_MODE even with valid session token + Origin + JSON
  const authorizedHeaders = {
    origin,
    'content-type': 'application/json',
    'x-deck-token': token
  };

  const blockedPosts = [
    ['/api/send', { seat: 'dev-coder@sandbox', type: 'key', text: '1 Enter' }],
    ['/api/keys', { seat: 'dev-coder@sandbox', key: 'Enter' }],
    ['/api/send-key', { seat: 'dev-coder@sandbox', key: 'Enter' }],
    ['/api/auto-consent/policy', { enabled: true, mode: 'armed' }],
    ['/api/auto-consent/session-grant', { scope: 'rig', targetId: 'sandbox', profile: 'trusted_dev', ttlMin: 15 }],
    ['/api/auto-consent/cancel', {}],
    ['/api/auto-consent/pause-all', { paused: true }],
    ['/api/guardrails/config', { mode: 'auto_stop', maxSessionUsd: 1 }],
    ['/api/guardrails/reset', {}],
    ['/api/guardrails/telegram', { action: 'disconnect' }],
    ['/api/playbooks/config', { enabled: true, mode: 'armed' }],
    ['/api/playbooks/reset', { action: 'pause' }],
    ['/api/playbooks/dry-run', {}],
    ['/api/resilience/resurrect', { providerId: 'openrig', scope: 'fleet', confirmed: true, planHash: 'abc' }],
    ['/api/resilience/snapshot', { providerId: 'openrig', scope: 'rig', target: 'sandbox' }],
    ['/api/resilience/plan', { providerId: 'openrig', scope: 'fleet' }],
    ['/api/update/check', {}],
    ['/api/update/apply', {}],
    ['/api/self-update/apply', {}],
    ['/api/remote/config', { publicUrl: 'https://example.ts.net' }],
    ['/api/remote/pair', {}],
    ['/api/remote/revoke', {}],
    ['/api/mobile-pair/start', {}]
  ];

  for (const [endpoint, body] of blockedPosts) {
    const res = await fetch(origin + endpoint, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify(body)
    });
    assert.equal(res.status, 403, `POST ${endpoint} should return 403 in read-only mode`);
    const data = await res.json();
    assert.deepEqual(data, READ_ONLY_ERROR_BODY, `POST ${endpoint} error payload mismatch`);
  }

  for (const [method, endpoint] of [
    ['PUT', '/api/guardrails/config'],
    ['PATCH', '/api/auto-consent/policy'],
    ['DELETE', '/api/auto-consent/session-grant']
  ]) {
    const res = await fetch(origin + endpoint, {
      method,
      headers: authorizedHeaders,
      body: '{}'
    });
    assert.equal(res.status, 403, `${method} ${endpoint} should return 403 in read-only mode`);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, 'READ_ONLY_MODE');
  }

  // 6. Verify 0 tmux send-keys invocations occurred and pre-seeded config on disk was never mutated
  const tmuxCalls = (await readFile(tmuxLog, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(tmuxCalls.filter(l => l.startsWith('send-keys')).length, 0, 'Zero tmux send-keys writes allowed');
  const diskConfigAfter = await readFile(seededAutoConsentPath, 'utf8');
  assert.equal(diskConfigAfter, seededRaw, 'Pre-seeded auto-consent.json must remain untouched in read-only mode');
});

test('server accepts --read-only CLI flag directly without RIGCOMMANDER_READ_ONLY env var', async t => {
  const { origin } = await startReadOnlyServer(t, { useCliFlag: true });
  const html = await (await fetch(origin + '/')).text();
  const token = html.match(/<meta name="deck-token" content="([^"]+)">/)?.[1];
  assert.ok(token);

  const tel = await (await fetch(origin + '/api/telemetry?force=1')).json();
  assert.equal(tel.readOnlyMode, true);

  const sendRes = await fetch(origin + '/api/send', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-deck-token': token },
    body: JSON.stringify({ seat: 'dev-coder@sandbox', type: 'key', text: 'Enter' })
  });
  assert.equal(sendRes.status, 403);
  const body = await sendRes.json();
  assert.equal(body.code, 'READ_ONLY_MODE');
});

test('bin/cli.mjs --read-only prints status line and forwards read-only enforcement to child server', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rigcmd-cli-ro-'));
  const stateDir = path.join(home, 'state');
  const port = await getFreePort();
  const child = spawn(process.execPath, [cliPath, '--read-only', '--universal', '--no-open', '-p', String(port)], {
    cwd: home,
    env: {
      HOME: home,
      PATH: `${home}:/bin:/usr/bin`,
      RIGCOMMANDER_STATE_DIR: stateDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill('SIGINT');
    await exited;
    await rm(home, { recursive: true, force: true });
  });

  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12000);
  const lines = createInterface({ input: child.stdout });
  let origin = '';
  try {
    for await (const line of lines) {
      stdout += line + '\n';
      const m = line.match(/at (http:\/\/127\.0\.0\.1:[1-9]\d*)/);
      if (m) {
        origin = m[1];
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    lines.close();
  }

  assert.ok(origin, `CLI child server failed to start. stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /🔒 Mode: READ-ONLY \(0 terminal writes\)/);

  const html = await (await fetch(origin + '/')).text();
  const token = html.match(/<meta name="deck-token" content="([^"]+)">/)?.[1];
  assert.ok(token);

  const tel = await (await fetch(origin + '/api/telemetry?force=1')).json();
  assert.equal(tel.readOnlyMode, true);

  const sendRes = await fetch(origin + '/api/send', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-deck-token': token },
    body: JSON.stringify({ seat: 'dev-coder@sandbox', type: 'key', text: '1 Enter' })
  });
  assert.equal(sendRes.status, 403);
  assert.equal((await sendRes.json()).code, 'READ_ONLY_MODE');
});
