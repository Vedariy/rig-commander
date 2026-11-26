import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as model from '../openrig/assets/domain/resilience-model.js';
import { ProcessProviderRegistry, DEFAULT_PROVIDER_CAPABILITIES, assertValidProcessProvider } from '../openrig/lib/resilience/provider-interface.mjs';
import { LocalFsVaultAdapter, MAX_VAULT_BYTES, assertValidStateVaultAdapter } from '../openrig/lib/resilience/vault-interface.mjs';
import { FleetManifestStore } from '../openrig/lib/resilience/manifest-store.mjs';

const at = Date.parse('2026-01-01T12:00:00Z');
const digest = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
function envelope(hostId, clock = 1, updatedAt = new Date(at).toISOString(), rigs = [{ rigId: 'fleet' }]) {
  const payload = { rigs, history: [] };
  return { schemaVersion: 1, bundleType: 'fleet-manifest', hostId, hostLabel: hostId, lamportClock: clock, updatedAt, contentSha256: digest(payload), encryption: { mode: 'none' }, payload };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resilience-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const vault = new LocalFsVaultAdapter({ baseDir: path.join(dir, 'vault') });
  return { dir, vault, store: new FleetManifestStore({ vault, hostId: 'host-a', now: () => at }) };
}

test('snapshot parser matches installed CLI padded table including long kind, JSON fallback and deterministic ordering', () => {
  // Verified dist/commands/snapshot.js: padEnd widest column, join with two spaces; status complete.
  const rows = [['snap-old', 'auto-pre-down', 'complete', '2026-01-01T10:00:00Z'], ['snap-new', 'manual', 'complete', '2026-01-01T11:00:00Z'], ['snap-bad', 'manual', 'failed', '2026-01-01T11:30:00Z']];
  const table = [['ID', 'Kind', 'Status', 'Created'], ...rows].map(r => r.map((s, i) => i < 3 ? s.padEnd(18) : s).join('  ')).join('\n');
  const parsed = model.parseSnapshotTable(`${table}\nmalformed\nNo snapshots\n`);
  assert.deepEqual(parsed.map(s => [s.id, s.restoreUsable]), [['snap-bad', false], ['snap-new', true], ['snap-old', true]]);
  assert.deepEqual(model.parseSnapshotTable(JSON.stringify(parsed)), parsed);
  // Real OpenRig SQLite timestamps (YYYY-MM-DD HH:MM:SS without offset) are UTC, never local time
  const sqliteOut = 'ID  Kind  Status  Created\n01M8BG  auto-periodic  complete  2026-11-26 08:44:18\n';
  assert.equal(model.parseSnapshotTable(sqliteOut)[0].createdAt, '2026-11-26T08:44:18.000Z');
  for (const bad of ['', null, '{}', '[]', 'No snapshots', 'x  manual  complete  no-date', 'x'.repeat(1024 * 1024 + 1)]) assert.deepEqual(model.parseSnapshotTable(bad), []);
});

test('target validators reject command injection, traversal, controls and oversized strings at exact boundaries', () => {
  for (const target of ['a;b', 'a|b', 'a&&b', '$(id)', '`id`', '../a', 'a..b', '/a', 'a/b', 'a\\b', 'a\0', 'a\n', 'a\r', '', 'a b', '-flag', 'a'.repeat(65)]) {
    assert.equal(model.validateResilienceTarget({ providerId: 'openrig', scope: 'rig', target }), false, JSON.stringify(target));
    assert.equal(model.SAFE_RIG_NAME_RE.test(target), false, JSON.stringify(target));
  }
  assert.equal(model.validateResilienceTarget({ providerId: 'openrig', scope: 'rig', target: 'a'.repeat(64) }), true);
  assert.equal(model.validateResilienceTarget({ providerId: 'openrig', scope: 'seat', target: 'dev.coder@fleet' }), true);
  assert.equal(model.validateResilienceTarget({ providerId: 'openrig', scope: 'seat', target: 'a'.repeat(129) }), false);
  for (const scope of ['fleet', 'rig', 'seat', 'nope']) assert.equal(model.validateResilienceTarget({ providerId: 'openrig\n', scope, target: 'fleet' }), false);
  assert.equal(model.validateResilienceTarget({ providerId: 'openrig', scope: 'fleet' }), true);
  assert.equal(model.validateResilienceTarget({ providerId: 'openrig', scope: 'fleet', target: ';' }), false);
});

test('sleep/wake jump guards first tick, skew, NaN and strict threshold', () => {
  assert.deepEqual(model.detectSleepWakeJump(null, at), { jumped: false, deltaMs: 0 });
  for (const prev of [NaN, Infinity, -1, at + 1]) assert.deepEqual(model.detectSleepWakeJump(prev, at), { jumped: false, deltaMs: 0 });
  assert.equal(model.detectSleepWakeJump(at, at + 90_000).jumped, false);
  assert.equal(model.detectSleepWakeJump(at, at + 90_001).jumped, true);
  assert.deepEqual(model.detectSleepWakeJump(at, at + 1, NaN), { jumped: false, deltaMs: 1 });
});

test('all outage tiers, intentional rig/seat stops, freshness boundaries and stable sorting', () => {
  const base = { daemonUp: true, manifestRigs: [{ rigId: 'z', intentionallyStopped: true }, { rigId: 'a' }], liveRigs: ['a'], nowMs: at };
  assert.equal(model.classifyFleetResilience(base).tier, 'healthy');
  assert.equal(model.classifyFleetResilience({ ...base, daemonUp: false }).tier, 'daemon_down');
  assert.equal(model.classifyFleetResilience({ ...base, liveRigs: [] }).tier, 'rig_down');
  assert.equal(model.classifyFleetResilience({ ...base, liveNodes: [{ canonicalSessionName: 'dev.coder@a', shellExited: true }] }).tier, 'seat_exited');
  assert.equal(model.classifyFleetResilience({ ...base, liveNodes: [{ canonicalSessionName: 'dev.coder@a', shellExited: true, intentionallyStopped: true }] }).tier, 'healthy');
  assert.deepEqual(model.classifyFleetResilience({ ...base, manifestRigs: [{ rigId: 'a', seats: ['dev.coder@a', { seatId: 'dev.check@a', intentionallyStopped: true }] }] }).rigReports[0].exitedSeats, ['dev.coder@a']);
  assert.deepEqual(model.classifyFleetResilience({ ...base, liveRigs: [] }).offlineRigs, ['a']);
  assert.equal(model.classifyFleetResilience({ ...base, liveRigs: [{ rigId: 'z', intentionallyStopped: false }] }).rigReports.find(r => r.rigId === 'z').intentionallyStopped, true);
  for (const [age, expected] of [[0, 'fresh'], [900_000, 'fresh'], [900_001, 'aging'], [7_200_000, 'aging'], [7_200_001, 'stale']]) {
    const report = model.classifyFleetResilience({ ...base, snapshotsByRig: { a: [{ id: 's', status: 'complete', createdAt: new Date(at - age).toISOString() }] } });
    assert.equal(report.rigReports[0].snapshot.freshness, expected);
    assert.deepEqual(report.rigReports.map(r => r.rigId), ['a', 'z']);
    assert.equal(report.rigReports[1].snapshot.freshness, 'missing');
  }
  assert.equal(model.classifyFleetResilience({ crashCart: { state: 'down' } }).tier, 'daemon_down');
});

test('host merge preserves same rig on two hosts, LWW clock/time/hash and invalid version exclusion', () => {
  const a = envelope('host-a'), b = envelope('host-b'), newer = envelope('host-a', 2);
  const tied = envelope('host-a', 2, new Date(at + 1).toISOString());
  const rows = [a, b, newer, tied, { ...b, schemaVersion: 2 }, { ...b, lamportClock: NaN }];
  assert.deepEqual(model.mergeHostManifestEnvelopes(rows), model.mergeHostManifestEnvelopes([...rows].reverse()));
  const merged = model.mergeHostManifestEnvelopes(rows);
  assert.equal(merged.rigs.length, 2);
  assert.equal(merged.hosts[0], tied);
  assert.deepEqual(merged.rigs.map(r => r.provenance.hostId), ['host-a', 'host-b']);
  const conflict = envelope('host-a', 2, tied.updatedAt, [{ rigId: 'other' }]);
  assert.deepEqual(model.mergeHostManifestEnvelopes([tied, conflict]), model.mergeHostManifestEnvelopes([conflict, tied]));
  const relabeled = { ...tied, hostLabel: 'another-label' };
  assert.deepEqual(model.mergeHostManifestEnvelopes([tied, relabeled]), model.mergeHostManifestEnvelopes([relabeled, tied]));
});

test('advisory plans require capabilities, skip intentional stops and receipts never promote partial/unknown', () => {
  const report = model.classifyFleetResilience({ daemonUp: false, manifestRigs: [{ rigId: 'fleet' }, { rigId: 'parked', intentionallyStopped: true }] });
  const plan = model.buildResurrectPlanPreview({ report, capabilities: { planPreview: true, fleetRecover: true }, commandPreview: 'rig start --last --json' });
  assert.deepEqual(plan.targetRigs, ['fleet']); assert.deepEqual(plan.skippedRigs, ['parked']); assert.equal(plan.requiresConfirmation, true);
  assert.equal(model.buildResurrectPlanPreview({ report }).supported, false);
  assert.throws(() => model.buildResurrectPlanPreview({ scope: 'rig', target: ';id' }));
  for (const status of ['partial', 'unknown', 'failed', 'completed', undefined]) assert.equal(model.normalizeRestoreReceipt({ status }).status, ['partial', 'failed'].includes(status) ? status : 'unknown');
  assert.equal(model.normalizeRestoreReceipt({ status: 'restored', seats: [{ target: 'a', status: 'partial' }] }).status, 'partial');
  assert.deepEqual(model.normalizeRestoreReceipt({ attemptId: 42, currentIntendedSetVerdict: 'partially_restored', currentNodes: [{ logicalId: 'dev.coder', status: 'fresh' }] }),
    { attemptId: '42', status: 'partial', rigs: [], seats: [{ target: 'dev.coder', status: 'partial' }] });
  assert.equal(model.normalizeRestoreReceipt({ ok: true, status: 'completed' }).status, 'unknown');
  assert.equal(model.normalizeRestoreReceipt({ currentIntendedSetVerdict: 'fully_restored', currentNodes: [{ logicalId: 'dev.coder', status: 'unrecognized' }] }).status, 'partial');
  for (const step of ['blackout', 'preview', 'recovered']) {
    const scenario = model.buildDemoResilienceScenario(step);
    assert.equal(scenario.vault.encrypted, false);
    assert.equal(scenario.report.tier, step === 'recovered' ? 'healthy' : 'daemon_down');
    assert.equal(scenario.receipt?.status || null, step === 'recovered' ? 'restored' : null);
  }
});

test('domain imports without browser/Node coupling and barrel exports the contract', async () => {
  const source = await fs.readFile(new URL('../openrig/assets/domain/resilience-model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:node:|\bwindow\b|\bdocument\b|\bfetch\s*\()/);
  const barrel = await import('../openrig/assets/domain/index.js');
  assert.equal(barrel.classifyFleetResilience, model.classifyFleetResilience);
});

test('multiple providers through one registry, defaults, capability validation and duplicate rejection', () => {
  const make = id => ({ id, capabilities: { ...DEFAULT_PROVIDER_CAPABILITIES }, ...Object.fromEntries(['probe', 'listCheckpoints', 'createCheckpoint', 'planRecover', 'executeRecover', 'getReceipt'].map(k => [k, async () => id])) });
  const registry = new ProcessProviderRegistry([make('second'), make('openrig')]);
  assert.equal(registry.resolveDefault().id, 'openrig'); assert.equal(registry.resolveDefault('second').id, 'second'); assert.equal(registry.get('missing'), null);
  assert.deepEqual(registry.listWithCapabilities().map(p => p.id), ['openrig', 'second']);
  assert.throws(() => registry.register(make('second')));
  assert.throws(() => assertValidProcessProvider({ ...make('bad'), capabilities: {} }));
  assert.throws(() => assertValidProcessProvider({ ...make('bad'), probe: null }));
  assert.equal(registry.unregister('openrig'), true); assert.equal(registry.resolveDefault().id, 'second');
});

test('local vault atomic reload, exact mode, host isolation and no temporary leftovers', async t => {
  const { vault } = await fixture(t);
  assert.equal(assertValidStateVaultAdapter(vault), vault);
  assert.deepEqual(await vault.health(), { adapterId: 'local-fs', healthy: true, encrypted: false });
  const key = 'hosts/host-a/fleet-manifest.v1.json';
  await vault.write(key, envelope('host-a'));
  const file = path.join(vault.baseDir, key);
  await fs.chmod(file, 0o644);
  await vault.write(key, envelope('host-a', 2));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await new LocalFsVaultAdapter({ baseDir: vault.baseDir }).read(key)).lamportClock, 2);
  await vault.write('hosts/host-b/fleet-manifest.v1.json', envelope('host-b'));
  assert.equal((await vault.list()).length, 2);
  assert.equal((await fs.readdir(path.dirname(file))).length, 1);
  assert.equal(await vault.read('hosts/absent/fleet-manifest.v1.json'), null);
});

test('vault rejects traversal, controls, symlink file/ancestor/root, oversize and preserves old bytes on serialization failure', async t => {
  const { vault, dir } = await fixture(t);
  for (const key of ['../x', '/tmp/x', 'hosts/../fleet-manifest.v1.json', 'hosts/a/../../x', 'hosts/a/fleet-manifest.v1.json\0', 'hosts/a/fleet-manifest.v1.json\n', 'hosts/a\\b/fleet-manifest.v1.json']) {
    await assert.rejects(vault.read(key), TypeError); await assert.rejects(vault.write(key, {}), TypeError);
  }
  const key = 'hosts/host-a/fleet-manifest.v1.json';
  await vault.write(key, envelope('host-a'));
  const old = await fs.readFile(path.join(vault.baseDir, key));
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(vault.write(key, cycle));
  await assert.rejects(vault.write(key, { data: 'x'.repeat(MAX_VAULT_BYTES) }));
  assert.deepEqual(await fs.readFile(path.join(vault.baseDir, key)), old);
  const rename = fs.rename;
  fs.rename = async () => { const error = new Error('synthetic disk failure before commit'); error.code = 'EIO'; throw error; };
  try { await assert.rejects(vault.write(key, envelope('host-a', 99)), { code: 'EIO' }); }
  finally { fs.rename = rename; }
  assert.deepEqual(await fs.readFile(path.join(vault.baseDir, key)), old);
  assert.deepEqual(await fs.readdir(path.dirname(path.join(vault.baseDir, key))), ['fleet-manifest.v1.json']);
  await fs.symlink(dir, path.join(vault.baseDir, 'hosts', 'escape'));
  await assert.rejects(vault.write('hosts/escape/fleet-manifest.v1.json', {}), /Unsafe/);
  await fs.symlink(path.join(vault.baseDir, key), path.join(dir, 'linked-root'));
  await assert.rejects(new LocalFsVaultAdapter({ baseDir: path.join(dir, 'linked-root') }).read(key));
  await fs.unlink(path.join(vault.baseDir, key));
  await fs.symlink(path.join(dir, 'outside'), path.join(vault.baseDir, key));
  await assert.rejects(vault.read(key)); await assert.rejects(vault.write(key, {}), /Unsafe/);
  await assert.rejects(fs.stat(path.join(dir, 'outside')), { code: 'ENOENT' });
});

test('concurrent atomic writers expose only complete JSON to readers', async t => {
  const { vault } = await fixture(t), key = 'hosts/host-a/fleet-manifest.v1.json';
  await vault.write(key, envelope('host-a'));
  await Promise.all([...Array.from({ length: 12 }, (_, i) => vault.write(key, envelope('host-a', i + 2))),
    (async () => { for (let i = 0; i < 12; i++) assert.ok(model.isStateBundleEnvelope(await vault.read(key))); })()]);
  assert.ok(model.isStateBundleEnvelope(await vault.read(key)));
  assert.equal((await fs.readdir(path.dirname(path.join(vault.baseDir, key)))).length, 1);
});

test('manifest bounds, LRU retention, stop persistence, reload, monotonic clock despite wall rollback and concurrent stores', async t => {
  const { vault } = await fixture(t);
  let now = at;
  const make = () => new FleetManifestStore({ vault, hostId: 'host-a', maxRigs: 2, maxSeatsPerRig: 2, maxHistory: 2, now: () => now });
  const store = make();
  await store.observeLiveFleet({ rigs: [{ rigId: 'old', seats: ['a', 'b', 'c'] }] });
  now++;
  await store.observeLiveFleet({ rigs: ['fresh'] });
  now++;
  let e = await store.markIntentionalStop('old');
  now++;
  e = await store.observeLiveFleet({ rigs: ['latest'] });
  assert.deepEqual(e.payload.rigs.map(r => r.rigId), ['latest', 'old']);
  assert.equal(e.payload.rigs[1].seats.length, 2);
  e = await store.observeLiveFleet({ rigs: ['old'] });
  assert.equal(e.payload.rigs.find(r => r.rigId === 'old').intentionallyStopped, true);
  now = at - 1000;
  const priorAt = e.updatedAt;
  const a = make(), b = make();
  const results = await Promise.all([a.recordRecoveryAttempt({ status: 'partial' }), b.recordRecoveryAttempt({ status: 'failed' }), a.recordRecoveryAttempt({ status: 'restored' })]);
  assert.deepEqual(results.map(r => r.lamportClock), [e.lamportClock + 1, e.lamportClock + 2, e.lamportClock + 3]);
  const read = await make().read();
  assert.equal(read.updatedAt, priorAt); assert.equal(read.payload.history.length, 2); assert.equal(read.contentSha256, digest(read.payload));
  assert.equal(read.encryption.mode, 'none');
});

test('corrupt/tampered manifest recovery and secret exclusion before serialization', async t => {
  const { vault, store } = await fixture(t);
  await vault.write(store.key, {});
  await fs.writeFile(path.join(vault.baseDir, store.key), '{broken', { mode: 0o600 });
  assert.equal(await store.read(), null); assert.equal(store.lastWarning, 'corrupt_manifest');
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwx';
  let e = await store.observeLiveFleet({ rigs: [{ rigId: 'fleet', name: `API_TOKEN=${secret}`, seats: ['a'], token: secret }] });
  assert.equal(e.lamportClock, 1); assert.doesNotMatch(JSON.stringify(e), new RegExp(secret));
  e = await store.recordRecoveryAttempt({ status: 'partial', apiKey: secret, rigs: [{ target: `API_TOKEN=${secret}`, status: 'failed' }] });
  assert.doesNotMatch(await fs.readFile(path.join(vault.baseDir, store.key), 'utf8'), new RegExp(secret));
  const bad = { ...e, payload: { rigs: [{ rigId: 'tampered' }] } };
  await vault.write(store.key, bad);
  assert.equal(await store.read(), null);
  assert.equal((await store.markIntentionalStop('fleet')).lamportClock, 3);
  const pem = '-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----';
  e = await store.recordRecoveryAttempt({ status: 'failed', rigs: [{ target: pem, status: 'failed' }], password: 'never-store' });
  assert.doesNotMatch(JSON.stringify(e), /synthetic-private-material|never-store/);
  await vault.write('hosts/host-b/fleet-manifest.v1.json', envelope('host-b'));
  await fs.writeFile(path.join(vault.baseDir, 'hosts/host-b/fleet-manifest.v1.json'), 'broken');
  assert.deepEqual((await store.listAllHostManifests()).hosts.map(h => h.hostId), ['host-a']);
});

test('mock second vault port and read-only multi-host merge leave foreign partitions unchanged', async () => {
  const data = new Map();
  const vault = { id: 'mock-vault', capabilities: { read: true, write: true, list: true, encrypted: false },
    async read(key) { return structuredClone(data.get(key) || null); }, async write(key, value) { data.set(key, structuredClone(value)); }, async list() { return [...data.keys()]; }, async health() { return { healthy: true, encrypted: false }; } };
  const a = new FleetManifestStore({ vault, hostId: 'host-a', now: () => at });
  const b = new FleetManifestStore({ vault, hostId: 'host-b', now: () => at });
  await a.observeLiveFleet({ rigs: ['fleet'] }); await b.observeLiveFleet({ rigs: ['fleet'] });
  const before = JSON.stringify(data.get(b.key));
  assert.deepEqual((await a.listAllHostManifests()).rigs.map(r => r.provenance.hostId), ['host-a', 'host-b']);
  await a.markIntentionalStop('fleet');
  assert.equal(JSON.stringify(data.get(b.key)), before);
});

test('LRU follows observation order when wall-clock ticks tie or rewind', async t => {
  const { vault } = await fixture(t);
  let now = at;
  const store = new FleetManifestStore({ vault, hostId: 'host-a', maxRigs: 2, now: () => now });
  await store.observeLiveFleet({ rigs: ['a', 'b'] });
  await store.observeLiveFleet({ rigs: ['b'] });
  now--;
  const result = await store.observeLiveFleet({ rigs: ['z'] });
  assert.deepEqual(result.payload.rigs.map(r => r.rigId), ['z', 'b']);
});
