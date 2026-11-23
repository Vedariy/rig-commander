# Changelog

All notable changes to **RigCommander** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **Auto-Update & npmjs Release Watcher:**
  - Shared zero-dependency SemVer & npmjs release module (`openrig/assets/domain/semver.js`) and server-side `SelfUpdater` (`openrig/lib/self-update.mjs`) polling `https://registry.npmjs.org/rig-commander/latest` (30-min cache + manual check).
  - Live RigCommander `⬆ Update vX.Y.Z` button + modal (`#updateModal`) with safe 1-click self-update per install mode (`global-npm`, `npx-cache`, `git-checkout`), graceful supervisor restart (`exit 75` in `bin/cli.mjs`), and automatic browser reconnect.
  - Dismissible website release notice (`✨ New vX.Y.Z`) on the landing page with `localStorage` persistence per version.
- **Control-Primitive Double-Click & Idempotency Guard (`openrig/assets/domain/action-guard.js`):**
  - Client-side `ActionFlightGuard` with exclusive per-seat in-flight locks, post-send cooldowns (`1.8s`–`2.2s`), DOM lock synchronization (`disabled`, `aria-busy`, `data-ctrl-busy="1"`) that survives 4s telemetry re-renders, and form input preservation on blocked retries.
  - Server-side `ServerIdempotencyCache` on `POST /api/send` supporting `X-Idempotency-Key` replay (30s TTL) and `409 Conflict` suppression of concurrent or rapid semantic duplicate commands (`1.5s`).
- **Changelog:** Added `CHANGELOG.md` linked from `README.md`, npm package, and `/guide`.

### Changed
- **Single-Card Graph Node Telemetry & 6-Band Thermal Spectrum (`thermal.js`, `deck.css`, `openrig/index.html`):**
  - Removed the dangling external neon `.node-bottom-badge` pill below graph nodes and integrated all telemetry cleanly inside one unified Dark-Cockpit card (Row 1: seat name + tabular context %; Row 2: quiet `K/K` token quota + `↓in ↑out` queue envelope traffic with tooltips; 3px progressive 6-band thermal rail via `clip-path`).
  - Calibrated `getContextThermal()` to a 6-band Inferno/Plasma spectrum (`violet → blue → sky → yellow → orange ≥65% → red ≥75%`) with zero green conflict against `WORKING` (`#00ff9d`), calm slate borders below 65%, and removal of noisy `live` / `• live` placeholders on seats without token readers.
- **Focused Health & Action Plan vs Fleet Advisor Split:** Clicking the top-left Health / Attention badge now opens a dedicated **Health & Action Plan** triage view (score gauge, penalty breakdown, and 1-click resolution steps), while clicking **Fleet Advisor** opens the 4 analytical tabs (Findings, QA Quality Radar, Budget & Pools, Topology WWR) at full modal height, with a 1-click switcher in the modal header.

---

## [3.2.0] - 2026-11-24

### Added
- **Live RigCommander Desktop & Mobile PWA (`openrig/lib/remote-access.mjs`):**
  - Dynamic live `GET /manifest.webmanifest` served by `openrig/server.mjs` targeting `/?source=pwa` (real live deck instead of `/demo`).
  - CLI flags `--public-url <https://...>` and `--host <address>`, plus auto-detection of `tailscale serve status --json`.
  - Cryptographic remote phone pairing: single-use 192-bit QR token + 8-character iOS Home Screen PIN (brute-force wipe after 5 bad attempts, `timingSafeEqual`), `HttpOnly; SameSite=Lax; Secure` 30-day session cookie, SHA-256-only persistence (`~/.config/rig-commander/remote-sessions.json`, mode `0600`), 3-layer origin + cookie + `DECK_TOKEN` enforcement, and 1-click device revoke.
  - Upgraded `Phone QR` modal with 2-step HTTPS tunnel wizard (`tailscale serve` / `cloudflared tunnel`) and live QR/PIN activation without server restart.
- **Bilingual Operator User Guide (`/guide` & `docs/USER_GUIDE.md`):**
  - Standalone responsive EN/RU manual served at `/guide` (local + web), linked from the deck Triage Strip, Landing navbar, Project Passport, and README.
- **Multi-Harness Realtime Screen Classifier (`classifyTerminalScreen()`):**
  - Detects narrow-pane wrapped Antigravity / Codex / Claude HITL menus, all 256 Unicode Braille active spinners (`\u2801`–`\u28FF`), and bare OS shell exits (`shellExited: true` → offers `rig restart` instead of `Wake Enter`).
- **UI Ergonomics & SA-DSS Polish:**
  - Contextual `(?)` help popovers on all 9 widgets.
  - Packed expandable envelope history with timestamps (`tsUpdated` / `tsCreated` / `qitemId`, up to 20 pair envelopes).
  - Unified `Cmd` + clipboard icon buttons across all CLI copy controls.
  - Automatic stripping of `@<rig>` suffix when filtered to a single rig.
  - Internal node thermal context fill, pool reservoir fill, swimlane progress rails, and strict non-overlapping status pills above graph nodes.
- **Mobile PWA Ergonomics & Fleet Advisor Playbook:**
  - 5-tab mobile bottom dock (`<= 768px`), zero-dependency local SVG QR generator (`openrig/assets/domain/qr.js`), severity-capped Fleet Advisor Health Score (`advisory.mjs`), `LiveBlockerDetector`, Top-5 `CeremonyAmplifierDetector`, and 1-click Action Plan Playbook.

### Changed
- Removed `<link rel="manifest">` from marketing pages (`landing/index.html`, `landing/passport.html`, `landing/guide.html`) so browsers install the live RigCommander app rather than the static website.
- Fixed stale `currentSliceFilter` ghost/dim graph states with auto-healing and clickable reset chip.

---

## [3.1.1] - 2026-11-22

### Added
- **1200×630 Share Card PNG Export (`openrig/assets/domain/share-card.js`):** Zero-dependency SVG→Canvas PNG shift receipt with Mini Task Gantt, Prompt Cache Hit %, SUB vs PAYG ROI, and default privacy anonymization in live mode.
- **10-Second Interactive Demo Mission (`openrig/assets/domain/quest.js`):** Non-blocking 3-step first-contact onboarding mission on `/demo`.
- **FinOps Window Switcher (`openrig/assets/domain/finops.js`):** `24h / 7d / session` SUB vs PAYG amortization and ROI comparison.
- **Persistent Operator Preferences (`openrig/assets/domain/preferences.js`):** Saves rig filter, CALM mode, idle visibility, density, radar tabs, and billing plans in `localStorage`.
- **OpenGraph & Twitter Social Cards** + 22s Landing Demo Video + 7-day Universal Mode grid & Gantt + terminal idle-at-prompt probe.

### Fixed
- Normalized `package.json` `bin` paths for npm v12 compatibility.

---

## [3.1.0] - 2026-11-21

### Added
- **Initial Public Release of RigCommander Neural Command Deck:**
  - Zero-dependency local BFF (`openrig/server.mjs`) and CLI (`npx rig-commander@latest`).
  - Dual discovery: native OpenRig daemon (`:7437`) + Universal Auto-Discovery for standalone `tmux` panes (Claude Code, Codex CLI, Aider, Gemini) and `~/.claude` / `~/.codex` JSONL transcripts.
  - Live Neural Call Highways Graph ⇄ Task Gantt (`G`), Slice Swimlanes, Wait Radar, Decisions Log, and 80-line Live TMUX capture with clickable parsed HITL prompts and WebAudio alerts.
  - **Operational Ontology v2.0:** 7 canonical object types, reason-driven Action Registry (0 write-back clutter on healthy idle seats), and `ActionAuditLog` with automatic `postcondition` verification.
  - **Guardrails:** Budget Circuit-Breaker (`alert_only` / `auto_stop` via `Ctrl+C`) and Telegram HITL Bridge (single-use nonces, authorized chat enforcement, `/status`, `/budget`, `/stop`, `/arm_breaker`).
  - Full bilingual **EN / RU** interface, Project Passport (`/passport`) with C4 diagrams, and hardened localhost security (`DECK_TOKEN`, strict `Origin`, allowlisted `tmux` keystrokes, anti-traversal static serving).
