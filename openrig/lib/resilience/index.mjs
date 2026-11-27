import { classifyFleetResilience, detectSleepWakeJump, SAFE_RIG_NAME_RE } from '../../assets/domain/resilience-model.js';
import { ActionAuditLog } from '../action-audit.mjs';
import { ShiftHistoryStore } from '../shift-history.mjs';
import { FleetManifestStore } from './manifest-store.mjs';
import { LocalFsVaultAdapter } from './vault-interface.mjs';
import { ProcessProviderRegistry } from './provider-interface.mjs';
import { OpenRigResilienceProvider } from './openrig-provider.mjs';
import { RecoveryPolicyGate } from './policy-gate.mjs';
import { HygienePolicyGate } from './hygiene-gate.mjs';
import { ControlPlaneProbe, resolveDefaultOpenrigHome } from '../control-plane-probe.mjs';

export class FleetResilienceService {
  constructor({ providers = [new OpenRigResilienceProvider()], vault, stateDir, store, now = Date.now,
    actionAudit = new ActionAuditLog(), shiftHistory = new ShiftHistoryStore(), notify = () => {},
    openrigHome = resolveDefaultOpenrigHome(), rigBin, readOnly = false, execCommand,
    controlPlaneProbe = new ControlPlaneProbe(), getHygieneState = null } = {}) {
    this.registry = new ProcessProviderRegistry(providers);
    this.store = store || new FleetManifestStore({ vault: vault || new LocalFsVaultAdapter({ baseDir: stateDir }), now });
    this.now = now;
    this.notify = notify;
    this.checkpoints = new Map();
    this.lastTick = null;
    this.lastWakeAdvisory = null;
    this.lastHygieneSnapshot = null;
    this.controlPlaneProbe = controlPlaneProbe;
    this.gate = new RecoveryPolicyGate({ registry: this.registry, now, getContext: provider => this.context(provider),
      record: async (operation, request, receipt) => {
        const success = ['created', 'restored'].includes(receipt.status);
        const failed = receipt.status === 'failed' || (operation === 'snapshot' && !success);
        const entry = actionAudit.record({ actionId: 'resilience_' + operation, type: 'resilience',
          seatId: request.target || 'fleet', payload: request.providerId + ' ' + receipt.status,
          httpStatus: failed ? 502 : 200, ok: !failed, nowMs: now() });
        // Do not let unrelated future seat activity verify this provider's result.
        entry.postconditionStatus = success ? 'verified' : receipt.status;
        entry.postconditionDetail = receipt.status;
        shiftHistory.recordOperatorAction(entry);
        if (operation === 'resurrect') {
          try { await this.store.recordRecoveryAttempt(receipt); }
          catch { receipt.historyWarning = 'history_write_failed'; }
        } else this.checkpoints.delete(JSON.stringify([request.providerId, request.target]));
      } });

    const defaultProvider = this.registry.resolveDefault();
    const resolvedRigBin = rigBin || defaultProvider?.rigBin || 'rig';
    const defaultExec = execCommand || (defaultProvider?.execFileFn
      ? (file, argv, opts) => defaultProvider.execFileFn(file, argv, { timeout: 15_000, maxBuffer: 5 * 1024 * 1024, ...opts, shell: false })
      : undefined);

    this.hygieneGate = new HygienePolicyGate({
      now,
      openrigHome,
      rigBin: resolvedRigBin,
      readOnly,
      probe: this.controlPlaneProbe,
      ...(defaultExec ? { execCommand: defaultExec } : {}),
      getState: getHygieneState || (async ({ fresh } = {}) => {
        if (!fresh && this.lastHygieneSnapshot) return this.lastHygieneSnapshot;
        const provider = this.registry.resolveDefault();
        let nodes = this.lastHygieneSnapshot?.nodes || [];
        let activeQueue = this.lastHygieneSnapshot?.activeQueue || [];
        if (fresh || !this.lastHygieneSnapshot) {
          if (provider?.capabilities?.daemonProbe) {
            try {
              const seen = await provider.probe();
              if (Array.isArray(seen?.liveNodes) && seen.liveNodes.length > 0) nodes = seen.liveNodes;
            } catch {}
          }
          if (typeof this.hygieneGate?.execCommand === 'function') {
            try {
              const { stdout } = await this.hygieneGate.execCommand(resolvedRigBin, ['queue', 'list', '-A', '--json'], { shell: false, timeout: 10_000 });
              const parsed = JSON.parse(stdout);
              if (Array.isArray(parsed)) activeQueue = parsed;
            } catch {}
          }
        }
        return {
          activeQueue,
          nodes,
          healthz: this.lastHygieneSnapshot?.controlPlane?.healthz || null,
          controlPlane: fresh ? null : (this.lastHygieneSnapshot?.controlPlane || null)
        };
      }),
      record: async (operation, request, receipt) => {
        const success = receipt.status === 'cleaned';
        const failed = receipt.status === 'failed';
        const targetLabel = request.scope === 'rig' ? `rig:${request.targetRig}` : 'fleet';
        const entry = actionAudit.record({
          actionId: `resilience_${operation}`,
          type: 'resilience',
          seatId: targetLabel,
          payload: `hygiene ${receipt.status} cleaned=${receipt.cleanedCount} remaining=${receipt.after?.remainingStaleQueueCount ?? 'unknown'}`,
          httpStatus: failed ? 502 : 200,
          ok: !failed,
          nowMs: now()
        });
        entry.postconditionStatus = success ? 'verified' : receipt.status;
        entry.postconditionDetail = receipt.status;
        shiftHistory.recordOperatorAction(entry);
      }
    });
  }

  async context(provider, envelope = undefined) {
    if (envelope === undefined) envelope = await this.store.read();
    if (!envelope && this.store.lastWarning) throw new Error('manifest_unavailable');
    const seen = provider.capabilities.daemonProbe ? await provider.probe() : {};
    // The local manifest tracks the default process provider only.
    const manifestRigs = this.registry.resolveDefault() === provider ? envelope?.payload?.rigs || [] : [];
    const input = { ...seen, manifestRigs, nowMs: this.now() };
    const stoppedSeats = [...manifestRigs.flatMap(r => r.seats || []), ...(seen.liveNodes || [])]
      .filter(s => s.intentionallyStopped).map(s => s.seatId || s.canonicalSessionName);
    const report = classifyFleetResilience(input);
    const unverifiedSkips = report.rigReports.filter(r => r.intentionallyStopped &&
      !seen.liveRigs?.some(live => live.rigId === r.rigId && live.intentionallyStopped)).map(r => r.rigId);
    return { input, report, stoppedSeats, unverifiedSkips };
  }

  async providerStatus(provider, envelope, refresh) {
    const { input, report } = await this.context(provider, envelope);
    const snapshotsByRig = Object.create(null);
    const rigs = report.rigReports.slice(0, 64);
    let next = 0;
    const poll = async () => {
      while (next < rigs.length) {
        const { rigId } = rigs[next++];
        const key = JSON.stringify([provider.id, rigId]);
        let cached = this.checkpoints.get(key);
        if (refresh || !cached || cached.until <= this.now()) {
          let rows = [];
          try { rows = await provider.listCheckpoints(rigId); } catch {}
          cached = { until: this.now() + 30000, rows: Array.isArray(rows) ? rows.slice(0, 64) : [] };
          this.checkpoints.delete(key);
          this.checkpoints.set(key, cached);
          if (this.checkpoints.size > 256) this.checkpoints.delete(this.checkpoints.keys().next().value);
        }
        snapshotsByRig[rigId] = cached.rows;
      }
    };
    if (provider.capabilities.checkpoints && input.daemonUp !== false) {
      await Promise.all(Array.from({ length: Math.min(3, rigs.length) }, poll));
    } else {
      for (const {rigId} of rigs) snapshotsByRig[rigId] = this.checkpoints.get(JSON.stringify([provider.id, rigId]))?.rows || [];
    }
    const finalReport = classifyFleetResilience({ ...input, snapshotsByRig });
    if (provider.commandPreview && provider.capabilities.unitRecover) {
      for (const rig of finalReport.rigReports) {
        rig.commandPreview = provider.commandPreview({ scope: 'rig', target: rig.rigId });
      }
    }
    return { id: provider.id, kind: provider.kind || 'process', capabilities: { ...provider.capabilities },
      report: finalReport, commandPreview: provider.capabilities.fleetRecover ? provider.commandPreview?.({ scope: 'fleet' }) : undefined };
  }

  getStatus({ refresh = false } = {}) {
    if (!this.loading) this.loading = this.loadStatus(refresh).finally(() => { this.loading = null; });
    return this.loading;
  }

  async loadStatus(refresh) {
    const envelope = await this.store.read();
    const providers = [];
    for (const provider of this.registry.list()) {
      try { providers.push(await this.providerStatus(provider, envelope, refresh)); }
      catch {
        providers.push({ id: provider.id, kind: provider.kind || 'process', capabilities: { ...provider.capabilities },
          report: null, error: 'provider_unavailable' });
      }
    }
    const report = providers.find(p => p.id === this.registry.resolveDefault()?.id)?.report || null;
    return { providers, report, vault: { adapterId: this.store.vault.id, encrypted: this.store.vault.capabilities.encrypted,
      hostId: this.store.hostId, lastUpdatedAt: envelope?.updatedAt || null, lamportClock: envelope?.lamportClock || 0 },
      activeRecoveries: [...this.gate.active.values()], history: envelope?.payload.history || [], lastWakeAdvisory: this.lastWakeAdvisory };
  }

  async checkWallClockJump(nowMs = this.now()) {
    const { jumped } = detectSleepWakeJump(this.lastTick, nowMs);
    this.lastTick = nowMs;
    if (!jumped) return;
    const { providers } = await this.getStatus({ refresh: true });
    const down = providers.find(p => ['rig_down', 'daemon_down'].includes(p.report?.tier));
    if (!down) return;
    this.lastWakeAdvisory = { kind: 'resilience_wake', at: new Date(nowMs).toISOString(), tier: down.report.tier };
    await this.notify(this.lastWakeAdvisory);
  }

  async observeTelemetry(snapshot) {
    if (snapshot && typeof snapshot === 'object') {
      this.lastHygieneSnapshot = {
        nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
        activeQueue: Array.isArray(snapshot.activeQueue) ? snapshot.activeQueue : [],
        controlPlane: snapshot.controlPlane || null
      };
    }
    if (snapshot.discoveryMode !== 'openrig' || snapshot.requestedRig !== 'all') return;
    const nodes = snapshot.nodes.map(n => ({ ...n, rigId: n.rigName || n.canonicalSessionName?.split('@')[1] }));
    const rigs = snapshot.availableRigs.filter(r => typeof r.name === 'string' && SAFE_RIG_NAME_RE.test(r.name))
      .map(r => {
        const seats = nodes.filter(n => n.rigId === r.name);
        return { rigId: r.name, seats, intentionallyStopped: !!seats.length &&
          seats.length === r.nodeCount && seats.every(s => s.intentionallyStopped === true) };
      }).filter(r => r.seats.length);
    if (!rigs.length) return;
    const signature = JSON.stringify(rigs.map(r => [r.rigId, r.seats.map(s => [s.canonicalSessionName, !!s.intentionallyStopped])]));
    if (signature === this.observed) return;
    await this.store.observeLiveFleet({ rigs });
    this.observed = signature;
  }
}
