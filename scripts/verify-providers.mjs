#!/usr/bin/env node
/**
 * Contour B — Dev-Time Provider Version & Contract Verification CLI.
 *
 * Non-destructive local runner checking installed agent CLIs (`rig`, `codex`, `claude`, `agy`)
 * `--version` & `--help` flags plus sample shapes against `openrig/lib/provider-contracts.json`.
 * Zero outbound network requests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ProviderDriftGuard, loadProviderContracts } from '../openrig/lib/provider-drift-guard.mjs';

function parseCliArgs(argv) {
  const opts = {
    json: false,
    strict: false,
    provider: '',
    contractsPath: '',
    samplePath: ''
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--provider' && argv[i + 1]) opts.provider = String(argv[++i]).trim();
    else if (a === '--contracts' && argv[i + 1]) opts.contractsPath = path.resolve(argv[++i]);
    else if (a === '--samples' && argv[i + 1]) opts.samplePath = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/verify-providers.mjs [options]

Options:
  --json              Emit machine-readable JSON contract diff report
  --provider <id>     Verify a single provider (openrig | codex | claude-code | agy)
  --strict            Treat unverified_version outside testedVersionRange as failure
  --contracts <path>  Override provider-contracts.json path
  --samples <path>    Validate custom JSON fixture samples ({ "<providerId>": { "<contract>": ... } })
  -h, --help          Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

const DEFAULT_CONTRACT_SAMPLES = Object.freeze({
  openrig: {
    apiRigsItem: { id: 'demo-rig', name: 'demo-rig', status: 'running' },
    apiNode: { canonicalSessionName: 'worker@demo-rig', activityState: { display: 'working' } },
    queueItem: { qitemId: 'qitem-1', state: 'in-progress' }
  },
  codex: {
    jsonlSessionMeta: { type: 'session_meta', payload: { id: 'thr-1', cwd: '~/repo' } },
    jsonlTokenCount: { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100 } } } }
  },
  'claude-code': {
    jsonlAssistant: { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 100 } } },
    teamConfig: { name: 'team-1', members: [] },
    teamTask: { id: '1', subject: 'Audit', status: 'in_progress' }
  },
  agy: {
    swarmMeta: { version: 1, swarm_id: '4b4b30d8-9fd7-45fb-aad2-4deafb21fb96' },
    swarmMembers: { members: { coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'working' } } },
    swarmMemberEntry: { role: 'worker', phase: 'RUNNING', wake_mode: 'working' },
    swarmPlan: { goal: { title: 'Goal', line: 'Line' }, tasks: {} },
    swarmBoardEntry: { seq: 1, agent: 'coordinator', text: '@worker start' }
  }
});

export async function runVerifyProvidersCli(argv = process.argv.slice(2), deps = {}) {
  const opts = parseCliArgs(argv);
  const contracts = deps.contracts || (opts.contractsPath ? loadProviderContracts(opts.contractsPath) : loadProviderContracts());
  let samplePayloads = deps.samplePayloads || null;
  if (!samplePayloads && opts.samplePath) {
    samplePayloads = JSON.parse(fs.readFileSync(opts.samplePath, 'utf8'));
  } else if (!samplePayloads) {
    samplePayloads = DEFAULT_CONTRACT_SAMPLES;
  }

  const guard = new ProviderDriftGuard({
    contracts,
    execFileFn: deps.execFileFn,
    statFn: deps.statFn,
    whichFn: deps.whichFn,
    now: deps.now
  });

  const report = await guard.verifyProviderContracts({
    providerIds: opts.provider ? [opts.provider] : null,
    samplePayloads,
    strict: opts.strict
  });

  return { opts, report };
}

function formatHumanReport(report) {
  const lines = [
    `Provider Contract Verification (${report.checkedAt})`,
    `------------------------------------------------------------------------`
  ];
  for (const p of report.providers) {
    const ver = p.version || (p.installed ? 'unknown' : 'not_installed');
    const helpNote = p.missingHelpTokens.length > 0
      ? `missing flags: ${p.missingHelpTokens.join(', ')}`
      : (p.helpStatus === 'pass' ? 'help ok' : 'help skipped');
    lines.push(
      `${p.providerId.padEnd(13)} | ver=${String(ver).padEnd(12)} | range=${String(p.testedVersionRange).padEnd(18)} | ${p.versionStatus.padEnd(18)} | ${helpNote} | ${p.contractStatus.toUpperCase()}`
    );
    for (const sc of p.sampleChecks || []) {
      if (!sc.ok) {
        lines.push(`  ! sample drift [${sc.contractName}]: missing=${sc.missingKeys.join(',')} skeleton=${JSON.stringify(sc.skeleton)}`);
      }
    }
  }
  lines.push(`------------------------------------------------------------------------`);
  lines.push(
    report.ok
      ? `PROVIDER_CONTRACTS_PASS (unverifiedVersions=${report.unverifiedVersionCount}, drift=${report.unexpectedDriftCount})`
      : `PROVIDER_CONTRACTS_DRIFT (unexpectedDrift=${report.unexpectedDriftCount})`
  );
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { opts, report } = await runVerifyProvidersCli(process.argv.slice(2));
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(report));
  }
  process.exit(report.ok ? 0 : 1);
}
