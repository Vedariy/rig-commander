import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FleetResilienceService } from '../openrig/lib/resilience/index.mjs';
import { OpenRigResilienceProvider } from '../openrig/lib/resilience/openrig-provider.mjs';
import { ActionAuditLog } from '../openrig/lib/action-audit.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resilience-engine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000;
  const calls = [], shifts = [], notifications = [];
  const rigs = Array.from({length: 7}, (_, i) => ({rigId: 'r' + i, running: false}));
  rigs[6].intentionallyStopped = true;
  const provider = {
    id: 'fixture', capabilities: new OpenRigResilienceProvider().capabilities,
    async probe() { calls.push('probe'); return {daemonUp: true, liveRigs: rigs}; },
    async listCheckpoints() { calls.push('list'); return []; },
    async createCheckpoint() { calls.push('snapshot'); return { created: true }; },
    async planRecover({ target }) { return {commandPreview: 'recover ' + target}; },
    async executeRecover() { calls.push('execute'); return {status: 'partial'}; },
    async getReceipt() { return {status: 'unknown'}; }
  };
  const audit = new ActionAuditLog();
  const service = new FleetResilienceService({ providers: [provider], stateDir: dir, now: () => now,
    actionAudit: audit, shiftHistory: { recordOperatorAction: e => shifts.push(e) }, notify: e => notifications.push(e) });
  return { service, provider, calls, audit, shifts, notifications, advance: n => { now += n; } };
}
const request = { providerId: 'fixture', scope: 'rig', target: 'r1' };
const denied = (fn, status) => assert.rejects(fn, err => err.status === status);

test('confirmation binds provider, target, scope, command and issuance before one effect', async t => {
  const { service, provider, calls, shifts, audit, advance } = await fixture(t);
  const gate = service.gate;
  const make = async () => ({ ...request, confirmed: true, planHash: (await gate.createPlan(request)).planHash });
  const valid = await make();
  for (const overrides of [{ confirmed: 1 }, { confirmed: false }, { planHash: null }, { scope: 'seat' },
    { providerId: 'unknown' }, {target: 'r2'}, {target: '--option'}]) {
    await denied(() => gate.executeRecovery({ ...valid, ...overrides }), 400);
  }
  provider.planRecover = async () => ({ commandPreview: 'revised command' });
  await denied(() => gate.executeRecovery(valid), 400);
  const expired = await make();
  advance(300000);
  await denied(() => gate.executeRecovery(expired), 400);
  const fresh = await make();
  assert.notEqual(fresh.planHash, valid.planHash);
  await denied(() => gate.executeRecovery(valid), 400);
  await denied(() => gate.createPlan({...request, target: 'r6'}), 400);
  assert.equal(calls.includes('execute'), false);
  assert.equal(shifts.length, 0);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  provider.executeRecover = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const result = gate.executeRecovery(fresh);
  await started;
  await denied(() => gate.executeRecovery(fresh), 409);
  assert.equal((await service.getStatus()).activeRecoveries.length, 1);
  release({status: 'partial', attemptId: 7});
  assert.equal((await result).status, 'partial');
  await denied(() => gate.executeRecovery(fresh), 400);
  assert.equal((await service.getStatus()).history[0].attemptId, '7');
  assert.equal(audit.list()[0].postconditionStatus, 'partial');
  assert.equal(shifts.length, 1);
  await gate.createCheckpoint(request);
  assert.equal(audit.list()[0].postconditionStatus, 'verified');
  assert.equal(shifts.length, 2);
  provider.capabilities = {...provider.capabilities, unitRecover: false, checkpoints: false};
  await denied(() => gate.createPlan(request), 400);
  await denied(() => gate.createCheckpoint(request), 400);
});

test('status is lazy, coalesces checkpoint probes, bounds concurrency and advises only after wake', async t => {
  const { service, provider, calls, notifications, advance } = await fixture(t);
  let active = 0, max = 0, count = 0;
  provider.listCheckpoints = async () => {
    count++; max = Math.max(max, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return [];
  };
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  const [a,b] = await Promise.all([service.getStatus(), service.getStatus()]);
  assert.deepEqual(a,b); assert.equal(max,3); assert.equal(count,7);
  assert.equal(a.report.offlineRigs.includes('r6'), false);
  assert.equal(a.vault.encrypted,false);
  await service.getStatus(); assert.equal(count,7);
  advance(30000);
  await service.getStatus(); assert.equal(count,14);
  await service.checkWallClockJump(1);
  await service.checkWallClockJump(90001);
  assert.equal(notifications.length,0);
  await service.checkWallClockJump(180002);
  assert.equal(notifications.length,1);
  assert.equal(notifications[0].tier,'rig_down');
  assert.equal(calls.includes('execute') || calls.includes('snapshot'),false);
  for (let i = 0; i < 65; i++) await service.gate.createPlan(request);
  assert.equal(service.gate.plans.size,64);
});

test('native provider uses fixed argv and requires matching rig and attempt evidence', async () => {
  const calls = [];
  let output = '', fail = false;
  const provider = new OpenRigResilienceProvider({ readFleet: async () => {throw Error('offline');},
    execFileFn: async (file, argv, options) => {
      assert.equal(file,'rig'); assert.equal(options.shell,false); assert.ok(options.timeout && options.maxBuffer);
      calls.push(argv);
      if (fail) throw Object.assign(Error('CLI nonzero'), { stdout: output });
      return {stdout: output};
    } });
  output = '{"state":"down"}'; fail = true;
  assert.equal((await provider.probe()).daemonUp,false);
  assert.deepEqual(calls.pop(),['crash-cart','--json']);
  output = '{"state":"unverified","evidence":{"pidState":"dead (pid 41091)","probeResult":"timeout"}}'; fail = false;
  assert.equal((await provider.probe()).daemonUp,false);
  assert.deepEqual(calls.pop(),['crash-cart','--json']);
  fail = false;
  output = 'id1  manual  complete  2026-11-20T01:00:00Z';
  assert.equal((await provider.listCheckpoints('demo'))[0].id,'id1');
  assert.deepEqual(calls.pop(),['snapshot','list','demo']);
  output = 'Snapshot created: id1';
  await provider.createCheckpoint('demo');
  assert.deepEqual(calls.pop(),['snapshot','demo']);
  const seat = { scope: 'seat', target: 'dev-test@demo' };
  output = '{"complete":true,"launchable":true}';
  assert.match((await provider.planRecover(seat)).commandPreview,/--reason "resurrect via deck"/);
  assert.deepEqual(calls.pop(),['seat','launch',seat.target,'--fresh','--stop','--plan','--json']);
  output = '{"ok":true,"status":"launched"}';
  assert.equal((await provider.executeRecover(seat)).status,'unknown');
  assert.deepEqual(calls.pop(),['seat','launch',seat.target,'--fresh','--stop','--reason','resurrect via deck','--json']);
  for (const target of [null, '--all', 'bad/rig']) {
    await assert.rejects(provider.createCheckpoint(target));
  }
  assert.deepEqual(calls,[]);
  output = '{"attemptId":17,"rigId":"demo","ok":true}';
  assert.equal((await provider.executeRecover({scope:'rig',target:'demo'})).status,'unknown');
  assert.deepEqual(calls.pop(),['restore','status','17','--rig','demo','--json']);
  assert.deepEqual(calls.pop(),['start','--rigs','demo','--json']);
  for (const [id, ctx] of [[17,'foreign'],[18,undefined]]) assert.equal((await provider.getReceipt(id,ctx)).status,'unknown');
  assert.deepEqual(calls,[]);
  output = '{"attemptId":17,"rigId":"demo","originalResult":"fully_restored","currentIntendedSetVerdict":"not_attempted"}';
  assert.equal((await provider.getReceipt(17)).status,'unknown');
  assert.deepEqual(calls.pop(),['restore','status','17','--rig','demo','--json']);
  output = '{"attemptId":17,"rigId":"other","currentIntendedSetVerdict":"fully_restored"}';
  assert.equal((await provider.getReceipt(17)).status,'unknown');
  output = '{"attemptId":17,"rigId":"demo","currentIntendedSetVerdict":"fully_restored","currentNodes":[{"logicalId":"one","status":"failed"}]}';
  assert.equal((await provider.getReceipt(17)).status,'partial');
  output = '{"status":"started","restoredRigs":[{"rigName":"demo","status":"partially_restored","nodes":[{"logicalId":"one","status":"failed"}]}]}';
  fail = true;
  const partial = await provider.executeRecover({scope:'fleet'});
  assert.equal(partial.status,'partial'); assert.equal(partial.seats[0].status,'failed');
  assert.deepEqual(calls.pop(),['start','--last','--json']);
});

test('native roster supplies authoritative stop intent and preserves rig-qualified receipt lookup', async t => {
  const { service } = await fixture(t);
  const rows = {
    '/api/rigs/summary': [{ id:'uuid1', name:'blue', lifecycleState:'stopped' }],
    '/api/rigs/uuid1/nodes': [
      {canonicalSessionName:'dev-one@blue', sessionStatus:'stopped', intentionallyStopped:true},
      {canonicalSessionName:'dev-two@blue', sessionStatus:null}
    ]
  };
  const effects = [];
  const native = new OpenRigResilienceProvider({ fetchFn: async url =>
    ({ok:true,json:async () => rows[new URL(url).pathname]}),
    execFileFn: async (file, argv) => {
      effects.push(argv);
      if (argv[0] === 'restore') return {stdout:'{"attemptId":5,"rigId":"uuid1","currentIntendedSetVerdict":"partially_restored"}'};
      return {stdout:'{"attemptId":5,"ok":true}'};
    } });
  service.registry.register(native);
  const r = {providerId:'openrig',scope:'rig',target:'blue'};
  await denied(() => service.gate.createPlan(r),400);
  await denied(() => service.gate.createPlan({...r,scope:'seat',target:'dev-one@blue'}),400);
  const fleet = await service.gate.createPlan({...r,scope:'fleet',target:null});
  assert.deepEqual(fleet.plan.skippedRigs,['blue']);
  assert.deepEqual(fleet.plan.targetRigs,[]);
  assert.deepEqual(effects,[]);
  rows['/api/rigs/uuid1/nodes'][0].intentionallyStopped = false;
  const plan = await service.gate.createPlan(r);
  rows['/api/rigs/uuid1/nodes'][0].intentionallyStopped = true;
  await denied(() => service.gate.executeRecovery({...r,planHash:plan.planHash,confirmed:true}),400);
  assert.deepEqual(effects,[]);
  rows['/api/rigs/uuid1/nodes'][0].intentionallyStopped = false;
  const fresh = await service.gate.createPlan(r);
  const result = await service.gate.executeRecovery({...r,planHash:fresh.planHash,confirmed:true});
  assert.equal(result.status,'partial');
  assert.deepEqual(effects,[['start','--rigs','blue','--json'],['restore','status','5','--rig','uuid1','--json']]);
  assert.equal((await native.getReceipt(5,'blue')).status,'partial');
  assert.equal((await native.getReceipt(5,'other')).status,'unknown');
});

test('native provider treats attention_required, degraded and hasLiveAgents rigs as online (not false rig_down)', async () => {
  const rows = {
    '/api/rigs/summary': [
      { id: 'r1', name: 'pod-hitl', lifecycleState: 'attention_required', restoreLifecycleState: 'attention_required', hasLiveAgents: true },
      { id: 'r2', name: 'pod-partial', lifecycleState: 'running', restoreLifecycleState: 'degraded', hasLiveAgents: true },
      { id: 'r3', name: 'pod-down', lifecycleState: 'recoverable', restoreLifecycleState: 'recoverable', hasLiveAgents: null }
    ],
    '/api/rigs/r1/nodes': [{ canonicalSessionName: 'dev-a@pod-hitl', sessionStatus: 'running', intentionallyStopped: false }],
    '/api/rigs/r2/nodes': [{ canonicalSessionName: 'dev-b@pod-partial', sessionStatus: 'running', intentionallyStopped: false }],
    '/api/rigs/r3/nodes': [{ canonicalSessionName: 'dev-c@pod-down', sessionStatus: null, intentionallyStopped: false }]
  };
  const native = new OpenRigResilienceProvider({ fetchFn: async url => ({ ok: true, json: async () => rows[new URL(url).pathname] }) });
  const probed = await native.probe();
  const byId = Object.fromEntries(probed.liveRigs.map(r => [r.rigId, r.running]));
  assert.deepEqual(byId, { 'pod-hitl': true, 'pod-partial': true, 'pod-down': false });
});

test('telemetry saves a verified local roster for outage reporting without recordings at rest', async t => {
  const {service,provider,calls} = await fixture(t);
  const live = {discoveryMode:'openrig',requestedRig:'all',availableRigs:[{name:'blue',nodeCount:1}],
    nodes:[{canonicalSessionName:'dev-one@blue',intentionallyStopped:true}]};
  await service.observeTelemetry(live);
  const before = await service.store.read();
  await service.observeTelemetry(live);
  assert.equal((await service.store.read()).lamportClock,before.lamportClock);
  provider.probe = async () => ({daemonUp:false});
  const status = await service.getStatus();
  assert.deepEqual(status.report.offlineRigs,[]);
  assert.equal(status.report.rigReports[0].intentionallyStopped,true);
  assert.equal(status.vault.lamportClock,before.lamportClock);
  assert.deepEqual(calls,[]);
});
