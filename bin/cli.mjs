#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESTART_FOR_UPDATE_EXIT_CODE, detectInstallMode } from '../openrig/lib/self-update.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
let APP_VERSION = '3.2.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  if (pkg && pkg.version) APP_VERSION = String(pkg.version);
} catch {}
const args = process.argv.slice(2);

// Check flags
if (args.includes('-h') || args.includes('--help')) {
  console.log(`
💠 RIGCOMMANDER // NEURAL COMMAND DECK v${APP_VERSION}
Mission Control for Autonomous AI Coding Fleets (OpenRig + Universal Claude/Codex/tmux)

Usage:
  npx rig-commander [options]
  rig-commander [options]

Options:
  -p, --port <number>     Specify telemetry bridge port (default: 7440)
  --host <address>        Bind host interface (default: 127.0.0.1)
  --public-url <https://> Enable paired Live Mobile PWA via Tailscale Serve / Cloudflare Tunnel
  --universal             Force Universal Mode (Claude Code / Codex / tmux without OpenRig)
  --read-only             Read-only inspection mode (0 terminal writes or state mutations)
  --no-open               Do not automatically open browser on startup
  -v, --version           Show version
  -h, --help              Show this help manual

Keyboard Shortcuts in Deck:
  G                     Toggle Graph ⇄ Task Gantt Timeline
  [                     Toggle Left Radar (Who Waits for Whom)
  ]                     Toggle Right Inspector & TMUX Capture
  \\                     Zen Canvas Mode (Maximize Topology Graph)
  D                     Toggle Card Density (Fit / Detailed)
  F                     Toggle Fullscreen Mode
`);
  process.exit(0);
}

if (args.includes('-v') || args.includes('--version')) {
  console.log(`rig-commander v${APP_VERSION}`);
  process.exit(0);
}

let port = 7440;
const portIdx = args.findIndex(a => a === '-p' || a === '--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = Number(args[portIdx + 1]) || 7440;
} else if (process.env.PORT) {
  port = Number(process.env.PORT) || 7440;
}

let host = process.env.RIGCOMMANDER_HOST || '127.0.0.1';
const hostIdx = args.findIndex(a => a === '--host');
if (hostIdx !== -1 && args[hostIdx + 1]) {
  host = String(args[hostIdx + 1]).trim() || '127.0.0.1';
}

let publicUrl = process.env.RIGCOMMANDER_PUBLIC_URL || '';
const pubIdx = args.findIndex(a => a === '--public-url');
if (pubIdx !== -1 && args[pubIdx + 1]) {
  publicUrl = String(args[pubIdx + 1]).trim();
}

const noOpen = args.includes('--no-open');
const forceUniversal = args.includes('--universal');
const readOnly =
  args.includes('--read-only') ||
  process.env.RIGCOMMANDER_READ_ONLY === '1' ||
  String(process.env.RIGCOMMANDER_READ_ONLY || '').trim().toLowerCase() === 'true';
const serverPath = path.resolve(__dirname, '../openrig/server.mjs');
const url = `http://127.0.0.1:${port}`;

console.log(`
\x1b[36m  💠 RIGCOMMANDER // NEURAL COMMAND DECK v${APP_VERSION}\x1b[0m
  \x1b[90m==============================================================\x1b[0m
  \x1b[32m●\x1b[0m Status:            \x1b[1m\x1b[32mLIVE TELEMETRY BRIDGE\x1b[0m${readOnly ? `\n  \x1b[33m🔒 Mode: READ-ONLY (0 terminal writes)\x1b[0m` : ''}
  \x1b[36m●\x1b[0m Command Deck:      \x1b[4m\x1b[36m${url}\x1b[0m${publicUrl ? `\n  \x1b[35m●\x1b[0m Live Mobile PWA:   \x1b[4m\x1b[35m${publicUrl}\x1b[0m \x1b[90m(QR paired)\x1b[0m` : ''}
  \x1b[33m●\x1b[0m Keyboard Control:  \x1b[90m[ [ ] Radar | [ ] ] Inspector | [ \\ ] Zen\x1b[0m
  \x1b[90m--------------------------------------------------------------\x1b[0m
  \x1b[90mPress \x1b[37mCtrl+C\x1b[90m to safely detach flight deck.\x1b[0m
`);

const childEnv = {
  ...process.env,
  PORT: String(port),
  RIGCOMMANDER_HOST: host,
  RIGCOMMANDER_SUPERVISED: '1',
  ...(publicUrl ? { RIGCOMMANDER_PUBLIC_URL: publicUrl } : {}),
  ...(forceUniversal ? { RIGCOMMANDER_FORCE_UNIVERSAL: '1' } : {}),
  ...(readOnly ? { RIGCOMMANDER_READ_ONLY: '1' } : {})
};

let serverProc = null;
let shuttingDown = false;
const installMode = detectInstallMode(pkgRoot);

function startServerChild(useNpxLatest = false) {
  if (useNpxLatest) {
    const npxArgs = ['--yes', 'rig-commander@latest', '--no-open', '-p', String(port), '--host', host];
    if (publicUrl) npxArgs.push('--public-url', publicUrl);
    if (forceUniversal) npxArgs.push('--universal');
    if (readOnly) npxArgs.push('--read-only');
    serverProc = spawn('npx', npxArgs, { env: childEnv, stdio: 'inherit' });
  } else {
    const serverArgs = readOnly ? [serverPath, '--read-only'] : [serverPath];
    serverProc = spawn(process.execPath, serverArgs, { env: childEnv, stdio: 'inherit' });
  }

  serverProc.on('error', err => {
    console.error('\x1b[31m✕ Failed to launch RigCommander server:\x1b[0m', err.message);
    process.exit(1);
  });

  serverProc.on('exit', code => {
    if (shuttingDown) return;
    if (code === RESTART_FOR_UPDATE_EXIT_CODE) {
      console.log('\n\x1b[32m🔄 Applying RigCommander update — restarting telemetry bridge...\x1b[0m');
      setTimeout(() => startServerChild(installMode === 'npx-cache'), 450);
    } else if (typeof code === 'number' && code !== 0) {
      process.exit(code);
    }
  });
}

startServerChild(false);

// Auto-open browser
if (!noOpen) {
  setTimeout(() => {
    const platform = process.platform;
    if (platform === 'darwin') {
      execFile('open', [url], () => {});
    } else if (platform === 'win32') {
      execFile('cmd', ['/c', 'start', url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  }, 450);
}

function shutdown() {
  shuttingDown = true;
  console.log('\n\x1b[36m💠 Detaching RigCommander flight deck. Agents remain in background.\x1b[0m');
  if (serverProc) serverProc.kill('SIGINT');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
