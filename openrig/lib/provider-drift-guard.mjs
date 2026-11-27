/**
 * Two-Contour Provider Version & Schema Drift Guard (ADR-I12).
 *
 * Contour A (Runtime Guard):
 * - Strictly local: 0 outbound network requests, 0% idle CPU (no polling loops).
 * - Caches local CLI `--version` probes keyed by binary path + mtimeMs/size.
 * - Versions outside `testedVersionRange` produce a soft `unverified_version` status badge
 *   (NEVER a P0 alarm).
 * - Validates parsed JSONL / swarm / OpenRig payloads against `provider-contracts.json`:
 *   when required keys fail to parse on an active file/process, affected metrics are
 *   explicitly marked `'unknown (schema_drift)'` (never fabricated `0` or false `'idle'`)
 *   and emit a single `P1 PROVIDER_SCHEMA_DRIFT` finding with a redacted key-and-type
 *   structural skeleton (ZERO raw values, secrets, or OS paths).
 *
 * Contour B (Dev-Time Spec Verification):
 * - Shared helpers used by `scripts/verify-providers.mjs` to check `--version`, `--help`
 *   required flags/subcommands, and contract samples cleanly.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseSemver, compareSemver } from '../assets/domain/semver.js';
import { stripAnsiAndRedact } from './ai-evaluator/redactor.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_CONTRACTS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'provider-contracts.json');

export const SCHEMA_DRIFT_UNKNOWN = 'unknown (schema_drift)';
export const PROVIDER_SCHEMA_DRIFT_CODE = 'PROVIDER_SCHEMA_DRIFT';

let cachedDefaultContracts = null;

export function loadProviderContracts(contractsPath = DEFAULT_CONTRACTS_PATH) {
  if (contractsPath === DEFAULT_CONTRACTS_PATH && cachedDefaultContracts) {
    return cachedDefaultContracts;
  }
  const raw = fs.readFileSync(contractsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (contractsPath === DEFAULT_CONTRACTS_PATH) {
    cachedDefaultContracts = parsed;
  }
  return parsed;
}

/**
 * Evaluates a SemVer string against a compact range expression
 * supporting `>=`, `<=`, `>`, `<`, `=`, `^`, `~`, space-AND, and `||`-OR.
 */
export function satisfiesVersionRange(versionStr, rangeStr) {
  const v = parseSemver(versionStr);
  if (!v) return false;
  const rawRange = String(rangeStr || '').trim();
  if (!rawRange || rawRange === '*') return true;

  const orClauses = rawRange.split(/\s*\|\|\s*/).filter(Boolean);
  for (const clause of orClauses) {
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    let allOk = true;
    for (const tok of tokens) {
      if (tok.startsWith('^')) {
        const base = parseSemver(tok.slice(1));
        if (!base) { allOk = false; break; }
        const upper = base.major > 0
          ? `${base.major + 1}.0.0`
          : (base.minor > 0 ? `0.${base.minor + 1}.0` : `0.0.${base.patch + 1}`);
        if (compareSemver(v, base) < 0 || compareSemver(v, upper) >= 0) {
          allOk = false; break;
        }
        continue;
      }
      if (tok.startsWith('~')) {
        const base = parseSemver(tok.slice(1));
        if (!base) { allOk = false; break; }
        const upper = `${base.major}.${base.minor + 1}.0`;
        if (compareSemver(v, base) < 0 || compareSemver(v, upper) >= 0) {
          allOk = false; break;
        }
        continue;
      }
      const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(tok);
      if (!m) { allOk = false; break; }
      const op = m[1] || '=';
      const target = parseSemver(m[2]);
      if (!target) { allOk = false; break; }
      const cmp = compareSemver(v, target);
      if (cmp === null) { allOk = false; break; }
      if (op === '>=' && cmp < 0) { allOk = false; break; }
      if (op === '<=' && cmp > 0) { allOk = false; break; }
      if (op === '>' && cmp <= 0) { allOk = false; break; }
      if (op === '<' && cmp >= 0) { allOk = false; break; }
      if (op === '=' && cmp !== 0) { allOk = false; break; }
    }
    if (allOk) return true;
  }
  return false;
}

/**
 * Produces a strictly redacted key-and-type structural skeleton of an arbitrary value.
 * ZERO scalar values, ZERO secrets, ZERO OS user paths are ever included.
 */
export function buildRedactedSkeleton(value, { maxDepth = 4, maxKeys = 24, _depth = 0 } = {}) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    if (_depth >= maxDepth) return 'array';
    if (value.length === 0) return [];
    return [buildRedactedSkeleton(value[0], { maxDepth, maxKeys, _depth: _depth + 1 })];
  }
  const t = typeof value;
  if (t !== 'object') return t;
  if (_depth >= maxDepth) return 'object';

  const out = {};
  const entries = Object.entries(value).slice(0, maxKeys);
  for (const [rawKey, val] of entries) {
    const safeKey = stripAnsiAndRedact(String(rawKey), { redactPaths: true }).text.slice(0, 80);
    out[safeKey] = buildRedactedSkeleton(val, { maxDepth, maxKeys, _depth: _depth + 1 });
  }
  if (Object.keys(value).length > maxKeys) {
    out['...truncatedKeys'] = 'number';
  }
  return out;
}

function getValueType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function resolvePathOption(rootObj, dotPath) {
  const parts = String(dotPath || '').split('.').filter(Boolean);
  let cur = rootObj;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) {
      return { found: false, value: undefined };
    }
    cur = cur[part];
  }
  return { found: cur !== undefined, value: cur };
}

function resolveContractField(rootObj, expr) {
  const alternatives = String(expr || '').split('|').map(s => s.trim()).filter(Boolean);
  for (const alt of alternatives) {
    const res = resolvePathOption(rootObj, alt);
    if (res.found) return { found: true, matchedKey: alt, value: res.value };
  }
  return { found: false, matchedKey: null, value: undefined };
}

/**
 * Validates a parsed telemetry / JSONL / swarm object against a single contract spec.
 */
export function validateContractShape(payload, contractSpec = {}) {
  const skeleton = buildRedactedSkeleton(payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      missingKeys: Array.isArray(contractSpec.required) ? [...contractSpec.required] : ['<root-object>'],
      typeMismatches: [{ key: '<root>', expected: 'object', actual: getValueType(payload) }],
      skeleton
    };
  }

  const required = Array.isArray(contractSpec.required) ? contractSpec.required : [];
  const types = contractSpec.types && typeof contractSpec.types === 'object' ? contractSpec.types : {};
  const missingKeys = [];
  const typeMismatches = [];

  for (const expr of required) {
    const res = resolveContractField(payload, expr);
    if (!res.found) {
      missingKeys.push(expr);
    }
  }

  for (const [expr, expectedSpec] of Object.entries(types)) {
    const res = resolveContractField(payload, expr);
    if (!res.found) continue;
    const allowed = String(expectedSpec).split('|').map(s => s.trim()).filter(Boolean);
    const actualType = getValueType(res.value);
    if (allowed.length > 0 && !allowed.includes(actualType)) {
      typeMismatches.push({
        key: expr,
        expected: allowed.join('|'),
        actual: actualType
      });
    }
  }

  return {
    ok: missingKeys.length === 0 && typeMismatches.length === 0,
    missingKeys,
    typeMismatches,
    skeleton
  };
}

/**
 * Applies explicit `'unknown (schema_drift)'` markers to affected metrics so
 * callers NEVER fabricate `0` tokens or false `'idle'` states on schema drift.
 */
export function applySchemaDriftFallback(metrics = {}, fields = []) {
  const base = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? { ...metrics } : {};
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field) continue;
    base[field] = SCHEMA_DRIFT_UNKNOWN;
  }
  base.schemaDrift = true;
  return base;
}

/**
 * Builds a canonical `P1 PROVIDER_SCHEMA_DRIFT` finding compatible with FleetIntelligenceEngine.
 */
export function buildSchemaDriftFinding({
  providerId,
  binaryVersion = 'unknown',
  testedVersionRange = '',
  contractName = '',
  missingKeys = [],
  typeMismatches = [],
  skeleton = {},
  affectedSeats = [],
  detectedAt = new Date().toISOString()
} = {}) {
  const cleanProvider = String(providerId || 'unknown').trim();
  const cleanVersion = String(binaryVersion || 'unknown').trim();
  const missingList = Array.isArray(missingKeys) ? missingKeys : [];
  const mismatchList = Array.isArray(typeMismatches) ? typeMismatches : [];
  const seats = Array.isArray(affectedSeats) ? affectedSeats.filter(Boolean) : [];
  const details = [
    ...(missingList.length ? [`missing: ${missingList.join(', ')}`] : []),
    ...(mismatchList.length ? [`type mismatch: ${mismatchList.map(m => `${m.key} (${m.actual} != ${m.expected})`).join(', ')}`] : [])
  ].join('; ') || 'contract mismatch';

  return {
    id: `provider-schema-drift-${cleanProvider}-${contractName || 'shape'}`,
    detectorId: 'provider.schema_drift',
    code: PROVIDER_SCHEMA_DRIFT_CODE,
    category: 'resilience',
    severity: 'p1_high',
    confidence: 0.95,
    shortTitle: `${cleanProvider}: schema drift`,
    title: `⚠️ PROVIDER_SCHEMA_DRIFT: ${cleanProvider} (${cleanVersion}) [${contractName || 'contract'}]`,
    summary: `Provider ${cleanProvider} (${cleanVersion}, tested ${testedVersionRange || '*'}) failed ${contractName || 'schema'} contract (${details}). Affected metrics marked '${SCHEMA_DRIFT_UNKNOWN}'.`,
    remediation: `Run 'node scripts/verify-providers.mjs --json' to inspect the schema diff and update provider-contracts.json + adapter.`,
    metrics: {
      riskScore: 78,
      providerId: cleanProvider,
      binaryVersion: cleanVersion,
      testedVersionRange,
      contractName,
      missingKeys: missingList,
      typeMismatches: mismatchList,
      skeleton,
      affectedSeats: seats,
      affectedSlices: []
    },
    detectedAt
  };
}

async function defaultWhich(binName) {
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, binName);
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue searching PATH
    }
  }
  return null;
}

async function defaultStat(filePath) {
  try {
    return await fsp.stat(filePath, { bigint: true });
  } catch {
    return null;
  }
}

async function defaultExecFile(bin, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs || 4000,
      maxBuffer: opts.maxBuffer || 512 * 1024
    });
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      code: typeof err?.code === 'number' ? err.code : 1,
      errnoCode: typeof err?.code === 'string' ? err.code : null,
      stdout: err?.stdout || '',
      stderr: err?.stderr || '',
      error: err?.message || 'exec failed'
    };
  }
}

export class ProviderDriftGuard {
  constructor(options = {}) {
    this.contracts = options.contracts || loadProviderContracts(options.contractsPath || DEFAULT_CONTRACTS_PATH);
    this.execFileFn = typeof options.execFileFn === 'function' ? options.execFileFn : defaultExecFile;
    this.statFn = typeof options.statFn === 'function' ? options.statFn : defaultStat;
    this.whichFn = typeof options.whichFn === 'function' ? options.whichFn : defaultWhich;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.versionCache = new Map(); // providerId -> { binaryPath, mtimeNs, mtimeMs, size, result }
    this.activeFindings = new Map(); // findingId -> finding
  }

  getProviderContract(providerId) {
    return this.contracts?.providers?.[providerId] || null;
  }

  async probeProviderVersion(providerId, { forceRefresh = false } = {}) {
    const spec = this.getProviderContract(providerId);
    if (!spec) {
      return {
        providerId,
        status: 'unknown_provider',
        badge: 'unknown_provider',
        version: null,
        testedVersionRange: null,
        cached: false
      };
    }

    const binName = spec.binary || providerId;
    const resolvedPath = await this.whichFn(binName);
    if (!resolvedPath) {
      const missingRes = {
        providerId,
        binary: binName,
        binaryPath: null,
        status: 'not_installed',
        badge: 'not_installed',
        version: null,
        testedVersionRange: spec.testedVersionRange || '*',
        probedAt: new Date(this.now()).toISOString(),
        cached: false
      };
      this.versionCache.set(providerId, { binaryPath: null, mtimeNs: null, mtimeMs: null, size: null, result: missingRes });
      return missingRes;
    }

    const st = await this.statFn(resolvedPath);
    const mtimeNs = st?.mtimeNs ?? null;
    const mtimeMs = st?.mtimeMs ?? null;
    const size = st?.size ?? null;

    const prev = this.versionCache.get(providerId);
    if (!forceRefresh && prev && prev.binaryPath === resolvedPath) {
      const sameNs = mtimeNs !== null && prev.mtimeNs !== null && mtimeNs === prev.mtimeNs;
      const sameMs = mtimeMs !== null && prev.mtimeMs !== null && Number(mtimeMs) === Number(prev.mtimeMs);
      const sameSize = size === null || prev.size === null || size === prev.size;
      if ((sameNs || (mtimeNs === null && sameMs)) && sameSize) {
        return { ...prev.result, cached: true };
      }
    }

    const args = Array.isArray(spec.versionArgs) ? spec.versionArgs : ['--version'];
    const execRes = await this.execFileFn(resolvedPath, args, { timeoutMs: 4000 });
    const rawOut = `${execRes.stdout || ''}\n${execRes.stderr || ''}`.trim();
    const versionRe = spec.versionRegex ? new RegExp(spec.versionRegex) : /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
    const match = versionRe.exec(rawOut);
    const parsed = match ? parseSemver(match[1]) : null;
    const version = parsed ? parsed.normalized : null;
    const testedRange = spec.testedVersionRange || '*';

    let status = 'unknown_version';
    let badge = 'unverified_version';
    if (version) {
      const inRange = satisfiesVersionRange(version, testedRange);
      status = inRange ? 'verified' : 'unverified_version';
      badge = inRange ? 'verified' : 'unverified_version';
    }

    const result = {
      providerId,
      binary: binName,
      binaryPath: path.basename(resolvedPath),
      status,
      badge,
      severity: status === 'unverified_version' ? 'info' : null,
      version,
      testedVersionRange: testedRange,
      probedAt: new Date(this.now()).toISOString(),
      cached: false
    };
    this.versionCache.set(providerId, { binaryPath: resolvedPath, mtimeNs, mtimeMs, size, result });
    return result;
  }

  async probeAllProviders({ forceRefresh = false } = {}) {
    const providerIds = Object.keys(this.contracts?.providers || {});
    const entries = await Promise.all(providerIds.map(id => this.probeProviderVersion(id, { forceRefresh })));
    return Object.fromEntries(entries.map(e => [e.providerId, e]));
  }

  /**
   * Validates a live parsed object against `provider-contracts.json`.
   * Records a `P1 PROVIDER_SCHEMA_DRIFT` finding with redacted key-and-type skeleton on mismatch.
   */
  validateLivePayload(providerId, contractName, payload, {
    binaryVersion = null,
    affectedSeats = []
  } = {}) {
    const spec = this.getProviderContract(providerId);
    const contractSpec = spec?.contracts?.[contractName];
    if (!spec || !contractSpec) {
      return { ok: true, drift: false, missingKeys: [], typeMismatches: [], skeleton: buildRedactedSkeleton(payload), finding: null };
    }

    const validation = validateContractShape(payload, contractSpec);
    if (validation.ok) {
      return { ok: true, drift: false, missingKeys: [], typeMismatches: [], skeleton: validation.skeleton, finding: null };
    }

    const cachedProbe = this.versionCache.get(providerId)?.result;
    const resolvedVersion = binaryVersion || cachedProbe?.version || 'unknown';
    const finding = buildSchemaDriftFinding({
      providerId,
      binaryVersion: resolvedVersion,
      testedVersionRange: spec.testedVersionRange || '*',
      contractName,
      missingKeys: validation.missingKeys,
      typeMismatches: validation.typeMismatches,
      skeleton: validation.skeleton,
      affectedSeats,
      detectedAt: new Date(this.now()).toISOString()
    });
    this.activeFindings.set(finding.id, finding);

    return {
      ok: false,
      drift: true,
      unknownValue: SCHEMA_DRIFT_UNKNOWN,
      missingKeys: validation.missingKeys,
      typeMismatches: validation.typeMismatches,
      skeleton: validation.skeleton,
      finding
    };
  }

  getStatus() {
    const providers = {};
    for (const [id, cached] of this.versionCache.entries()) {
      providers[id] = cached.result;
    }
    return {
      providers,
      findings: Array.from(this.activeFindings.values()),
      schemaVersion: this.contracts?.schemaVersion || 1
    };
  }

  /**
   * Contour B verification check: compares local CLI `--version` and `--help` tokens,
   * plus optional sample contract fixtures, returning a non-destructive diff report.
   */
  async verifyProviderContracts({
    providerIds = null,
    samplePayloads = null,
    strict = false
  } = {}) {
    const allIds = Object.keys(this.contracts?.providers || {});
    const targetIds = Array.isArray(providerIds) && providerIds.length > 0
      ? providerIds.filter(id => allIds.includes(id))
      : allIds;

    const results = [];
    let unexpectedDriftCount = 0;
    let unverifiedVersionCount = 0;

    for (const providerId of targetIds) {
      const spec = this.getProviderContract(providerId);
      const versionProbe = await this.probeProviderVersion(providerId, { forceRefresh: true });
      const binName = spec.binary || providerId;
      const resolvedPath = await this.whichFn(binName);

      let helpStatus = 'skipped';
      let missingHelpTokens = [];
      if (resolvedPath) {
        const helpArgs = Array.isArray(spec.helpArgs) ? spec.helpArgs : ['--help'];
        const helpRes = await this.execFileFn(resolvedPath, helpArgs, { timeoutMs: 5000 });
        const helpOut = `${helpRes.stdout || ''}\n${helpRes.stderr || ''}`;
        const requiredTokens = Array.isArray(spec.requiredHelpTokens) ? spec.requiredHelpTokens : [];
        missingHelpTokens = requiredTokens.filter(tok => !helpOut.includes(tok));
        helpStatus = missingHelpTokens.length === 0 ? 'pass' : 'drift';
      }

      const sampleChecks = [];
      const providerSamples = samplePayloads?.[providerId] || null;
      if (providerSamples && typeof providerSamples === 'object') {
        for (const [contractName, sample] of Object.entries(providerSamples)) {
          const check = this.validateLivePayload(providerId, contractName, sample, {
            binaryVersion: versionProbe.version || 'sample'
          });
          sampleChecks.push({
            contractName,
            ok: check.ok,
            missingKeys: check.missingKeys,
            typeMismatches: check.typeMismatches,
            skeleton: check.ok ? undefined : check.skeleton
          });
        }
      }

      const hasSampleDrift = sampleChecks.some(c => !c.ok);
      const hasHelpDrift = helpStatus === 'drift';
      const isUnverifiedVersion = versionProbe.status === 'unverified_version';
      if (isUnverifiedVersion) unverifiedVersionCount += 1;

      const hasDrift = hasHelpDrift || hasSampleDrift || (strict && isUnverifiedVersion);
      if (hasDrift) unexpectedDriftCount += 1;

      results.push({
        providerId,
        binary: binName,
        installed: versionProbe.status !== 'not_installed',
        version: versionProbe.version,
        testedVersionRange: spec.testedVersionRange,
        versionStatus: versionProbe.status,
        helpStatus,
        missingHelpTokens,
        sampleChecks,
        contractStatus: hasDrift ? 'drift' : (versionProbe.status === 'not_installed' ? 'not_installed' : 'pass')
      });
    }

    return {
      ok: unexpectedDriftCount === 0,
      checkedAt: new Date(this.now()).toISOString(),
      strict: Boolean(strict),
      unexpectedDriftCount,
      unverifiedVersionCount,
      providers: results
    };
  }
}
