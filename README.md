# 💠 RigCommander — Mission Control for Autonomous AI Coding Fleets

**Live Demo:** https://rig-commander.vercel.app/demo · **User Guide & OpenRig Playbook:** https://rig-commander.vercel.app/guide ([Playbook MD](./openrig/docs/openrig-playbook.md)) · **Passport:** https://rig-commander.vercel.app/passport · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Landing:** https://rig-commander.vercel.app

RigCommander is a **zero-dependency, local-first DSS SA (L1–L3)** command deck for engineers running parallel AI coding agents across `tmux`, **Claude Code**, **Codex CLI**, **Gemini / Antigravity**, **Pi**, and **OpenRig** fleets.

## ✨ Highlights

- **Real-Time SSE Push & Live 80-Line TMUX Stream (`0%` Idle CPU):**
  - Delta-deduplicated fleet telemetry push (`/api/events`) and shared per-seat live terminal streaming (`/api/capture/stream`) with instant post-command refresh and automatic backoff.
- **Universal Auto-Discovery (Works with or without OpenRig):**
  - Connects natively to an **OpenRig daemon (`:7437`)** when running, and automatically falls back to **Universal Discovery** — scanning local `tmux` panes and incrementally reading `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl`.
- **Adaptive Neural Graph (Dynamic / Fixed) ⇄ Sub-Lane Task Gantt (`G`):**
  - Anti-collinear Dynamic & Fixed SVG topology with cursor-anchored Route X-Ray, exponential context thermal curves, non-overlapping sub-lane Gantt, and chronological **Handoff Flow** with QA bounce-back tracking.
- **`⌘K` Command Palette & Safe Queue Triage:**
  - Instant keyboard navigation across seats, slices, queues, and safe remediation actions with deduplicated write-back targeting.
- **Git Worktree & Conflict Radar + Shift Catch-Up Digest:**
  - Detects dirty worktrees, ahead/behind drift, and cross-seat file overlaps before merge/rebase, and persists redacted append-only shift history (`0600`) for one-click overnight catch-up digests.
- **Clickable HITL Prompts & Operational Twin (Ontology v2.2):**
  - Auto-parses interactive confirmation menus into idempotency-guarded 1-click actions (zero write-back clutter on healthy idle seats) with automatic postcondition verification in `ActionAuditLog`.
- **Opt-In 3-Tier Advisory-Only AI Evaluator:**
  - Deterministic hard safety vetoes + optional fast triage & deep reasoning slots with automatic secret redaction — strictly advisory, never auto-executes commands.
- **FinOps (`SUB vs PAYG`), Circuit-Breaker & Telegram HITL:**
  - Tracks live token usage, prompt cache hit %, and subscription ROI across exclusive model pools; enforces spend/rework caps and supports phone approvals via Telegram or paired Mobile PWA.
- **OpenRig L3 Playbook Built In:**
  - Full bilingual operational guide to OpenRig (`@openrig/cli`) — honest recovery, queue patterns, 10 advanced flows (`discover/adopt`, `set-runtime`, `fork`, `ask --wake`, `crash-cart`), and Top 7 anti-patterns.
- **Hardened Local-First Security:** `0 npm dependencies`, loopback-only `127.0.0.1`, `--read-only` zero-write inspection mode, per-process session auth, strict `Origin` checks, allowlisted `tmux` keystrokes, paired QR+PIN Mobile PWA, and `349 / 349` automated unit tests.

## 🚀 Quick Start

```bash
npx rig-commander@latest
# or locally from source:
npm start
```

Open `http://127.0.0.1:7440` (or `http://127.0.0.1:7440/guide` for the bilingual Operator User Guide & OpenRig Playbook, `http://127.0.0.1:7440/passport` for the Architecture & Security Passport).

### Agent Skill (`SKILL.md`)
Install the public [RigCommander Mission Control Skill](./skills/rig-commander-mission-control/SKILL.md) for **Claude Code**, **Codex CLI**, **Cursor**, **Copilot**, **Gemini CLI**, and **Agensi.io**:

```bash
npx skills add Vedariy/rig-commander
```

### Live Desktop & Mobile PWA
- **Mac Desktop PWA:** Open `http://127.0.0.1:7440` → Chrome/Edge **Install App** or Safari **File → Add to Dock…** (installs live Command Deck `/?source=pwa`).
- **Phone Live PWA:** Expose port `7440` via `tailscale serve https / http://127.0.0.1:7440` or `cloudflared tunnel --url http://127.0.0.1:7440`, then pass `--public-url https://...` or activate inside the **Phone QR** modal (single-use QR + 8-char PIN, `HttpOnly; Secure` cookie, 1-click revoke). See [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) for step-by-step instructions.

### Keyboard Shortcuts
| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open Command Palette & Safe Queue Triage |
| `G` | Toggle Topology Graph ⇄ Sub-Lane Task Gantt |
| `[` / `]` | Toggle Left Wait Radar / Right Inspector |
| `\` | Zen Canvas Mode (hide both sidebars) |
| `D` | Toggle Fit / Detailed node cards |
| `F` | Toggle Fullscreen |
| `?` | Interactive 6-step SA-DSS Tour |

## 🧪 Development & Verification

```bash
npm test                 # Zero-dependency Node test runner (41 suites, 349 tests)
npm run sync:public      # Sync openrig/ + landing/ -> public/ for static showcase hosting
npm run audit:exposure   # Verify .private-docs/ isolation, clean public showcase & zero leaks
```

## 📄 License

[MIT](./LICENSE)
