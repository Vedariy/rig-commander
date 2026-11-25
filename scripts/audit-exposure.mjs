#!/usr/bin/env node
/**
 * Exposure & privacy boundary audit for RigCommander.
 * Enforces the 3-tier documentation rules defined in AGENTS.md:
 *   1. .private-docs/ is gitignored and contains 0 tracked files.
 *   2. Public showcase pages (public/index.html, public/passport/index.html, public/guide/index.html)
 *      do not expose internal implementation details (raw file trees, internal symbols, exact thresholds).
 *   3. No local machine home paths, private keys, or raw API secrets exist in tracked source/docs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

function checkGitignore() {
  const giPath = path.join(ROOT, '.gitignore');
  const content = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  if (!/^\.private-docs\/?$/m.test(content)) {
    violations.push('.gitignore is missing `.private-docs/` rule');
  }
  try {
    const tracked = execFileSync('git', ['ls-files', '.private-docs'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (tracked) {
      violations.push(`.private-docs/ has tracked git files:\n${tracked}`);
    }
  } catch {
    // Allow running outside a git worktree (e.g. tarball check)
  }
}

function checkPackageFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  if (files.some((entry) => entry.includes('.private-docs'))) {
    violations.push('package.json "files" must never include .private-docs');
  }
  if (!files.includes('!openrig/docs/**')) {
    violations.push('package.json "files" should exclude `!openrig/docs/**` from npm tarball');
  }
}

const PUBLIC_FORBIDDEN = [
  /\/v1\/systemone/i,
  /\bH_norm\b/,
  /\bDECK_TOKEN\b/,
  /\bActionFlightGuard\b/,
  /\bServerIdempotencyCache\b/,
  /\bparseAllowedTmuxKeys\b/,
  /\bresolveSafeStaticPath\b/,
  /\bclassifyTerminalScreen\b/,
  /\bboundedMapSet\b/,
  /\b192-bit\b|192 бита/,
  /5 ошибок|5 wrong/,
  /tests\/[a-z-]+\.test\.mjs/,
  /lib\/ai-evaluator/,
  /\bGLiClass\b|\bEmbeddingGemma\b|\bHydrogen\b/,
  /72 строки|72-line|72L capture/,
  /\bshellExited\b/
];

function checkPublicShowcase() {
  const pages = [
    'public/index.html',
    'public/passport/index.html',
    'public/guide/index.html'
  ];
  for (const rel of pages) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      violations.push(`Missing synced public page: ${rel} (run npm run sync:public)`);
      continue;
    }
    const text = fs.readFileSync(full, 'utf8');
    for (const rx of PUBLIC_FORBIDDEN) {
      const m = text.match(rx);
      if (m) {
        violations.push(`Public showcase exposure in ${rel}: matched ${rx} (${m[0]})`);
      }
    }
  }
}

const SECRET_AND_PATH_PATTERNS = [
  { name: 'macOS home path', rx: /\/Users\/[a-zA-Z0-9._-]+/ },
  { name: 'Linux home path', rx: /\/home\/[a-zA-Z0-9._-]+/ },
  { name: 'Private key block', rx: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'GitHub PAT', rx: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Private lab path', rx: /~\/openrig-lab\/|~\/www\/EnterpriseCore/ }
];

const SCAN_DIRS = ['openrig', 'landing', 'docs', 'scripts', 'bin'];
const SCAN_FILES = ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'package.json'];
const TEXT_EXTS = new Set(['.md', '.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.yml', '.yaml']);

function walkFiles(dirRel) {
  const out = [];
  const start = path.join(ROOT, dirRel);
  if (!fs.existsSync(start)) return out;
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
      if (entry.name === 'node_modules') continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (TEXT_EXTS.has(path.extname(entry.name).toLowerCase())) {
        out.push(path.relative(ROOT, full));
      }
    }
  }
  return out;
}

function checkLeaks() {
  const targets = [...SCAN_FILES];
  for (const d of SCAN_DIRS) targets.push(...walkFiles(d));
  for (const rel of targets) {
    if (rel === 'scripts/audit-exposure.mjs') continue;
    // Allow regex/redactor test literals in openrig/lib/ai-evaluator/redactor.mjs & shift-history.mjs
    const isRedactorCode = rel.endsWith('redactor.mjs') || rel.endsWith('shift-history.mjs');
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const { name, rx } of SECRET_AND_PATH_PATTERNS) {
      if (isRedactorCode && (name === 'macOS home path' || name === 'Linux home path' || name === 'Private key block')) {
        continue;
      }
      const m = text.match(rx);
      if (m) {
        violations.push(`Leak (${name}) in ${rel}: ${m[0]}`);
      }
    }
  }
}

checkGitignore();
checkPackageFiles();
checkPublicShowcase();
checkLeaks();

if (violations.length > 0) {
  console.error(`EXPOSURE_AUDIT_FAIL (${violations.length} issue(s)):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('EXPOSURE_AUDIT_PASS: .private-docs/ protected, public showcase clean, zero path/secret leaks.');
