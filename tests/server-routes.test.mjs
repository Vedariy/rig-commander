import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RemoteAccessGuard } from '../openrig/lib/remote-access.mjs';

const serverPath = fileURLToPath(new URL('../openrig/server.mjs', import.meta.url));
const mutations = [
  'guardrails/config', 'guardrails/reset', 'guardrails/telegram',
  'evaluator/config', 'evaluator/models', 'evaluator/run',
  'playbooks/config', 'playbooks/reset', 'playbooks/dry-run',
  'remote/config', 'remote/pair', 'remote/revoke', 'update/check', 'update/apply', 'send'
];

async function startFixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'rigcmd-routes-'));
  const publicUrl = 'https://fixture.invalid';
  const guard = new RemoteAccessGuard({
    stateFile: path.join(home, '.config', 'rig-commander', 'remote-sessions.json'),
    publicUrl
  });
  const { sessionToken } = guard.consumePairingCode(guard.getStatus().pairingPin);
  assert.ok(sessionToken);
  const preload = path.join(home, 'offline.cjs');
  // No daemon, registry, or provider I/O. No installed rig, tmux, updater binaries or account state.
  await writeFile(preload, "globalThis.fetch = async () => { throw new Error('Offline test fixture'); };");
  const child = spawn(process.execPath, ['--require', preload, serverPath], {
    cwd: home,
    env: { HOME: home, PATH: home, RIGCOMMANDER_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
    await rm(home, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const startupTimeout = setTimeout(() => child.kill(), 10000);
  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      const url = line.match(/at (http:\/\/127\.0\.0\.1:[1-9]\d*)/);
      if (url) return { origin: url[1], publicUrl, cookie: 'rigcmd_session=' + sessionToken };
    }
    assert.fail('Server exited before listening. ' + stderr);
  } finally {
    clearTimeout(startupTimeout);
    lines.close();
  }
}

test('Deck HTTP router with an isolated bridge on a kernel-assigned port', async t => {
  const { origin, publicUrl, cookie } = await startFixture(t);
  const get = (pathname, headers = {}) => fetch(origin + pathname, { headers, signal: AbortSignal.timeout(10000) });
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const token = (await page.text()).match(/<meta name="deck-token" content="([^"]+)">/)?.[1];
  assert.ok(token);
  const authorized = { origin, 'content-type': 'application/json', 'x-deck-token': token };
  const post = (route, headers = authorized, body = '{}') => fetch(origin + '/api/' + route, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(10000)
  });

  await t.test('telemetry, SSE ready frame, guardrail and playbook state, digest and queue aliases', async () => {
    const telemetry = await get('/api/telemetry?rig=fixture');
    assert.equal(telemetry.status, 200);
    assert.equal((await telemetry.json()).requestedRig, 'fixture');
    const sse = await get('/api/events?rig=fixture');
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    const reader = sse.body.getReader();
    try {
      let frame = '';
      while (!frame.includes('\n\n')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        frame += Buffer.from(value).toString();
      }
      assert.match(frame, /event: ready/);
      assert.match(frame, /"rig":"fixture"/);
    } finally {
      await reader.cancel();
    }
    for (const route of ['guardrails', 'playbooks']) {
      const r = await get('/api/' + route);
      assert.equal(r.status, 200, route);
      const data = await r.json();
      assert.ok(data.breaker && data.playbooks && data.telegram);
    }
    for (const route of ['digest', 'shift/digest']) {
      const r = await get('/api/' + route + '?lang=en');
      assert.equal(r.status, 200, route);
      const data = await r.json();
      assert.ok(data.ok && data.digest && data.markdown);
    }
    for (const route of ['queue/context', 'queue/item', 'git/diff']) {
      const r = await get('/api/' + route);
      assert.equal(r.status, 400, route);
      assert.equal((await r.json()).ok, false);
    }
    assert.equal((await get('/api/missing')).status, 404);
  });

  for (const route of mutations) {
    await t.test(route + ' enforces method, origin, token, JSON media type and byte limit', async () => {
      const withoutToken = { origin, 'content-type': 'application/json' };
      const cases = [
        [405, () => get('/api/' + route)],
        [403, () => post(route, { ...authorized, origin: publicUrl + '.elsewhere' })],
        [403, () => post(route, withoutToken)],
        [403, () => post(route, { ...authorized, 'x-deck-token': 'x'.repeat(token.length) })],
        [415, () => post(route, { ...authorized, 'content-type': 'text/plain' })],
        [415, () => post(route, { ...authorized, 'content-type': 'application/jsonish' })],
        [413, () => post(route, authorized, JSON.stringify('界'.repeat(22000)))]
      ];
      for (const [status, request] of cases) {
        const r = await request();
        assert.equal(r.status, status, route);
        assert.equal((await r.json()).ok, false);
      }
    });
  }

  await t.test('paired remote status is readable, remote settings and update actions are local only', async () => {
    const remote = { 'x-forwarded-proto': 'https', origin: publicUrl };
    const paired = { ...remote, cookie };
    for (const route of ['telemetry', 'guardrails', 'playbooks', 'update/status']) {
      assert.equal((await get('/api/' + route, remote)).status, 401, route);
    }
    const status = await get('/api/update/status', paired);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).isRemote, true);
    assert.equal((await get('/api/remote/status', paired)).status, 403);
    for (const route of mutations) {
      assert.equal((await post(route, { ...authorized, ...remote })).status, 401, route);
    }
    for (const route of ['update/check', 'update/apply', 'remote/config', 'remote/revoke', 'remote/pair']) {
      assert.equal((await post(route, { ...authorized, ...paired })).status, 403, route);
    }
    assert.equal((await post('playbooks/dry-run', { ...authorized, ...paired })).status, 200);
  });

  await t.test('a rejected upload leaves the fixture connection usable', async t => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    t.after(() => agent.destroy());
    const chunk = Buffer.alloc(32 * 1024, ' ');

    async function exchange(pathname, method) {
      const req = request(origin + pathname, {
        agent, method, headers: authorized, signal: AbortSignal.timeout(5000)
      });
      const received = once(req, 'response');
      if (method === 'POST') {
        for (let i = 0; i < 8; i++) req.write(chunk);
      }
      req.end();
      const [res] = await received;
      const socket = res.socket;
      assert.ok(socket, 'response has a connected socket');
      const parts = [];
      for await (const part of res) parts.push(part);
      return { socket, status: res.statusCode, data: JSON.parse(Buffer.concat(parts).toString()) };
    }

    for (const path of ['/api/guardrails/config', '/api/remote/config', '/api/update/check']) {
      const rejected = await exchange(path, 'POST');
      assert.equal(rejected.status, 413, path);
      assert.equal(rejected.data.ok, false);
      const next = await exchange('/api/update/status', 'GET');
      assert.ok(next.socket === rejected.socket, 'the client reused the fixture socket');
      assert.equal(next.status, 200, path);
      assert.equal(next.data.ok, true);
    }
  });

  await t.test('authorized requests reach handlers at the exact byte limits', async () => {
    const data = '{"maxSessionUsd":29}';
    const changed = await post('guardrails/config', authorized, data.padEnd(65536));
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).breaker.config.maxSessionUsd, 29);
    const denied = await post('guardrails/config', authorized, '{"maxSessionUsd":45}'.padEnd(65537));
    assert.equal(denied.status, 413);
    assert.equal((await (await get('/api/guardrails')).json()).breaker.config.maxSessionUsd, 29);

    const invalidUrl = '{"publicUrl":"invalid"}';
    const exact = await post('remote/config', authorized, invalidUrl.padEnd(16384));
    assert.equal(exact.status, 400);
    assert.equal((await post('remote/config', authorized, invalidUrl.padEnd(16385))).status, 413);
    assert.equal((await post('send')).status, 400);
    const preview = await post('playbooks/dry-run');
    assert.equal(preview.status, 200);
    assert.ok((await preview.json()).dryRun);
  });
});
