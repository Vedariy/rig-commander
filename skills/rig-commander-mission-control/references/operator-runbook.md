# RigCommander Operator Runbook

Concise operational reference for CLI startup, keyboard navigation, fleet discovery, paired Mobile PWA setup, and operator verification.

## Verified CLI Flags

Every flag below matches `npx rig-commander --help` (`rig-commander` and `rig-cmd` share the same CLI):

| Flag | Default | Purpose |
|---|---|---|
| `-p, --port <number>` | `7440` | Telemetry bridge port |
| `--host <address>` | `127.0.0.1` | Bind host interface (keep loopback by default) |
| `--public-url <https://>` | *(unset)* | Enable paired Live Mobile PWA via Tailscale Serve or Cloudflare Tunnel |
| `--universal` | `false` | Force Universal Mode (Claude Code / Codex / tmux without OpenRig) |
| `--no-open` | `false` | Do not automatically open browser on startup |
| `-v, --version` | — | Print RigCommander version |
| `-h, --help` | — | Print CLI usage and deck shortcuts |

Local surfaces once running:
- Live Command Deck: `http://127.0.0.1:7440`
- Operator Guide & OpenRig Playbook: `http://127.0.0.1:7440/guide`
- Architecture & Security Passport: `http://127.0.0.1:7440/passport`
- Hosted Offline Sandbox Demo: `https://rig-commander.vercel.app/demo` (locally, `http://127.0.0.1:7440` automatically falls back to Demo Sandbox when no live agents are running)

## Discovery Modes

1. **OpenRig Native Mode (automatic):**
   - Engages automatically when a local `rig daemon` is running.
   - Reads live rig topology, named seats, durable queue envelopes, decisions log, parked obligations, recaps, and live `tmux` panes.
2. **Universal Mode (automatic fallback or `--universal`):**
   - Engages when OpenRig is absent or `--universal` is passed.
   - Discovers local `tmux` panes running Claude Code, Codex CLI, Gemini CLI, or Aider and incrementally tails local transcripts under `~/.claude/` and `~/.codex/`.
   - Context and token metrics vary by harness; missing usage evidence never means zero usage.
3. **Offline Sandbox (`/demo`):**
   - Serves sample fleet scenarios with zero live fleet API or terminal stream calls.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open Command Palette & Safe Queue Triage |
| `G` | Toggle Call Highways Graph ⇄ Sub-Lane Task Gantt |
| `[` | Toggle Left Wait Radar (Who Waits for Whom) |
| `]` | Toggle Right Inspector & Live TMUX Capture |
| `\` | Zen Canvas Mode (hide both sidebars / maximize graph) |
| `D` | Toggle Node Card Density (Compact / Detailed) |
| `F` | Toggle Fullscreen Mode |
| `?` | Toggle Interactive SA-DSS Tour |
| `Esc` | Close active modal or popover |

## Live Desktop & Mobile PWA Pairing

### Desktop Mac PWA
Open `http://127.0.0.1:7440` → Chrome/Edge **Install App** icon in the address bar, or Safari **File → Add to Dock…** (targets live `/?source=pwa`, never the marketing site).

### Mobile Live PWA (iPhone / Android)
Mobile browsers require `https://` to install a live PWA. Expose local port `7440` through a private HTTPS tunnel:

```bash
# Option A (Recommended — private Tailscale tailnet):
tailscale serve https / http://127.0.0.1:7440

# Option B (Zero-account HTTPS tunnel locked by RigCommander pairing):
cloudflared tunnel --url http://127.0.0.1:7440
```

Then pair your phone:
1. Launch with `--public-url https://<your-tunnel-host>`, or open `http://127.0.0.1:7440` → **Phone QR** → paste the `https://` URL → click **Activate Live QR** (no restart required).
2. Scan the single-use QR with your phone camera to establish an authenticated `HttpOnly; Secure` session.
3. Install to Home Screen (iOS: **Share → Add to Home Screen**; Android: **Install app**).
4. On iOS standalone Home Screen first launch, enter the single-use pairing PIN displayed beneath the QR on your Mac to pair the isolated Home Screen cookie jar.
5. Click **Revoke Phones** anytime on your Mac to disconnect all paired devices immediately.

## Verification Checks

Run these checks to confirm healthy operation:

1. **CLI sanity:** `npx rig-commander --version` and `npx rig-commander --help`.
2. **Bridge health:** Confirm `http://127.0.0.1:7440` renders the live deck (or `DEMO SANDBOX` when no live agents are running).
3. **OpenRig fleet check (when using OpenRig):** Run `rig daemon status`, `rig ps`, and `rig parked` to verify daemon reachability and surface stuck obligations.
4. **Post-action verification:** After answering a HITL prompt or sending `/compact`, inspect **Action Audit** in the Inspector to verify the seat transitioned cleanly instead of blindly re-sending input.
5. **Recovery receipt check:** After Crash-Cart execution, review each target's explicit status (`restored`, `partial`, `failed`, or `unknown`) and copy the proposed command if manual follow-up is needed.
