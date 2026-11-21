import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseInteractivePromptOptions } from '../assets/domain/prompt-parser.js';

const execFileAsync = promisify(execFile);

const AGENT_CMD_RE = /(claude|codex|aider|gemini|agy|pi|opencode|goose)/i;
const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|(?:Thinking|Reasoning|Running|Working|Searching|Executing)\.{0,3}\s*$/im;
const PROMPT_CONFIRM_RE = /(?:allow\b.*\?|proceed\?|\[y\/n\]|\(y\/n\)|press enter to confirm|permission prompt)/i;

export function sanitizeIdPart(raw, fallback = 'seat') {
  const clean = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return clean || fallback;
}

export function isValidTmuxTarget(target) {
  return /^(%\d+|[a-zA-Z0-9._-]+:\d+\.\d+)$/.test(String(target || ''));
}

export function inferContextWindow(model = '', runtime = '') {
  const m = String(model || '').toLowerCase();
  if (/gemini|glm/i.test(m)) return 1_000_000;
  if (/sol|gpt-6/i.test(m)) return 475_000;
  if (/gpt-5|codex|o[134]/i.test(m)) return 272_000;
  if (/claude|sonnet|opus|haiku/i.test(m) || String(runtime).includes('claude')) return 200_000;
  if (/deepseek/i.test(m)) return 258_400;
  return 200_000;
}

export function inferRuntimeFromPane(pane) {
  const hay = `${pane.command || ''} ${pane.title || ''}`.toLowerCase();
  if (/claude/.test(hay)) return 'claude-code';
  if (/codex/.test(hay)) return 'codex';
  if (/\bpi\b/.test(hay)) return 'pi';
  if (/gemini|agy/.test(hay)) return 'terminal';
  if (AGENT_CMD_RE.test(hay)) return 'terminal';
  return null;
}

/**
 * Parses `tmux list-panes -a -F "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_active}"`
 */
export function parseTmuxPaneLines(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const panes = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const [sessionName, winIdx, paneIdx, paneId, command, cwd, title = '', active = '0'] = parts;
    const target = isValidTmuxTarget(paneId) ? paneId : `${sessionName}:${winIdx}.${paneIdx}`;
    if (!isValidTmuxTarget(target)) continue;
    panes.push({
      sessionName: sessionName || 'tmux',
      winIdx: winIdx || '0',
      paneIdx: paneIdx || '0',
      paneId: paneId || target,
      target,
      command: command || '',
      cwd: cwd || '',
      title: title || '',
      active: active === '1'
    });
  }
  return panes;
}

/**
 * Classifies a universal tmux pane screen capture + transcript age into OpenRig-compatible activityState.
 */
export function detectUniversalPaneState(screenText = '', transcriptAgeMs = Infinity) {
  const parsedOptions = parseInteractivePromptOptions(screenText);
  const tail = String(screenText || '').split(/\r?\n/).slice(-10).join('\n');
  const hasPrompt = parsedOptions.length >= 2 || PROMPT_CONFIRM_RE.test(tail);

  if (hasPrompt) {
    return {
      display: 'needs-input',
      needsInput: {
        count: 1,
        reason: parsedOptions.length >= 2 ? `menu (${parsedOptions.length} options)` : 'permission_prompt'
      }
    };
  }

  if (SPINNER_RE.test(tail) || (Number.isFinite(transcriptAgeMs) && transcriptAgeMs < 20_000)) {
    return {
      display: 'working',
      needsInput: { count: 0, reason: '' }
    };
  }

  return {
    display: 'idle',
    needsInput: { count: 0, reason: '' }
  };
}

/**
 * Reads lightweight head+tail metadata (cwd, model, last context tokens) from a Claude/Codex JSONL file.
 */
export async function inspectTranscriptMetadata(filePath, runtimeHint = '') {
  let fh = null;
  try {
    const stat = await fs.stat(filePath);
    fh = await fs.open(filePath, 'r');
    const headLen = Math.min(stat.size, 16 * 1024);
    const tailLen = Math.min(stat.size, 32 * 1024);
    const headBuf = Buffer.allocUnsafe(headLen);
    await fh.read(headBuf, 0, headLen, 0);

    let tailText = '';
    if (stat.size > headLen) {
      const tailBuf = Buffer.allocUnsafe(tailLen);
      await fh.read(tailBuf, 0, tailLen, Math.max(0, stat.size - tailLen));
      tailText = tailBuf.toString('utf-8');
    } else {
      tailText = headBuf.toString('utf-8');
    }

    const headText = headBuf.toString('utf-8');
    let cwd = '';
    let model = '';
    let lastContextTokens = null;
    let runtime = runtimeHint || 'terminal';

    for (const line of headText.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const obj = JSON.parse(line);
        if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
        if (!cwd && obj.payload && typeof obj.payload.cwd === 'string') cwd = obj.payload.cwd;
        if (!model && obj.message && typeof obj.message.model === 'string') model = obj.message.model;
        if (!model && obj.payload && typeof obj.payload.model === 'string') model = obj.payload.model;
        if (obj.type === 'session_meta' || obj.type === 'event_msg') runtime = 'codex';
        if (obj.type === 'assistant' && obj.message && obj.message.usage) runtime = 'claude-code';
      } catch {
        // ignore partial head line
      }
    }

    const tailLines = tailText.split('\n');
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i].trim();
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line);
        if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
        if (obj.type === 'assistant' && obj.message && obj.message.usage) {
          const u = obj.message.usage;
          if (!model && typeof obj.message.model === 'string') model = obj.message.model;
          const totalIn =
            (Number(u.input_tokens) || 0) +
            (Number(u.cache_creation_input_tokens) || 0) +
            (Number(u.cache_read_input_tokens) || 0);
          if (totalIn > 0 && lastContextTokens === null) {
            lastContextTokens = totalIn;
          }
          runtime = 'claude-code';
        } else if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count') {
          const info = obj.payload.info || {};
          const lastU = info.last_token_usage || info.total_token_usage;
          if (lastU && lastContextTokens === null) {
            const inp = Number(lastU.input_tokens) || 0;
            if (inp > 0) lastContextTokens = inp;
          }
          if (!model && typeof obj.payload.model === 'string') model = obj.payload.model;
          runtime = 'codex';
        }
        if (model && lastContextTokens !== null && cwd) break;
      } catch {
        // ignore partial tail line
      }
    }

    const ctxWindow = inferContextWindow(model, runtime);
    const usedPercentage =
      typeof lastContextTokens === 'number' && ctxWindow > 0
        ? Math.min(100, Math.round((lastContextTokens / ctxWindow) * 100))
        : null;

    return {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      runtime,
      cwd,
      model: model || (runtime === 'claude-code' ? 'claude-sonnet-4' : runtime === 'codex' ? 'codex' : 'terminal'),
      usedTokens: lastContextTokens,
      contextWindowSize: ctxWindow,
      usedPercentage
    };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function collectJsonlFiles(dir, maxDepth, maxAgeMs, nowMs, out, depth = 0) {
  if (depth > maxDepth || out.length >= 40) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= 40) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await collectJsonlFiles(full, maxDepth, maxAgeMs, nowMs, out, depth + 1);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      try {
        const st = await fs.stat(full);
        if (nowMs - st.mtimeMs <= maxAgeMs && st.size > 0) {
          out.push({ filePath: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // skip unreadable
      }
    }
  }
}

/**
 * Scans ~/.claude/projects and ~/.codex/sessions for recent active JSONL transcripts.
 */
export async function discoverRecentTranscripts({
  claudeDir = path.join(os.homedir(), '.claude', 'projects'),
  codexDir = path.join(os.homedir(), '.codex', 'sessions'),
  maxAgeMs = 6 * 3600 * 1000,
  nowMs = Date.now(),
  limit = 16
} = {}) {
  const candidates = [];
  await Promise.all([
    collectJsonlFiles(claudeDir, 2, maxAgeMs, nowMs, candidates, 0).then(() => {}),
    collectJsonlFiles(codexDir, 4, maxAgeMs, nowMs, candidates, 0).then(() => {})
  ]);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, limit);
  const metas = await Promise.all(
    top.map(c => {
      const hint = c.filePath.startsWith(claudeDir) ? 'claude-code' : 'codex';
      return inspectTranscriptMetadata(c.filePath, hint);
    })
  );
  return metas.filter(Boolean);
}

/**
 * Discovers local AI coding agents via plain tmux panes + Claude Code / Codex JSONL transcripts.
 * Returns OpenRig-compatible { availableRigs, nodes, tmuxTargets } so the entire Ontology,
 * FinOps, HITL prompt parser, and Action Audit pipeline works identically without OpenRig!
 */
export async function discoverUniversalFleet({
  tmuxBin = 'tmux',
  claudeDir = path.join(os.homedir(), '.claude', 'projects'),
  codexDir = path.join(os.homedir(), '.codex', 'sessions'),
  maxAgeMs = 6 * 3600 * 1000,
  nowMs = Date.now(),
  execTmux = null
} = {}) {
  const runTmux = execTmux || (async (args) => {
    try {
      const { stdout } = await execFileAsync(tmuxBin, args, { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
      return stdout || '';
    } catch {
      return '';
    }
  });

  const [panesRaw, transcripts] = await Promise.all([
    runTmux([
      'list-panes', '-a', '-F',
      '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_active}'
    ]),
    discoverRecentTranscripts({ claudeDir, codexDir, maxAgeMs, nowMs })
  ]);

  const panes = parseTmuxPaneLines(panesRaw);
  const matchedTranscriptPaths = new Set();
  const nodes = [];
  const tmuxTargets = new Map();
  const usedSeatIds = new Set();
  const rigCounts = new Map();

  const registerRig = (rigName, isWorking) => {
    const cur = rigCounts.get(rigName) || { nodeCount: 0, runningCount: 0 };
    cur.nodeCount += 1;
    if (isWorking) cur.runningCount += 1;
    rigCounts.set(rigName, cur);
  };

  // 1. Match tmux panes running AI agents (or sharing CWD with an active Claude/Codex transcript)
  for (const pane of panes) {
    const inferredRuntime = inferRuntimeFromPane(pane);
    const matchingTr = transcripts.find(tr =>
      !matchedTranscriptPaths.has(tr.filePath) &&
      tr.cwd && pane.cwd &&
      (pane.cwd === tr.cwd || pane.cwd.startsWith(tr.cwd + path.sep) || tr.cwd.startsWith(pane.cwd + path.sep))
    );

    if (!inferredRuntime && !matchingTr) continue;
    if (matchingTr) matchedTranscriptPaths.add(matchingTr.filePath);

    const runtime = (matchingTr && matchingTr.runtime) || inferredRuntime || 'terminal';
    const rigName = sanitizeIdPart(path.basename(pane.cwd || pane.sessionName || 'local-tmux'), 'local-tmux');
    const baseSeat = sanitizeIdPart(`${pane.sessionName}-${pane.winIdx}-${pane.paneIdx}`, 'pane');
    let seatId = `${baseSeat}@${rigName}`;
    let suffix = 2;
    while (usedSeatIds.has(seatId)) {
      seatId = `${baseSeat}-${suffix++}@${rigName}`;
    }
    usedSeatIds.add(seatId);

    const screenText = await runTmux(['capture-pane', '-p', '-t', pane.target, '-S', '-30']);
    const trAgeMs = matchingTr ? Math.max(0, nowMs - matchingTr.mtimeMs) : Infinity;
    const actState = detectUniversalPaneState(screenText, trAgeMs);
    const model = (matchingTr && matchingTr.model) || (runtime === 'claude-code' ? 'claude-sonnet-4' : runtime === 'codex' ? 'codex' : pane.command || 'terminal');

    tmuxTargets.set(seatId, pane.target);
    registerRig(rigName, actState.display === 'working');

    nodes.push({
      canonicalSessionName: seatId,
      rigId: rigName,
      runtime,
      nodeKind: 'agent',
      resolvedSpecName: `${runtime} (tmux)`,
      cwd: pane.cwd || rigName,
      model,
      modelObservation: { model },
      activityState: actState,
      assignedWorkCount: actState.display === 'working' ? 1 : 0,
      lastActivityAt: new Date(matchingTr ? matchingTr.mtimeMs : nowMs).toISOString(),
      tmuxAttachCommand: `tmux attach -t ${pane.sessionName}`,
      contextUsage: matchingTr ? {
        usedPercentage: matchingTr.usedPercentage,
        usedTokens: matchingTr.usedTokens,
        contextWindowSize: matchingTr.contextWindowSize,
        transcriptPath: matchingTr.filePath,
        source: 'universal-jsonl',
        sampledAt: new Date(matchingTr.mtimeMs).toISOString()
      } : null
    });
  }

  // 2. Standalone recent Claude Code / Codex JSONL sessions (even when not inside tmux!)
  const seenStandaloneByDir = new Set();
  for (const tr of transcripts) {
    if (matchedTranscriptPaths.has(tr.filePath)) continue;
    const repoName = sanitizeIdPart(
      tr.cwd ? path.basename(tr.cwd) : path.basename(path.dirname(tr.filePath)),
      'local'
    );
    const dedupKey = `${tr.runtime}:${repoName}`;
    if (seenStandaloneByDir.has(dedupKey)) continue;
    seenStandaloneByDir.add(dedupKey);

    const rigName = tr.runtime === 'claude-code' ? 'claude-local' : 'codex-local';
    const baseSeat = sanitizeIdPart(`${tr.runtime === 'claude-code' ? 'claude' : 'codex'}-${repoName}`, 'session');
    let seatId = `${baseSeat}@${rigName}`;
    let suffix = 2;
    while (usedSeatIds.has(seatId)) {
      seatId = `${baseSeat}-${suffix++}@${rigName}`;
    }
    usedSeatIds.add(seatId);

    const ageMs = Math.max(0, nowMs - tr.mtimeMs);
    const isWorking = ageMs < 20_000;
    registerRig(rigName, isWorking);

    nodes.push({
      canonicalSessionName: seatId,
      rigId: rigName,
      runtime: tr.runtime,
      nodeKind: 'agent',
      resolvedSpecName: `${tr.runtime} (JSONL)`,
      cwd: tr.cwd || repoName,
      model: tr.model,
      modelObservation: { model: tr.model },
      activityState: {
        display: isWorking ? 'working' : 'idle',
        needsInput: { count: 0, reason: '' }
      },
      assignedWorkCount: isWorking ? 1 : 0,
      lastActivityAt: new Date(tr.mtimeMs).toISOString(),
      tmuxAttachCommand: `ls -la ${tr.filePath}`,
      contextUsage: {
        usedPercentage: tr.usedPercentage,
        usedTokens: tr.usedTokens,
        contextWindowSize: tr.contextWindowSize,
        transcriptPath: tr.filePath,
        source: 'universal-jsonl',
        sampledAt: new Date(tr.mtimeMs).toISOString()
      }
    });
  }

  const availableRigs = Array.from(rigCounts.entries()).map(([name, c]) => ({
    id: name,
    name,
    status: c.runningCount > 0 ? 'running' : 'idle',
    nodeCount: c.nodeCount,
    runningCount: c.runningCount,
    activeCount: c.runningCount,
    hasWorkCount: c.runningCount
  }));

  return { availableRigs, nodes, tmuxTargets };
}
