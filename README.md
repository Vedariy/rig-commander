# 💠 RigCommander — Mission Control for Autonomous AI Coding Fleets

**Live Demo:** https://rig-commander.vercel.app/demo · **User Guide:** https://rig-commander.vercel.app/guide ([Markdown](./docs/USER_GUIDE.md)) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Landing:** https://rig-commander.vercel.app · **Project Passport:** https://rig-commander.vercel.app/passport

RigCommander is a **zero-dependency, local-first DSS SA (L1–L3)** command deck for engineers running parallel AI coding agents across `tmux`, **Claude Code**, **Codex CLI**, and **OpenRig** fleets.

## ✨ Highlights

- **Universal Auto-Discovery (Works with or without OpenRig):**
  - Connects natively to an **OpenRig daemon** when running.
  - Automatically falls back to **Universal Discovery** — scans local `tmux` panes running `claude` / `codex` / `aider` / `gemini` AND reads `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl` incrementally by byte offset.
- **Live Neural Graph ⇄ Task Gantt (`G`):**
  - Switch between dynamic SVG call highways and a chain-colored Task Gantt separating queue wait (hatched) from active execution.
- **Clickable HITL Prompts & 80-Line Live TMUX:**
  - Auto-parses Codex / Claude numbered confirmation menus into 1-click buttons, streams 80-line terminal captures, and plays distinct per-seat WebAudio alert motifs.
- **Operational Ontology v2.0 & Postcondition Audit:**
  - 7 canonical object types (`Rig`, `Seat`, `OccupantSession`, `WorkChain`, `QueueObligation`, `Situation`, `ActionRecord`).
  - Reason-driven Action Registry (0 write-back noise on healthy idle seats) with automatic `postcondition` verification in `ActionAuditLog`.
- **FinOps Token & Exclusive Model Pools:**
  - Live `uncached / cached / output` token usage, cache-hit %, and estimated `$` cost across non-overlapping model pools (`Codex / GPT`, `Claude`, `GLM / DeepSeek`, `Terminal / AGY`).
- **Budget & Loop Circuit-Breaker + Telegram HITL Bridge:**
  - Set hard guardrails (`maxSessionUsd`, `maxSeatUsd`, `maxUsdPerHour`, `maxQaRounds`) in `alert_only` or `auto_stop` (`Ctrl+C`) mode.
  - Connect a Telegram bot (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` or via the `🛡️ Guardrails` modal) to approve parsed HITL prompts from your phone with single-use nonces, plus `/status`, `/budget`, `/stop <seat>`, and `/arm_breaker` commands.
- **10-Second Interactive Demo Mission:** First-time `/demo` visitors get a non-blocking 3-step live mission (Unblock QA HITL → Inspect Gantt `G` → Audit `$6.63` Spend & Pools) with 1-click Declutter HUD so the full deck makes sense in 10 seconds.
- **Daily Fleet Receipt / Share Card (`1200×630` PNG):** Export a zero-dependency trophy card showing your Mini Task Gantt, prompt cache hit %, and **SUB vs PAYG ROI** — with 1-click privacy anonymization for sharing on X / Telegram.
- **Bilingual EN / RU UI:** Full English & Russian support across Landing, Project Passport, and Command Deck.
- **Hardened Localhost Security:** `0 npm dependencies`, loopback-only `127.0.0.1`, per-process `DECK_TOKEN` (`timingSafeEqual`), strict `Origin` check, allowlisted `tmux` keystrokes, anti-traversal static serving.

## 🚀 Quick Start

```bash
npx rig-commander@latest
# or locally from source:
npm start
```

Open `http://127.0.0.1:7440` (or `http://127.0.0.1:7440/guide` for the bilingual Operator User Guide, `http://127.0.0.1:7440/passport` for C4 architecture diagrams & test matrix).

### Live Desktop & Mobile PWA
- **Mac Desktop PWA:** Open `http://127.0.0.1:7440` → Chrome/Edge **Install App** or Safari **File → Add to Dock…** (installs live Command Deck `/?source=pwa`).
- **Phone Live PWA:** Expose port `7440` via `tailscale serve https / http://127.0.0.1:7440` or `cloudflared tunnel --url http://127.0.0.1:7440`, then pass `--public-url https://...` or activate inside the **Phone QR** modal (single-use QR + 8-char iPhone PIN, `HttpOnly; Secure` cookie, 1-click revoke). See [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) for step-by-step instructions.

### Keyboard Shortcuts
| Key | Action |
|---|---|
| `G` | Toggle Topology Graph ⇄ Task Gantt |
| `[` / `]` | Toggle Left Wait Radar / Right Inspector |
| `\` | Zen Canvas Mode (hide both sidebars) |
| `D` | Toggle Fit / Detailed node cards |
| `F` | Toggle Fullscreen |
| `?` | Interactive 6-step SA-DSS Tour |

## 🧪 Development & Verification

```bash
npm test            # Zero-dependency Node test runner (node --test)
npm run sync:public # Sync openrig/ + landing/ -> public/ for static demo hosting
```

## 📄 License

[MIT](./LICENSE)
