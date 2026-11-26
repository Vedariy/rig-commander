import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PolicyError } from './policy-gate.mjs';
import {
  normalizeRestoreReceipt, parseSnapshotTable, SAFE_ATTEMPT_ID_RE, SAFE_RIG_NAME_RE,
  validateResilienceTarget
} from '../../assets/domain/resilience-model.js';

const runFile = promisify(execFile);
const LIVE_RIG_STATES = new Set(['running', 'attention_required', 'degraded', 'partial']);
const unknown = attemptId => normalizeRestoreReceipt({ attemptId });
function argsFor({ scope, target }) {
  if (!validateResilienceTarget({ providerId: 'openrig', scope, target })) throw new Error('invalid_target');
  if (scope === 'seat') return ['seat', 'launch', target, '--fresh', '--stop', '--reason', 'resurrect via deck', '--json'];
  return scope === 'fleet' ? ['start', '--last', '--json'] : ['start', '--rigs', target, '--json'];
}

export class OpenRigResilienceProvider {
  id = 'openrig';
  kind = 'process';
  capabilities = Object.freeze({ daemonProbe: true, checkpoints: true, fleetRecover: true,
    unitRecover: true, planPreview: true, receiptPolling: true });

  constructor({ execFileFn = runFile, rigBin = 'rig', readFleet, daemonUrl = 'http://127.0.0.1:7437',
    fetchFn = fetch } = {}) {
    this.execFileFn = execFileFn;
    this.rigBin = rigBin;
    this.attemptRigs = new Map();
    this.rigIds = new Map();
    this.readFleet = readFleet || (async () => {
      const read = async path => {
        const res = await fetchFn(daemonUrl + path, { signal: AbortSignal.timeout(3500) });
        if (!res.ok) throw new Error('daemon_unavailable');
        const rows = await res.json();
        if (!Array.isArray(rows)) throw new Error('invalid_fleet_response');
        return rows;
      };
      const summary = await read('/api/rigs/summary');
      const rigs = summary.filter(r => typeof r?.id === 'string' && SAFE_RIG_NAME_RE.test(r.id) &&
        typeof r.name === 'string' && SAFE_RIG_NAME_RE.test(r.name));
      this.rigIds = new Map(rigs.map(r => [r.name, r.id]));
      const liveRigs = [], liveNodes = [];
      let cursor = 0;
      const readNodes = async () => {
        while (cursor < rigs.length) {
          const rig = rigs[cursor++];
          const nodes = await read('/api/rigs/' + encodeURIComponent(rig.id) + '/nodes');
          const launched = nodes.filter(n => n.sessionStatus != null);
          const intentionallyStopped = rig.intentionallyStopped === true || (launched.length > 0 &&
            launched.every(n => n.intentionallyStopped === true));
          liveRigs.push({ rigId: rig.name, intentionallyStopped,
            running: rig.hasLiveAgents === true || LIVE_RIG_STATES.has(rig.lifecycleState) || LIVE_RIG_STATES.has(rig.restoreLifecycleState) });
          for (const node of nodes) liveNodes.push({ ...node, rigName: rig.name });
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, rigs.length) }, readNodes));
      return { liveRigs, liveNodes };
    });
  }

  run(argv, timeout = 10000) {
    return this.execFileFn(this.rigBin, argv, { timeout, maxBuffer: 1024 * 1024, shell: false });
  }

  async probe() {
    try { return { ...await this.readFleet(), daemonUp: true }; }
    catch {
      let stdout;
      try { ({ stdout } = await this.run(['crash-cart', '--json'])); }
      catch (error) { stdout = error.stdout; } // A daemon-down verdict exits 1.
      let verdict;
      try { verdict = JSON.parse(stdout); } catch {}
      if (verdict?.state !== 'down') throw new Error('fleet_probe_unavailable');
      const found = verdict.discovery?.foundOnHost;
      const liveRigs = Array.isArray(found) ? found.slice(0, 64)
        .filter(r => typeof r?.rigName === 'string' && SAFE_RIG_NAME_RE.test(r.rigName))
        .map(r => ({ rigId: r.rigName, running: false })) : [];
      return { daemonUp: false, crashCart: { state: 'down' }, liveRigs };
    }
  }

  async listCheckpoints(target) {
    argsFor({ scope: 'rig', target });
    return parseSnapshotTable((await this.run(['snapshot', 'list', target])).stdout);
  }

  async createCheckpoint(target) {
    argsFor({ scope: 'rig', target });
    const { stdout } = await this.run(['snapshot', target]);
    if (!/^Snapshot created: \S+/m.test(stdout)) throw new Error('checkpoint_unconfirmed');
    return { created: true };
  }

  commandPreview(request) {
    return ['rig', ...argsFor(request)].map(arg => arg.includes(' ') ? JSON.stringify(arg) : arg).join(' ');
  }

  async planRecover(request) {
    const commandPreview = this.commandPreview(request);
    // --last has no per-rig exclusion argument. A stop known only to the vault
    // cannot be guaranteed by the CLI; individually scoped recovery remains available.
    if (request.scope === 'fleet' && request.unverifiedSkips?.length) throw new PolicyError(400, 'unverified_stop_exclusion');
    if (request.scope === 'rig' && request.report && !request.report.rigReports.some(r => r.rigId === request.target)) {
      throw new PolicyError(400, 'unknown_rig');
    }
    if (request.scope === 'seat') {
      const { stdout } = await this.run(['seat', 'launch', request.target, '--fresh', '--stop', '--plan', '--json']);
      const plan = JSON.parse(stdout);
      if (plan.launchable !== true || plan.complete !== true || plan.blockers?.length) throw new PolicyError(400, 'seat_unavailable');
      if (request.stoppedSeats?.includes(plan.sessionName) || request.report?.rigReports.some(r =>
        r.intentionallyStopped && r.rigId === plan.sessionName?.split('@')[1])) throw new PolicyError(400, 'intentionally_stopped');
    }
    return { commandPreview };
  }

  async executeRecover(request) {
    const argv = argsFor(request);
    let stdout, failed = false;
    try { ({ stdout } = await this.run(argv, 180000)); }
    catch (error) {
      if (error.killed || error.signal) return unknown(null);
      stdout = error.stdout;
      failed = true;
    }
    let raw;
    try { raw = JSON.parse(stdout); }
    catch { return normalizeRestoreReceipt({ status: failed ? 'failed' : 'unknown' }); }
    if (Array.isArray(raw?.restoredRigs)) {
      const rigs = [], seats = [];
      for (const row of raw.restoredRigs.slice(0, 64)) {
        const receipt = normalizeRestoreReceipt({ rigResult: row.status, currentNodes: row.nodes });
        const status = ['error', 'pre_restore_validation_failed'].includes(row.status) ? 'failed' : receipt.status;
        rigs.push({ target: row.rigName, status });
        seats.push(...receipt.seats);
      }
      const all = status => rigs.length > 0 && rigs.every(row => row.status === status);
      let status = 'unknown';
      if (request.scope === 'rig' && rigs.some(r => r.target !== request.target)) return unknown(null);
      if (all('failed')) status = 'failed';
      else if (all('restored') && !failed && !raw.previewErrors?.length && !raw.kernelRestore) status = 'restored';
      else if (rigs.some(row => ['partial', 'restored'].includes(row.status))) status = 'partial';
      return normalizeRestoreReceipt({ status, rigs, seats });
    }
    const requestedRig = request.scope === 'rig' ? request.target : request.target?.split('@')[1];
    const expectedRig = this.rigIds.get(requestedRig) || requestedRig;
    const rig = raw?.rigId || raw?.rigName || expectedRig;
    if (expectedRig && rig !== expectedRig && rig !== requestedRig) return unknown(null);
    // Only a native derived verdict or an explicit failure constitutes evidence here.
    const receipt = normalizeRestoreReceipt({ attemptId: raw?.attemptId, currentNodes: raw?.currentNodes,
      currentIntendedSetVerdict: raw?.currentIntendedSetVerdict, rigResult: raw?.rigResult,
      status: raw?.ok === false ? 'failed' : undefined });
    if (receipt.attemptId && typeof rig === 'string' && SAFE_RIG_NAME_RE.test(rig)) {
      const key = receipt.attemptId;
      // A collision across rigs makes an unqualified lookup ambiguous.
      if (this.attemptRigs.has(key) && this.attemptRigs.get(key) !== rig) this.attemptRigs.set(key, null);
      else this.attemptRigs.set(key, rig);
      if (this.attemptRigs.size > 64) this.attemptRigs.delete(this.attemptRigs.keys().next().value);
    }
    if (failed && receipt.status === 'unknown' && raw?.ok === false) receipt.status = 'failed';
    if (receipt.attemptId && rig && receipt.status === 'unknown') {
      return this.getReceipt(receipt.attemptId, rig);
    }
    return receipt;
  }

  async getReceipt(attemptId, rigContext) {
    const id = Number.isSafeInteger(attemptId) && attemptId >= 0 ? String(attemptId) : attemptId;
    if (typeof id !== 'string' || !SAFE_ATTEMPT_ID_RE.test(id)) return unknown(null);
    const known = this.attemptRigs.get(id);
    const rig = this.rigIds.get(rigContext) || rigContext || known;
    if (typeof rig !== 'string' || !SAFE_RIG_NAME_RE.test(rig) || (known && rig !== known)) return unknown(id);
    try {
      const { stdout } = await this.run(['restore', 'status', id, '--rig', rig, '--json']);
      const raw = JSON.parse(stdout);
      if (String(raw.attemptId) !== id || (raw.rigId !== rig && raw.rigName !== rig)) return unknown(id);
      return normalizeRestoreReceipt(raw);
    } catch { return unknown(id); }
  }
}
