import { createHash, randomUUID } from 'node:crypto';
import { buildResurrectPlanPreview, normalizeRestoreReceipt, validateResilienceTarget } from '../../assets/domain/resilience-model.js';

export class PolicyError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export class RecoveryPolicyGate {
  constructor({ registry, getContext, record, now = Date.now }) {
    Object.assign(this, { registry, getContext, record, now });
    this.plans = new Map();
    this.active = new Map();
  }

  resolve(input, snapshot = false) {
    if (!input || !validateResilienceTarget(input)) throw new PolicyError(400, 'invalid_target');
    const { providerId, scope } = input;
    const request = { providerId, scope, target: scope === 'fleet' ? null : input.target };
    const provider = this.registry.get(providerId);
    const caps = provider?.capabilities;
    const supported = snapshot ? scope === 'rig' && caps?.checkpoints :
      caps?.planPreview && caps[scope === 'fleet' ? 'fleetRecover' : 'unitRecover'];
    if (!supported) throw new PolicyError(400, 'unsupported_operation');
    return { provider, request, key: JSON.stringify([providerId, scope, request.target]) };
  }

  async preview(provider, request) {
    const { report, stoppedSeats = [], unverifiedSkips = [] } = await this.getContext(provider);
    const { scope, target } = request;
    const rig = scope === 'seat' ? target.split('@')[1] : target;
    const stoppedRig = report.rigReports.some(r => r.intentionallyStopped && r.rigId === rig);
    if (scope !== 'fleet' && (stoppedRig || stoppedSeats.includes(target))) throw new PolicyError(400, 'intentionally_stopped');
    const details = await provider.planRecover({ ...request, report, stoppedSeats, unverifiedSkips });
    if (typeof details?.commandPreview !== 'string' || !details.commandPreview.trim() ||
        details.commandPreview.length > 2048 || details.supported === false) throw new PolicyError(400, 'plan_unavailable');
    return buildResurrectPlanPreview({ ...request, report, capabilities: provider.capabilities,
      commandPreview: details.commandPreview, warnings: details.warnings });
  }

  async createPlan(input) {
    const { provider, request, key } = this.resolve(input);
    const plan = await this.preview(provider, request);
    const expires = this.now() + 300000;
    // A new issuance cannot re-enable confirmation of an expired identical command.
    const planHash = createHash('sha256').update(JSON.stringify([key, plan, expires, randomUUID()])).digest('hex');
    this.plans.set(planHash, { provider, key, serialized: JSON.stringify(plan), expires });
    if (this.plans.size > 64) this.plans.delete(this.plans.keys().next().value);
    return { plan, planHash, expiresAt: new Date(expires).toISOString() };
  }

  async executeRecovery(input) {
    const { provider, request, key } = this.resolve(input);
    if (input.confirmed !== true) throw new PolicyError(400, 'plan_required_or_expired');
    if (this.active.has(key)) throw new PolicyError(409, 'in_progress');
    const cached = this.plans.get(input.planHash);
    if (!cached || cached.key !== key || cached.provider !== provider || cached.expires <= this.now()) {
      throw new PolicyError(400, 'plan_required_or_expired');
    }
    // A confirmed attempt consumes its issuance even if revalidation no longer agrees.
    this.plans.delete(input.planHash);
    this.active.set(key, request);
    try {
      const plan = await this.preview(provider, request);
      if (JSON.stringify(plan) !== cached.serialized || cached.expires <= this.now() ||
          this.registry.get(provider.id) !== provider) {
        throw new PolicyError(400, 'plan_required_or_expired');
      }
      let receipt;
      try { receipt = normalizeRestoreReceipt(await provider.executeRecover({ ...request, plan })); }
      catch { receipt = normalizeRestoreReceipt({ status: 'unknown' }); }
      await this.record('resurrect', request, receipt);
      return receipt;
    } finally { this.active.delete(key); }
  }

  async createCheckpoint(input) {
    const { provider, request, key } = this.resolve(input, true);
    if (this.active.has(key)) throw new PolicyError(409, 'in_progress');
    this.active.set(key, request);
    try {
      let created = false;
      try { created = (await provider.createCheckpoint(request.target))?.created === true; } catch {}
      await this.record('snapshot', request, { status: created ? 'created' : 'unknown' });
      if (!created) throw new PolicyError(502, 'checkpoint_unconfirmed');
      return { providerId: provider.id, target: request.target, created };
    } finally { this.active.delete(key); }
  }
}
