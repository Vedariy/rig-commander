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

- **L0 — Top Triage Strip:** Fleet Health % (opens the dedicated **Health & Action Plan** modal) and Top-3 seat-diverse alerts (HITL blockers, context ≥ 75%, real queue bottlenecks), plus quick access to **Fleet Advisor** (4 analytical tabs), **Guardrails / TG**, **Share Card**, **Phone QR**, **Update** (`⬆ Update vX.Y.Z`), **Guide**, **Passport**, and **EN / RU**.
- **L1 — HUD, Model Pools & Center Canvas:**
  - **Model Pools** (`Codex / GPT`, `GLM / DeepSeek`, `Terminal / AGY`) display peak `CTX%` and 24h SUB vs PAYG spend.
  - **Call Highways Graph (`[Dynamic | Fixed]`):** `Dynamic` (default) spotlights active & communicating seats on the upper stage while docking sleeping seats into compact single-row pills on the bottom bench (`DORMANT · N`); `Fixed` keeps stable role-tiered positions. Each unified Dark-Cockpit node card uses a 6-band Inferno/Plasma context rail (`violet → blue → sky → yellow → orange ≥65% → red ≥75%`, zero green conflict with `WORKING`).
  - **Operational Task Gantt (`G`):** non-overlapping sub-lane bars, `[By Agent | By Slice]` grouping, `[📊 Timeline | 🔀 Handoff Flow]` chronological sequence view for 2–5 slice participants, Wait-vs-Work KPI strip with clickable `🔥 Top delay`, signal/noise toggle (`Wake escalation` / `recovery` hidden by default), `30m / 1h / 6h / 24h` + `1× / 2× / 4×` zoom, hover popover, and bottom **Span Inspector**.
  - **Slice Swimlanes** track every feature slice end-to-end (`Spec → Code → QA → Fix → Accept → Push`).
- **L2 — Wait Radar & Route X-Ray:**
  - **Wait Radar** (`Who → Whom → Why`) lists blockers, parked holds, and pending work, plus the **Decisions Log**.
  - Clicking any highway opens **Route X-Ray**: envelopes grouped by slice/task; multi-event envelopes expand on click with timestamps.
- **L3 — Node Passport, Actionable Diagnosis & Live TMUX:**
  - **Diagnosis & What to Fix** at the top of the Inspector explains active findings in plain language, lists exact waiting queue tasks (`slice`, sender, summary), and offers 1-click remediation (including **`📨 Process queue`** sending `rig queue list --owned` when bare `Enter` won't wake an idle prompt).
  - Live 80-line `tmux` screen (`AUTO-FOLLOW`), parsed 1-click HITL prompt pills, manual key/command bar protected by double-click & `409` idempotency guards, postcondition-verified **Action Audit**, and **QA Rework Scorecard**.

---

## 3. Operational Playbooks

1. **Unblock a Terminal Prompt (P0 HITL):**
   Click the red alert card → click the parsed option pill (e.g. `1 Enter` / `Yes`) in the Inspector (or in Telegram) → confirm `✅ Verified` in **Action Audit**.
2. **Cool Down Overheated Context (`CTX ≥ 65–75%`):**
   - **Codex / Claude:** click `🗜️ /compact` (clears dirty input via `C-u`, deduplicates slash commands, and audits a `≥ 10%` context drop).
   - **Pi / DeepSeek:** does not support `/compact`; RigCommander blocks unsafe commands and provides a `Cmd` button copying `rig restart`.
3. **Queue Bottleneck, Parked Seat vs Bare Shell Exit:**
   - Click any topology alert (`Inspect seat`) → read **Diagnosis & What to Fix** at the top of the Inspector to see exact waiting queue envelopes.
   - If the agent is sitting at a clean idle prompt with pending work, click **`📨 Process queue`** (`nudge_queue`, sends an explicit `rig queue list --owned` prompt instead of bare `Enter`).
   - Normal `PARKED` seat → click `⚡ Wake (Enter)`.
   - Agent crashed to bare `zsh/bash` → screen classifier flags `⚠️ SHELL EXITED` and swaps `Wake`/`Process queue` for a `Cmd` copy of `rig restart <seat>`.
4. **Diagnose Bottlenecks & QA Rework Loops (Gantt + Handoff Flow):**
   Press `G` for the **Task Gantt** (`30m / 1h / 6h / 24h` + `1× / 2× / 4×` zoom). Switch between **`By Agent`** (utilization & parallel sub-lanes) and **`By Slice`** (trace waterfall), click **`🔥 Top delay`** to jump directly to the worst wait span, and switch to **`🔀 Handoff Flow`** to trace chronological handoffs and `🪃` QA bounce-backs between participating seats. Click any bar to inspect it in the bottom **Span Inspector**.
5. **Focus, Layout Modes & Declutter:**
   Toggle **`[Dynamic | Fixed]`** in the graph header (persisted automatically), select a single rig in the top bar (strips `@<rig>`), filter by **SLICE**, toggle `CALM: ON`, or hide sleeping seats. Every `Cmd` button copies the exact CLI command (`rig queue show`, `tmux attach`, `rig status`).

---

## 4. FinOps (SUB vs PAYG), Budget Circuit-Breaker & Telegram HITL

- **FinOps:** Open **Fleet Advisor → Budget** to compare real API-equivalent spend (PAYG) against prorated subscription plans across `24h`, `7d`, and `session` windows, plus Prompt Cache Hit %.
- **Budget Circuit-Breaker:** Open **Guardrails / TG** to configure `maxSessionUsd`, `maxSeatUsd`, `maxUsdPerHour`, and `maxQaRounds` in `alert_only` or `auto_stop` (`Ctrl+C`) mode.
- **3-Tier AI Evaluator (`Heuristic + Expert ➔ System 1 ➔ System 2`):** Switch to the **`🧠 AI Evaluator`** tab inside **Guardrails / TG** to configure independent **Slot S1** (non-generative single-pass `/v1/systemone` for **TypeSafe Jev**, local Apache-2.0 **Laya**, local ~15ms CPU **Von**, **GLiClass-v3**, or **EmbeddingGemma-300M**) and **Slot S2** (deliberative reasoners: **Gemini 4 Hydrogen**, **GLM-5.3**, **GPT-6.2 Sol**, **Claude 5.5**, or local Apple MLX/Ollama **Qwen3.8 / Qwen3.6 MoE / Qwen3.5 / LFM2.5**). Strictly **Advisory-Only** with **Tier 0 Expert Vetoes**, secret redaction, and `Localhost Only` default privacy mode.
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
