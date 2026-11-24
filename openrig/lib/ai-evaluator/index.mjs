/**
 * AiEvaluatorService — Public Facade for RigCommander's 3-Tier AI Evaluator.
 * Persists slot bindings cleanly at ~/.config/rig-commander/ai-evaluator.json (mode 0600),
 * masks API keys on all GET responses, discovers live models, and delegates cascade
 * execution to TieredEvaluatorRouter.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EVALUATOR_CONFIG,
  sanitizeEvaluatorConfig,
  isLoopbackEndpoint
} from '../../assets/domain/evaluator-model.js';
import { TieredEvaluatorRouter } from './router.mjs';
import { discoverEndpointModels } from './s2-adapters.mjs';

function defaultConfigPath() {
  const home = process.env.HOME || os.homedir();
  return home ? path.join(home, '.config', 'rig-commander', 'ai-evaluator.json') : null;
}

function maskKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export class AiEvaluatorService {
  constructor(options = {}) {
    this.configFile = options.configFile !== undefined ? options.configFile : defaultConfigPath();
    this.fetchImpl = options.fetchImpl || fetch;
    this.router = new TieredEvaluatorRouter({ fetchImpl: this.fetchImpl });
    this.config = this._loadConfig(options.initialConfig || null);
  }

  _loadConfig(override = null) {
    if (override) {
      return sanitizeEvaluatorConfig(override, DEFAULT_EVALUATOR_CONFIG);
    }
    if (!this.configFile) {
      return sanitizeEvaluatorConfig(DEFAULT_EVALUATOR_CONFIG);
    }
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        return sanitizeEvaluatorConfig(raw, DEFAULT_EVALUATOR_CONFIG);
      }
    } catch {
      // ignore corrupted file and fall back to safe defaults
    }
    return sanitizeEvaluatorConfig(DEFAULT_EVALUATOR_CONFIG);
  }

  _saveConfig() {
    if (!this.configFile) return;
    try {
      const dir = path.dirname(this.configFile);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    } catch {
      // non-fatal on read-only environments
    }
  }

  getPublicConfig() {
    const c = this.config;
    return {
      privacyMode: c.privacyMode,
      autoSystem1Hitl: c.autoSystem1Hitl,
      autoEscalateS2: c.autoEscalateS2,
      maxCallsPerHour: c.maxCallsPerHour,
      maxDailyUsd: c.maxDailyUsd,
      redactPaths: c.redactPaths,
      system1: {
        ...c.system1,
        apiKey: '',
        hasApiKey: Boolean(c.system1.apiKey),
        maskedApiKey: maskKey(c.system1.apiKey),
        isLocal: isLoopbackEndpoint(c.system1.baseUrl)
      },
      system2: {
        ...c.system2,
        apiKey: '',
        hasApiKey: Boolean(c.system2.apiKey),
        maskedApiKey: maskKey(c.system2.apiKey),
        isLocal: isLoopbackEndpoint(c.system2.baseUrl)
      }
    };
  }

  updateConfig(patch) {
    this.config = sanitizeEvaluatorConfig(patch, this.config);
    this._saveConfig();
    this.router.cache.clear();
    return this.getPublicConfig();
  }

  getStatus() {
    return {
      config: this.getPublicConfig(),
      stats: this.router.getUsageStats(),
      verdictsByTarget: this.router.getLatestByTargetMap()
    };
  }

  getTelemetrySummary() {
    return {
      privacyMode: this.config.privacyMode,
      autoSystem1Hitl: this.config.autoSystem1Hitl,
      s1Label: this.config.system1.enabled ? `${this.config.system1.model || this.config.system1.dialect}` : 'off',
      s2Label: this.config.system2.enabled ? `${this.config.system2.model || this.config.system2.dialect}` : 'off',
      stats: this.router.getUsageStats(),
      verdictsByTarget: this.router.getLatestByTargetMap()
    };
  }

  invalidateSeat(seatId) {
    this.router.invalidateSeat(seatId);
  }

  canAutoRunLocalS1() {
    return Boolean(
      this.config.autoSystem1Hitl &&
      this.config.system1.enabled &&
      this.config.system1.dialect !== 'disabled' &&
      isLoopbackEndpoint(this.config.system1.baseUrl)
    );
  }

  async discoverSlotModels(slotRole = 'system1', overrideBinding = null) {
    const existing = slotRole === 'system2' ? this.config.system2 : this.config.system1;
    const binding = overrideBinding
      ? { ...existing, ...overrideBinding, apiKey: (overrideBinding.apiKey && !String(overrideBinding.apiKey).includes('••')) ? overrideBinding.apiKey : existing.apiKey }
      : existing;
    return discoverEndpointModels(binding, {
      privacyMode: this.config.privacyMode,
      fetchImpl: this.fetchImpl
    });
  }

  async runEvaluation(params = {}) {
    return this.router.evaluate({
      ...params,
      config: this.config
    });
  }
}

export { evaluateTier0, evaluateHitlRiskRules, computeHeuristicSignals } from './expert-rules.mjs';
export { stripAnsiAndRedact, wrapUntrustedTelemetry, buildSystem1State, buildSystem2Bundle } from './redactor.mjs';
export { TieredEvaluatorRouter } from './router.mjs';
export { discoverEndpointModels } from './s2-adapters.mjs';
