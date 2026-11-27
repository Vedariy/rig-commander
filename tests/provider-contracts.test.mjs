import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  SCHEMA_DRIFT_UNKNOWN,
  PROVIDER_SCHEMA_DRIFT_CODE,
  ProviderDriftGuard,
  loadProviderContracts,
  satisfiesVersionRange,
  buildRedactedSkeleton,
  applySchemaDriftFallback
} from '../openrig/lib/provider-drift-guard.mjs';
import { discoverSwarmFleets, clearSwarmDiscoveryCache } from '../openrig/lib/swarm-discovery.mjs';
import { compileAdvisoryReport } from '../openrig/lib/fleet-intelligence/advisory.mjs';
import { runVerifyProvidersCli } from '../scripts/verify-providers.mjs';

const execFileAsync = promisify(execFile);

const FAKE_API_SECRET = 'sk-proj-' + 'ZzYyXxWwVvUuTtSsRrQqPpOo123456';
const FAKE_USER_PATH = ['', 'Users', 'alice-dev', 'secret-project'].join('/');
const FAKE_TOKEN_VAL = 'Bearer ' + 'SecretTokenPayload1234567890';

test('provider-contracts.json & satisfiesVersionRange handle SemVer ranges accurately', () => {
  const registry = loadProviderContracts();
  assert.deepEqual(Object.keys(registry.providers).sort(), ['agy', 'claude-code', 'codex', 'openrig']);

  assert.equal(satisfiesVersionRange('0.7.6', '>=0.7.0 <0.9.0'), true);
  assert.equal(satisfiesVersionRange('0.172.0', '>=0.150.0 <0.200.0'), true);
  assert.equal(satisfiesVersionRange('0.999.0', '>=0.150.0 <0.200.0'), false);
  assert.equal(satisfiesVersionRange('1.5.18', '^1.4.0'), true);
  assert.equal(satisfiesVersionRange('2.0.0', '^1.4.0'), false);
  assert.equal(satisfiesVersionRange('1.5.19', '~1.5.0'), true);
  assert.equal(satisfiesVersionRange('1.6.0', '~1.5.0'), false);
});

test('ProviderDriftGuard caches version probes by mtimeMs and treats newer versions as soft unverified_version badge (never P0)', async () => {
  let execCalls = 0;
  let fakeMtimeMs = 1_700_000_000_000;

  const guard = new ProviderDriftGuard({
    whichFn: async (bin) => (bin === 'codex' ? '/mock/bin/codex' : null),
    statFn: async () => ({ mtimeNs: BigInt(fakeMtimeMs) * 1_000_000n, mtimeMs: fakeMtimeMs, size: 4096 }),
    execFileFn: async () => {
      execCalls += 1;
      return { ok: true, code: 0, stdout: 'codex-cli 0.999.0\n', stderr: '' };
    }
  });

  const first = await guard.probeProviderVersion('codex');
  assert.equal(first.status, 'unverified_version');
  assert.equal(first.badge, 'unverified_version');
  assert.equal(first.severity, 'info', 'unverified_version must NEVER raise P0');
  assert.equal(first.version, '0.999.0');
  assert.equal(first.cached, false);
  assert.equal(execCalls, 1);

  // Unchanged binary mtime -> cached hit (0 subprocess invocations)
  const second = await guard.probeProviderVersion('codex');
  assert.equal(second.cached, true);
  assert.equal(execCalls, 1);

  // Binary mtime change triggers fresh probe
  fakeMtimeMs += 5000;
  const third = await guard.probeProviderVersion('codex');
  assert.equal(third.cached, false);
  assert.equal(execCalls, 2);

  // Missing binary reports not_installed without errors
  const missing = await guard.probeProviderVersion('claude-code');
  assert.equal(missing.status, 'not_installed');
});

test('buildRedactedSkeleton emits strictly key+type structural skeletons with ZERO scalar values, secrets, or OS paths', () => {
  const dirtyPayload = {
    members: {
      worker: { phase: 'RUNNING', apiKey: FAKE_API_SECRET }
    },
    head: 42,
    secretNote: `${FAKE_TOKEN_VAL} in ${FAKE_USER_PATH}`,
    items: [
      { id: '1', path: FAKE_USER_PATH, token: FAKE_API_SECRET }
    ],
    [FAKE_USER_PATH]: 'leak-key-val'
  };

  const skeleton = buildRedactedSkeleton(dirtyPayload);
  assert.equal(skeleton.members.worker.phase, 'string');
  assert.equal(skeleton.members.worker.apiKey, 'string');
  assert.equal(skeleton.head, 'number');
  assert.equal(skeleton.secretNote, 'string');
  assert.deepEqual(skeleton.items, [{ id: 'string', path: 'string', token: 'string' }]);
  assert.equal(skeleton['[REDACTED:USER_PATH]'], 'string');

  const serialized = JSON.stringify(skeleton);
  assert.equal(serialized.includes(FAKE_API_SECRET), false);
  assert.equal(serialized.includes(FAKE_TOKEN_VAL), false);
  assert.equal(serialized.includes(FAKE_USER_PATH), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('RUNNING'), false);
  assert.equal(serialized.includes('42'), false);
});

test('Contour A marks drifted telemetry as unknown (schema_drift) (never 0 tokens or false idle) and emits P1 PROVIDER_SCHEMA_DRIFT', async () => {
  clearSwarmDiscoveryCache();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigcmd-drift-'));
  const brainRoot = path.join(root, 'brain');
  const codexRoot = path.join(root, 'codex');
  await fs.mkdir(path.join(brainRoot, 'aaaaaaaa-1111-2222-3333-444455556666', '.system_generated', 'swarm'), { recursive: true });
  await fs.mkdir(codexRoot, { recursive: true });

  // Drifted Antigravity members.json (renamed `phase`/`wake_mode` to `v2_status` + embedded secret value)
  const agyDir = path.join(brainRoot, 'aaaaaaaa-1111-2222-3333-444455556666', '.system_generated', 'swarm');
  await fs.writeFile(path.join(agyDir, 'swarm.json'), JSON.stringify({ version: 2, swarm_id: 'aaaaaaaa-1111-2222-3333-444455556666' }));
  await fs.writeFile(path.join(agyDir, 'members.json'), JSON.stringify({
    title: 'Drifted Swarm',
    members: {
      worker: {
        role: 'worker',
        v2_status: 'active',
        secretVal: FAKE_API_SECRET,
        userPath: FAKE_USER_PATH
      }
    }
  }));

  // Drifted Codex subagent token_count JSONL (missing info.last_token_usage / total_token_usage)
  await fs.writeFile(path.join(codexRoot, 'rollout-drifted.jsonl'), [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-11-27T11:50:00Z',
      payload: {
        id: 'codex-drift-1',
        cwd: FAKE_USER_PATH,
        source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent-x', agent_nickname: 'drifted-sub' } } }
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-11-27T11:55:00Z',
      payload: {
        type: 'token_count',
        info: { v2_usage_metrics: { prompt: 99999 }, leaked: FAKE_TOKEN_VAL }
      }
    })
  ].join('\n') + '\n');

  const guard = new ProviderDriftGuard({
    whichFn: async (bin) => `/mock/bin/${bin}`,
    statFn: async () => ({ mtimeNs: 1n, mtimeMs: 1000, size: 100 }),
    execFileFn: async (bin) => ({
      ok: true,
      code: 0,
      stdout: bin.endsWith('codex') ? 'codex-cli 0.250.0' : '1.9.0',
      stderr: ''
    })
  });
  await guard.probeProviderVersion('codex');
  await guard.probeProviderVersion('agy');

  const res = await discoverSwarmFleets({
    brainRoot,
    claudeTeamsRoot: path.join(root, 'missing-claude'),
    codexSessionsRoot: codexRoot,
    driftGuard: guard,
    nowMs: Date.parse('2026-11-27T11:56:00Z')
  });

  // Never fabricate false 'idle' on drifted Antigravity member!
  const driftedAgySeat = res.nodes.find(n => n.providerKind === 'antigravity-swarm');
  assert.ok(driftedAgySeat);
  assert.equal(driftedAgySeat.activityState.display, SCHEMA_DRIFT_UNKNOWN);

  // Never fabricate 0 tokens on drifted Codex token_count!
  const driftedCodexSeat = res.nodes.find(n => n.providerKind === 'codex-subagents');
  assert.ok(driftedCodexSeat);
  assert.equal(driftedCodexSeat.contextUsage.usedTokens, SCHEMA_DRIFT_UNKNOWN);
  assert.equal(driftedCodexSeat.contextUsage.usedPercentage, SCHEMA_DRIFT_UNKNOWN);

  // Must emit P1 PROVIDER_SCHEMA_DRIFT findings with redacted skeletons
  assert.ok(res.driftFindings.length >= 2);
  for (const f of res.driftFindings) {
    assert.equal(f.severity, 'p1_high');
    assert.equal(f.code, PROVIDER_SCHEMA_DRIFT_CODE);
    assert.ok(f.metrics.binaryVersion);
    assert.ok(f.metrics.testedVersionRange);
    assert.ok(Array.isArray(f.metrics.missingKeys) && f.metrics.missingKeys.length > 0);
    assert.ok(f.metrics.skeleton && typeof f.metrics.skeleton === 'object');

    const json = JSON.stringify(f);
    assert.equal(json.includes(FAKE_API_SECRET), false);
    assert.equal(json.includes(FAKE_TOKEN_VAL), false);
    assert.equal(json.includes(FAKE_USER_PATH), false);
    assert.equal(json.includes('/Users/'), false);
  }

  // Integrates cleanly into FleetIntelligenceEngine advisory report
  const report = compileAdvisoryReport(res.driftFindings);
  assert.ok(report.counts.p1 >= 2);
  assert.equal(report.counts.p0, 0);

  // Direct helper check for applySchemaDriftFallback
  const patched = applySchemaDriftFallback({ usedTokens: 0 }, ['usedTokens', 'usedPercentage']);
  assert.equal(patched.usedTokens, SCHEMA_DRIFT_UNKNOWN);
  assert.equal(patched.usedPercentage, SCHEMA_DRIFT_UNKNOWN);
  assert.equal(patched.schemaDrift, true);

  await fs.rm(root, { recursive: true, force: true });
});

test('Contour B verify-providers CLI produces accurate diffs for green, unverified_version, and schema_drift', async () => {
  // 1. Mocked green vs unverified vs broken --help/--samples
  const greenCli = await runVerifyProvidersCli(['--json'], {
    whichFn: async (bin) => `/mock/${bin}`,
    statFn: async () => ({ mtimeNs: 1n, mtimeMs: 1, size: 10 }),
    execFileFn: async (bin, args) => {
      if (args.includes('--version')) {
        if (bin.endsWith('rig')) return { ok: true, stdout: '0.7.6\n' };
        if (bin.endsWith('codex')) return { ok: true, stdout: 'codex-cli 0.250.0\n' }; // newer than range
        if (bin.endsWith('claude')) return { ok: true, stdout: '2.1.0\n' };
        return { ok: true, stdout: '1.5.18\n' };
      }
      if (bin.endsWith('rig')) return { ok: true, stdout: 'start status crash-cart parked ps queue transcript' };
      if (bin.endsWith('codex')) return { ok: true, stdout: 'exec review resume agents' };
      if (bin.endsWith('claude')) return { ok: true, stdout: '--print --output-format --resume' };
      return { ok: true, stdout: '--print --output-format --conversation --model agents' };
    }
  });
  assert.equal(greenCli.report.ok, true, 'newer version with intact help+samples stays green in non-strict mode');
  assert.equal(greenCli.report.unverifiedVersionCount, 1);

  const strictCli = await runVerifyProvidersCli(['--json', '--strict'], {
    whichFn: async (bin) => (bin === 'codex' ? '/mock/codex' : null),
    statFn: async () => ({ mtimeNs: 1n, mtimeMs: 1, size: 10 }),
    execFileFn: async (_bin, args) => ({
      ok: true,
      stdout: args.includes('--version') ? 'codex-cli 0.250.0\n' : 'exec review resume agents'
    })
  });
  assert.equal(strictCli.report.ok, false, '--strict treats unverified_version as failure');

  const driftCli = await runVerifyProvidersCli(['--json', '--provider', 'codex'], {
    whichFn: async () => '/mock/codex',
    statFn: async () => ({ mtimeNs: 1n, mtimeMs: 1, size: 10 }),
    execFileFn: async (_bin, args) => ({
      ok: true,
      stdout: args.includes('--version') ? 'codex-cli 0.172.0\n' : 'exec review' // missing resume, agents
    }),
    samplePayloads: {
      codex: {
        jsonlTokenCount: { type: 'event_msg', payload: { type: 'token_count', info: { secret: FAKE_API_SECRET } } }
      }
    }
  });
  assert.equal(driftCli.report.ok, false);
  assert.equal(driftCli.report.unexpectedDriftCount, 1);
  assert.deepEqual(driftCli.report.providers[0].missingHelpTokens, ['resume', 'agents']);
  assert.equal(driftCli.report.providers[0].sampleChecks[0].ok, false);
  assert.equal(JSON.stringify(driftCli.report).includes(FAKE_API_SECRET), false);

  // 2. Real standalone execution of `node scripts/verify-providers.mjs --json`
  const scriptPath = path.resolve('scripts/verify-providers.mjs');
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], { timeout: 10_000 });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.unexpectedDriftCount, 0);
  assert.equal(parsed.providers.length, 4);
});
