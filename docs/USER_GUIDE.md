# 💠 RigCommander — Operator User Guide

> **Interactive bilingual (EN / RU) web version:** https://rig-commander.vercel.app/guide (also served locally at `http://127.0.0.1:7440/guide`).

RigCommander is a zero-dependency, local-first Mission Control deck for engineers running parallel AI coding agents across **OpenRig**, **Claude Code**, **Codex CLI**, **Gemini / Antigravity**, **Pi**, and plain **`tmux`** sessions.

---

## 1. Quick Start & Discovery Modes

```bash
npx rig-commander@latest
```

Open `http://127.0.0.1:7440`.

- **OpenRig Native Mode (automatic):** When local `rig daemon` (`127.0.0.1:7437`) is running, RigCommander reads live rig nodes, queue envelopes, `decisions/*.tsv`, parked obligations, recaps, and live `tmux` screens every 4 seconds.
- **Universal Mode (`--universal` or automatic fallback):** When OpenRig is not running, RigCommander scans local `tmux` panes running `claude` / `codex` / `aider` / `gemini` and incrementally tails `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl`.

### CLI Options

| Flag | Description |
|---|---|
| `-p, --port <number>` | Telemetry bridge port (default: `7440`) |
| `--universal` | Force Universal `tmux` + JSONL discovery without OpenRig |
| `--public-url <https://...>` | Pre-configure HTTPS origin for paired Live Mobile PWA & QR code |
| `--host <address>` | Bind host interface (default: `127.0.0.1`) |
| `--no-open` | Do not auto-open browser tab on startup |
| `-v, --version` / `-h, --help` | Print version or CLI usage |

---

## 2. Reading the Deck in 5 Seconds (SA-DSS L0 → L3)

Every widget includes a top-right **`(?)`** icon showing its purpose and how to read it.

- **L0 — Top Triage Strip:** Fleet Health % and Top-3 highest-impact alerts (HITL blockers, context ≥ 75%, ready-to-push slices), plus quick access to **Fleet Advisor**, **Guardrails / TG**, **Share Card**, **Phone QR**, **Guide**, **Passport**, and **EN / RU**.
- **L1 — HUD, Model Pools & Center Canvas:**
  - **Model Pools** (`Codex / GPT`, `GLM / DeepSeek`, `Terminal / AGY`) display peak `CTX%` and 24h SUB vs PAYG spend.
  - **Call Highways Graph ⇄ Task Gantt (`G`)** visualizes agent-to-agent handoff volume and separates queue wait (hatched) from execution (solid).
  - **Slice Swimlanes** track every feature slice end-to-end (`Spec → Code → QA → Fix → Accept → Push`).
- **L2 — Wait Radar & Route X-Ray:**
  - **Wait Radar** (`Who → Whom → Why`) lists blockers, parked holds, and pending work, plus the **Decisions Log**.
  - Clicking any highway opens **Route X-Ray**: envelopes grouped by slice/task; multi-event envelopes expand on click with timestamps.
- **L3 — Node Passport & Live TMUX:**
  - Live 80-line `tmux` screen (`AUTO-FOLLOW`), parsed 1-click HITL prompt pills, manual key/command bar, postcondition-verified **Action Audit**, and **QA Rework Scorecard**.

---

## 3. Operational Playbooks

1. **Unblock a Terminal Prompt (P0 HITL):**
   Click the red alert card → click the parsed option pill (e.g. `1 Enter` / `Yes`) in the Inspector (or in Telegram) → confirm `✅ Verified` in **Action Audit**.
2. **Cool Down Overheated Context (`CTX ≥ 65–75%`):**
   - **Codex / Claude:** click `🗜️ /compact` (clears dirty input via `C-u`, deduplicates slash commands, and audits a `≥ 10%` context drop).
   - **Pi / DeepSeek:** does not support `/compact`; RigCommander blocks unsafe commands and provides a `Cmd` button copying `rig restart`.
3. **Parked Seat vs Bare Shell Exit:**
   - Normal `PARKED` seat → click `⚡ Wake (Enter)`.
   - Agent crashed to bare `zsh/bash` → screen classifier flags `⚠️ SHELL EXITED` and swaps `Wake` for a `Cmd` copy of `rig restart <seat>`.
4. **Diagnose QA Rework Loops:**
   Press `G` for the **Task Gantt** (rows marked `🪃` had `>2` QA rounds) and open **Fleet Advisor** for the prioritized Action Plan.
5. **Focus & Declutter:**
   Select a single rig in the header (automatically strips `@<rig>` from node labels), filter by **SLICE**, toggle `CALM: ON`, or hide sleeping seats. Every `Cmd` button copies the exact CLI command (`rig queue show`, `tmux attach`, `rig status`).

---

## 4. FinOps (SUB vs PAYG), Budget Circuit-Breaker & Telegram HITL

- **FinOps:** Open **Fleet Advisor → Budget** to compare real API-equivalent spend (PAYG) against prorated subscription plans across `24h`, `7d`, and `session` windows, plus Prompt Cache Hit %.
- **Budget Circuit-Breaker:** Open **Guardrails / TG** to configure `maxSessionUsd`, `maxSeatUsd`, `maxUsdPerHour`, and `maxQaRounds` in `alert_only` or `auto_stop` (`Ctrl+C`) mode.
- **Telegram HITL Bridge:** Create a bot in `@BotFather`, enter Bot Token + your personal Chat ID in **Guardrails / TG** (or pass `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID`). Only your authorized chat can approve HITL inline buttons or run `/status`, `/budget`, `/stop <seat>`, and `/arm_breaker`.

---

## 5. Installing Live RigCommander as a PWA (Mac + Phone)

Live `openrig/server.mjs` dynamically serves `/manifest.webmanifest` pointing to `/?source=pwa` (never the marketing site or `/demo`).

### Desktop Mac PWA (Works Immediately)
Open `http://127.0.0.1:7440` → click **Install App** in Chrome/Edge address bar, or **File → Add to Dock…** in Safari.

### Mobile Live PWA (iPhone / Android)
iOS Safari and Android Chrome require `https://` to install a PWA. Expose local port `7440` through a private HTTPS tunnel:

```bash
# Option A (Recommended — private Tailscale mesh VPN):
tailscale serve https / http://127.0.0.1:7440

# Option B (Instant zero-account HTTPS tunnel):
cloudflared tunnel --url http://127.0.0.1:7440
```

Then:
1. On your Mac open `http://127.0.0.1:7440` → click **Phone QR** → paste your `https://...` URL → click **Activate Live QR** (or start with `--public-url https://...`).
2. Scan the QR code with your phone camera to pair an `HttpOnly; SameSite=Lax; Secure` 30-day session cookie.
3. Add to Home Screen (**iPhone:** `Share ⬆ → Add to Home Screen`; **Android:** `Install app`).
4. **iPhone Home Screen tip:** iOS isolates cookies between Safari and standalone Home Screen apps. On first launch of the installed icon, enter the single-use **8-character PIN** shown below the QR on your Mac — it stays paired for 30 days across restarts.
5. Click **Revoke Phones** anytime on your Mac to disconnect all paired devices immediately. Only SHA-256 hashes are stored on disk (`~/.config/rig-commander/remote-sessions.json`, mode `0600`).

---

## 6. Keyboard Shortcuts & Daily Share Card

| Key | Action |
|---|---|
| `G` | Toggle Call Highways Graph ⇄ Task Gantt |
| `[` / `]` | Toggle Left Wait Radar / Right Inspector |
| `\` | Zen Canvas Mode (hide both sidebars) |
| `D` | Toggle Card Density (Compact / Detailed) |
| `F` | Toggle Fullscreen |
| `?` / `Esc` | 6-Step Interactive Tour / Close modal |

Click the **Camera** icon in the top strip to export a `1200×630` PNG **Daily Fleet Receipt** (anonymized by default in live mode so private rig/seat names are never exposed).
