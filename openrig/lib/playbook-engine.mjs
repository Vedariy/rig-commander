/**
 * SafePlaybookEngine — Zero-dependency, local-first Opt-In Playbook Automation runtime.
 * Enforces default-OFF + dry-run-by-default posture, Hard Safety Vetoes, per-seat cooldowns,
 * sliding 1h fleet rate caps, 0600 config persistence, and bounded audit history.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_PLAYBOOK_CONFIG,
  sanitizePlaybookConfig,
  evaluatePlaybookCandidates
} from '../assets/domain/playbooks-model.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'rig-commander');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'playbooks.json');
const MAX_RECENT_RUNS = 40;

export class SafePlaybookEngine {
  constructor(options = {}) {
    this.configPath = options.configPath === null ? null : (options.configPath || DEFAULT_CONFIG_PATH);
    this.onCompact = typeof options.onCompact === 'function' ? options.onCompact : null;
    this.onWake = typeof options.onWake === 'function' ? options.onWake : null;
    this.onNudge = typeof options.onNudge === 'function' ? options.onNudge : null;
    this.onNotify = typeof options.onNotify === 'function' ? options.onNotify : null;

    this.config = this._loadConfig(options.initialConfig);
    this.lastRunAtByKey = new Map(); // ruleId:seatId (or cooldownKey) -> tsMs
    this.executedTimestamps = []; // sliding 1h write action timestamps
    this.recentRuns = []; // newest first, bounded MAX_RECENT_RUNS
    this.lastDryRun = null;
    this.isEvaluating = false;
  }

  _loadConfig(initialConfig) {
    let base = sanitizePlaybookConfig(initialConfig || {}, DEFAULT_PLAYBOOK_CONFIG);
    if (!this.configPath) return base;
    try {
      if (fs.existsSync(this.configPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        base = sanitizePlaybookConfig(parsed, base);
      }
    } catch {
      // Ignore corrupt config; stick to safe defaults
    }
    return base;
  }

  _persistConfig() {
    if (!this.configPath) return;
    try {
      const dir = path.dirname(this.configPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.configPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.configPath);
      try { fs.chmodSync(this.configPath, 0o600); } catch {}
    } catch {
      // Non-fatal persistence failure (e.g. read-only FS)
    }
  }

  _pruneExecutedTimestamps(nowMs = Date.now()) {
    const cutoff = nowMs - 3_600_000;
    while (this.executedTimestamps.length && this.executedTimestamps[0] < cutoff) {
      this.executedTimestamps.shift();
    }
  }

  _recordRun(entry) {
    this.recentRuns.unshift(entry);
    if (this.recentRuns.length > MAX_RECENT_RUNS) {
      this.recentRuns.length = MAX_RECENT_RUNS;
    }
  }

  getConfig() {
    return sanitizePlaybookConfig({}, this.config);
  }

  updateConfig(patch = {}) {
    this.config = sanitizePlaybookConfig(patch, this.config);
    this._persistConfig();
    return this.getState();
  }

  pauseAll() {
    this.config = sanitizePlaybookConfig({ enabled: false, mode: 'dry_run' }, this.config);
    this._persistConfig();
    return this.getState();
  }

  resetCooldowns() {
    this.lastRunAtByKey.clear();
    this.executedTimestamps.length = 0;
    return this.getState();
  }

  /**
   * Zero-side-effect dry-run simulation against current fleet snapshot.
   * Evaluates enabled rules even if master switch is currently paused so operator can preview safely.
   */
  dryRun(snapshot = {}, nowMs = Date.now()) {
    this._pruneExecutedTimestamps(nowMs);
    const res = evaluatePlaybookCandidates(snapshot, this.config, {
      nowMs,
      lastRunAtByKey: this.lastRunAtByKey,
      recentExecutedTimestamps: this.executedTimestamps,
      ignoreEnabledFlag: true
    });
    this.lastDryRun = {
      at: new Date(nowMs).toISOString(),
      mode: this.config.mode,
      enabled: this.config.enabled,
      eligible: res.eligible,
      vetoed: res.vetoed,
      summary: res.summary
    };
    return this.lastDryRun;
  }

  /**
   * Evaluates snapshot and executes whitelisted actions (only when enabled === true).
   * In `dry_run` mode, records preview entries without mutating any terminal.
   * In `armed` mode, dispatches allowlisted hooks with strict hourly cap & cooldown enforcement.
   */
  async evaluateAndRun(snapshot = {}, nowMs = Date.now()) {
    if (!this.config.enabled || this.isEvaluating) return [];
    this.isEvaluating = true;
    const runs = [];
    try {
      this._pruneExecutedTimestamps(nowMs);
      const evalRes = evaluatePlaybookCandidates(snapshot, this.config, {
        nowMs,
        lastRunAtByKey: this.lastRunAtByKey,
        recentExecutedTimestamps: this.executedTimestamps,
        ignoreEnabledFlag: false
      });

      for (const cand of evalRes.eligible) {
        const cdKey = cand.cooldownKey || `${cand.ruleId}:${cand.seatId}`;
        if (cand.kind === 'write' && this.config.mode !== 'armed') {
          this.lastRunAtByKey.set(cdKey, nowMs);
          const entry = {
            id: `pb-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            ruleId: cand.ruleId,
            actionId: cand.actionId,
            kind: cand.kind,
            seatId: cand.seatId,
            status: 'dry_run',
            reason: cand.reason,
            detail: 'Dry-run preview (no command dispatched)',
            at: new Date(nowMs).toISOString()
          };
          this._recordRun(entry);
          runs.push(entry);
          continue;
        }

        // Enforce live hourly rate cap right before write dispatch
        if (cand.kind === 'write') {
          this._pruneExecutedTimestamps(nowMs);
          if (this.executedTimestamps.length >= this.config.maxActionsPerHour) {
            const capped = {
              id: `pb-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              ruleId: cand.ruleId,
              actionId: cand.actionId,
              kind: cand.kind,
              seatId: cand.seatId,
              status: 'vetoed',
              reason: cand.reason,
              detail: `VETO_HOURLY_RATE_CAP (${this.config.maxActionsPerHour}/h)`,
              at: new Date(nowMs).toISOString()
            };
            this._recordRun(capped);
            runs.push(capped);
            continue;
          }
        }

        // Mark cooldown before async dispatch to prevent concurrent double-fires
        this.lastRunAtByKey.set(cdKey, nowMs);

        let ok = false;
        let detail = '';
        try {
          if (cand.ruleId === 'auto_compact_idle_hot' && this.onCompact) {
            const r = await this.onCompact(cand);
            ok = r !== false && (!r || r.ok !== false);
            detail = (r && r.detail) || (ok ? 'Dispatched /compact' : 'Dispatch rejected');
          } else if (cand.ruleId === 'auto_wake_parked' && this.onWake) {
            const r = await this.onWake(cand);
            ok = r !== false && (!r || r.ok !== false);
            detail = (r && r.detail) || (ok ? 'Dispatched wake Enter' : 'Dispatch rejected');
          } else if (cand.ruleId === 'auto_nudge_stalled_queue' && this.onNudge) {
            const r = await this.onNudge(cand);
            ok = r !== false && (!r || r.ok !== false);
            detail = (r && r.detail) || (ok ? 'Dispatched queue review prompt' : 'Dispatch rejected');
          } else if (cand.ruleId === 'auto_notify_critical_sa' && this.onNotify) {
            const r = await this.onNotify(cand);
            ok = r !== false && (!r || r.ok !== false);
            detail = (r && r.detail) || (ok ? 'Critical SA escalation sent' : 'Notify skipped');
          } else {
            ok = false;
            detail = 'No dispatcher bound';
          }
        } catch (err) {
          ok = false;
          detail = (err && err.message) ? err.message.slice(0, 120) : 'Dispatch error';
        }

        if (ok && cand.kind === 'write') {
          this.executedTimestamps.push(nowMs);
        }

        const entry = {
          id: `pb-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          ruleId: cand.ruleId,
          actionId: cand.actionId,
          kind: cand.kind,
          seatId: cand.seatId,
          status: ok ? 'executed' : 'failed',
          reason: cand.reason,
          detail,
          at: new Date(nowMs).toISOString()
        };
        this._recordRun(entry);
        runs.push(entry);
      }
    } finally {
      this.isEvaluating = false;
    }
    return runs;
  }

  getState(nowMs = Date.now()) {
    this._pruneExecutedTimestamps(nowMs);
    const actionsLastHour = this.executedTimestamps.length;
    const remainingHourlyQuota = Math.max(0, this.config.maxActionsPerHour - actionsLastHour);
    const status = !this.config.enabled
      ? 'disabled'
      : remainingHourlyQuota === 0 && this.config.mode === 'armed'
        ? 'capped'
        : this.config.mode;
    return {
      status,
      config: this.getConfig(),
      actionsLastHour,
      remainingHourlyQuota,
      recentRuns: this.recentRuns.slice(0, 20),
      lastDryRun: this.lastDryRun
    };
  }
}
