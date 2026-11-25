/**
 * Tier 0: Heuristic Signal Scorer + Symbolic Expert Rule Engine.
 * Runs synchronously in < 2ms with $0 cost, handles ~90% routine cases,
 * computes epistemic uncertainty U0, reads ActionAuditLog anti-repeat feedback,
 * and enforces non-overridable Hard Safety Vetoes (Expert > AI).
 */

import { classifyTerminalScreen, getLiveHitlOptions } from '../../assets/domain/prompt-parser.js';
import { isPiHarness } from '../../assets/ontology/actions.js';
import { EVAL_RISK_LEVELS, EVAL_TIERS } from '../../assets/domain/evaluator-model.js';

const DESTRUCTIVE_VETO_PATTERNS = [
  { id: 'rm_rf', re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)\b/i, label: 'rm -rf (recursive deletion)' },
  { id: 'git_force_push', re: /\bgit\s+push\b[^\n]*(\s--force\b|\s--force-with-lease\b|\s-f\b)/i, label: 'git push --force' },
  { id: 'git_hard_reset', re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, label: 'git reset --hard / clean -f' },
  { id: 'sql_ddl', re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE|ALTER\s+TABLE)\b/i, label: 'SQL DDL/destructive schema change' },
  { id: 'chmod_777', re: /\bchmod\s+(-R\s+)?0?777\b/i, label: 'chmod 777' },
  { id: 'curl_pipe_sh', re: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/i, label: 'curl/wget piped to shell' },
  { id: 'sudo_cmd', re: /(?:^|[\s$`(])sudo\s+/m, label: 'sudo privilege escalation' },
  { id: 'secret_file_access', re: /(~\/\.ssh\b|id_rsa\b|\.env(\.local|\.prod|\.production)?\b)/i, label: 'Sensitive credential / .env / SSH access' },
  { id: 'publish_prod', re: /\b(npm\s+publish|vercel\s+--prod|git\s+push\s+origin\s+(main|master|prod))\b/i, label: 'Production publish / push' }
];

const SHELL_METACHAR_RE = /[;|&`><]|\$\(/;

const SAFE_READONLY_COMMAND_RE = /^(?:npm\s+test|npx\s+vitest(?:\s+[a-zA-Z0-9._/-]+)?|npx\s+playwright\s+test(?:\s+[a-zA-Z0-9._/-]+)?|pytest(?:\s+[a-zA-Z0-9._/-]+)?|git\s+(?:status|diff|log)(?:\s+[a-zA-Z0-9._/@~^-]+)*|ls(?:\s+-[a-zA-Z0-9]+)?(?:\s+[a-zA-Z0-9._/-]+)?|rg\s+[a-zA-Z0-9._"'/-]+|cat\s+[a-zA-Z0-9._/-]+)$/;

function clamp01(val) {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, +val.toFixed(4)));
}

function extractPromptCommandRegion(screenText) {
  const lines = String(screenText || '').replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '').split(/\r?\n/);
  const tail = lines.slice(-32);
  return tail.join('\n');
}

function extractCandidateCommandLine(promptRegion) {
  const lines = String(promptRegion || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Match explicit command preview lines like "$ npm test", "Command: git status", "Run: ..."
    const m = line.match(/^(?:\$|›\s*\$|Command:|Run:|Bash:|Shell:)\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

/**
 * Symbolic HITL risk classifier (Tier 0B): catches hard destructive vetoes and pure read-only test commands.
 */
export function evaluateHitlRiskRules(screenText = '', parsedOptions = null) {
  const region = extractPromptCommandRegion(screenText);
  const opts = Array.isArray(parsedOptions) ? parsedOptions : getLiveHitlOptions(screenText);
  const hardVetoes = [];

  for (const pat of DESTRUCTIVE_VETO_PATTERNS) {
    if (pat.re.test(region)) {
      hardVetoes.push({ ruleId: `E-VETO-${pat.id.toUpperCase()}`, reason: pat.label });
    }
  }

  if (hardVetoes.length > 0) {
    return {
      riskLevel: EVAL_RISK_LEVELS.BLOCK,
      confidence: 0.99,
      promptAmbiguity: 0.05,
      hardVetoes,
      matchedRule: 'E-VETO-DESTRUCTIVE-CMD',
      safeReadOnly: false
    };
  }

  const candidateCmd = extractCandidateCommandLine(region);
  const isCleanReadOnly = Boolean(
    candidateCmd &&
    !SHELL_METACHAR_RE.test(candidateCmd) &&
    SAFE_READONLY_COMMAND_RE.test(candidateCmd)
  );

  if (isCleanReadOnly && opts.length >= 2) {
    return {
      riskLevel: EVAL_RISK_LEVELS.SAFE,
      confidence: 0.93,
      promptAmbiguity: 0.12,
      hardVetoes: [],
      matchedRule: 'E-RES-SAFE-READONLY-HITL',
      safeReadOnly: true,
      candidateCmd
    };
  }

  return {
    riskLevel: EVAL_RISK_LEVELS.REVIEW,
    confidence: 0.42,
    promptAmbiguity: 0.85,
    hardVetoes: [],
    matchedRule: null,
    safeReadOnly: false,
    candidateCmd
  };
}

/**
 * Extracts actionIds that recently ended in postcondition='unchanged' or 'failed'
 * for this target seat (closed-loop anti-repeat feedback).
 */
export function extractFailedActionIds(auditRecords = [], seatId = '', nowMs = Date.now(), windowMs = 15 * 60_000) {
  const failed = new Set();
  if (!Array.isArray(auditRecords) || !seatId) return failed;
  for (const rec of auditRecords) {
    if (!rec || rec.targetSeatId !== seatId) continue;
    const ts = rec.executedAt ? Date.parse(rec.executedAt) : 0;
    if (ts > 0 && (nowMs - ts) > windowMs) continue;
    if (rec.postconditionStatus === 'unchanged' || rec.postconditionStatus === 'failed') {
      if (rec.actionId) failed.add(rec.actionId);
    }
  }
  return failed;
}

/**
 * Layer 0A: Continuous Heuristic Signal Scorer + Epistemic Uncertainty U0.
 */
export function computeHeuristicSignals({
  isUrgent = false,
  ctxPct = null,
  pendingRealCount = 0,
  maxWaitMin = 0,
  qaRounds = 0,
  bounceCount = 0,
  wwr = 0,
  promptAmbiguity = 0,
  failedActionCount = 0
} = {}) {
  const ctxSignal = typeof ctxPct === 'number' ? clamp01((ctxPct - 55) / 30) : 0;
  const queueSignal = clamp01(pendingRealCount / 4);
  const waitSignal = clamp01(maxWaitMin / 30);
  const urgency = clamp01(Math.max(isUrgent ? 1.0 : 0, ctxSignal, queueSignal, waitSignal * 0.85));
  const loopFriction = clamp01(
    Math.max(0, qaRounds - 1) * 0.35 +
    bounceCount * 0.25 +
    (wwr >= 1.8 ? 0.25 : 0)
  );
  const interventionFailure = clamp01(failedActionCount * 0.5);
  const uncertaintyU0 = clamp01(
    0.55 * promptAmbiguity +
    0.25 * loopFriction +
    0.20 * interventionFailure
  );

  return {
    urgency,
    loopFriction,
    promptAmbiguity: clamp01(promptAmbiguity),
    interventionFailure,
    uncertaintyU0
  };
}

/**
 * Full Tier 0 evaluation (Heuristics 0A + Symbolic Expert System 0B).
 */
export function evaluateTier0({
  scope = 'seat',
  targetId = '',
  seat = null,
  screenText = '',
  findings = [],
  auditRecords = [],
  sliceMetrics = null,
  lang = 'ru',
  nowMs = Date.now()
} = {}) {
  const t0 = Date.now();
  const isEn = lang === 'en';
  const seatId = seat?.id || seat?.canonicalSessionName || (scope === 'seat' ? targetId : '');
  const shortName = seatId ? seatId.split('@')[0] : (targetId || 'fleet');

  const screenClass = screenText ? classifyTerminalScreen(screenText, seat?.harness || seat?.runtime || '') : null;
  const parsedOptions = screenText ? getLiveHitlOptions(screenText) : [];

  const isUrgent = Boolean(
    seat?.state === 'urgent' ||
    seat?.activityState?.display === 'needs-input' ||
    (seat?.activityState?.needsInput?.count || 0) > 0 ||
    screenClass?.state === 'needs-input'
  );
  const isWorking = Boolean(
    seat?.state === 'working' ||
    seat?.activityState?.display === 'working' ||
    screenClass?.state === 'working'
  );
  const isShellExited = Boolean(seat?.shellExited || screenClass?.shellExited);
  const isParked = Boolean(seat?.parkedData?.parked || seat?.isParked);
  const isPi = isPiHarness(seat || { id: seatId, harness: seat?.harness || seat?.runtime || '' });
  const ctxPct = typeof seat?.ctxPct === 'number'
    ? seat.ctxPct
    : (typeof seat?.contextUsage?.usedPercentage === 'number' ? seat.contextUsage.usedPercentage : null);

  const seatFindings = (Array.isArray(findings) ? findings : []).filter(f => {
    if (!seatId) return true;
    const seats = f?.metrics?.affectedSeats || [];
    return seats.includes(seatId) || f?.actionPlan?.seatTarget === seatId;
  });

  const bottleneckFinding = seatFindings.find(f => f.detectorId === 'topology.bottleneck');
  const pendingRealCount = Number(
    bottleneckFinding?.metrics?.pendingCount ??
    seat?.assignedWorkCount ??
    0
  );
  const maxWaitMin = Number(bottleneckFinding?.metrics?.avgWaitMin ?? sliceMetrics?.maxWaitMin ?? 0);
  const wwr = Number(bottleneckFinding?.metrics?.wwr ?? sliceMetrics?.wwr ?? 0);
  const qaRounds = Number(sliceMetrics?.qaRounds ?? 0);
  const bounceCount = Number(sliceMetrics?.bounceCount ?? 0);

  const failedActionIds = extractFailedActionIds(auditRecords, seatId, nowMs);

  // Evaluate HITL screen risk rules if prompt is present or screen has destructive text
  const hitlEval = (isUrgent || parsedOptions.length >= 2)
    ? evaluateHitlRiskRules(screenText, parsedOptions)
    : { riskLevel: EVAL_RISK_LEVELS.SAFE, confidence: 0.9, promptAmbiguity: 0, hardVetoes: [], matchedRule: null, safeReadOnly: false };

  const signals = computeHeuristicSignals({
    isUrgent,
    ctxPct,
    pendingRealCount,
    maxWaitMin,
    qaRounds,
    bounceCount,
    wwr,
    promptAmbiguity: hitlEval.promptAmbiguity,
    failedActionCount: failedActionIds.size
  });

  const firedRules = [];
  const hardVetoes = [...hitlEval.hardVetoes];
  const forbiddenActionIds = [];
  const suggestedActions = [];
  const escalationTriggers = [];
  let forcedActionId = null;
  let forcedRationale = '';
  let riskLevel = hitlEval.riskLevel;
  let confidence = 0.85;
  let stopCascade = false;
  let recommendedTier = EVAL_TIERS.HEURISTIC;
  let headline = '';
  let summary = '';

  // --- Rule Group 1: Hard Safety Vetoes (E-VETO-*) ---
  if (hardVetoes.length > 0) {
    firedRules.push('E-VETO-DESTRUCTIVE-CMD');
    forbiddenActionIds.push('proceed_prompt', 'confirm_yes');
    riskLevel = EVAL_RISK_LEVELS.BLOCK;
    confidence = 0.99;
    headline = isEn
      ? `Expert Veto: destructive command detected on ${shortName}`
      : `Вето эксперта: опасная команда на ${shortName}`;
    summary = isEn
      ? `Blocked auto-approval due to hard safety pattern: ${hardVetoes.map(v => v.reason).join('; ')}. Inspect terminal manually.`
      : `Сработало жёсткое правило безопасности: ${hardVetoes.map(v => v.reason).join('; ')}. Проверьте терминал вручную перед любым ответом.`;
    suggestedActions.push({
      actionId: 'cancel_prompt',
      seatId,
      rationale: isEn ? 'Cancel dangerous prompt (Escape)' : 'Отменить опасный промпт (Escape)'
    });
    suggestedActions.push({
      actionId: 'open_live_terminal',
      seatId,
      rationale: isEn ? 'Inspect full tmux buffer' : 'Открыть полный экран tmux'
    });
  }

  if (isShellExited) {
    firedRules.push('E-VETO-SHELL-EXITED');
    hardVetoes.push({ ruleId: 'E-VETO-SHELL-EXITED', reason: 'Agent process exited to bare OS shell' });
    forbiddenActionIds.push('wake_parked_seat', 'nudge_queue', 'compact_context');
    forcedActionId = 'copy_restart_shell';
    forcedRationale = isEn
      ? `Agent exited to bare shell — copy rig restart ${seatId}`
      : `Процесс агента вышел в shell — перезапустите через rig restart ${seatId}`;
    riskLevel = EVAL_RISK_LEVELS.REVIEW;
    confidence = 0.98;
    stopCascade = true;
    headline = isEn
      ? `Expert: ${shortName} exited to bare shell`
      : `Эксперт: ${shortName} вышел в голый shell`;
    summary = forcedRationale;
    suggestedActions.unshift({ actionId: 'copy_restart_shell', seatId, rationale: forcedRationale });
  }

  if (isPi && typeof ctxPct === 'number' && ctxPct >= 65) {
    firedRules.push('E-VETO-PI-COMPACT');
    forbiddenActionIds.push('compact_context');
    if (!forcedActionId) {
      forcedActionId = 'copy_restart_seat';
      forcedRationale = isEn
        ? `Pi harness does not support /compact — rotate with rig restart ${seatId}`
        : `Харнес Pi не поддерживает /compact — ротация через rig restart ${seatId}`;
    }
  }

  // --- Rule Group 2: Slice / Multi-Seat Deep Escalation Triggers (E-ESC-S2-*) ---
  if (scope === 'slice' || qaRounds >= 3 || bounceCount >= 2) {
    if (qaRounds >= 3 || bounceCount >= 2) {
      firedRules.push('E-ESC-S2-QA-LOOP');
      escalationTriggers.push('qa_bounce_loop');
      recommendedTier = EVAL_TIERS.SYSTEM2;
      riskLevel = EVAL_RISK_LEVELS.REVIEW;
      confidence = 0.62;
      headline = isEn
        ? `QA rework loop detected (${qaRounds} rounds) on ${shortName}`
        : `Петля возвратов QA (${qaRounds} кр.) на ${shortName}`;
      summary = isEn
        ? 'Repeated QA bounce-backs indicate spec mismatch or recurring boundary failure — run System 2 to analyze Handoff Flow.'
        : 'Повторяющиеся возвраты QA указывают на конфликт критериев или системную ошибку — запустите 🧠 S2 для разбора Handoff Flow.';
      suggestedActions.push({
        actionId: 'open_gantt_slice',
        seatId,
        rationale: isEn ? 'Inspect Handoff Flow in Gantt' : 'Открыть поток передач в Ганте'
      });
    } else if (scope === 'slice') {
      firedRules.push('E-ESC-S2-SLICE-REVIEW');
      escalationTriggers.push('slice_flow_analysis');
      recommendedTier = EVAL_TIERS.SYSTEM2;
      riskLevel = EVAL_RISK_LEVELS.REVIEW;
      confidence = 0.65;
      headline = isEn
        ? `Slice flow assessment: ${targetId}`
        : `Оценка цепочки слайса: ${targetId}`;
      summary = isEn
        ? `Wait ratio / flow metrics collected for ${targetId}. Escalate to System 2 for cross-seat root-cause synthesis.`
        : `Собраны метрики потока для ${targetId}. Запустите 🧠 S2 для многоагентного разбора первопричины.`;
    }
  }

  if (pendingRealCount >= 3 && wwr >= 2.2) {
    firedRules.push('E-ESC-S2-MULTI-SEAT-JAM');
    escalationTriggers.push('multi_seat_jam');
    if (recommendedTier !== EVAL_TIERS.SYSTEM2) recommendedTier = EVAL_TIERS.SYSTEM2;
  }

  // --- Rule Group 3: System 1 Tactical Escalation Triggers (E-ESC-S1-*) ---
  if (isUrgent && hitlEval.promptAmbiguity >= 0.5 && hardVetoes.length === 0) {
    firedRules.push('E-ESC-S1-AMBIGUOUS-HITL');
    escalationTriggers.push('ambiguous_hitl');
    if (recommendedTier === EVAL_TIERS.HEURISTIC) recommendedTier = EVAL_TIERS.SYSTEM1;
    riskLevel = EVAL_RISK_LEVELS.REVIEW;
    confidence = 0.48;
    headline = isEn
      ? `Ambiguous HITL prompt on ${shortName} — S1 triage recommended`
      : `Неоднозначный HITL-промпт на ${shortName} — нужен быстрый триаж S1`;
    summary = isEn
      ? 'Command does not match a known safe read-only signature. Run S1 or open terminal to review.'
      : 'Команда не совпала с безопасным read-only шаблоном. Запустите ⚡ S1 или откройте экран tmux.';
    suggestedActions.push({
      actionId: 'open_live_terminal',
      seatId,
      rationale: isEn ? 'Open live tmux capture' : 'Открыть экран tmux'
    });
  }

  if (failedActionIds.size > 0) {
    firedRules.push('E-ESC-S1-UNCHANGED-ACTION');
    escalationTriggers.push('postcondition_unchanged');
    if (recommendedTier === EVAL_TIERS.HEURISTIC) recommendedTier = EVAL_TIERS.SYSTEM1;
  }

  if (!isWorking && !isShellExited && !isUrgent && (pendingRealCount >= 1 || isParked)) {
    if (maxWaitMin >= 10 || failedActionIds.size > 0) {
      firedRules.push('E-ESC-S1-STALE-QUEUE');
      escalationTriggers.push('stale_queue_idle_prompt');
      if (recommendedTier === EVAL_TIERS.HEURISTIC) recommendedTier = EVAL_TIERS.SYSTEM1;
    }
    if (!headline) {
      riskLevel = EVAL_RISK_LEVELS.REVIEW;
      confidence = failedActionIds.size > 0 ? 0.55 : 0.84;
      headline = isEn
        ? `${shortName}: idle with ${pendingRealCount || 'open'} queued task(s)`
        : `${shortName}: простой при открытой очереди (${pendingRealCount || 'PARKED'})`;
      summary = isEn
        ? 'Seat is not executing despite open obligations. Use Process queue (rig queue list --owned) instead of bare Enter.'
        : 'Сиденье простаивает при открытых обязательствах. Используйте «Разобрать очередь» (rig queue list --owned) вместо пустого Enter.';
      if (!failedActionIds.has('nudge_queue')) {
        suggestedActions.push({
          actionId: 'nudge_queue',
          seatId,
          rationale: isEn ? 'Prompt seat to review rig queue list --owned' : 'Отправить промпт разбора rig queue list --owned'
        });
      }
    }
  }

  // --- Rule Group 4: Deterministic Fast-Resolve Rules (E-RES-*) ---
  if (!stopCascade && hardVetoes.length === 0 && escalationTriggers.length === 0) {
    if (isUrgent && hitlEval.safeReadOnly) {
      firedRules.push('E-RES-SAFE-READONLY-HITL');
      riskLevel = EVAL_RISK_LEVELS.SAFE;
      confidence = 0.93;
      stopCascade = true;
      headline = isEn
        ? `Expert: safe read-only prompt on ${shortName} (${hitlEval.candidateCmd})`
        : `Эксперт: безопасный read-only промпт на ${shortName} (${hitlEval.candidateCmd})`;
      summary = isEn
        ? 'Matches allowlisted read-only/test command with zero shell metacharacters. Safe to proceed.'
        : 'Команда совпала со списком безопасных read-only/test проверок без опасных операторов оболочки.';
      suggestedActions.push({
        actionId: 'proceed_prompt',
        seatId,
        rationale: isEn ? 'Approve option 1' : 'Подтвердить вариант 1'
      });
    } else if (!isUrgent && typeof ctxPct === 'number' && ctxPct >= 75 && signals.loopFriction < 0.4) {
      firedRules.push('E-RES-CTX-OVERHEAT');
      riskLevel = EVAL_RISK_LEVELS.REVIEW;
      confidence = 0.92;
      stopCascade = true;
      headline = isEn
        ? `Expert: context overheated on ${shortName} (${ctxPct}%)`
        : `Эксперт: перегрев контекста на ${shortName} (${ctxPct}%)`;
      summary = isPi
        ? (isEn ? 'Pi harness requires seat rotation (rig restart) instead of /compact.' : 'Харнес Pi требует ротации (rig restart) вместо /compact.')
        : (isEn ? 'Context >= 75% elevates QA rework risk. Run /compact before the next task.' : 'Контекст >= 75% повышает риск возвратов QA. Выполните /compact.');
      suggestedActions.push({
        actionId: isPi ? 'copy_restart_seat' : 'compact_context',
        seatId,
        rationale: isPi ? `rig restart ${seatId}` : '/compact'
      });
    } else if (!isUrgent && !isParked && pendingRealCount === 0 && (ctxPct === null || ctxPct < 65)) {
      firedRules.push('E-RES-HEALTHY-IDLE');
      riskLevel = EVAL_RISK_LEVELS.SAFE;
      confidence = 0.97;
      stopCascade = true;
      headline = isEn
        ? `Expert: ${shortName} is healthy (${isWorking ? 'working' : 'idle'})`
        : `Эксперт: ${shortName} в штатном режиме (${isWorking ? 'работает' : 'свободен'})`;
      summary = isEn
        ? 'No blockers, no context overheating, and no pending queue congestion.'
        : 'Блокеров, перегрева контекста и затора очереди не обнаружено.';
    }
  }

  if (!headline) {
    headline = isEn
      ? `Expert baseline for ${shortName}`
      : `Базовая экспертная оценка для ${shortName}`;
    summary = seatFindings[0]?.summary || (isEn ? 'Baseline telemetry collected.' : 'Собрана базовая телеметрия узла.');
  }

  const durationMs = Math.max(1, Date.now() - t0);
  return {
    scope,
    targetId: targetId || seatId,
    targetSeatId: seatId,
    riskLevel,
    confidence,
    signals,
    uncertaintyU0: signals.uncertaintyU0,
    firedRules,
    hardVetoes,
    forbiddenActionIds,
    forcedActionId,
    forcedRationale,
    failedActionIds: Array.from(failedActionIds),
    escalationTriggers,
    stopCascade,
    recommendedTier,
    headline,
    summary,
    suggestedActions,
    facts: {
      targetSeatId: seatId,
      targetId: targetId || seatId,
      shortName,
      isUrgent,
      isWorking,
      isParked,
      isShellExited,
      isPi,
      ctxPct,
      pendingRealCount,
      maxWaitMin,
      wwr,
      qaRounds,
      bounceCount,
      parsedOptionsCount: parsedOptions.length
    },
    durationMs
  };
}
