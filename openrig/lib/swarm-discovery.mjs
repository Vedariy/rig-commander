/**
 * Multi-Vendor Swarm Discovery Engine (Pluggable Adapter Architecture).
 *
 * Discovers active & recent local agent swarms across:
 *   1. Antigravity `/swarm` (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/swarm/`)
 *   2. Claude Code Agent Teams (`~/.claude/teams/<team>/`)
 *   3. Codex CLI Subagents (`~/.codex/sessions/...`)
 *
 * Guarantees:
 * - Zero npm dependencies (`node >= 18` built-ins only).
 * - Incremental `mtimeNs`/`mtimeMs`/`size` caching + bounded tail/head reads (`0%` idle CPU).
 * - Strict separation of raw `gitWorktrees` / `worktreePaths` (for server-side `collectFleetGitRadar`)
 *   from 100% redacted telemetry structures (`os.homedir()` -> `~`, secrets & user paths stripped
 *   via `SecretRedactor` `stripAnsiAndRedact`).
 * - Optional Contour A `ProviderDriftGuard` contract verification (`unknown (schema_drift)` on mismatch).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SWARM_PROVIDER_KINDS,
  deriveSwarmRigSlug,
  normalizeSwarmCluster,
  parseSwarmTimestampMs,
  sanitizeSwarmIdPart
} from '../assets/domain/swarm-model.js';
import { inferContextWindow } from './universal-discovery.mjs';
import { stripAnsiAndRedact } from './ai-evaluator/redactor.mjs';
import { ProviderDriftGuard, SCHEMA_DRIFT_UNKNOWN, applySchemaDriftFallback } from './provider-drift-guard.mjs';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const BOARD_TAIL_MAX_BYTES = 32 * 1024;
const TRANSCRIPT_HEAD_BYTES = 16 * 1024;
const TRANSCRIPT_TAIL_BYTES = 32 * 1024;
const MAX_FILE_CACHE_ENTRIES = 256;

const fileCache = new Map(); // cacheKey -> { mtimeNs, mtimeMs, size, data }
const defaultDriftGuard = new ProviderDriftGuard();

export function clearSwarmDiscoveryCache() {
  fileCache.clear();
}

function setBoundedCache(key, entry) {
  if (fileCache.has(key)) fileCache.delete(key);
  else if (fileCache.size >= MAX_FILE_CACHE_ENTRIES) {
    const oldest = fileCache.keys().next().value;
    if (oldest !== undefined) fileCache.delete(oldest);
  }
  fileCache.set(key, entry);
}

function isStatFresh(cached, st) {
  if (!cached || !st) return false;
  if (cached.size !== st.size) return false;
  if (typeof cached.mtimeNs === 'bigint' && typeof st.mtimeNs === 'bigint') {
    return cached.mtimeNs === st.mtimeNs;
  }
  return cached.mtimeMs === st.mtimeMs;
}

/**
 * Redacts personal OS home paths (`os.homedir()` -> `~`) and all secrets / foreign user paths
 * via SecretRedactor (`stripAnsiAndRedact`).
 */
export function redactSwarmText(rawText, { homeDir = os.homedir() } = {}) {
  const s = String(rawText ?? '');
  if (!s) return '';
  let normalized = s;
  const cleanHome = String(homeDir || '').replace(/\/+$/, '');
  if (cleanHome && cleanHome.length > 1) {
    normalized = normalized.split(cleanHome).join('~');
  }
  return stripAnsiAndRedact(normalized, { redactPaths: true }).text;
}

export function redactSwarmValue(val, opts = {}) {
  if (typeof val === 'string') return redactSwarmText(val, opts);
  if (Array.isArray(val)) return val.map(item => redactSwarmValue(item, opts));
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[redactSwarmText(k, opts)] = redactSwarmValue(v, opts);
    }
    return out;
  }
  return val;
}

function formatWorkspaceLabel(rawPaths, { homeDir = os.homedir() } = {}) {
  const arr = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
  const clean = arr
    .filter(p => typeof p === 'string' && p.trim())
    .map(p => redactSwarmText(p.trim(), { homeDir }));
  return clean.join(', ');
}

function splitWorkspacePaths(rawWorkspace) {
  if (Array.isArray(rawWorkspace)) {
    return rawWorkspace.map(s => String(s || '').trim()).filter(Boolean);
  }
  if (typeof rawWorkspace !== 'string' || !rawWorkspace.trim()) return [];
  return rawWorkspace.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
}

async function readJsonCached(filePath, { useCache = true } = {}) {
  let st;
  try {
    st = await fs.stat(filePath, { bigint: true });
  } catch {
    return null;
  }
  const cacheKey = `json:${filePath}`;
  const cached = useCache ? fileCache.get(cacheKey) : null;
  if (isStatFresh(cached, st)) {
    return { ...cached.data, stat: st, fromCache: true };
  }
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const data = { ok: true, parsed, mtimeMs: Number(st.mtimeMs) };
    if (useCache) {
      setBoundedCache(cacheKey, { mtimeNs: st.mtimeNs, mtimeMs: st.mtimeMs, size: st.size, data });
    }
    return { ...data, stat: st, fromCache: false };
  } catch {
    return { ok: false, parsed: null, mtimeMs: Number(st.mtimeMs), stat: st, fromCache: false };
  }
}

async function readJsonlTailCached(filePath, { maxBytes = BOARD_TAIL_MAX_BYTES, useCache = true } = {}) {
  let st;
  try {
    st = await fs.stat(filePath, { bigint: true });
  } catch {
    return null;
  }
  const cacheKey = `tail:${maxBytes}:${filePath}`;
  const cached = useCache ? fileCache.get(cacheKey) : null;
  if (isStatFresh(cached, st)) {
    return { ...cached.data, stat: st, fromCache: true };
  }

  let fh = null;
  try {
    const fileSize = Number(st.size);
    const readLen = Math.min(fileSize, maxBytes);
    const startOffset = Math.max(0, fileSize - readLen);
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(readLen);
    if (readLen > 0) {
      await fh.read(buf, 0, readLen, startOffset);
    }
    const raw = buf.toString('utf8');
    const lines = raw.split(/\r?\n/);
    if (startOffset > 0 && lines.length > 0) lines.shift(); // Drop partial first line

    const entries = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') entries.push(obj);
      } catch {
        // tolerate incomplete trailing line
      }
    }
    const data = { entries, mtimeMs: Number(st.mtimeMs), size: fileSize };
    if (useCache) {
      setBoundedCache(cacheKey, { mtimeNs: st.mtimeNs, mtimeMs: st.mtimeMs, size: st.size, data });
    }
    return { ...data, stat: st, fromCache: false };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function inspectBoundedTranscriptCached(filePath, runtimeHint = '', { useCache = true } = {}) {
  let st;
  try {
    st = await fs.stat(filePath, { bigint: true });
  } catch {
    return null;
  }
  const cacheKey = `tr:${filePath}`;
  const cached = useCache ? fileCache.get(cacheKey) : null;
  if (isStatFresh(cached, st)) {
    return { ...cached.data, fromCache: true };
  }

  let fh = null;
  try {
    const fileSize = Number(st.size);
    const mtimeMs = Number(st.mtimeMs);
    fh = await fs.open(filePath, 'r');
    const headLen = Math.min(fileSize, TRANSCRIPT_HEAD_BYTES);
    const tailLen = Math.min(fileSize, TRANSCRIPT_TAIL_BYTES);
    const headBuf = Buffer.allocUnsafe(headLen);
    if (headLen > 0) await fh.read(headBuf, 0, headLen, 0);

    let tailText = '';
    if (fileSize > headLen) {
      const tailBuf = Buffer.allocUnsafe(tailLen);
      await fh.read(tailBuf, 0, tailLen, Math.max(0, fileSize - tailLen));
      tailText = tailBuf.toString('utf8');
    } else {
      tailText = headBuf.toString('utf8');
    }

    const headText = headBuf.toString('utf8');
    const parseLines = (txt) => {
      const out = [];
      for (const line of txt.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj === 'object') out.push(obj);
        } catch {
          // ignore partial line
        }
      }
      return out;
    };

    const headObjs = parseLines(headText);
    const tailObjs = parseLines(tailText);

    let cwd = '';
    let model = '';
    let firstTsMs = null;
    let lastTsMs = null;
    let lastContextTokens = null;
    let runtime = runtimeHint || '';
    let sessionId = '';
    let parentId = '';
    let swarmId = '';
    let role = '';
    let nickname = '';
    let isSubagent = false;
    let closed = false;
    let lastEventType = '';
    let hasTokenCountShape = false;
    let tokenCountShapeValid = true;
    const spawnedTargets = [];
    const sampleEvents = {};

    for (const obj of headObjs) {
      const ts = parseSwarmTimestampMs(obj.timestamp || obj.time);
      if (firstTsMs === null && Number.isFinite(ts)) firstTsMs = ts;
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
      if (!cwd && obj.payload && typeof obj.payload.cwd === 'string') cwd = obj.payload.cwd;
      if (!model && typeof obj.model === 'string') model = obj.model;
      if (!model && obj.message && typeof obj.message.model === 'string') model = obj.message.model;
      if (!model && obj.payload && typeof obj.payload.model === 'string') model = obj.payload.model;
      if (obj.type === 'session_meta' || obj.type === 'event_msg') {
        runtime = runtime || 'codex';
        if (obj.type === 'session_meta') sampleEvents.sessionMeta = obj;
      }
      if (obj.type === 'assistant' && obj.message) {
        runtime = runtime || 'claude-code';
        sampleEvents.assistant = obj;
      }

      const metaPayload = obj.type === 'session_meta' ? (obj.payload || {}) : obj;
      if (!sessionId && typeof metaPayload.id === 'string') sessionId = metaPayload.id;
      if (!sessionId && typeof obj.sessionId === 'string') sessionId = obj.sessionId;
      if (!swarmId && typeof (metaPayload.swarmId || metaPayload.swarm_id || obj.swarmId) === 'string') {
        swarmId = metaPayload.swarmId || metaPayload.swarm_id || obj.swarmId;
      }
      const spawnMeta = metaPayload.source?.subagent?.thread_spawn || metaPayload.subagent || null;
      if (spawnMeta && typeof spawnMeta === 'object') {
        isSubagent = true;
        if (!parentId && typeof (spawnMeta.parent_thread_id || spawnMeta.parentThreadId) === 'string') {
          parentId = spawnMeta.parent_thread_id || spawnMeta.parentThreadId;
        }
        if (!nickname && typeof (spawnMeta.agent_nickname || spawnMeta.nickname) === 'string') {
          nickname = spawnMeta.agent_nickname || spawnMeta.nickname;
        }
        if (!role && typeof (spawnMeta.agent_role || spawnMeta.role) === 'string') {
          role = spawnMeta.agent_role || spawnMeta.role;
        }
      }
      if (!parentId && typeof (metaPayload.parent_thread_id || metaPayload.parentThreadId || metaPayload.parent_session_id || metaPayload.parentSessionId || metaPayload.parentId || obj.parentSessionId) === 'string') {
        parentId = metaPayload.parent_thread_id || metaPayload.parentThreadId || metaPayload.parent_session_id || metaPayload.parentSessionId || metaPayload.parentId || obj.parentSessionId;
        isSubagent = true;
      }
      if (metaPayload.source === 'subagent' || metaPayload.isSubagent === true || obj.isSubagent === true) {
        isSubagent = true;
      }
      if (!nickname && typeof (metaPayload.agent_nickname || obj.agentNickname) === 'string') {
        nickname = metaPayload.agent_nickname || obj.agentNickname;
      }
      if (!role && typeof (metaPayload.agent_role || obj.agentRole) === 'string') {
        role = metaPayload.agent_role || obj.agentRole;
      }
    }

    for (let i = 0; i < tailObjs.length; i++) {
      const obj = tailObjs[i];
      const ts = parseSwarmTimestampMs(obj.timestamp || obj.time);
      if (Number.isFinite(ts)) lastTsMs = ts;
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
      if (!cwd && obj.payload && typeof obj.payload.cwd === 'string') cwd = obj.payload.cwd;
      if (obj.type === 'event_msg' && obj.payload) {
        lastEventType = String(obj.payload.type || lastEventType);
        if (obj.payload.type === 'token_count') {
          hasTokenCountShape = true;
          sampleEvents.tokenCount = obj;
          const info = obj.payload.info;
          const lastU = info && (info.last_token_usage || info.total_token_usage);
          if (!info || !lastU) {
            tokenCountShapeValid = false;
          } else if (lastContextTokens === null) {
            const inp = Number(lastU.input_tokens) || 0;
            if (inp >= 0) lastContextTokens = inp;
          }
          if (!model && typeof obj.payload.model === 'string') model = obj.payload.model;
          runtime = runtime || 'codex';
        }
        if (obj.payload.type === 'collab_agent_spawn_end' && obj.payload.new_thread_id) {
          spawnedTargets.push(String(obj.payload.new_thread_id));
        }
        if (obj.payload.type === 'agent_closed' || obj.payload.type === 'session_closed') {
          closed = true;
        }
      } else if (obj.type === 'assistant' && obj.message) {
        runtime = runtime || 'claude-code';
        sampleEvents.assistant = obj;
        if (!model && typeof obj.message.model === 'string') model = obj.message.model;
        const u = obj.message.usage;
        if (u && typeof u === 'object') {
          const totalIn =
            (Number(u.input_tokens) || 0) +
            (Number(u.cache_creation_input_tokens) || 0) +
            (Number(u.cache_read_input_tokens) || 0);
          if (totalIn > 0) lastContextTokens = totalIn;
        }
      } else if (obj.type === 'response_item' && obj.payload?.type === 'function_call') {
        const fnName = String(obj.payload.name || '');
        if (fnName === 'spawn_agent') {
          try {
            const args = typeof obj.payload.arguments === 'string' ? JSON.parse(obj.payload.arguments) : obj.payload.arguments;
            if (args?.thread_id || args?.agent_id) spawnedTargets.push(String(args.thread_id || args.agent_id));
          } catch {
            // ignore
          }
        }
        if (fnName === 'close_agent') {
          lastEventType = 'close_agent';
        }
      }
      if (obj.killed === true || obj.closed === true) closed = true;
    }

    const ctxWindow = inferContextWindow(model, runtime);
    const usedPercentage =
      typeof lastContextTokens === 'number' && ctxWindow > 0
        ? Math.min(100, Math.round((lastContextTokens / ctxWindow) * 100))
        : null;

    const data = {
      filePath,
      firstTsMs: firstTsMs || Math.max(0, mtimeMs - 15 * 60_000),
      lastTsMs: lastTsMs || mtimeMs,
      mtimeMs,
      size: fileSize,
      runtime: runtime || 'codex',
      cwd,
      model,
      usedTokens: lastContextTokens,
      contextWindowSize: ctxWindow,
      usedPercentage,
      sessionId,
      parentId,
      swarmId,
      role,
      nickname,
      isSubagent,
      closed,
      lastEventType,
      hasTokenCountShape,
      tokenCountShapeValid,
      spawnedTargets,
      sampleEvents
    };
    if (useCache) {
      setBoundedCache(cacheKey, { mtimeNs: st.mtimeNs, mtimeMs: st.mtimeMs, size: st.size, data });
    }
    return { ...data, fromCache: false };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

export class SwarmDiscoveryAdapter {
  constructor(providerKind) {
    this.providerKind = providerKind;
  }

  // eslint-disable-next-line no-unused-vars
  async discover(_options = {}) {
    return [];
  }
}

export class AntigravitySwarmAdapter extends SwarmDiscoveryAdapter {
  constructor() {
    super(SWARM_PROVIDER_KINDS.ANTIGRAVITY);
  }

  async discover({
    brainRoot = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    includeKilled = false,
    stallThresholdMs,
    nowMs = Date.now(),
    useCache = true,
    driftGuard = null,
    homeDir = os.homedir()
  } = {}) {
    let dirs;
    try {
      dirs = await fs.readdir(brainRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const candidates = [];
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const swarmDir = path.join(brainRoot, ent.name, '.system_generated', 'swarm');
      const membersPath = path.join(swarmDir, 'members.json');
      try {
        const st = await fs.stat(membersPath);
        if (nowMs - st.mtimeMs <= maxAgeMs) {
          candidates.push({ dirId: ent.name, swarmDir, mtimeMs: st.mtimeMs });
        }
      } catch {
        // not a swarm directory
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out = [];

    for (const cand of candidates.slice(0, 24)) {
      const [swarmRes, membersRes, planRes, boardRes] = await Promise.all([
        readJsonCached(path.join(cand.swarmDir, 'swarm.json'), { useCache }),
        readJsonCached(path.join(cand.swarmDir, 'members.json'), { useCache }),
        readJsonCached(path.join(cand.swarmDir, 'plan.json'), { useCache }),
        readJsonlTailCached(path.join(cand.swarmDir, 'board.jsonl'), { useCache })
      ]);

      const swarmJson = swarmRes?.parsed || { swarm_id: cand.dirId };
      const membersJson = membersRes?.parsed || {};
      const planJson = planRes?.parsed || {};
      const boardEntries = boardRes?.entries || [];

      const driftFindings = [];
      let membersSchemaBroken = false;
      if (driftGuard) {
        if (swarmRes?.parsed) {
          const checkMeta = driftGuard.validateLivePayload('agy', 'swarmMeta', swarmRes.parsed);
          if (checkMeta.finding) driftFindings.push(checkMeta.finding);
        }
        if (membersRes?.parsed) {
          const checkMembers = driftGuard.validateLivePayload('agy', 'swarmMembers', membersRes.parsed);
          if (checkMembers.finding) {
            driftFindings.push(checkMembers.finding);
            membersSchemaBroken = true;
          }
        }
        if (planRes?.parsed) {
          const checkPlan = driftGuard.validateLivePayload('agy', 'swarmPlan', planRes.parsed);
          if (checkPlan.finding) driftFindings.push(checkPlan.finding);
        }
        if (boardEntries.length > 0) {
          const checkBoard = driftGuard.validateLivePayload('agy', 'swarmBoardEntry', boardEntries[boardEntries.length - 1]);
          if (checkBoard.finding) driftFindings.push(checkBoard.finding);
        }
      }

      const rigId = deriveSwarmRigSlug(membersJson.title || planJson.goal?.title || '', swarmJson.swarm_id || cand.dirId);
      const rawMembers = membersJson.members && typeof membersJson.members === 'object' ? membersJson.members : {};
      const sanitizedMembers = {};
      const transcriptsByMember = {};
      const gitWorktrees = [];

      await Promise.all(
        Object.entries(rawMembers).map(async ([name, m]) => {
          if (!m || typeof m !== 'object') return;
          const seatId = `${sanitizeSwarmIdPart(name, 'agent', 60)}@${rigId}`;
          let memberSchemaDrift = membersSchemaBroken;
          if (driftGuard) {
            const mCheck = driftGuard.validateLivePayload('agy', 'swarmMemberEntry', m, {
              affectedSeats: [seatId]
            });
            if (mCheck.finding) {
              driftFindings.push(mCheck.finding);
              memberSchemaDrift = true;
            }
          }
          const workspacePaths = splitWorkspacePaths(m.workspace);
          const isKilled = m.killed === true || String(m.phase || '').toUpperCase() === 'KILLED';

          let tr = null;
          let transcriptDrift = false;
          if ((!isKilled || includeKilled) && typeof m.conversation_id === 'string' && m.conversation_id.trim()) {
            const trPath = path.join(brainRoot, m.conversation_id.trim(), '.system_generated', 'logs', 'transcript.jsonl');
            tr = await inspectBoundedTranscriptCached(trPath, 'antigravity-swarm', { useCache });
            if (tr) {
              if (driftGuard) {
                if (tr.sampleEvents?.tokenCount) {
                  const tc = driftGuard.validateLivePayload('codex', 'jsonlTokenCount', tr.sampleEvents.tokenCount, {
                    affectedSeats: [seatId]
                  });
                  if (tc.finding) {
                    driftFindings.push(tc.finding);
                    transcriptDrift = true;
                  }
                }
                if (tr.sampleEvents?.assistant) {
                  const ac = driftGuard.validateLivePayload('claude-code', 'jsonlAssistant', tr.sampleEvents.assistant, {
                    affectedSeats: [seatId]
                  });
                  if (ac.finding) {
                    driftFindings.push(ac.finding);
                    transcriptDrift = true;
                  }
                }
              }
              transcriptsByMember[name] = {
                firstTsMs: tr.firstTsMs,
                lastActivityAt: new Date(tr.lastTsMs || tr.mtimeMs).toISOString(),
                mtimeMs: tr.mtimeMs,
                model: transcriptDrift ? SCHEMA_DRIFT_UNKNOWN : (tr.model || m.model || m.applied_model || m.desired_model || ''),
                usedTokens: transcriptDrift ? SCHEMA_DRIFT_UNKNOWN : tr.usedTokens,
                contextWindowSize: tr.contextWindowSize,
                usedPercentage: transcriptDrift ? SCHEMA_DRIFT_UNKNOWN : tr.usedPercentage,
                source: 'antigravity-jsonl'
              };
            }
          }

          if (!isKilled && workspacePaths.length > 0) {
            for (const wp of workspacePaths) {
              if (path.isAbsolute(wp)) {
                gitWorktrees.push({
                  seatId,
                  canonicalSessionName: seatId,
                  rigId,
                  providerKind: this.providerKind,
                  workspaceMode: String(m.workspace_mode || 'share'),
                  cwd: wp,
                  path: wp,
                  activityState: {
                    display: memberSchemaDrift ? SCHEMA_DRIFT_UNKNOWN : (m.wake_mode === 'working' ? 'working' : 'idle')
                  }
                });
              }
            }
          }

          const redactedCwd = workspacePaths.length > 0
            ? formatWorkspaceLabel(workspacePaths[0], { homeDir })
            : rigId;

          sanitizedMembers[name] = {
            ...m,
            schemaDrift: memberSchemaDrift,
            workspace: undefined,
            cwd: redactedCwd,
            workspaceLabel: workspacePaths.length > 0 ? formatWorkspaceLabel(workspacePaths, { homeDir }) : rigId
          };
        })
      );

      // If members.json existed and failed contract shape, raise explicit unknown fallback
      const cluster = normalizeSwarmCluster({
        providerKind: this.providerKind,
        swarmId: swarmJson.swarm_id || cand.dirId,
        rigId,
        swarm: swarmJson,
        members: { ...membersJson, members: sanitizedMembers },
        plan: planJson,
        boardEntries,
        transcriptsByMember
      }, { includeKilled, nowMs, stallThresholdMs });

      if (membersSchemaBroken) {
        cluster.rig.status = SCHEMA_DRIFT_UNKNOWN;
        cluster.rig.swarmMeta = applySchemaDriftFallback(cluster.rig.swarmMeta, ['members']);
      }

      out.push({
        cluster: redactSwarmValue(cluster, { homeDir }),
        gitWorktrees,
        driftFindings
      });
    }

    return out;
  }
}

export class ClaudeTeamsAdapter extends SwarmDiscoveryAdapter {
  constructor() {
    super(SWARM_PROVIDER_KINDS.CLAUDE_TEAMS);
  }

  async discover({
    claudeTeamsRoot = path.join(os.homedir(), '.claude', 'teams'),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    includeKilled = false,
    stallThresholdMs,
    nowMs = Date.now(),
    useCache = true,
    driftGuard = null,
    homeDir = os.homedir()
  } = {}) {
    let entries;
    try {
      entries = await fs.readdir(claudeTeamsRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const siblingTasksRoot = path.join(path.dirname(claudeTeamsRoot), 'tasks');
    const out = [];

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const teamDir = path.join(claudeTeamsRoot, ent.name);
      const configPath = await (async () => {
        for (const name of ['config.json', 'team.json']) {
          const p = path.join(teamDir, name);
          try {
            const st = await fs.stat(p);
            if (nowMs - st.mtimeMs <= maxAgeMs) return { path: p, mtimeMs: st.mtimeMs };
          } catch {
            // continue
          }
        }
        return null;
      })();
      if (!configPath) continue;

      const configRes = await readJsonCached(configPath.path, { useCache });
      const config = configRes?.parsed || {};
      const driftFindings = [];
      let teamDrift = false;
      if (driftGuard && configRes?.parsed) {
        const chk = driftGuard.validateLivePayload('claude-code', 'teamConfig', configRes.parsed);
        if (chk.finding) {
          driftFindings.push(chk.finding);
          teamDrift = true;
        }
      }

      // Collect tasks from either <teamDir>/tasks/*.json or <claudeRoot>/tasks/<teamName>/*.json
      const taskFiles = [];
      for (const tDir of [path.join(teamDir, 'tasks'), path.join(siblingTasksRoot, ent.name)]) {
        try {
          const tEnts = await fs.readdir(tDir, { withFileTypes: true });
          for (const tf of tEnts) {
            if (tf.isFile() && tf.name.endsWith('.json')) {
              taskFiles.push(path.join(tDir, tf.name));
            }
          }
        } catch {
          // optional
        }
      }

      const rawTasks = (await Promise.all(taskFiles.slice(0, 64).map(p => readJsonCached(p, { useCache }))))
        .map(r => r?.parsed)
        .filter(Boolean);

      // Collect optional team inboxes into synthetic boardEntries
      const boardEntries = [];
      try {
        const inboxDir = path.join(teamDir, 'inboxes');
        const inboxEnts = await fs.readdir(inboxDir, { withFileTypes: true });
        let seq = 1;
        for (const ib of inboxEnts) {
          if (!ib.isFile() || !ib.name.endsWith('.json')) continue;
          const recipient = ib.name.replace(/\.json$/i, '');
          const ibRes = await readJsonCached(path.join(inboxDir, ib.name), { useCache });
          const msgs = Array.isArray(ibRes?.parsed) ? ibRes.parsed : [];
          for (const msg of msgs) {
            if (!msg || typeof msg !== 'object') continue;
            boardEntries.push({
              seq: seq++,
              agent: String(msg.from || config.name || ent.name),
              text: `@${recipient} ${msg.summary || msg.text || ''}`,
              time: msg.timestamp || new Date(configPath.mtimeMs).toISOString(),
              kind: 'message'
            });
          }
        }
      } catch {
        // optional
      }

      const rigId = deriveSwarmRigSlug(config.name || ent.name, config.teamId || ent.name);
      const rawMembers = Array.isArray(config.members)
        ? config.members
        : (config.members && typeof config.members === 'object'
            ? Object.entries(config.members).map(([k, v]) => ({ name: k, ...(v || {}) }))
            : []);

      const membersMap = {};
      const tasksMap = {};
      const gitWorktrees = [];

      for (const t of rawTasks) {
        if (driftGuard) {
          const chk = driftGuard.validateLivePayload('claude-code', 'teamTask', t);
          if (chk.finding) driftFindings.push(chk.finding);
        }
        const owner = String(t.owner || '').trim();
        if (owner) {
          tasksMap[owner] = {
            summary: t.subject || t.description || t.activeForm || '',
            status: t.status || 'pending',
            createdAt: t.createdAt,
            completedAt: t.status === 'completed' ? (t.updatedAt || null) : null
          };
        }
      }

      for (const m of rawMembers) {
        if (!m || typeof m !== 'object') continue;
        const memberName = String(m.name || m.agentId || 'teammate').trim();
        const seatId = `${sanitizeSwarmIdPart(memberName, 'agent', 60)}@${rigId}`;
        const ownedTask = rawTasks.find(t => t.owner === memberName && t.status === 'in_progress');
        const isKilled = m.killed === true || ['killed', 'shutdown', 'closed'].includes(String(m.status || '').toLowerCase());
        const rawCwd = String(m.cwd || m.worktree || '').trim();

        if (!isKilled && rawCwd && path.isAbsolute(rawCwd)) {
          gitWorktrees.push({
            seatId,
            canonicalSessionName: seatId,
            rigId,
            providerKind: this.providerKind,
            workspaceMode: m.worktree ? 'worktree' : 'inherit',
            cwd: rawCwd,
            path: rawCwd,
            activityState: {
              display: ownedTask || m.status === 'working' || m.status === 'active' ? 'working' : 'idle'
            }
          });
        }

        const memberWake = ownedTask || m.status === 'working' || m.status === 'active' || m.status === 'running'
          ? 'working'
          : (m.status === 'stalled' || m.status === 'parked' ? 'working' : 'idle');

        membersMap[memberName] = {
          role: m.agentType || (config.leadAgentId && config.leadAgentId === m.agentId ? 'lead' : 'teammate'),
          model: teamDrift ? SCHEMA_DRIFT_UNKNOWN : (m.model || 'claude-sonnet-4'),
          phase: m.status === 'stalled' ? 'STALLED' : (isKilled ? 'KILLED' : 'RUNNING'),
          desired_state: isKilled ? 'KILLED' : 'RUNNING',
          wake_mode: memberWake,
          stalled: m.status === 'stalled' || m.status === 'parked',
          killed: isKilled,
          workspace_mode: m.worktree ? 'worktree' : (m.backendType || 'in-process'),
          cwd: rawCwd ? redactSwarmText(rawCwd, { homeDir }) : rigId,
          firstActivityAt: m.joinedAt ? new Date(m.joinedAt).toISOString() : undefined,
          lastActivityAt: new Date(configPath.mtimeMs).toISOString()
        };
      }

      const cluster = normalizeSwarmCluster({
        providerKind: this.providerKind,
        swarmId: config.teamId || ent.name,
        rigId,
        title: config.name || ent.name,
        description: config.description || '',
        createdAt: config.createdAt ? new Date(config.createdAt).toISOString() : new Date(configPath.mtimeMs).toISOString(),
        members: { title: config.name || ent.name, members: membersMap },
        plan: {
          goal: { title: config.name || ent.name, line: config.description || '' },
          tasks: tasksMap,
          threads: [{ id: ent.name, title: config.name || ent.name, tasks: Object.keys(tasksMap) }]
        },
        boardEntries
      }, { includeKilled, nowMs, stallThresholdMs });

      if (teamDrift) {
        cluster.rig.status = SCHEMA_DRIFT_UNKNOWN;
        cluster.rig.swarmMeta = applySchemaDriftFallback(cluster.rig.swarmMeta, ['members']);
      }

      out.push({
        cluster: redactSwarmValue(cluster, { homeDir }),
        gitWorktrees,
        driftFindings
      });
    }

    return out;
  }
}

async function collectCodexSessionFiles(dir, maxDepth, maxAgeMs, nowMs, out, depth = 0) {
  if (depth > maxDepth || out.length >= 100) return;
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (out.length >= 100) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await collectCodexSessionFiles(full, maxDepth, maxAgeMs, nowMs, out, depth + 1);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      try {
        const st = await fs.stat(full);
        if (nowMs - st.mtimeMs <= maxAgeMs && st.size > 0) {
          out.push({ filePath: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // skip
      }
    }
  }
}

export class CodexSubagentsAdapter extends SwarmDiscoveryAdapter {
  constructor() {
    super(SWARM_PROVIDER_KINDS.CODEX_SUBAGENTS);
  }

  async discover({
    codexSessionsRoot = path.join(os.homedir(), '.codex', 'sessions'),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    includeKilled = false,
    stallThresholdMs,
    nowMs = Date.now(),
    useCache = true,
    driftGuard = null,
    homeDir = os.homedir()
  } = {}) {
    const files = [];
    await collectCodexSessionFiles(codexSessionsRoot, 4, maxAgeMs, nowMs, files, 0);
    if (files.length === 0) return [];
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const metas = (await Promise.all(
      files.slice(0, 48).map(f => inspectBoundedTranscriptCached(f.filePath, 'codex', { useCache }))
    )).filter(Boolean);

    const bySessionId = new Map();
    for (const m of metas) {
      const sid = m.sessionId || path.basename(m.filePath, '.jsonl');
      m._resolvedId = sid;
      bySessionId.set(sid, m);
    }

    // Determine which sessions belong to a multi-agent subagent tree
    const spawnedIds = new Set();
    for (const m of metas) {
      for (const childId of m.spawnedTargets || []) {
        spawnedIds.add(childId);
      }
      if (m.parentId) spawnedIds.add(m._resolvedId);
    }

    const clustersMap = new Map(); // rootId -> { rootId, members: [] }
    for (const m of metas) {
      const hasSubagentLink = Boolean(
        m.isSubagent ||
        m.parentId ||
        m.swarmId ||
        (m.spawnedTargets && m.spawnedTargets.length > 0) ||
        spawnedIds.has(m._resolvedId)
      );
      if (!hasSubagentLink) continue;

      let rootId = m.swarmId || m.parentId || m._resolvedId;
      // Walk up one hop if parent also has a parent/swarmId
      const parentMeta = m.parentId ? bySessionId.get(m.parentId) : null;
      if (parentMeta) {
        rootId = parentMeta.swarmId || parentMeta.parentId || parentMeta._resolvedId;
      }

      if (!clustersMap.has(rootId)) {
        clustersMap.set(rootId, { rootId, members: new Map() });
      }
      clustersMap.get(rootId).members.set(m._resolvedId, m);
      if (parentMeta && !clustersMap.get(rootId).members.has(parentMeta._resolvedId)) {
        clustersMap.get(rootId).members.set(parentMeta._resolvedId, parentMeta);
      }
    }

    const out = [];
    for (const { rootId, members } of clustersMap.values()) {
      const rigId = deriveSwarmRigSlug(rootId);
      const membersMap = {};
      const transcriptsByMember = {};
      const tasksMap = {};
      const boardEntries = [];
      const gitWorktrees = [];
      const driftFindings = [];
      let earliestMs = nowMs;
      let seq = 1;

      const ordered = Array.from(members.values()).sort((a, b) => a.firstTsMs - b.firstTsMs);
      for (const m of ordered) {
        earliestMs = Math.min(earliestMs, m.firstTsMs);
        const isRoot = m._resolvedId === rootId && !m.parentId && !m.isSubagent;
        const memberName = sanitizeSwarmIdPart(
          m.nickname || (isRoot ? 'lead' : (m.role ? `${m.role}-${m._resolvedId.slice(0, 6)}` : m._resolvedId.slice(0, 14))),
          'subagent',
          42
        );
        const seatId = `${memberName}@${rigId}`;

        let tokenDrift = false;
        let sessionMetaDrift = false;
        if (driftGuard) {
          if (m.sampleEvents?.sessionMeta) {
            const chk = driftGuard.validateLivePayload('codex', 'jsonlSessionMeta', m.sampleEvents.sessionMeta, {
              affectedSeats: [seatId]
            });
            if (chk.finding) {
              driftFindings.push(chk.finding);
              sessionMetaDrift = true;
            }
          }
          if (m.sampleEvents?.tokenCount) {
            const chk = driftGuard.validateLivePayload('codex', 'jsonlTokenCount', m.sampleEvents.tokenCount, {
              affectedSeats: [seatId]
            });
            if (chk.finding) {
              driftFindings.push(chk.finding);
              tokenDrift = true;
            }
          }
        }

        const ageMs = Math.max(0, nowMs - m.mtimeMs);
        const isKilled = Boolean(m.closed);
        const isCompleted = m.lastEventType === 'task_complete' || m.lastEventType === 'close_agent';
        const isWorking = !isKilled && !isCompleted && ageMs < 20_000;

        if (!isKilled && m.cwd && path.isAbsolute(m.cwd)) {
          gitWorktrees.push({
            seatId,
            canonicalSessionName: seatId,
            rigId,
            providerKind: this.providerKind,
            workspaceMode: m.cwd.includes('.codex') || m.cwd.includes('worktree') ? 'worktree' : 'inherit',
            cwd: m.cwd,
            path: m.cwd,
            activityState: { display: sessionMetaDrift ? SCHEMA_DRIFT_UNKNOWN : (isWorking ? 'working' : 'idle') }
          });
        }

        const redactedCwd = m.cwd ? redactSwarmText(m.cwd, { homeDir }) : (sessionMetaDrift ? SCHEMA_DRIFT_UNKNOWN : rigId);
        membersMap[memberName] = {
          role: m.role || (isRoot ? 'coordinator' : 'subagent'),
          model: tokenDrift ? SCHEMA_DRIFT_UNKNOWN : (m.model || 'codex'),
          phase: isKilled ? 'KILLED' : 'RUNNING',
          desired_state: isKilled ? 'KILLED' : 'RUNNING',
          wake_mode: sessionMetaDrift ? SCHEMA_DRIFT_UNKNOWN : (isWorking ? 'working' : 'idle'),
          schemaDrift: sessionMetaDrift,
          killed: isKilled,
          workspace_mode: m.cwd && m.cwd.includes('worktree') ? 'worktree' : 'inherit',
          cwd: redactedCwd,
          firstActivityAt: new Date(m.firstTsMs).toISOString(),
          lastActivityAt: new Date(m.lastTsMs || m.mtimeMs).toISOString()
        };

        transcriptsByMember[memberName] = {
          firstTsMs: m.firstTsMs,
          lastActivityAt: new Date(m.lastTsMs || m.mtimeMs).toISOString(),
          mtimeMs: m.mtimeMs,
          model: tokenDrift ? SCHEMA_DRIFT_UNKNOWN : (m.model || 'codex'),
          usedTokens: tokenDrift ? SCHEMA_DRIFT_UNKNOWN : m.usedTokens,
          contextWindowSize: m.contextWindowSize,
          usedPercentage: tokenDrift ? SCHEMA_DRIFT_UNKNOWN : m.usedPercentage,
          source: 'codex-subagent-jsonl'
        };

        tasksMap[memberName] = {
          summary: `${m.role || 'subagent'} (${redactedCwd})`,
          status: isCompleted || isKilled ? 'completed' : (isWorking ? 'in_progress' : 'pending'),
          createdAt: new Date(m.firstTsMs).toISOString(),
          completedAt: isCompleted || isKilled ? new Date(m.mtimeMs).toISOString() : null
        };

        if (m.parentId && bySessionId.has(m.parentId)) {
          const p = bySessionId.get(m.parentId);
          const parentName = sanitizeSwarmIdPart(
            p.nickname || (p._resolvedId === rootId ? 'lead' : p._resolvedId.slice(0, 14)),
            'lead',
            42
          );
          boardEntries.push({
            seq: seq++,
            agent: parentName,
            text: `@${memberName} subagent spawned`,
            time: new Date(m.firstTsMs).toISOString(),
            kind: 'brief'
          });
          if (isCompleted || isKilled) {
            boardEntries.push({
              seq: seq++,
              agent: memberName,
              text: `@${parentName} [done] subagent task complete`,
              time: new Date(m.mtimeMs).toISOString(),
              kind: 'done'
            });
          }
        }
      }

      const rootMeta = bySessionId.get(rootId);
      const repoLabel = rootMeta?.cwd ? path.basename(rootMeta.cwd) : rootId.slice(0, 12);
      const title = `Codex Subagents (${repoLabel})`;

      const cluster = normalizeSwarmCluster({
        providerKind: this.providerKind,
        swarmId: rootId,
        rigId,
        title,
        createdAt: new Date(earliestMs).toISOString(),
        members: { title, members: membersMap },
        plan: {
          goal: { title, line: `Codex multi-agent thread tree (${Object.keys(membersMap).length} seats)` },
          tasks: tasksMap,
          threads: [{ id: rootId.slice(0, 12), title, tasks: Object.keys(tasksMap) }]
        },
        boardEntries,
        transcriptsByMember
      }, { includeKilled, nowMs, stallThresholdMs });

      out.push({
        cluster: redactSwarmValue(cluster, { homeDir }),
        gitWorktrees,
        driftFindings
      });
    }

    return out;
  }
}

export function createDefaultSwarmAdapters() {
  return [
    new AntigravitySwarmAdapter(),
    new ClaudeTeamsAdapter(),
    new CodexSubagentsAdapter()
  ];
}

/**
 * Discovers multi-vendor swarm sessions across Antigravity `/swarm`, Claude Teams,
 * and Codex subagents. Returns fully redacted telemetry structures alongside raw
 * `gitWorktrees` / `worktreePaths` for server-side `collectFleetGitRadar`.
 */
export async function discoverSwarmFleets({
  brainRoot = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
  claudeTeamsRoot = path.join(os.homedir(), '.claude', 'teams'),
  codexSessionsRoot = path.join(os.homedir(), '.codex', 'sessions'),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  includeKilled = false,
  stallThresholdMs,
  nowMs = Date.now(),
  useCache = true,
  adapters = null,
  driftGuard = null,
  homeDir = os.homedir()
} = {}) {
  const activeAdapters = Array.isArray(adapters) && adapters.length > 0
    ? adapters
    : createDefaultSwarmAdapters();
  const effectiveDriftGuard = driftGuard === false ? null : (driftGuard || defaultDriftGuard);

  const perAdapterResults = await Promise.all(
    activeAdapters.map(adapter =>
      adapter.discover({
        brainRoot,
        claudeTeamsRoot,
        codexSessionsRoot,
        maxAgeMs,
        includeKilled,
        stallThresholdMs,
        nowMs,
        useCache,
        driftGuard: effectiveDriftGuard,
        homeDir
      }).catch(() => [])
    )
  );

  const swarms = [];
  const availableRigs = [];
  const nodes = [];
  const edges = [];
  const ganttItems = [];
  const gitWorktrees = [];
  const worktreePathSet = new Set();
  const driftFindings = [];
  const adapterCounts = {};

  activeAdapters.forEach((adapter, idx) => {
    const items = Array.isArray(perAdapterResults[idx]) ? perAdapterResults[idx] : [];
    adapterCounts[adapter.providerKind || `adapter_${idx}`] = items.length;
    for (const item of items) {
      if (!item || !item.cluster) continue;
      const safeCluster = redactSwarmValue(item.cluster, { homeDir });
      swarms.push(safeCluster);
      if (safeCluster.rig) availableRigs.push(safeCluster.rig);
      if (Array.isArray(safeCluster.nodes)) nodes.push(...safeCluster.nodes);
      if (Array.isArray(safeCluster.edges)) edges.push(...safeCluster.edges);
      if (Array.isArray(safeCluster.ganttItems)) ganttItems.push(...safeCluster.ganttItems);
      if (Array.isArray(item.gitWorktrees)) {
        for (const wt of item.gitWorktrees) {
          if (!wt || !wt.path) continue;
          gitWorktrees.push(wt);
          worktreePathSet.add(wt.path);
        }
      }
      if (Array.isArray(item.driftFindings)) {
        for (const f of item.driftFindings) {
          driftFindings.push(redactSwarmValue(f, { homeDir }));
        }
      }
    }
  });

  return {
    swarms,
    availableRigs,
    nodes,
    edges,
    ganttItems,
    gitWorktrees,
    worktreePaths: Array.from(worktreePathSet),
    driftFindings,
    stats: {
      scannedAt: new Date(nowMs).toISOString(),
      clusterCount: swarms.length,
      nodeCount: nodes.length,
      adapterCounts
    }
  };
}
