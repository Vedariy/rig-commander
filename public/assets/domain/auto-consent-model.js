/**
 * Scoped Opt-In Auto-Consent Policy Engine — Pure Zero-DOM Domain Model.
 * Deterministic, fail-closed policy resolution (Global -> Project -> Agent -> Ephemeral Session),
 * single-source-of-truth Hard Safety Vetoes (shared with Tier 0 Expert Rules),
 * Option-1-Only invariant, Permission-vs-Question gate, and anti-loop/CTX/rate guards.
 *
 * Pure native ESM: zero npm dependencies, zero DOM or Node-only imports.
 * Directly importable in both browser ES modules and Node.js (>= 18).
 */

import {
  getLiveHitlOptions,
  parseInteractivePromptOptions,
  getHitlPromptPresentation,
  classifyTerminalScreen
} from './prompt-parser.js';
import { SAFE_RIG_NAME_RE, SAFE_SEAT_ID_RE } from './resilience-model.js';

export const AUTO_CONSENT_SCHEMA_VERSION = 1;

export const AUTO_CONSENT_MODES = Object.freeze({
  DRY_RUN: 'dry_run',
  ARMED: 'armed'
});

export const AUTO_CONSENT_PROFILES = Object.freeze({
  OFF: 'off',
  MANUAL_ONLY: 'manual_only',
  SAFE_READONLY: 'safe_readonly',
  TRUSTED_DEV: 'trusted_dev',
  SPRINT_ALL: 'sprint_all'
});

export const AUTO_CONSENT_LIMITS = Object.freeze({
  MIN_GRACE_MS: 1500,
  MAX_GRACE_MS: 10000,
  DEFAULT_GRACE_MS: 3000,
  MIN_SESSION_TTL_MS: 60_000,
  MAX_SESSION_TTL_MS: 2 * 3_600_000,
  DEFAULT_SESSION_TTL_MS: 60 * 60_000,
  MAX_SPRINT_APPROVALS: 40,
  MAX_SESSION_APPROVALS: 100,
  DEFAULT_SESSION_APPROVALS: 25,
  MIN_CTX_THRESHOLD_PCT: 50,
  MAX_CTX_THRESHOLD_PCT: 95,
  DEFAULT_CTX_THRESHOLD_PCT: 75,
  MIN_ACTIONS_PER_HOUR: 1,
  MAX_ACTIONS_PER_HOUR: 120,
  DEFAULT_MAX_ACTIONS_PER_HOUR: 30,
  MIN_PER_SEAT_10M: 1,
  MAX_PER_SEAT_10M: 30,
  DEFAULT_MAX_PER_SEAT_10M: 8,
  RETRY_LOOP_WINDOW_MS: 10 * 60_000,
  RETRY_LOOP_CMD_CAP: 3,
  HOURLY_WINDOW_MS: 3_600_000
});

export const AUTO_CONSENT_VETO_CODES = Object.freeze({
  MASTER_PAUSED: 'VETO_MASTER_PAUSED',
  POLICY_OFF: 'VETO_POLICY_OFF',
  MANUAL_ONLY: 'VETO_MANUAL_ONLY',
  NO_SINGLE_ALLOW_OPTION: 'VETO_NO_SINGLE_ALLOW_OPTION',
  NON_PERMISSION_QUESTION: 'VETO_NON_PERMISSION_QUESTION',
  DESTRUCTIVE_CMD: 'E-VETO-DESTRUCTIVE-CMD',
  PACKAGE_INSTALL_POLICY: 'VETO_PACKAGE_INSTALL_POLICY',
  NETWORK_POLICY: 'VETO_NETWORK_POLICY',
  CTX_OVERHEAT: 'VETO_CTX_OVERHEAT',
  BREAKER_TRIPPED: 'VETO_BREAKER_TRIPPED',
  SHELL_EXITED: 'VETO_SHELL_EXITED',
  WORKTREE_CONFLICT: 'VETO_WORKTREE_CONFLICT',
  RETRY_LOOP: 'VETO_RETRY_LOOP',
  RATE_CAP: 'VETO_RATE_CAP',
  PROMPT_DRIFT: 'VETO_PROMPT_DRIFT',
  PROFILE_UNMATCHED: 'VETO_PROFILE_UNMATCHED',
  SESSION_EXPIRED: 'VETO_SESSION_EXPIRED',
  SESSION_EXHAUSTED: 'VETO_SESSION_EXHAUSTED',
  SESSION_EPOCH_MISMATCH: 'VETO_SESSION_EPOCH_MISMATCH',
  OPERATOR_CANCELED: 'VETO_OPERATOR_CANCELED'
});

export const DEFAULT_AUTO_CONSENT_FLAGS = Object.freeze({
  pauseOnCtxOverheat: true,
  ctxPauseThresholdPct: AUTO_CONSENT_LIMITS.DEFAULT_CTX_THRESHOLD_PCT,
  allowPackageInstall: false,
  allowReadOnlyNetwork: false
});

export const DEFAULT_AUTO_CONSENT_CONFIG = Object.freeze({
  schemaVersion: AUTO_CONSENT_SCHEMA_VERSION,
  enabled: false,
  mode: AUTO_CONSENT_MODES.DRY_RUN,
  masterPaused: false,
  graceWindowMs: AUTO_CONSENT_LIMITS.DEFAULT_GRACE_MS,
  maxActionsPerHour: AUTO_CONSENT_LIMITS.DEFAULT_MAX_ACTIONS_PER_HOUR,
  maxPerSeatPer10m: AUTO_CONSENT_LIMITS.DEFAULT_MAX_PER_SEAT_10M,
  defaults: DEFAULT_AUTO_CONSENT_FLAGS,
  projects: Object.freeze({}),
  seats: Object.freeze({})
});

const PROJECT_PROFILES = new Set(['off', 'manual_only', 'safe_readonly', 'trusted_dev']);
const SEAT_PROFILES = new Set(['inherit', 'off', 'manual_only', 'safe_readonly', 'trusted_dev']);
const SESSION_PROFILES = new Set(['safe_readonly', 'trusted_dev', 'sprint_all']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const GIT_OPT_ARG = `(?:"[^"\\n]+"|'[^'\\n]+'|[^\\s;|&\`]+)`;
const GIT_GLOBAL_OPTS = `(?:(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\\s+${GIT_OPT_ARG}|--?[a-zA-Z0-9-]+(?:=${GIT_OPT_ARG})?)\\s+)*`;

/**
 * Canonical Non-Overridable Hard Safety Veto Patterns (Single Source of Truth).
 * Shared directly with openrig/lib/ai-evaluator/expert-rules.mjs so Tier 0 Expert Rules
 * and Auto-Consent Policy Engine never drift.
 */
export const DESTRUCTIVE_VETO_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'rm_rf',
    ruleId: 'E-VETO-RM_RF',
    re: /\brm\s+(?:[^\n;|&`]*\s)?(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|(?:-[a-z]*r[a-z]*|--recursive)\b[^\n;|&`]*(?:-[a-z]*f[a-z]*|--force)|(?:-[a-z]*f[a-z]*|--force)\b[^\n;|&`]*(?:-[a-z]*r[a-z]*|--recursive))\b/i,
    label: 'rm -rf (recursive deletion)'
  }),
  Object.freeze({
    id: 'git_push',
    ruleId: 'E-VETO-GIT_PUSH',
    re: new RegExp(`\\bgit\\s+${GIT_GLOBAL_OPTS}push\\b`, 'i'),
    label: 'git push (remote mutation)'
  }),
  Object.freeze({
    id: 'git_hard_reset',
    ruleId: 'E-VETO-GIT_HARD_RESET',
    re: new RegExp(`\\bgit\\s+${GIT_GLOBAL_OPTS}(?:reset\\s+[^\\n;|&\`]*--hard|clean\\s+[^\\n;|&\`]*(?:-[a-z]*f[a-z]*|--force))\\b`, 'i'),
    label: 'git reset --hard / clean -f'
  }),
  Object.freeze({
    id: 'sql_ddl',
    ruleId: 'E-VETO-SQL_DDL',
    re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER|FUNCTION)\b|TRUNCATE\s+TABLE\b|TRUNCATE\s+(?:ONLY\s+)?["'`]?[a-z_][a-z0-9_.]*["'`]?\s*(?:;|(?:CASCADE|RESTART|CONTINUE)\b)|ALTER\s+TABLE\b)/i,
    label: 'SQL DDL/destructive schema change'
  }),
  Object.freeze({
    id: 'chmod_777',
    ruleId: 'E-VETO-CHMOD_777',
    re: /\bchmod\s+(?:--?[a-zA-Z0-9-]+(?:=\S+)?\s+)*(?:0?777|a\+rwx|ugo\+rwx)\b/,
    label: 'chmod 777'
  }),
  Object.freeze({
    id: 'disk_destroy',
    ruleId: 'E-VETO-DISK_DESTROY',
    re: /\b(?:mkfs(?:\.[a-z0-9]+)?\s+|dd\s+[^\n;|&`]*\bof=)/i,
    label: 'Disk formatting / raw dd write (mkfs / dd)'
  }),
  Object.freeze({
    id: 'curl_pipe_sh',
    ruleId: 'E-VETO-CURL_PIPE_SH',
    re: /\b(?:(?:curl|wget)\b[^\n]*\|\s*(?:(?:\/[\w./-]*\/)?sudo\s+)?(?:(?:\/[\w./-]*\/)?env\s+(?:-[a-zA-Z]+\s+)*)?(?:\/[\w./-]*\/)?(?:sh|bash|zsh|dash|ksh|python3?|node)\b|(?:\/[\w./-]*\/)?(?:sh|bash|zsh)\s+<\(\s*(?:\/[\w./-]*\/)?(?:curl|wget)\b)/i,
    label: 'curl/wget piped to shell/interpreter'
  }),
  Object.freeze({
    id: 'sudo_cmd',
    ruleId: 'E-VETO-SUDO_CMD',
    re: /(?:^|[\s$`(;|&\/])sudo\s+/m,
    label: 'sudo privilege escalation'
  }),
  Object.freeze({
    id: 'secret_file_access',
    ruleId: 'E-VETO-SECRET_FILE_ACCESS',
    re: /(?:(?:~|\$HOME)\/\.ssh\b|(?:^|[\s"'`=/(:<>\[{])\.ssh(?:\/|\b)|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|(?:^|[\s"'`=/(:<>\[{])\.env(?:\.[a-zA-Z0-9._-]+)?(?=$|[^a-zA-Z0-9_-])|(?:^|[\s"'`=(:<>\[{])\/etc(?:\/[\w.-]*|\b))/im,
    label: 'Sensitive credential / .env / SSH / /etc access'
  }),
  Object.freeze({
    id: 'path_traversal',
    ruleId: 'E-VETO-PATH_TRAVERSAL',
    re: /(?:^|[\s"'`=(:<>\/\[{])\.\.(?:\/|\\|$|[\s"'`):;,&|?!\]}])/m,
    label: 'Path traversal (..) outside workspace'
  }),
  Object.freeze({
    id: 'publish_prod',
    ruleId: 'E-VETO-PUBLISH_PROD',
    re: /\b(?:(?:npm|pnpm|yarn)\s+(?:[^\n;|&`]*\s)?publish\b|vercel\b[^\n;|&`]*--prod\b|gh\s+(?:[^\n;|&`]*\s)?release\b)/i,
    label: 'Production publish / release'
  })
]);

export const PACKAGE_INSTALL_PATTERNS = Object.freeze([
  Object.freeze({ id: 'npm_install', re: /\bnpm\s+(?:install|i|add|ci|update|upgrade)\b/i, label: 'npm package install' }),
  Object.freeze({ id: 'pnpm_install', re: /\bpnpm\s+(?:add|install|i|update|up|dlx)\b/i, label: 'pnpm package install' }),
  Object.freeze({ id: 'yarn_install', re: /\byarn\s+(?:add|install|upgrade|up|dlx)\b/i, label: 'yarn package install' }),
  Object.freeze({ id: 'bun_install', re: /\bbun\s+(?:add|install|i)\b/i, label: 'bun package install' }),
  Object.freeze({ id: 'pip_install', re: /\b(?:pip3?|uv\s+pip)\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\b(?:uv|poetry)\s+(?:add|install)\b/i, label: 'Python package install' }),
  Object.freeze({ id: 'brew_install', re: /\bbrew\s+(?:install|upgrade|reinstall)\b/i, label: 'Homebrew package install' }),
  Object.freeze({ id: 'sys_pkg_install', re: /\b(?:cargo\s+(?:install|add)|go\s+(?:install|get)|apt(?:-get)?\s+install|gem\s+install|composer\s+(?:require|install))\b/i, label: 'Package manager install' })
]);

export const EXTERNAL_NETWORK_PATTERNS = Object.freeze([
  Object.freeze({ id: 'curl', re: /\bcurl\b/i, label: 'curl external network call' }),
  Object.freeze({ id: 'wget', re: /\bwget\b/i, label: 'wget external network call' }),
  Object.freeze({ id: 'ssh', re: /\b(?:ssh|scp|sftp)\b/i, label: 'ssh/scp remote connection' }),
  Object.freeze({ id: 'gh_cli', re: /\bgh\s+[a-z][a-z0-9-]*/i, label: 'GitHub CLI network call' }),
  Object.freeze({ id: 'git_network', re: new RegExp(`\\bgit\\s+${GIT_GLOBAL_OPTS}(?:fetch|pull|clone|ls-remote)\\b`, 'i'), label: 'git remote network call' }),
  Object.freeze({ id: 'raw_net', re: /\b(?:nc|ncat|netcat|telnet|ftp|httpie)\b/i, label: 'Raw network client' })
]);

export const SHELL_METACHAR_RE = /[;|&`><\n\r]|\$\(/;

const SAFE_ARG_TOKEN = `[a-zA-Z0-9._/@~^:,=+*-]+`;
const SAFE_ARGS_OPT = `(?:\\s+(?:${SAFE_ARG_TOKEN}|"[^"\\n;|&\`><$]*"|'[^'\\n;|&\`><]*'))*`;

const ANCHORED_PACKAGE_INSTALL_RE = new RegExp(
  `^(?:` +
  `npm\\s+(?:install|i|add|ci|update|upgrade)|` +
  `pnpm\\s+(?:add|install|i|update|up|dlx)|` +
  `yarn\\s+(?:add|install|upgrade|up|dlx)|` +
  `bun\\s+(?:add|install|i)|` +
  `(?:pip3?|uv\\s+pip)\\s+install|` +
  `python3?\\s+-m\\s+pip\\s+install|` +
  `(?:uv|poetry)\\s+(?:add|install)|` +
  `brew\\s+(?:install|upgrade|reinstall)|` +
  `cargo\\s+(?:install|add)|` +
  `go\\s+(?:install|get)|` +
  `apt(?:-get)?\\s+install|` +
  `gem\\s+install|` +
  `composer\\s+(?:require|install)` +
  `)(?:${SAFE_ARGS_OPT})$`,
  'i'
);

const NODE_EXEC_INJECTION_FLAG_RE = /(?:^|\s)(?:-(?!-)[a-zA-Z]*(?:e|p|r)[a-zA-Z]*|--(?:eval|print|require|import|loader|experimental-loader|input-type|inspect(?:-brk|-wait)?|run|test-reporter-destination))(?:=|\s|$)/;
const RG_EXEC_INJECTION_FLAG_RE = /(?:^|\s)--pre(?:-glob)?(?:=|\s|$)/i;
const GIT_EXEC_INJECTION_FLAG_RE = /(?:^|\s)(?:-c\b|--config-env\b|--ext-diff\b|--upload-pack\b|--exec\b)/i;

/**
 * Detects code-execution / hook-injection flags on otherwise read-only tools
 * (e.g., `node --test -e`, `node --check --import`, `rg --pre`, `git -c`).
 */
export function hasForbiddenExecFlag(cmd = '') {
  const s = normalizeCommandText(cmd);
  if (!s) return false;
  if (/^node\b/i.test(s) && NODE_EXEC_INJECTION_FLAG_RE.test(s)) return true;
  if (/^rg\b/i.test(s) && RG_EXEC_INJECTION_FLAG_RE.test(s)) return true;
  if (/^git\b/i.test(s) && GIT_EXEC_INJECTION_FLAG_RE.test(s)) return true;
  return false;
}

/**
 * Strictly read-only & test commands (zero shell metacharacters).
 * Shared with Tier 0 Expert Rules (expert-rules.mjs).
 */
export const SAFE_READONLY_COMMAND_RE = new RegExp(
  `^(?:` +
  `npm\\s+(?:test|t)(?:\\s+--${SAFE_ARGS_OPT}|${SAFE_ARGS_OPT})?|` +
  `(?:pnpm|yarn)\\s+test${SAFE_ARGS_OPT}|` +
  `npx\\s+(?:vitest|playwright\\s+test|jest|tsc\\s+--noEmit)${SAFE_ARGS_OPT}|` +
  `(?:vitest|playwright\\s+test|pytest|go\\s+test|cargo\\s+test)${SAFE_ARGS_OPT}|` +
  `node\\s+(?:--test|--check)${SAFE_ARGS_OPT}|` +
  `git\\s+(?:status|diff|log|show|rev-parse)${SAFE_ARGS_OPT}|` +
  `git\\s+branch(?:\\s+(?:-a|-r|-l|--list|--show-current|-v|-vv))*|` +
  `(?:rg|ls|cat|head|tail|wc|pwd|which|grep)${SAFE_ARGS_OPT}|` +
  `rig\\s+(?:ps|status|seat\\s+(?:list|status)|queue\\s+(?:list|show))${SAFE_ARGS_OPT}` +
  `)$`
);

/**
 * Canonical check for a strictly read-only command: matches SAFE_READONLY_COMMAND_RE,
 * has zero shell metacharacters, zero destructive patterns, and zero code-execution flags.
 */
export function isSafeReadOnlyCommand(cmd = '') {
  const s = normalizeCommandText(cmd);
  if (!s) return false;
  if (SHELL_METACHAR_RE.test(s)) return false;
  if (hasForbiddenExecFlag(s)) return false;
  if (classifyDestructiveVetoes(s).length > 0) return false;
  return SAFE_READONLY_COMMAND_RE.test(s);
}

const TRUSTED_DEV_NPM_SCRIPT_RE = /^(?:npm|pnpm|yarn)\s+run\s+([a-zA-Z0-9:._-]+)(?:\s+--)?/;
const FORBIDDEN_NPM_SCRIPT_NAME_RE = /(?:publish|deploy|release|prod|production|destroy|drop|nuke|wipe|reset-db)/i;

const SAFE_LOG_PATH_RE = /^(?:\/)?[a-zA-Z0-9._/-]+\.(?:log|txt|out)$/i;
const SENSITIVE_ROOT_PATH_RE = /^\/?(?:etc|usr|bin|sbin|System|var|dev|proc|sys|private\/(?:etc|var))(?:\/|$)/i;
const SENSITIVE_ANY_DEPTH_SEGMENT_RE = /(?:^|\/)(?:\.ssh|\.git|\.gnupg|\.aws|\.kube)(?:\/|$)/i;
const SENSITIVE_ENV_PATH_RE = /(?:^|\/)\.env(?:\.|\/|$)/i;

const TRAILING_REDIRECT_THEN_STDERR_RE = /^([\s\S]+?)\s+(?:>>|[12]?>)\s*(\S+)\s+2>&1$/;
const TRAILING_STDERR_THEN_REDIRECT_RE = /^([\s\S]+?)\s+2>&1\s+(?:>>|[12]?>)\s*(\S+)$/;
const TRAILING_REDIRECT_ONLY_RE = /^([\s\S]+?)\s+(?:>>|[12]?>)\s*(\S+)$/;
const TRAILING_STDERR_ONLY_RE = /^([\s\S]+?)\s+2>&1$/;

const SAFE_TEST_CHECK_BUILD_COMMAND_RE = new RegExp(
  `^(?:` +
  `(?:npm|pnpm|yarn)\\s+run\\s+[a-zA-Z0-9:._-]+${SAFE_ARGS_OPT}|` +
  `npx\\s+(?:vitest|playwright|tsc|eslint|prettier|jest|mocha|biome|stylelint|svelte-check|vite)${SAFE_ARGS_OPT}|` +
  `node\\s+(?:--test|--check|[a-zA-Z0-9._/-]+\\.test\\.m?js)${SAFE_ARGS_OPT}|` +
  `(?:cargo\\s+(?:check|build|clippy|test)|go\\s+(?:build|vet|test)|ruff\\s+check|mypy|flake8|eslint|tsc|make\\s+(?:test|build|lint|check))${SAFE_ARGS_OPT}` +
  `)$`
);

/**
 * Validates that a trailing redirection target is strictly a safe log/txt/out file path.
 * Rejects path traversal (.. / .), dotfile basenames, OS system roots, and sensitive hidden dirs.
 */
export function isSafeLogPath(filePath = '') {
  const p = String(filePath || '').trim();
  if (!p || p.length > 512) return false;
  if (!SAFE_LOG_PATH_RE.test(p)) return false;
  const trimmed = p.startsWith('/') ? p.slice(1) : p;
  const segments = trimmed.split('/');
  if (segments.length === 0 || segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    return false;
  }
  const basename = segments[segments.length - 1];
  if (basename.startsWith('.')) return false;
  if (SENSITIVE_ROOT_PATH_RE.test(p)) return false;
  if (SENSITIVE_ANY_DEPTH_SEGMENT_RE.test(p)) return false;
  if (SENSITIVE_ENV_PATH_RE.test(p)) return false;
  return true;
}

function stripSafeTrailingLogRedirect(segment) {
  const s = normalizeCommandText(segment);
  if (!s) return { hasRedirect: false, valid: false, base: '', logPath: null };

  let m = s.match(TRAILING_REDIRECT_THEN_STDERR_RE);
  if (m) {
    const base = m[1].trim();
    const logPath = m[2].trim();
    return { hasRedirect: true, valid: isSafeLogPath(logPath), base, logPath };
  }
  m = s.match(TRAILING_STDERR_THEN_REDIRECT_RE);
  if (m) {
    const base = m[1].trim();
    const logPath = m[2].trim();
    return { hasRedirect: true, valid: isSafeLogPath(logPath), base, logPath };
  }
  m = s.match(TRAILING_STDERR_ONLY_RE);
  if (m) {
    const base = m[1].trim();
    return { hasRedirect: true, valid: true, base, logPath: null };
  }
  m = s.match(TRAILING_REDIRECT_ONLY_RE);
  if (m) {
    const base = m[1].trim();
    const logPath = m[2].trim();
    return { hasRedirect: true, valid: isSafeLogPath(logPath), base, logPath };
  }
  return { hasRedirect: false, valid: true, base: s, logPath: null };
}

function isSafeReadOnlyOrTestCommand(cmd = '') {
  const s = normalizeCommandText(cmd);
  if (!s) return false;
  if (SHELL_METACHAR_RE.test(s)) return false;
  if (hasForbiddenExecFlag(s)) return false;
  if (classifyDestructiveVetoes(s).length > 0) return false;
  if (classifyExternalNetwork(s)) return false;
  if (classifyPackageInstall(s)) return false;
  if (isSafeReadOnlyCommand(s)) return true;
  const npmRunMatch = s.match(TRUSTED_DEV_NPM_SCRIPT_RE);
  if (npmRunMatch && FORBIDDEN_NPM_SCRIPT_NAME_RE.test(npmRunMatch[1])) return false;
  return SAFE_TEST_CHECK_BUILD_COMMAND_RE.test(s);
}

/**
 * Checks whether a single (unchained) command is a recognized read-only/test/lint/typecheck/build
 * command with optional single trailing log redirection to a validated safe log path.
 */
export function isSafeReadOnlyOrTestWithOptionalLogRedirect(cmd = '') {
  const s = normalizeCommandText(cmd);
  if (!s) return false;
  if (classifyDestructiveVetoes(s).length > 0) return false;
  const redir = stripSafeTrailingLogRedirect(s);
  if (redir.hasRedirect && !redir.valid) return false;
  return isSafeReadOnlyOrTestCommand(redir.base);
}

const TRUSTED_DEV_SINGLE_COMMAND_RE = new RegExp(
  `^(?:` +
  `(?:npm|pnpm|yarn)\\s+run\\s+[a-zA-Z0-9:._-]+${SAFE_ARGS_OPT}|` +
  `npx\\s+(?:vitest|playwright|tsc|eslint|prettier|jest|mocha|biome|stylelint|svelte-check|vite|tsx|ts-node)${SAFE_ARGS_OPT}|` +
  `node\\s+(?:--test|--check|scripts\\/[a-zA-Z0-9._/-]+\\.m?js|[a-zA-Z0-9._/-]+\\.test\\.m?js)${SAFE_ARGS_OPT}|` +
  `git\\s+(?:add|commit|switch|checkout|restore|mv)${SAFE_ARGS_OPT}|` +
  `git\\s+branch(?:\\s+(?:-[a-zA-Z0-9-]+|${SAFE_ARG_TOKEN}))*|` +
  `git\\s+stash(?:\\s+(?:push|list|show|apply|pop)(?:${SAFE_ARGS_OPT}))?|` +
  `rig\\s+(?:ps|status|send|seat\\s+(?:list|status)|queue\\s+(?:list|show|claim|handoff|complete|update|ack))${SAFE_ARGS_OPT}|` +
  `(?:cargo\\s+(?:check|build|clippy|fmt|test)|go\\s+(?:build|vet|fmt|test)|ruff\\s+(?:check|format)|mypy|flake8|black|eslint|prettier|tsc|make\\s+(?:test|build|lint|check))${SAFE_ARGS_OPT}` +
  `)$`
);

const TRUSTED_DEV_GIT_FORCE_MUTATION_RE = /\bgit\s+(?:branch\b[^\n]*\s(?:-D|--delete\s+--force|--force\s+--delete)|(?:checkout|switch)\b[^\n]*\s(?:-f|--force))\b/;

const READONLY_CURL_MUTATING_RE = /(?:^|\s)(?:-(?!-)[a-zA-Z]*[XdFToOKcD]|--(?:request|data(?:-[a-z-]+)?|json|form(?:-[a-z-]+)?|upload-file|output|remote-name(?:-all)?|config|next|cookie-jar|dump-header)\b)/;
const READONLY_WGET_SAFE_RE = /^wget\s+(?:[^\n;|&`><]*\s)?(?:--spider|-qO-|-O\s*-)\b/i;
const READONLY_WGET_MUTATING_RE = /(?:^|\s)--(?:post-data|post-file|method|body-data|body-file)\b/i;
const READONLY_GH_SAFE_RE = /^gh\s+(?:status|pr\s+(?:list|view|status|checks|diff)|issue\s+(?:list|view|status)|run\s+(?:list|view)|repo\s+view|api\b)/i;
const READONLY_GH_API_MUTATING_RE = /(?:^|\s)(?:-X\s*(?:POST|PUT|PATCH|DELETE)\b|--method\s*(?:POST|PUT|PATCH|DELETE)\b|-f\b|-F\b|--field\b|--raw-field\b|--input\b)/i;

const PERMISSION_PROMPT_HEADER_RE = /(?:requesting\s+permission\s+for:|run\s+this\s+command\?|allow\s+this\s+(?:command|tool|action|edit|write)\?|allow\s+running\b|(?:^|\n)\s*do\s+you\s+want\s+to\s+proceed\??\s*(?:$|\n)|do\s+you\s+want\s+to\s+(?:run\s+(?:this|the\s+following)\s+command|allow\s+this\s+(?:command|tool|action)|make\s+this\s+edit|edit\s+this\s+file|create\s+this\s+file|write\s+to\b|execute\s+this\s+command)|would\s+you\s+like\s+to\s+(?:run\s+(?:this|the\s+following)\s+command|run\s+`?\$?|allow\s+this\s+(?:command|tool|action)|proceed\??\s*$)|permission\s+(?:prompt|request|required)|approve\s+this\s+(?:command|tool|action)|waiting\s+for\s+(?:human|approval)|persist\s+to\s+settings\.json|approve\?\s*\(y\/n\)|\[y\/n\]|\(y\/n\)\s*$|(?:^|\n)\s*(?:[●⏺]\s*)?(?:Bash|Run|Command|Shell|Tool|Edit|Write)\s*[:(])/im;

const WORKSPACE_FILE_EDIT_HEADER_RE = /(?:do\s+you\s+want\s+to\s+(?:make\s+this\s+edit|edit\s+this\s+file|create\s+this\s+file|write\s+to\b)|allow\s+(?:this\s+edit|file\s+edit|this\s+write)\b|requesting\s+permission\s+for:\s*(?:edit_file|write_file|write_to_file|create_file|replace_file_content|multi_replace_file_content|read_file|view_file|grep_search|find_by_name)\b|(?:^|\n)\s*(?:[●⏺]\s*)?(?:Edit|Write|Update)\s*\([^)]+\))/im;

const FORBIDDEN_PERSISTENT_ALLOW_RE = /(?:always\s+allow|allow\s+always|allow\s+all|don'?t\s+ask\s+again|do\s+not\s+ask\s+again|persist\s+to\s+settings|settings\.json|remember\s+(?:this|my)\s+(?:choice|decision)|for\s+this\s+session|during\s+this\s+session|for\s+all\s+future|auto-?approve|always\s+approve|всегда\s+разрешать|запомнить\s+выбор|больше\s+не\s+спрашивать|above\s+fold)/i;

const SINGLE_ALLOW_OPT_RE = /^(?:(?:yes|да)(?:\s*\([y1]\)|\s*[,.]?\s*(?:proceed|allow(?:\s+once|\s+this\s+(?:command|tool|action|edit|time))?|run(?:\s+once|\s+this\s+command)?|approve(?:\s+once)?|continue|make\s+this\s+edit|this\s+time|продолжить|разрешить(?:\s+(?:один\s+раз|разово))?)(?:\s*\([y1]\))?)?|(?:allow|approve|proceed)(?:\s+(?:once|this\s+(?:command|tool|action|edit|time)))?(?:\s*\([y1]\))?|разрешить(?:\s+(?:один\s+раз|разово))?)\s*$/i;

const CANCEL_OPT_RE = /^(?:no\b|cancel\b|deny\b|reject\b|abort\b|decline\b|отмен|нет\b)|\(esc\)|\bcancel\b|\bno,?\s+and\s+tell\b/i;

const NUMBERED_OPT_LINE_RE = /^\s*(?:[›❯>*•]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const INLINE_OPT_LINE_RE = /^\[[1-9a-zA-Z]\]/;
const SENSITIVE_PREVIEW_PATTERNS = [
  /\b(?:bearer|basic|authorization|proxy-authorization|cookie|set-cookie)\s*[:=\s]/i,
  /(?:api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?key|token|secret|passwd|password|credential|signature)[\w-]*["']?\s*[:=]/i,
  /--[\w-]*(?:key|token|secret|pass(?:word|wd)?|credential|auth|cookie|user)(?:[=\s]|$)/i,
  /\b(?:curl|wget)\b.*\s-(?:u|b)\s*\S|:\/\/[^/\s@]+:[^/\s@]*@/i,
  /-----BEGIN [^-]*PRIVATE KEY|\b(?:sk[-_](?:proj[-_]|live[-_]|test[-_])?[\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]+|AIza[\w-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]+|ts_[\w-]{16,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/
];

function clampInt(val, fallback, min, max) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function stripAnsiAndControls(text) {
  return String(text || '')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

function redactCommandPreview(text) {
  const clean = normalizeCommandText(text);
  if (!clean) return '';
  if (!SENSITIVE_PREVIEW_PATTERNS.some((re) => re.test(clean))) {
    const chars = Array.from(clean);
    return chars.length > 180 ? chars.slice(0, 179).join('') + '…' : clean;
  }
  const cmd = clean.match(/^([a-z][a-z0-9.-]{0,31})\s/i);
  return cmd && !SENSITIVE_PREVIEW_PATTERNS.some((re) => re.test(cmd[0]))
    ? `${cmd[1]} [REDACTED]`
    : '[REDACTED]';
}

function parseTsMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function inferRigIdFromSeat(seatId) {
  const s = String(seatId || '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at >= s.length - 1) return '';
  const rig = s.slice(at + 1);
  return SAFE_RIG_NAME_RE.test(rig) ? rig : '';
}

function getSeatIdFromObj(seat) {
  if (!seat || typeof seat !== 'object') return '';
  return String(seat.canonicalSessionName || seat.seatId || seat.id || '').trim();
}

function getCtxPctFromSeat(seat) {
  if (!seat || typeof seat !== 'object') return null;
  if (seat.contextUsage && typeof seat.contextUsage.usedPercentage === 'number' && Number.isFinite(seat.contextUsage.usedPercentage)) {
    return seat.contextUsage.usedPercentage;
  }
  if (typeof seat.ctxPct === 'number' && Number.isFinite(seat.ctxPct)) {
    return seat.ctxPct;
  }
  return null;
}

function isSeatShellExited(seat, screenText) {
  if (seat && typeof seat === 'object') {
    if (seat.shellExited === true) return true;
    if (seat.activityState && seat.activityState.shellExited === true) return true;
    if (seat.activityState && seat.activityState.display === 'shell-exited') return true;
    if (seat.state === 'shell-exited') return true;
  }
  if (typeof screenText === 'string' && screenText.trim()) {
    const cls = classifyTerminalScreen(screenText, seat?.harness || seat?.runtime || '');
    if (cls && cls.shellExited === true) return true;
  }
  return false;
}

function isBreakerTrippedForSeat(breakerState, seatId) {
  if (!breakerState) return false;
  if (breakerState === true || breakerState.tripped === true) return true;
  if (breakerState.status !== 'tripped') return false;
  const tripped = Array.isArray(breakerState.trippedSeats) ? breakerState.trippedSeats : [];
  if (tripped.length === 0) return true;
  if (!seatId) return true;
  return tripped.some((t) => {
    if (typeof t === 'string') return t === seatId || t === 'fleet' || t === '*';
    return Boolean(t && (t.seatId === seatId || t.seatId === 'fleet' || t.seatId === '*'));
  });
}

const OVERLAY_INSTRUCTION_BASENAME_RE = /^(?:AGENTS|CLAUDE)\.md$/i;

function isOverlayInstructionFile(filePath = '') {
  const clean = String(filePath || '').trim().replace(/\\/g, '/');
  if (!clean) return false;
  const base = clean.split('/').pop() || '';
  return OVERLAY_INSTRUCTION_BASENAME_RE.test(base);
}

function entryMatchesSeat(entry, seatId) {
  if (!entry || typeof entry !== 'object') return false;
  if (Array.isArray(entry.seatIds)) {
    return !seatId || entry.seatIds.includes(seatId);
  }
  if (Array.isArray(entry.seats)) {
    return !seatId || entry.seats.includes(seatId);
  }
  if (typeof entry.seatId === 'string' && entry.seatId.trim()) {
    return !seatId || entry.seatId.trim() === seatId;
  }
  return true;
}

export function hasWorktreeConflictForSeat(gitConflicts, seat, seatId, { isReadOnlyOrTestCmd = false } = {}) {
  const effectiveSeatId = String(seatId || getSeatIdFromObj(seat) || '').trim();
  // Hard unmerged git index conflicts ALWAYS escalate, even for read-only/test commands
  if (seat && (seat.gitConflict === true || seat.hasWorktreeConflict === true)) return true;
  if (!gitConflicts) return false;
  if (gitConflicts === true) return true;

  const unmergedWorkspaces = !Array.isArray(gitConflicts) && Array.isArray(gitConflicts.unmergedWorkspaces)
    ? gitConflicts.unmergedWorkspaces
    : [];
  for (const u of unmergedWorkspaces) {
    if (!u) continue;
    if (typeof u === 'string') {
      if (u.trim()) return true;
      continue;
    }
    if (entryMatchesSeat(u, effectiveSeatId)) return true;
  }

  const list = Array.isArray(gitConflicts)
    ? gitConflicts
    : (Array.isArray(gitConflicts.conflicts) ? gitConflicts.conflicts : []);
  if (list.length === 0) return false;

  for (const c of list) {
    if (!c) continue;
    if (typeof c === 'string') {
      const trimmed = c.trim();
      if (!trimmed) continue;
      if (isOverlayInstructionFile(trimmed)) continue;
      if (!isReadOnlyOrTestCmd) return true;
      continue;
    }
    if (typeof c !== 'object') continue;

    let matchesSeat = false;
    let isHardUnmerged = c.unmerged === true;

    if (Array.isArray(c.workspaces)) {
      for (const ws of c.workspaces) {
        if (!ws || typeof ws !== 'object') continue;
        const wsMatches = Array.isArray(ws.seatIds)
          ? (!effectiveSeatId || ws.seatIds.includes(effectiveSeatId))
          : entryMatchesSeat(ws, effectiveSeatId);
        if (wsMatches) {
          matchesSeat = true;
          if (ws.unmerged === true) isHardUnmerged = true;
        }
      }
      if (!matchesSeat) continue;
    } else if (Array.isArray(c.seats)) {
      matchesSeat = !effectiveSeatId || c.seats.includes(effectiveSeatId);
      if (!matchesSeat) continue;
    } else if (typeof c.seatId === 'string' && c.seatId.trim()) {
      matchesSeat = !effectiveSeatId || c.seatId.trim() === effectiveSeatId;
      if (!matchesSeat) continue;
    } else {
      matchesSeat = true;
    }

    if (isHardUnmerged) return true;

    const filePath = c.filePath || c.file || c.path || '';
    if (isOverlayInstructionFile(filePath)) continue;

    if (isReadOnlyOrTestCmd) continue;

    return true;
  }

  return false;
}

/**
 * Normalizes a command string for deterministic comparison and fingerprinting.
 */
export function normalizeCommandText(text) {
  return stripAnsiAndControls(text).replace(/\s+/g, ' ').trim();
}

/**
 * Pure zero-DOM deterministic fingerprint of (commandPreview, parsedOptions).
 * Produces a stable 64-bit hex fingerprint (`fp1:<16-hex>`) identical in browser and Node.
 */
export function computePromptFingerprint(commandPreview = '', parsedOptions = []) {
  const normCmd = normalizeCommandText(commandPreview);
  const opts = Array.isArray(parsedOptions) ? parsedOptions : [];
  const normOpts = opts
    .map((o) => {
      if (!o || typeof o !== 'object') return '';
      const badge = String(o.badge ?? '').trim();
      const label = normalizeCommandText(o.fullText || o.shortLabel || '');
      return `${badge}:${label}`;
    })
    .filter(Boolean)
    .join('|');

  const payload = `cmd=${normCmd}\nopts=${normOpts}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (ch + ((i * 31) & 0xff));
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `fp1:${hex1}${hex2}`;
}

/**
 * Runs canonical non-overridable DESTRUCTIVE_VETO_PATTERNS against text.
 * Shared with Tier 0 Expert Rules (expert-rules.mjs).
 */
export function classifyDestructiveVetoes(text = '') {
  const raw = stripAnsiAndControls(text);
  if (!raw.trim()) return [];
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const hits = [];
  for (const pat of DESTRUCTIVE_VETO_PATTERNS) {
    if (pat.re.test(raw) || pat.re.test(collapsed)) {
      hits.push({
        id: pat.id,
        ruleId: pat.ruleId,
        reason: pat.label
      });
    }
  }
  return hits;
}

/**
 * Sanitizes configurable policy flags (with strict clamping and fail-closed defaults).
 */
export function sanitizeAutoConsentFlags(patch = {}, base = DEFAULT_AUTO_CONSENT_FLAGS) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const b = base && typeof base === 'object' ? base : DEFAULT_AUTO_CONSENT_FLAGS;
  return {
    pauseOnCtxOverheat: typeof src.pauseOnCtxOverheat === 'boolean'
      ? src.pauseOnCtxOverheat
      : (typeof b.pauseOnCtxOverheat === 'boolean' ? b.pauseOnCtxOverheat : true),
    ctxPauseThresholdPct: clampInt(
      src.ctxPauseThresholdPct !== undefined ? src.ctxPauseThresholdPct : b.ctxPauseThresholdPct,
      AUTO_CONSENT_LIMITS.DEFAULT_CTX_THRESHOLD_PCT,
      AUTO_CONSENT_LIMITS.MIN_CTX_THRESHOLD_PCT,
      AUTO_CONSENT_LIMITS.MAX_CTX_THRESHOLD_PCT
    ),
    allowPackageInstall: typeof src.allowPackageInstall === 'boolean'
      ? src.allowPackageInstall
      : Boolean(b.allowPackageInstall),
    allowReadOnlyNetwork: typeof src.allowReadOnlyNetwork === 'boolean'
      ? src.allowReadOnlyNetwork
      : Boolean(b.allowReadOnlyNetwork)
  };
}

function sanitizePartialOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (typeof raw.pauseOnCtxOverheat === 'boolean') {
    out.pauseOnCtxOverheat = raw.pauseOnCtxOverheat;
  }
  if (raw.ctxPauseThresholdPct !== undefined && raw.ctxPauseThresholdPct !== null && raw.ctxPauseThresholdPct !== '') {
    out.ctxPauseThresholdPct = clampInt(
      raw.ctxPauseThresholdPct,
      AUTO_CONSENT_LIMITS.DEFAULT_CTX_THRESHOLD_PCT,
      AUTO_CONSENT_LIMITS.MIN_CTX_THRESHOLD_PCT,
      AUTO_CONSENT_LIMITS.MAX_CTX_THRESHOLD_PCT
    );
  }
  if (typeof raw.allowPackageInstall === 'boolean') {
    out.allowPackageInstall = raw.allowPackageInstall;
  }
  if (typeof raw.allowReadOnlyNetwork === 'boolean') {
    out.allowReadOnlyNetwork = raw.allowReadOnlyNetwork;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeScopeMap(patchMap, baseMap, keyRe, allowedProfiles, defaultProfile) {
  const result = {};
  const addEntry = (key, entry) => {
    if (typeof key !== 'string' || FORBIDDEN_OBJECT_KEYS.has(key) || !keyRe.test(key)) return;
    if (entry === null) {
      delete result[key];
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const prev = result[key] || {};
    const profile = allowedProfiles.has(entry.profile)
      ? entry.profile
      : (allowedProfiles.has(prev.profile) ? prev.profile : defaultProfile);
    const mergedOverrides = entry.overrides === null
      ? undefined
      : sanitizePartialOverrides(
          entry.overrides !== undefined
            ? { ...(prev.overrides || {}), ...entry.overrides }
            : prev.overrides
        );
    result[key] = mergedOverrides ? { profile, overrides: mergedOverrides } : { profile };
  };

  if (baseMap && typeof baseMap === 'object' && !Array.isArray(baseMap)) {
    for (const [k, v] of Object.entries(baseMap)) {
      addEntry(k, v);
    }
  }
  if (patchMap && typeof patchMap === 'object' && !Array.isArray(patchMap)) {
    for (const [k, v] of Object.entries(patchMap)) {
      addEntry(k, v);
    }
  }
  return result;
}

/**
 * Sanitizes and merges an Auto-Consent configuration patch against a base config.
 * Guarantees fail-closed defaults, clamped bounds, safe keys, and no permanent sprint_all.
 */
export function sanitizeAutoConsentConfig(patch = {}, base = DEFAULT_AUTO_CONSENT_CONFIG) {
  const src = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_AUTO_CONSENT_CONFIG;

  const mode = (src.mode === AUTO_CONSENT_MODES.ARMED || src.mode === AUTO_CONSENT_MODES.DRY_RUN)
    ? src.mode
    : (b.mode === AUTO_CONSENT_MODES.ARMED ? AUTO_CONSENT_MODES.ARMED : AUTO_CONSENT_MODES.DRY_RUN);

  const defaults = sanitizeAutoConsentFlags(
    src.defaults,
    sanitizeAutoConsentFlags(b.defaults, DEFAULT_AUTO_CONSENT_FLAGS)
  );

  const projects = sanitizeScopeMap(
    src.projects,
    src.replaceProjects === true ? {} : b.projects,
    SAFE_RIG_NAME_RE,
    PROJECT_PROFILES,
    AUTO_CONSENT_PROFILES.OFF
  );

  const seats = sanitizeScopeMap(
    src.seats,
    src.replaceSeats === true ? {} : b.seats,
    SAFE_SEAT_ID_RE,
    SEAT_PROFILES,
    'inherit'
  );

  return {
    schemaVersion: AUTO_CONSENT_SCHEMA_VERSION,
    enabled: typeof src.enabled === 'boolean' ? src.enabled : Boolean(b.enabled),
    mode,
    masterPaused: typeof src.masterPaused === 'boolean' ? src.masterPaused : Boolean(b.masterPaused),
    graceWindowMs: clampInt(
      src.graceWindowMs !== undefined ? src.graceWindowMs : b.graceWindowMs,
      AUTO_CONSENT_LIMITS.DEFAULT_GRACE_MS,
      AUTO_CONSENT_LIMITS.MIN_GRACE_MS,
      AUTO_CONSENT_LIMITS.MAX_GRACE_MS
    ),
    maxActionsPerHour: clampInt(
      src.maxActionsPerHour !== undefined ? src.maxActionsPerHour : b.maxActionsPerHour,
      AUTO_CONSENT_LIMITS.DEFAULT_MAX_ACTIONS_PER_HOUR,
      AUTO_CONSENT_LIMITS.MIN_ACTIONS_PER_HOUR,
      AUTO_CONSENT_LIMITS.MAX_ACTIONS_PER_HOUR
    ),
    maxPerSeatPer10m: clampInt(
      src.maxPerSeatPer10m !== undefined ? src.maxPerSeatPer10m : b.maxPerSeatPer10m,
      AUTO_CONSENT_LIMITS.DEFAULT_MAX_PER_SEAT_10M,
      AUTO_CONSENT_LIMITS.MIN_PER_SEAT_10M,
      AUTO_CONSENT_LIMITS.MAX_PER_SEAT_10M
    ),
    defaults,
    projects,
    seats
  };
}

/**
 * Validates and constructs a bounded ephemeral SessionGrant (strictly TTL <= 2h,
 * maxApprovals <= 40 for sprint_all, mandatory seatSessionEpoch when seat-scoped).
 */
export function createSessionGrant({
  grantId = '',
  scope = 'seat',
  targetId = '',
  profile = AUTO_CONSENT_PROFILES.TRUSTED_DEV,
  ttlMs = undefined,
  ttlMin = undefined,
  maxApprovals = undefined,
  seatSessionEpoch = null,
  overrides = undefined,
  nowMs = Date.now()
} = {}) {
  if (scope !== 'rig' && scope !== 'seat') {
    return { ok: false, error: 'Invalid session grant scope (must be "rig" or "seat")' };
  }
  const cleanTarget = String(targetId || '').trim();
  const targetRe = scope === 'rig' ? SAFE_RIG_NAME_RE : SAFE_SEAT_ID_RE;
  if (!cleanTarget || FORBIDDEN_OBJECT_KEYS.has(cleanTarget) || !targetRe.test(cleanTarget)) {
    return { ok: false, error: `Invalid ${scope} targetId` };
  }
  if (!SESSION_PROFILES.has(profile)) {
    return { ok: false, error: 'Invalid session grant profile (must be safe_readonly, trusted_dev, or sprint_all)' };
  }

  const epochStr = (seatSessionEpoch !== null && seatSessionEpoch !== undefined)
    ? String(seatSessionEpoch).trim()
    : '';
  if (scope === 'seat' && !epochStr) {
    return { ok: false, error: 'Seat-scoped session grants require a non-empty seatSessionEpoch' };
  }

  const now = Number.isFinite(nowMs) ? Math.round(nowMs) : Date.now();
  const rawTtl = ttlMs !== undefined
    ? Number(ttlMs)
    : (ttlMin !== undefined ? Number(ttlMin) * 60_000 : AUTO_CONSENT_LIMITS.DEFAULT_SESSION_TTL_MS);
  const clampedTtl = clampInt(
    rawTtl,
    AUTO_CONSENT_LIMITS.DEFAULT_SESSION_TTL_MS,
    AUTO_CONSENT_LIMITS.MIN_SESSION_TTL_MS,
    AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS
  );

  const maxCap = profile === AUTO_CONSENT_PROFILES.SPRINT_ALL
    ? AUTO_CONSENT_LIMITS.MAX_SPRINT_APPROVALS
    : AUTO_CONSENT_LIMITS.MAX_SESSION_APPROVALS;
  const clampedApprovals = clampInt(
    maxApprovals,
    Math.min(AUTO_CONSENT_LIMITS.DEFAULT_SESSION_APPROVALS, maxCap),
    1,
    maxCap
  );

  const cleanId = String(grantId || '').trim() || `grant-${scope}-${now.toString(36)}`;
  const cleanOverrides = sanitizePartialOverrides(overrides);

  const grant = {
    grantId: cleanId,
    scope,
    targetId: cleanTarget,
    profile,
    createdAtMs: now,
    expiresAtMs: now + clampedTtl,
    maxApprovals: clampedApprovals,
    usedApprovals: 0,
    seatSessionEpoch: scope === 'seat' ? epochStr : null
  };
  if (cleanOverrides) grant.overrides = cleanOverrides;
  return { ok: true, grant };
}

/**
 * Validates whether a SessionGrant is currently active and eligible for the given target/epoch/time.
 */
export function isSessionGrantValid(grant, { rigId = '', seatId = '', seatSessionEpoch = null, nowMs = Date.now() } = {}) {
  if (!grant || typeof grant !== 'object' || grant.revoked === true) {
    return { valid: false, matchesTarget: false, reason: null, effectiveExpiresAtMs: null, remainingApprovals: 0 };
  }
  if (grant.scope !== 'seat' && grant.scope !== 'rig') {
    return { valid: false, matchesTarget: false, reason: null, effectiveExpiresAtMs: null, remainingApprovals: 0 };
  }
  if (!SESSION_PROFILES.has(grant.profile)) {
    return { valid: false, matchesTarget: false, reason: null, effectiveExpiresAtMs: null, remainingApprovals: 0 };
  }

  const resolvedRig = String(rigId || '').trim() || inferRigIdFromSeat(seatId);
  const cleanSeat = String(seatId || '').trim();
  const matchesTarget = grant.scope === 'seat'
    ? (Boolean(cleanSeat) && grant.targetId === cleanSeat)
    : (Boolean(resolvedRig) && grant.targetId === resolvedRig);

  if (!matchesTarget) {
    return { valid: false, matchesTarget: false, reason: null, effectiveExpiresAtMs: null, remainingApprovals: 0 };
  }

  const createdAtMs = Number(grant.createdAtMs);
  const rawExpiresAtMs = Number(grant.expiresAtMs);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(rawExpiresAtMs) || rawExpiresAtMs <= createdAtMs) {
    return { valid: false, matchesTarget: true, reason: AUTO_CONSENT_VETO_CODES.SESSION_EXPIRED, effectiveExpiresAtMs: null, remainingApprovals: 0 };
  }

  // Enforce hard 2h TTL cap even on un-sanitized grants
  const effectiveExpiresAtMs = Math.min(rawExpiresAtMs, createdAtMs + AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (now >= effectiveExpiresAtMs) {
    return { valid: false, matchesTarget: true, reason: AUTO_CONSENT_VETO_CODES.SESSION_EXPIRED, effectiveExpiresAtMs, remainingApprovals: 0 };
  }

  // Enforce seatSessionEpoch binding on seat-scoped grants
  if (grant.scope === 'seat') {
    const grantEpoch = (grant.seatSessionEpoch !== null && grant.seatSessionEpoch !== undefined)
      ? String(grant.seatSessionEpoch).trim()
      : '';
    const liveEpoch = (seatSessionEpoch !== null && seatSessionEpoch !== undefined)
      ? String(seatSessionEpoch).trim()
      : '';
    if (!grantEpoch || !liveEpoch || grantEpoch !== liveEpoch) {
      return { valid: false, matchesTarget: true, reason: AUTO_CONSENT_VETO_CODES.SESSION_EPOCH_MISMATCH, effectiveExpiresAtMs, remainingApprovals: 0 };
    }
  }

  // Enforce maxApprovals cap (strictly <= 40 for sprint_all)
  const rawMax = Math.floor(Number(grant.maxApprovals));
  const used = Math.floor(Number(grant.usedApprovals ?? 0));
  if (!Number.isFinite(rawMax) || rawMax <= 0 || !Number.isFinite(used) || used < 0) {
    return { valid: false, matchesTarget: true, reason: AUTO_CONSENT_VETO_CODES.SESSION_EXHAUSTED, effectiveExpiresAtMs, remainingApprovals: 0 };
  }
  const hardCap = grant.profile === AUTO_CONSENT_PROFILES.SPRINT_ALL
    ? AUTO_CONSENT_LIMITS.MAX_SPRINT_APPROVALS
    : AUTO_CONSENT_LIMITS.MAX_SESSION_APPROVALS;
  const effectiveMax = Math.min(rawMax, hardCap);
  const remainingApprovals = Math.max(0, effectiveMax - used);
  if (remainingApprovals <= 0) {
    return { valid: false, matchesTarget: true, reason: AUTO_CONSENT_VETO_CODES.SESSION_EXHAUSTED, effectiveExpiresAtMs, remainingApprovals: 0 };
  }

  return {
    valid: true,
    matchesTarget: true,
    reason: null,
    effectiveExpiresAtMs,
    remainingApprovals
  };
}

function normalizeGrantsList(sessionGrants) {
  if (Array.isArray(sessionGrants)) return sessionGrants;
  if (sessionGrants instanceof Map) return Array.from(sessionGrants.values());
  if (sessionGrants && typeof sessionGrants === 'object') return Object.values(sessionGrants);
  return [];
}

function pickBestGrant(validMatches) {
  if (!validMatches.length) return null;
  const sorted = [...validMatches].sort((a, b) => {
    if (b.grant.createdAtMs !== a.grant.createdAtMs) return b.grant.createdAtMs - a.grant.createdAtMs;
    if (b.check.effectiveExpiresAtMs !== a.check.effectiveExpiresAtMs) {
      return b.check.effectiveExpiresAtMs - a.check.effectiveExpiresAtMs;
    }
    return String(a.grant.grantId || '').localeCompare(String(b.grant.grantId || ''));
  });
  return sorted[0];
}

/**
 * Pure 4-level scope inheritance resolver (Deny-Wins, Fail-Closed):
 *   masterPaused
 *   > Global enabled === false
 *   > Active valid Seat-scoped SessionGrant (matching seatSessionEpoch, TTL <= 2h, used < max)
 *   > Explicit manual_only on Seat or Project (deny-wins; cannot be bypassed by rig grant or parent trusted_dev)
 *   > Active valid Rig-scoped SessionGrant (TTL <= 2h, used < max)
 *   > Explicit Seat policy (if not 'inherit')
 *   > Explicit Project policy
 *   > Global default ('off')
 */
export function resolveEffectiveConsentPolicy(
  rawConfig = DEFAULT_AUTO_CONSENT_CONFIG,
  sessionGrants = [],
  { rigId = '', seatId = '', seatSessionEpoch = null, nowMs = Date.now() } = {}
) {
  const cfg = sanitizeAutoConsentConfig(rawConfig, DEFAULT_AUTO_CONSENT_CONFIG);
  const cleanSeatId = String(seatId || '').trim();
  const cleanRigId = String(rigId || '').trim() || inferRigIdFromSeat(cleanSeatId);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  const projectPolicy = (cleanRigId && Object.prototype.hasOwnProperty.call(cfg.projects, cleanRigId))
    ? cfg.projects[cleanRigId]
    : null;
  const seatPolicy = (cleanSeatId && Object.prototype.hasOwnProperty.call(cfg.seats, cleanSeatId))
    ? cfg.seats[cleanSeatId]
    : null;

  let effectiveFlags = sanitizeAutoConsentFlags(
    projectPolicy?.overrides,
    cfg.defaults
  );
  effectiveFlags = sanitizeAutoConsentFlags(
    seatPolicy?.overrides,
    effectiveFlags
  );

  const makeResult = (fields) => ({
    active: false,
    sourceScope: 'global',
    grantScope: null,
    grantId: null,
    profile: AUTO_CONSENT_PROFILES.OFF,
    mode: cfg.mode,
    graceWindowMs: cfg.graceWindowMs,
    maxActionsPerHour: cfg.maxActionsPerHour,
    maxPerSeatPer10m: cfg.maxPerSeatPer10m,
    effectiveFlags,
    expiresAtMs: null,
    remainingApprovals: null,
    vetoReason: null,
    ...fields
  });

  // 1. Global panic kill-switch unconditionally halts all scopes immediately
  if (cfg.masterPaused) {
    return makeResult({
      active: false,
      sourceScope: 'global',
      profile: AUTO_CONSENT_PROFILES.OFF,
      vetoReason: AUTO_CONSENT_VETO_CODES.MASTER_PAUSED
    });
  }

  // 2. Fail-closed global master switch
  if (!cfg.enabled) {
    return makeResult({
      active: false,
      sourceScope: 'global',
      profile: AUTO_CONSENT_PROFILES.OFF,
      vetoReason: AUTO_CONSENT_VETO_CODES.POLICY_OFF
    });
  }

  // Evaluate matching session grants (seat-scoped and rig-scoped)
  const grants = normalizeGrantsList(sessionGrants);
  const validSeatGrants = [];
  const validRigGrants = [];
  let rejectedGrantReason = null;

  for (const grant of grants) {
    const check = isSessionGrantValid(grant, {
      rigId: cleanRigId,
      seatId: cleanSeatId,
      seatSessionEpoch,
      nowMs: now
    });
    if (check.valid) {
      if (grant.scope === 'seat') validSeatGrants.push({ grant, check });
      else if (grant.scope === 'rig') validRigGrants.push({ grant, check });
    } else if (check.matchesTarget && check.reason && !rejectedGrantReason) {
      rejectedGrantReason = check.reason;
    }
  }

  // 3. Explicit targeted Seat-scoped Session Grant (only override permitted over manual_only)
  const bestSeatGrant = pickBestGrant(validSeatGrants);
  if (bestSeatGrant) {
    const grantFlags = bestSeatGrant.grant.overrides
      ? sanitizeAutoConsentFlags(bestSeatGrant.grant.overrides, effectiveFlags)
      : effectiveFlags;
    return makeResult({
      active: true,
      sourceScope: 'session',
      grantScope: 'seat',
      grantId: bestSeatGrant.grant.grantId || null,
      profile: bestSeatGrant.grant.profile,
      effectiveFlags: grantFlags,
      expiresAtMs: bestSeatGrant.check.effectiveExpiresAtMs,
      remainingApprovals: bestSeatGrant.check.remainingApprovals,
      vetoReason: null
    });
  }

  // 4. Deny-Wins: explicit manual_only on Seat or Project blocks Rig grants and inherited profiles
  if (seatPolicy && seatPolicy.profile === AUTO_CONSENT_PROFILES.MANUAL_ONLY) {
    return makeResult({
      active: false,
      sourceScope: 'seat',
      profile: AUTO_CONSENT_PROFILES.MANUAL_ONLY,
      vetoReason: AUTO_CONSENT_VETO_CODES.MANUAL_ONLY
    });
  }
  if (projectPolicy && projectPolicy.profile === AUTO_CONSENT_PROFILES.MANUAL_ONLY) {
    return makeResult({
      active: false,
      sourceScope: 'project',
      profile: AUTO_CONSENT_PROFILES.MANUAL_ONLY,
      vetoReason: AUTO_CONSENT_VETO_CODES.MANUAL_ONLY
    });
  }

  // 5. Active valid Rig-scoped Session Grant
  const bestRigGrant = pickBestGrant(validRigGrants);
  if (bestRigGrant) {
    const grantFlags = bestRigGrant.grant.overrides
      ? sanitizeAutoConsentFlags(bestRigGrant.grant.overrides, effectiveFlags)
      : effectiveFlags;
    return makeResult({
      active: true,
      sourceScope: 'session',
      grantScope: 'rig',
      grantId: bestRigGrant.grant.grantId || null,
      profile: bestRigGrant.grant.profile,
      effectiveFlags: grantFlags,
      expiresAtMs: bestRigGrant.check.effectiveExpiresAtMs,
      remainingApprovals: bestRigGrant.check.remainingApprovals,
      vetoReason: null
    });
  }

  // 6. Explicit Seat policy (when not 'inherit')
  if (seatPolicy && seatPolicy.profile && seatPolicy.profile !== 'inherit') {
    if (seatPolicy.profile === AUTO_CONSENT_PROFILES.OFF) {
      return makeResult({
        active: false,
        sourceScope: 'seat',
        profile: AUTO_CONSENT_PROFILES.OFF,
        vetoReason: rejectedGrantReason || AUTO_CONSENT_VETO_CODES.POLICY_OFF
      });
    }
    return makeResult({
      active: true,
      sourceScope: 'seat',
      profile: seatPolicy.profile,
      vetoReason: null
    });
  }

  // 7. Explicit Project (Rig) policy
  if (projectPolicy && projectPolicy.profile) {
    if (projectPolicy.profile === AUTO_CONSENT_PROFILES.OFF) {
      return makeResult({
        active: false,
        sourceScope: 'project',
        profile: AUTO_CONSENT_PROFILES.OFF,
        vetoReason: rejectedGrantReason || AUTO_CONSENT_VETO_CODES.POLICY_OFF
      });
    }
    return makeResult({
      active: true,
      sourceScope: 'project',
      profile: projectPolicy.profile,
      vetoReason: null
    });
  }

  // 8. Global fallback (off)
  return makeResult({
    active: false,
    sourceScope: 'global',
    profile: AUTO_CONSENT_PROFILES.OFF,
    vetoReason: rejectedGrantReason || AUTO_CONSENT_VETO_CODES.POLICY_OFF
  });
}

const PROMPT_STRUCTURAL_FOOTER_RE = /^(?:run\s+this\s+command\?|allow\s+this\s+(?:command|tool|action|edit|write)\?|do\s+you\s+want\s+to\s+proceed\??|would\s+you\s+like\s+to\s+proceed\??|approve\?\s*\(y\/n\)|justification:|reason:|working\s+directory:|cwd:|description:|[-─━═]{4,})$/i;
const PROMPT_COMMAND_HEADER_RE = /^(?:requesting\s+permission\s+for:|would\s+you\s+like\s+to\s+run\b|run\s+this\s+command\?|allow\s+this\s+command\?|allow\s+running\b)/i;
const PROMPT_COMMAND_PREFIX_RE = /^(?:\$|›\s*\$|Command:|Run:|Bash:|Shell:)\s*(.+)$/i;
const PROMPT_BASH_TOOL_RE = /^(?:[●⏺]\s*)?Bash\((.+)\)$/i;
const SHELL_CONTINUATION_END_RE = /(?:\\|&&|\|\||\|)\s*$/;
const OUTPUT_OR_PROSE_BOUNDARY_RE = /^(?:[✓✔✖✗❌✅⚠]|all\s+\d+\s+tests?\b|\d+\s+(?:passed|failed|passing|failing)\b|(?:pass|fail|passed|failed|error|warn|info)\b[:\s]|tests?\s+\d+)/i;

function extractActivePromptContext(screenText, explicitCommandPreview) {
  const cleanScreen = stripAnsiAndControls(screenText || '');
  const lines = cleanScreen.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-64);

  // Locate where the active option menu starts
  let optStart = lines.findLastIndex((line) => NUMBERED_OPT_LINE_RE.exec(line)?.[1] === '1');
  if (optStart < 0) {
    optStart = lines.findIndex((line) => NUMBERED_OPT_LINE_RE.test(line) || INLINE_OPT_LINE_RE.test(line));
    if (optStart < 0) optStart = lines.length;
  }

  // Keep full pre-option buffer (up to 64 lines) so multi-line commands can never truncate out of safety inspection
  const fullPreLines = lines.slice(0, optStart);
  const explicitRaw = normalizeCommandText(explicitCommandPreview || '');

  // Check immediate non-separator line right above Option 1 for non-permission questions
  let cursor = fullPreLines.length - 1;
  while (cursor >= 0 && /^[-─━═]{4,}$/.test(fullPreLines[cursor])) {
    cursor -= 1;
  }

  let hasStructuralPermissionFooter = false;
  let immediateNonPermissionQuestion = false;
  let isWorkspaceEditPrompt = false;
  let hasPermissionHeader = false;
  let rawExtractedCommand = '';
  let activeStartIdx = Math.max(0, cursor);

  if (cursor >= 0) {
    const immediateLine = fullPreLines[cursor];
    if (WORKSPACE_FILE_EDIT_HEADER_RE.test(immediateLine)) {
      isWorkspaceEditPrompt = true;
      hasPermissionHeader = true;
      activeStartIdx = cursor;
    } else if (
      /\?\s*$/.test(immediateLine) &&
      !PERMISSION_PROMPT_HEADER_RE.test(immediateLine) &&
      !PROMPT_COMMAND_PREFIX_RE.test(immediateLine) &&
      !PROMPT_BASH_TOOL_RE.test(immediateLine)
    ) {
      // Immediate line above Option 1 is a product/architectural question — NEVER steal a stale command from scrollback!
      immediateNonPermissionQuestion = true;
      activeStartIdx = cursor;
    } else {
      // Skip recognized structural permission footers right above Option 1 (e.g., "Run this command?", "Do you want to proceed?", "Justification: ...")
      while (cursor >= 0 && PROMPT_STRUCTURAL_FOOTER_RE.test(fullPreLines[cursor])) {
        if (/^(?:run\s+this\s+command\?|allow\s+this\s+|do\s+you\s+want\s+to\s+proceed|would\s+you\s+like\s+to\s+proceed|approve\?)/i.test(fullPreLines[cursor])) {
          hasStructuralPermissionFooter = true;
          hasPermissionHeader = true;
        }
        cursor -= 1;
      }

      if (cursor >= 0) {
        const anchorLine = fullPreLines[cursor];
        if (WORKSPACE_FILE_EDIT_HEADER_RE.test(anchorLine)) {
          isWorkspaceEditPrompt = true;
          hasPermissionHeader = true;
          activeStartIdx = cursor;
        } else if (PROMPT_BASH_TOOL_RE.test(anchorLine)) {
          rawExtractedCommand = anchorLine.match(PROMPT_BASH_TOOL_RE)[1].trim();
          hasPermissionHeader = true;
          activeStartIdx = cursor;
        } else if (PROMPT_COMMAND_PREFIX_RE.test(anchorLine)) {
          rawExtractedCommand = anchorLine.match(PROMPT_COMMAND_PREFIX_RE)[1].trim();
          activeStartIdx = cursor;
          if (cursor > 0 && PERMISSION_PROMPT_HEADER_RE.test(fullPreLines[cursor - 1])) {
            hasPermissionHeader = true;
            activeStartIdx = cursor - 1;
          }
        } else if (!OUTPUT_OR_PROSE_BOUNDARY_RE.test(anchorLine) && !/\?\s*$/.test(anchorLine)) {
          // Walk backwards across contiguous multi-line command / permission body (up to 64 lines!)
          // Stop on any numbered option, output/prose boundary, or non-permission question.
          let foundStart = -1;
          let foundHeaderIdx = -1;
          for (let i = cursor; i >= 0; i--) {
            const l = fullPreLines[i];
            if (NUMBERED_OPT_LINE_RE.test(l) || INLINE_OPT_LINE_RE.test(l)) break;
            if (PROMPT_BASH_TOOL_RE.test(l)) {
              // ● Bash(...) is single-line; never cross non-continuation prose/output above it
              break;
            }
            if (PROMPT_COMMAND_PREFIX_RE.test(l)) {
              // Ensure intervening lines actually belong to a multi-line command (either wrapped inside a permission footer or shell continuation)
              const sliceLines = fullPreLines.slice(i, cursor + 1);
              const allContinuationOrWrapped = hasStructuralPermissionFooter ||
                sliceLines.slice(0, -1).every((part) => SHELL_CONTINUATION_END_RE.test(part)) ||
                (i > 0 && PROMPT_COMMAND_HEADER_RE.test(fullPreLines[i - 1]));
              if (allContinuationOrWrapped) {
                foundStart = i;
                if (i > 0 && PERMISSION_PROMPT_HEADER_RE.test(fullPreLines[i - 1])) {
                  foundHeaderIdx = i - 1;
                }
              }
              break;
            }
            if (PROMPT_COMMAND_HEADER_RE.test(l)) {
              foundHeaderIdx = i;
              foundStart = i + 1;
              break;
            }
            if (OUTPUT_OR_PROSE_BOUNDARY_RE.test(l)) break;
            if (/\?\s*$/.test(l) && !PERMISSION_PROMPT_HEADER_RE.test(l)) break;
          }

          if (foundStart >= 0 && foundStart <= cursor) {
            const parts = [];
            for (let k = foundStart; k <= cursor; k++) {
              const rawPart = fullPreLines[k];
              if (/^[-─━═]{4,}$/.test(rawPart) || /^(?:justification:|reason:|working\s+directory:|cwd:)/i.test(rawPart)) continue;
              const pm = rawPart.match(PROMPT_COMMAND_PREFIX_RE);
              parts.push(pm ? pm[1].trim() : rawPart);
            }
            rawExtractedCommand = parts.join(' ').trim();
            activeStartIdx = foundHeaderIdx >= 0 ? foundHeaderIdx : foundStart;
            if (foundHeaderIdx >= 0) hasPermissionHeader = true;
          }
        }
      }
    }
  }

  // Handle single-line "Requesting permission for: <tool>" with no body lines
  if (!rawExtractedCommand && !isWorkspaceEditPrompt && !immediateNonPermissionQuestion && cursor >= 0) {
    const reqInline = fullPreLines[cursor].match(/^requesting\s+permission\s+for:\s*(.+)$/i);
    if (reqInline && reqInline[1]) {
      hasPermissionHeader = true;
      activeStartIdx = cursor;
      const target = reqInline[1].trim();
      if (/^(?:edit_file|write_file|write_to_file|create_file|replace_file_content|multi_replace_file_content|read_file|view_file|grep_search|find_by_name)$/i.test(target)) {
        isWorkspaceEditPrompt = true;
      } else if (!/^(?:run_command|bash|shell)$/i.test(target)) {
        rawExtractedCommand = target;
      }
    }
  }

  // Only consult prompt-parser fallback when NOT already rejected as a non-permission question
  if (!rawExtractedCommand && !isWorkspaceEditPrompt && !immediateNonPermissionQuestion && cleanScreen) {
    const pres = getHitlPromptPresentation(cleanScreen);
    if (
      pres &&
      pres.fullCommand &&
      !/^(?:do you want to|run this command|allow this|would you like to)/i.test(pres.fullCommand)
    ) {
      // Guard against prompt-parser grabbing a stale command across prose/output
      const tailSlice = fullPreLines.slice(Math.max(0, fullPreLines.length - 4));
      const hasBoundary = tailSlice.some((l) => OUTPUT_OR_PROSE_BOUNDARY_RE.test(l) || (/\?\s*$/.test(l) && !PERMISSION_PROMPT_HEADER_RE.test(l)));
      if (!hasBoundary) {
        rawExtractedCommand = pres.fullCommand;
      }
    }
  }

  const activePromptLines = fullPreLines.slice(activeStartIdx);
  const activePromptBlock = activePromptLines.join('\n');
  if (!immediateNonPermissionQuestion && PERMISSION_PROMPT_HEADER_RE.test(activePromptBlock)) {
    hasPermissionHeader = true;
  }

  const rawCommand = explicitRaw || rawExtractedCommand;
  const inspectionParts = [];
  if (rawCommand) inspectionParts.push(rawCommand);
  if (rawExtractedCommand && rawExtractedCommand !== rawCommand) inspectionParts.push(rawExtractedCommand);
  if (activePromptBlock) inspectionParts.push(activePromptBlock);

  return {
    rawCommand,
    normalizedCommand: normalizeCommandText(rawCommand),
    redactedPreview: redactCommandPreview(rawCommand || (isWorkspaceEditPrompt ? activePromptBlock.split('\n')[0] : '')),
    activePromptBlock,
    inspectionText: inspectionParts.join('\n'),
    hasPermissionHeader,
    isWorkspaceEditPrompt,
    immediateNonPermissionQuestion
  };
}

function resolvePromptOptions(screenText, parsedOptions) {
  if (Array.isArray(parsedOptions) && parsedOptions.length > 0) {
    return parsedOptions;
  }
  if (typeof screenText === 'string' && screenText.trim()) {
    const live = getLiveHitlOptions(screenText);
    if (live.length > 0) return live;
    return parseInteractivePromptOptions(screenText);
  }
  return [];
}

function classifyPackageInstall(cmd) {
  for (const pat of PACKAGE_INSTALL_PATTERNS) {
    if (pat.re.test(cmd)) return pat;
  }
  return null;
}

function classifyExternalNetwork(cmd) {
  for (const pat of EXTERNAL_NETWORK_PATTERNS) {
    if (pat.re.test(cmd)) return pat;
  }
  return null;
}

function isReadOnlyNetworkCommand(segment) {
  const s = normalizeCommandText(segment);
  if (!s || SHELL_METACHAR_RE.test(s)) return false;
  if (/^curl\b/i.test(s)) {
    return !READONLY_CURL_MUTATING_RE.test(s);
  }
  if (/^wget\b/i.test(s)) {
    return READONLY_WGET_SAFE_RE.test(s) && !READONLY_WGET_MUTATING_RE.test(s);
  }
  if (/^gh\b/i.test(s)) {
    if (!READONLY_GH_SAFE_RE.test(s)) return false;
    if (/^gh\s+api\b/i.test(s) && READONLY_GH_API_MUTATING_RE.test(s)) return false;
    return true;
  }
  // ssh, scp, sftp, git fetch/pull, nc, telnet are never treated as read-only network
  return false;
}

function matchesTrustedDevSegment(segment, effectiveFlags) {
  const s = normalizeCommandText(segment);
  if (!s) {
    return { ok: false, vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED, reason: 'Command contains disallowed shell operators' };
  }

  // Optional trailing log-file redirection is permitted ONLY on recognized read-only/test/lint/typecheck/build commands
  if (SHELL_METACHAR_RE.test(s)) {
    const redir = stripSafeTrailingLogRedirect(s);
    if (redir.hasRedirect) {
      if (!redir.valid) {
        return {
          ok: false,
          vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
          reason: 'Log redirection target path is disallowed (must be a safe .log/.txt/.out file)'
        };
      }
      if (SHELL_METACHAR_RE.test(redir.base)) {
        return {
          ok: false,
          vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
          reason: 'Command contains disallowed shell operators'
        };
      }
      if (hasForbiddenExecFlag(redir.base)) {
        return {
          ok: false,
          vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
          reason: 'Command contains disallowed code-execution or hook flag'
        };
      }
      if (classifyExternalNetwork(redir.base)) {
        return {
          ok: false,
          vetoCode: AUTO_CONSENT_VETO_CODES.NETWORK_POLICY,
          reason: 'Log redirection is not permitted on external network commands'
        };
      }
      if (classifyPackageInstall(redir.base)) {
        return {
          ok: false,
          vetoCode: AUTO_CONSENT_VETO_CODES.PACKAGE_INSTALL_POLICY,
          reason: 'Log redirection is not permitted on package installation commands'
        };
      }
      if (isSafeReadOnlyOrTestCommand(redir.base)) {
        return {
          ok: true,
          vetoCode: null,
          reason: 'Matches trusted_dev test/check command with safe log redirection'
        };
      }
      return {
        ok: false,
        vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
        reason: 'Log redirection is only permitted on recognized read-only/test/lint/typecheck/build commands'
      };
    }
    return { ok: false, vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED, reason: 'Command contains disallowed shell operators' };
  }

  if (hasForbiddenExecFlag(s)) {
    return { ok: false, vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED, reason: 'Command contains disallowed code-execution or hook flag' };
  }

  // External network gate runs BEFORE package install so `ssh ... "npm install"` / `curl ... "npm install"` never bypass VETO_NETWORK_POLICY
  const netHit = classifyExternalNetwork(s);
  if (netHit) {
    if (effectiveFlags.allowReadOnlyNetwork === true && isReadOnlyNetworkCommand(s)) {
      return { ok: true, vetoCode: null, reason: `Read-only network command permitted by policy (${netHit.label})` };
    }
    return {
      ok: false,
      vetoCode: AUTO_CONSENT_VETO_CODES.NETWORK_POLICY,
      reason: effectiveFlags.allowReadOnlyNetwork === true
        ? `Mutating/remote network command blocked by policy (${netHit.label})`
        : `External network call blocked by policy (${netHit.label})`
    };
  }

  // Package install gate (default OFF; when ON, strictly anchored at start of command only!)
  const pkgHit = classifyPackageInstall(s);
  if (pkgHit) {
    if (effectiveFlags.allowPackageInstall !== true) {
      return {
        ok: false,
        vetoCode: AUTO_CONSENT_VETO_CODES.PACKAGE_INSTALL_POLICY,
        reason: `Package installation blocked by policy (${pkgHit.label})`
      };
    }
    if (ANCHORED_PACKAGE_INSTALL_RE.test(s)) {
      return { ok: true, vetoCode: null, reason: `Package install permitted by policy (${pkgHit.label})` };
    }
    return {
      ok: false,
      vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
      reason: 'Unanchored package-install substring inside non-package command is outside trusted_dev allowlist'
    };
  }

  if (isSafeReadOnlyCommand(s)) {
    return { ok: true, vetoCode: null, reason: 'Matches safe read-only command allowlist' };
  }

  const npmRunMatch = s.match(TRUSTED_DEV_NPM_SCRIPT_RE);
  if (npmRunMatch && FORBIDDEN_NPM_SCRIPT_NAME_RE.test(npmRunMatch[1])) {
    return {
      ok: false,
      vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
      reason: `Script "${npmRunMatch[1]}" requires manual approval`
    };
  }

  if (TRUSTED_DEV_GIT_FORCE_MUTATION_RE.test(s)) {
    return {
      ok: false,
      vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
      reason: 'Force-mutating git branch/checkout/switch requires manual approval'
    };
  }

  if (TRUSTED_DEV_SINGLE_COMMAND_RE.test(s)) {
    return { ok: true, vetoCode: null, reason: 'Matches trusted_dev workspace command allowlist' };
  }

  return {
    ok: false,
    vetoCode: AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
    reason: 'Command is outside trusted_dev allowlist'
  };
}

function checkAntiLoopAndRateCaps({
  recentApprovals,
  seatId,
  promptFingerprint,
  normalizedCommand,
  effectivePolicy,
  config,
  nowMs
}) {
  const list = Array.isArray(recentApprovals) ? recentApprovals : [];
  const maxPerHour = Number.isFinite(effectivePolicy?.maxActionsPerHour)
    ? effectivePolicy.maxActionsPerHour
    : (Number.isFinite(config?.maxActionsPerHour) ? config.maxActionsPerHour : AUTO_CONSENT_LIMITS.DEFAULT_MAX_ACTIONS_PER_HOUR);
  const maxPerSeat10m = Number.isFinite(effectivePolicy?.maxPerSeatPer10m)
    ? effectivePolicy.maxPerSeatPer10m
    : (Number.isFinite(config?.maxPerSeatPer10m) ? config.maxPerSeatPer10m : AUTO_CONSENT_LIMITS.DEFAULT_MAX_PER_SEAT_10M);

  // Session approval cap check
  if (
    effectivePolicy?.sourceScope === 'session' &&
    typeof effectivePolicy.remainingApprovals === 'number' &&
    effectivePolicy.remainingApprovals <= 0
  ) {
    return {
      vetoCode: AUTO_CONSENT_VETO_CODES.RATE_CAP,
      reason: 'Session grant maxApprovals exhausted'
    };
  }

  let fleetLastHour = 0;
  let seatLast10m = 0;
  let sameCmdLast10m = 0;

  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const ts = parseTsMs(rec.timestampMs ?? rec.executedAt ?? rec.tsMs ?? rec.at);
    const ageMs = ts !== null ? (nowMs - ts) : 0;
    if (ageMs < 0) continue;

    if (ageMs <= AUTO_CONSENT_LIMITS.HOURLY_WINDOW_MS) {
      fleetLastHour += 1;
    }

    const recSeat = String(rec.seatId || rec.targetSeatId || '').trim();
    const isThisSeat = !seatId || !recSeat || recSeat === seatId;
    if (isThisSeat && ageMs <= AUTO_CONSENT_LIMITS.RETRY_LOOP_WINDOW_MS) {
      seatLast10m += 1;

      const recFp = String(rec.promptFingerprint || rec.promptHash || '').trim();
      if (recFp && recFp === promptFingerprint && rec.cleared !== true) {
        return {
          vetoCode: AUTO_CONSENT_VETO_CODES.RETRY_LOOP,
          reason: 'Identical prompt was already approved without clearing (anti-loop protection)'
        };
      }

      const recNormCmd = normalizeCommandText(rec.normalizedCommand || rec.commandPreview || '');
      if (normalizedCommand && recNormCmd && recNormCmd === normalizedCommand) {
        sameCmdLast10m += 1;
      }
    }
  }

  if (sameCmdLast10m >= AUTO_CONSENT_LIMITS.RETRY_LOOP_CMD_CAP) {
    return {
      vetoCode: AUTO_CONSENT_VETO_CODES.RETRY_LOOP,
      reason: `Repeated approval of the same command (${sameCmdLast10m}x in 10m)`
    };
  }

  if (seatLast10m >= maxPerSeat10m) {
    return {
      vetoCode: AUTO_CONSENT_VETO_CODES.RATE_CAP,
      reason: `Per-seat 10-minute auto-consent cap (${maxPerSeat10m}) reached`
    };
  }

  if (fleetLastHour >= maxPerHour) {
    return {
      vetoCode: AUTO_CONSENT_VETO_CODES.RATE_CAP,
      reason: `Fleet hourly auto-consent cap (${maxPerHour}/h) reached`
    };
  }

  return null;
}

/**
 * Pure Auto-Consent Prompt Decision Classifier.
 * Evaluates all Hard Safety Vetoes, Option-1-Only invariant, Permission-vs-Question gate,
 * operational/anti-loop guards, and profile allowlists.
 *
 * Always returns:
 * { decision: 'approve_once' | 'dry_run' | 'escalate', keyStroke: '1 Enter' | null,
 *   vetoCode, hardVetoes, reason, matchedProfile, sourceScope, commandPreview,
 *   normalizedCommand, promptFingerprint }
 */
export function evaluateAutoConsentPrompt({
  screenText = '',
  parsedOptions = null,
  commandPreview = '',
  seat = null,
  effectivePolicy = null,
  recentApprovals = [],
  breakerState = null,
  gitConflicts = null,
  nowMs = Date.now(),
  config = null
} = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const seatId = getSeatIdFromObj(seat);
  const options = resolvePromptOptions(screenText, parsedOptions);
  const promptCtx = extractActivePromptContext(screenText, commandPreview);
  const promptFingerprint = computePromptFingerprint(
    promptCtx.normalizedCommand || promptCtx.redactedPreview,
    options
  );

  const profile = effectivePolicy?.profile || AUTO_CONSENT_PROFILES.OFF;
  const sourceScope = effectivePolicy?.sourceScope || 'global';
  const mode = effectivePolicy?.mode || config?.mode || AUTO_CONSENT_MODES.DRY_RUN;
  const effectiveFlags = sanitizeAutoConsentFlags(
    effectivePolicy?.effectiveFlags,
    config?.defaults || DEFAULT_AUTO_CONSENT_FLAGS
  );

  const escalate = (vetoCode, reason, hardVetoes = []) => ({
    decision: 'escalate',
    keyStroke: null,
    vetoCode,
    hardVetoes,
    reason,
    matchedProfile: profile,
    sourceScope,
    commandPreview: promptCtx.redactedPreview,
    normalizedCommand: promptCtx.normalizedCommand,
    promptFingerprint
  });

  // 1. Policy activation / master pause / manual_only checks
  if (!effectivePolicy || effectivePolicy.vetoReason === AUTO_CONSENT_VETO_CODES.MASTER_PAUSED) {
    return escalate(
      effectivePolicy?.vetoReason || AUTO_CONSENT_VETO_CODES.POLICY_OFF,
      effectivePolicy?.vetoReason === AUTO_CONSENT_VETO_CODES.MASTER_PAUSED
        ? 'Master kill-switch pause is active'
        : 'Auto-consent policy is inactive'
    );
  }
  if (!effectivePolicy.active || profile === AUTO_CONSENT_PROFILES.OFF || profile === AUTO_CONSENT_PROFILES.MANUAL_ONLY) {
    const code = effectivePolicy.vetoReason || (
      profile === AUTO_CONSENT_PROFILES.MANUAL_ONLY
        ? AUTO_CONSENT_VETO_CODES.MANUAL_ONLY
        : AUTO_CONSENT_VETO_CODES.POLICY_OFF
    );
    return escalate(code, `Auto-consent disabled for scope (${code})`);
  }

  // Enforce direct expiry check even when caller passes a pre-resolved session effectivePolicy
  if (effectivePolicy.expiresAtMs !== null && effectivePolicy.expiresAtMs !== undefined) {
    const expMs = Number(effectivePolicy.expiresAtMs);
    if (!Number.isFinite(expMs) || now >= expMs) {
      return escalate(AUTO_CONSENT_VETO_CODES.SESSION_EXPIRED, 'Session grant has expired');
    }
  }

  // 2. Operational Safety Vetoes
  if (isSeatShellExited(seat, screenText)) {
    return escalate(AUTO_CONSENT_VETO_CODES.SHELL_EXITED, 'Seat exited to bare OS shell');
  }
  if (isBreakerTrippedForSeat(breakerState, seatId)) {
    return escalate(AUTO_CONSENT_VETO_CODES.BREAKER_TRIPPED, 'Budget/loop circuit-breaker is tripped');
  }
  const isReadOnlyOrTestCmd = Boolean(
    !promptCtx.isWorkspaceEditPrompt &&
    promptCtx.normalizedCommand &&
    isSafeReadOnlyOrTestWithOptionalLogRedirect(promptCtx.normalizedCommand)
  );
  if (hasWorktreeConflictForSeat(gitConflicts, seat, seatId, { isReadOnlyOrTestCmd })) {
    return escalate(AUTO_CONSENT_VETO_CODES.WORKTREE_CONFLICT, 'Active git worktree file overlap/conflict');
  }
  const ctxPct = getCtxPctFromSeat(seat);
  if (effectiveFlags.pauseOnCtxOverheat !== false && ctxPct !== null && ctxPct >= effectiveFlags.ctxPauseThresholdPct) {
    return escalate(
      AUTO_CONSENT_VETO_CODES.CTX_OVERHEAT,
      `Seat context ${ctxPct}% >= overheat threshold ${effectiveFlags.ctxPauseThresholdPct}%`
    );
  }

  // 3. Non-Overridable Hard Safety Vetoes (Single Source of Truth)
  const hardVetoes = classifyDestructiveVetoes(promptCtx.inspectionText);
  if (hardVetoes.length > 0) {
    return escalate(
      hardVetoes[0].ruleId,
      `Hard safety veto: ${hardVetoes.map((v) => v.reason).join('; ')}`,
      hardVetoes
    );
  }

  // 4. Option-1-Only Invariant & Permission-vs-Question Gate
  const opt1 = options.find((o) => o && String(o.badge) === '1') || null;
  const opt1Text = normalizeCommandText(opt1?.fullText || opt1?.shortLabel || '');
  const hasCancelOpt = options.some((o) => {
    if (!o || String(o.badge) === '1') return false;
    const txt = normalizeCommandText(o.fullText || o.shortLabel || '');
    return o.isCancel === true || CANCEL_OPT_RE.test(txt);
  });
  const hasPermissionEvidence = Boolean(
    !promptCtx.immediateNonPermissionQuestion &&
    (promptCtx.normalizedCommand || promptCtx.isWorkspaceEditPrompt)
  );

  // Explicit check: if Option 1 says "Always allow" / "Persist to settings" / "Don't ask again" / "above fold"
  if (opt1 && FORBIDDEN_PERSISTENT_ALLOW_RE.test(opt1Text)) {
    return escalate(
      AUTO_CONSENT_VETO_CODES.NO_SINGLE_ALLOW_OPTION,
      'Option 1 would persist permission ("Always allow" / settings) or is unverified above fold'
    );
  }

  // Permission-vs-Question gate: must have permission evidence AND recognizable Yes/Allow + No/Cancel pair
  if (!hasPermissionEvidence || options.length < 2 || !hasCancelOpt) {
    // Distinguish missing Option 1 on an explicit permission prompt (e.g. scrolled tail 2..3)
    if (hasPermissionEvidence && hasCancelOpt && !opt1) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.NO_SINGLE_ALLOW_OPTION,
        'Option 1 is missing from visible permission prompt'
      );
    }
    return escalate(
      AUTO_CONSENT_VETO_CODES.NON_PERMISSION_QUESTION,
      'Non-permission question or product/architectural menu requires human decision'
    );
  }

  // Option-1-Only invariant: Option 1 MUST match explicit single-use allow semantics and keyStroke "1 Enter"
  if (!opt1 || !SINGLE_ALLOW_OPT_RE.test(opt1Text) || CANCEL_OPT_RE.test(opt1Text)) {
    // If Option 1 looks like a non-yes product choice (e.g., "Use Redis"), classify as non-permission question unless it contains allow/yes
    const looksLikePermissionAttempt = /\b(?:yes|allow|approve|proceed|always|persist|разрешить|да)\b/i.test(opt1Text);
    return escalate(
      looksLikePermissionAttempt
        ? AUTO_CONSENT_VETO_CODES.NO_SINGLE_ALLOW_OPTION
        : AUTO_CONSENT_VETO_CODES.NON_PERMISSION_QUESTION,
      looksLikePermissionAttempt
        ? `Option 1 ("${opt1Text}") does not match strict single-use Allow semantics`
        : `Option 1 ("${opt1Text}") looks like a choice question rather than a permission prompt`
    );
  }
  if (opt1.keyStroke && String(opt1.keyStroke).trim() !== '1 Enter') {
    return escalate(
      AUTO_CONSENT_VETO_CODES.NO_SINGLE_ALLOW_OPTION,
      `Option 1 keyStroke ("${opt1.keyStroke}") is not "1 Enter"`
    );
  }

  // 5. Anti-loop & sliding rate caps
  const loopOrRate = checkAntiLoopAndRateCaps({
    recentApprovals,
    seatId,
    promptFingerprint,
    normalizedCommand: promptCtx.normalizedCommand,
    effectivePolicy,
    config,
    nowMs: now
  });
  if (loopOrRate) {
    return escalate(loopOrRate.vetoCode, loopOrRate.reason);
  }

  // 6. Trust Profile Matching
  const cmd = promptCtx.normalizedCommand;

  if (profile === AUTO_CONSENT_PROFILES.SAFE_READONLY) {
    if (!cmd) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
        'safe_readonly requires an explicit read-only/test command preview'
      );
    }
    if (SHELL_METACHAR_RE.test(cmd)) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
        'safe_readonly forbids all shell metacharacters'
      );
    }
    const pkgHit = classifyPackageInstall(cmd);
    if (pkgHit) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.PACKAGE_INSTALL_POLICY,
        `Package install (${pkgHit.label}) is not permitted under safe_readonly`
      );
    }
    const netHit = classifyExternalNetwork(cmd);
    if (netHit) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.NETWORK_POLICY,
        `Network call (${netHit.label}) is not permitted under safe_readonly`
      );
    }
    if (hasForbiddenExecFlag(cmd)) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
        'safe_readonly forbids code-execution and hook-injection flags'
      );
    }
    if (!isSafeReadOnlyCommand(cmd)) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
        'Command is not in the safe_readonly allowlist'
      );
    }
  } else if (profile === AUTO_CONSENT_PROFILES.TRUSTED_DEV) {
    if (cmd) {
      // Allow clean '&&' chaining ONLY when every individual segment passes trusted_dev checks
      const rawSegments = cmd.split(/\s*&&\s*/);
      if (rawSegments.some((seg) => !seg.trim())) {
        return escalate(
          AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
          'Malformed chained command requires manual approval'
        );
      }
      for (const seg of rawSegments) {
        const segCheck = matchesTrustedDevSegment(seg, effectiveFlags);
        if (!segCheck.ok) {
          return escalate(segCheck.vetoCode, segCheck.reason);
        }
      }
    } else if (!promptCtx.isWorkspaceEditPrompt) {
      return escalate(
        AUTO_CONSENT_VETO_CODES.PROFILE_UNMATCHED,
        'trusted_dev requires a recognized workspace command or file edit prompt'
      );
    }
  } else if (profile === AUTO_CONSENT_PROFILES.SPRINT_ALL) {
    // sprint_all MUST only be active via a bounded Session Grant
    if (sourceScope !== 'session') {
      return escalate(
        AUTO_CONSENT_VETO_CODES.POLICY_OFF,
        'sprint_all requires a bounded ephemeral Session Grant'
      );
    }
    // All Hard Safety Vetoes, Option-1-Only, Permission-vs-Question, operational & anti-loop checks passed!
  } else {
    return escalate(AUTO_CONSENT_VETO_CODES.POLICY_OFF, `Unsupported profile: ${profile}`);
  }

  // Eligible! Respect dry_run vs armed mode
  if (mode === AUTO_CONSENT_MODES.ARMED) {
    return {
      decision: 'approve_once',
      keyStroke: '1 Enter',
      vetoCode: null,
      hardVetoes: [],
      reason: `Matched ${profile} policy (${sourceScope}) — eligible for Option 1 (Allow Once)`,
      matchedProfile: profile,
      sourceScope,
      commandPreview: promptCtx.redactedPreview,
      normalizedCommand: promptCtx.normalizedCommand,
      promptFingerprint
    };
  }

  return {
    decision: 'dry_run',
    keyStroke: null,
    vetoCode: null,
    hardVetoes: [],
    reason: `Dry-run preview: matched ${profile} policy (${sourceScope}) — 0 tmux writes`,
    matchedProfile: profile,
    sourceScope,
    commandPreview: promptCtx.redactedPreview,
    normalizedCommand: promptCtx.normalizedCommand,
    promptFingerprint
  };
}

/**
 * Pure summary helper for HUD indicators and status badges.
 */
export function summarizeActiveAutoConsentScopes(
  rawConfig = DEFAULT_AUTO_CONSENT_CONFIG,
  sessionGrants = [],
  nowMs = Date.now()
) {
  const cfg = sanitizeAutoConsentConfig(rawConfig, DEFAULT_AUTO_CONSENT_CONFIG);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const activeProjectIds = Object.entries(cfg.projects)
    .filter(([, p]) => p && (p.profile === 'safe_readonly' || p.profile === 'trusted_dev'))
    .map(([id]) => id);
  const activeSeatIds = Object.entries(cfg.seats)
    .filter(([, s]) => s && (s.profile === 'safe_readonly' || s.profile === 'trusted_dev'))
    .map(([id]) => id);

  const grants = normalizeGrantsList(sessionGrants);
  const activeGrants = [];
  let minRemainingMs = null;

  for (const grant of grants) {
    if (!grant || typeof grant !== 'object' || grant.revoked === true) continue;
    if (grant.scope !== 'seat' && grant.scope !== 'rig') continue;
    if (!SESSION_PROFILES.has(grant.profile)) continue;
    const targetId = String(grant.targetId || '').trim();
    const targetRe = grant.scope === 'rig' ? SAFE_RIG_NAME_RE : SAFE_SEAT_ID_RE;
    if (!targetId || FORBIDDEN_OBJECT_KEYS.has(targetId) || !targetRe.test(targetId)) continue;
    if (grant.scope === 'seat') {
      const epoch = (grant.seatSessionEpoch !== null && grant.seatSessionEpoch !== undefined)
        ? String(grant.seatSessionEpoch).trim()
        : '';
      if (!epoch) continue;
    }
    const createdAtMs = Number(grant.createdAtMs);
    const rawExp = Number(grant.expiresAtMs);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(rawExp) || rawExp <= createdAtMs) continue;
    const effExp = Math.min(rawExp, createdAtMs + AUTO_CONSENT_LIMITS.MAX_SESSION_TTL_MS);
    if (now >= effExp) continue;
    const hardCap = grant.profile === AUTO_CONSENT_PROFILES.SPRINT_ALL
      ? AUTO_CONSENT_LIMITS.MAX_SPRINT_APPROVALS
      : AUTO_CONSENT_LIMITS.MAX_SESSION_APPROVALS;
    const rawMax = Math.floor(Number(grant.maxApprovals));
    const rawUsed = grant.usedApprovals === undefined ? 0 : Math.floor(Number(grant.usedApprovals));
    if (!Number.isFinite(rawMax) || rawMax <= 0 || !Number.isFinite(rawUsed) || rawUsed < 0) continue;
    const maxAllowed = Math.min(rawMax, hardCap);
    if (rawUsed >= maxAllowed) continue;
    activeGrants.push(grant);
    const rem = effExp - now;
    if (minRemainingMs === null || rem < minRemainingMs) minRemainingMs = rem;
  }

  const totalActiveScopes = activeProjectIds.length + activeSeatIds.length + activeGrants.length;
  const hasActiveScopes = cfg.enabled && totalActiveScopes > 0;

  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    masterPaused: cfg.masterPaused,
    hasActiveScopes,
    totalActiveScopes,
    activeProjectCount: activeProjectIds.length,
    activeSeatCount: activeSeatIds.length,
    activeSessionCount: activeGrants.length,
    shortestSessionRemainingMin: minRemainingMs !== null ? Math.max(1, Math.ceil(minRemainingMs / 60_000)) : null
  };
}
