import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR_NAME = 'rig-commander-mission-control';
const SKILL_DIR = path.join(ROOT, 'skills', SKILL_DIR_NAME);
const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md');
const TEXT_EXTS = new Set(['.md', '.txt', '.yml', '.yaml', '.json']);

function readRel(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walkSkillFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSkillFiles(full));
    } else if (TEXT_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'SKILL.md must start with valid YAML frontmatter delimited by ---');
  const data = {};
  let currentMap = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const nested = rawLine.match(/^ {2}([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (nested && currentMap) {
      currentMap[nested[1]] = unquote(nested[2]);
      continue;
    }
    const top = rawLine.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    assert.ok(top, `Invalid frontmatter line: ${rawLine}`);
    const [, key, rest] = top;
    if (rest.trim() === '') {
      data[key] = {};
      currentMap = data[key];
    } else {
      data[key] = unquote(rest);
      currentMap = null;
    }
  }
  return data;
}

test('SKILL.md frontmatter satisfies agentskills.io schema and canonical metadata', () => {
  const pkg = JSON.parse(readRel('package.json'));
  const content = fs.readFileSync(SKILL_MD_PATH, 'utf8');
  const fm = parseFrontmatter(content);

  assert.equal(fm.name, SKILL_DIR_NAME);
  assert.match(fm.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(fm.name.length <= 64, `name exceeds 64 chars: ${fm.name.length}`);

  assert.equal(typeof fm.description, 'string');
  assert.ok(fm.description.length > 0 && fm.description.length <= 1024);
  assert.match(fm.description, /\bUse when\b/);

  assert.equal(fm.license, 'MIT');

  assert.equal(typeof fm.compatibility, 'string');
  assert.ok(fm.compatibility.length > 0 && fm.compatibility.length <= 500);
  assert.match(fm.compatibility, /Node\.js\s*>=\s*18/);

  assert.equal(typeof fm.metadata, 'object');
  assert.equal(fm.metadata.author, 'Vedariy');
  assert.equal(fm.metadata.version, pkg.version);
  assert.equal(fm.metadata.homepage, 'https://rig-commander.vercel.app');
  assert.equal(fm.metadata.repository, 'https://github.com/Vedariy/rig-commander');
  assert.equal(fm.metadata.demo, 'https://rig-commander.vercel.app/demo');
});

test('SKILL.md and progressive-disclosure references stay concise and resolve cleanly', () => {
  const content = fs.readFileSync(SKILL_MD_PATH, 'utf8');
  const lines = content.trimEnd().split(/\r?\n/);
  assert.ok(lines.length > 0 && lines.length <= 220, `SKILL.md has ${lines.length} lines (limit 220)`);

  const refMatches = [...content.matchAll(/\]\((references\/[a-z0-9-]+\.md)\)/g)].map(m => m[1]);
  const uniqueRefs = [...new Set(refMatches)];
  assert.ok(uniqueRefs.includes('references/operator-runbook.md'));
  assert.ok(uniqueRefs.includes('references/safety-boundaries.md'));

  for (const relRef of uniqueRefs) {
    const absRef = path.join(SKILL_DIR, relRef);
    assert.ok(fs.existsSync(absRef), `Missing referenced file: ${relRef}`);
    const refLines = fs.readFileSync(absRef, 'utf8').trimEnd().split(/\r?\n/);
    assert.ok(refLines.length > 0 && refLines.length <= 200, `${relRef} has ${refLines.length} lines (limit 200)`);
  }

  const actualRefs = fs
    .readdirSync(path.join(SKILL_DIR, 'references'))
    .filter(f => f.endsWith('.md'))
    .map(f => `references/${f}`);
  for (const relRef of actualRefs) {
    assert.ok(uniqueRefs.includes(relRef), `Unreferenced file in references/: ${relRef}`);
  }
});

test('public skill files contain zero Tier-1 leakage patterns or undocumented CLI flags', () => {
  const cliSource = readRel('bin/cli.mjs');
  const verifiedFlags = new Set([
    '-p', '--port', '--host', '--public-url', '--universal', '--no-open', '-v', '--version', '-h', '--help'
  ]);
  for (const flag of verifiedFlags) {
    assert.ok(cliSource.includes(flag), `Expected CLI flag ${flag} in bin/cli.mjs`);
  }

  const forbiddenPatterns = [
    /\b(?:assets\/(?:domain|ontology|ui)|lib|tests)\//,
    /\.private-docs\b/,
    /\bH_norm\b/,
    /\bDECK_TOKEN\b/,
    /\bActionFlightGuard\b/,
    /\bServerIdempotencyCache\b/,
    /\bparseAllowedTmuxKeys\b/,
    /\bresolveSafeStaticPath\b/,
    /\bclassifyTerminalScreen\b/,
    /\bboundedMapSet\b/,
    /\bDESTRUCTIVE_VETO_PATTERNS\b/,
    /\bseatSessionEpoch\b/,
    /\bpromptHash\b/,
    /\bctxPauseThresholdPct\b/,
    /\bauto-consent-model\b/,
    /\bauto-consent-engine\b/,
    /\bshellExited\b/,
    /\bGLiClass\b|\bEmbeddingGemma\b|\bHydrogen\b/,
    /\/v1\/systemone/i,
    /\b(?:409|413)\b/,
    /\b192-bit\b/i,
    /5 wrong|5 ошибок/i,
    /72-line|72L capture/i,
    /\/Users\/[a-zA-Z0-9._-]+/,
    /\/home\/[a-zA-Z0-9._-]+/,
    /~\/openrig-lab\/|~\/www\/EnterpriseCore/,
    /--state-dir\b/,
    /127\.0\.0\.1(?::\d+)?\/demo\b/i,
    /\blocal\s+`?\/demo\b/i
  ];

  const skillFiles = walkSkillFiles(path.join(ROOT, 'skills'));
  assert.ok(skillFiles.length >= 3, 'Expected SKILL.md and at least 2 reference files');

  for (const full of skillFiles) {
    const rel = path.relative(ROOT, full);
    const text = fs.readFileSync(full, 'utf8');
    for (const rx of forbiddenPatterns) {
      const m = text.match(rx);
      assert.equal(m, null, `Tier-1 leakage or undocumented flag in ${rel}: ${m?.[0]}`);
    }
    for (const line of text.split(/\r?\n/)) {
      if (!/\brig-commander(?:@latest)?\b/.test(line)) continue;
      for (const m of line.matchAll(/(?:^|\s)(--[a-z0-9-]+|-[a-zA-Z])\b/g)) {
        const flag = m[1];
        assert.ok(verifiedFlags.has(flag), `Undocumented rig-commander flag ${flag} in ${rel}: ${line}`);
      }
    }
  }
});

test('package.json excludes skills/ from the npm CLI tarball and preserves zero dependencies', () => {
  const pkg = JSON.parse(readRel('package.json'));
  assert.ok(Array.isArray(pkg.files), 'package.json must declare a files allowlist');
  assert.equal(
    pkg.files.some(entry => /(^|\/)skills(\/|$)/.test(entry)),
    false,
    'package.json "files" must keep skills/ out of the npm CLI tarball'
  );
  assert.deepEqual(pkg.dependencies, {});
});

test('README.md documents the Agent Skill install command and links to SKILL.md', () => {
  const readme = readRel('README.md');
  assert.ok(readme.includes('npx skills add Vedariy/rig-commander'));
  assert.ok(readme.includes('./skills/rig-commander-mission-control/SKILL.md'));
});
