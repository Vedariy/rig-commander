import { SAFE_PROVIDER_ID_RE } from '../../assets/domain/resilience-model.js';

export const DEFAULT_PROVIDER_CAPABILITIES = Object.freeze({ daemonProbe: false, checkpoints: false, fleetRecover: false, unitRecover: false, planPreview: false, receiptPolling: false });
const methods = ['probe', 'listCheckpoints', 'createCheckpoint', 'planRecover', 'executeRecover', 'getReceipt'];
export function assertValidProcessProvider(provider) {
  if (typeof provider?.id !== 'string' || !SAFE_PROVIDER_ID_RE.test(provider.id) || !provider.capabilities ||
    Object.keys(DEFAULT_PROVIDER_CAPABILITIES).some(key => typeof provider.capabilities[key] !== 'boolean') ||
    methods.some(key => typeof provider[key] !== 'function')) throw new TypeError('Invalid process recovery provider');
  return provider;
}

export class ProcessProviderRegistry {
  constructor(providers = []) { this.providers = new Map(); for (const provider of providers) this.register(provider); }
  register(provider) {
    assertValidProcessProvider(provider);
    if (this.providers.has(provider.id)) throw new Error('Provider already registered');
    this.providers.set(provider.id, provider);
    return provider;
  }
  unregister(id) { return this.providers.delete(id); }
  get(id) { return this.providers.get(id) || null; }
  list() { return [...this.providers.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  listWithCapabilities() { return this.list().map(p => ({ id: p.id, kind: p.kind || 'process', capabilities: { ...p.capabilities } })); }
  resolveDefault(id) { return id ? this.get(id) : this.get('openrig') || this.list()[0] || null; }
}
