# Changelog

All notable changes to **RigCommander** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [3.4.0] - 2026-11-25

### Added
- **Opt-In Safe Playbook Automation & Critical SA Desktop Notifications (`openrig/assets/domain/playbooks-model.js`, `openrig/lib/playbook-engine.mjs`, `openrig/server.mjs`, `openrig/index.html`):**
  - Added strictly allowlisted Safe Playbook Automation (`auto_compact_idle_hot`, `auto_wake_parked`, `auto_nudge_stalled_queue`, read-only `auto_notify_critical_sa`) defaulting to `enabled: false` + `mode: 'dry_run'` with 8 non-overridable Hard Safety Vetoes, `0600` local persistence, sliding hourly rate caps, Dry-Run preview, Guardrails `🤖 Playbooks` tab, and `/demo?track=playbooks`.
  - Added opt-in browser Desktop Notifications for P0/P1 critical SA events (click-to-focus) and live dynamic SVG Favicon badges reflecting active alert severity & counts.
- **Zero-Build UI Modularization — Phase 1 (`openrig/assets/ui/guardrails-view.js`, `openrig/assets/ui/gantt-view.js`):**
  - Extracted Guardrails / Playbooks / AI Evaluator modal renderers and Task Gantt / Handoff Sequence / Span Detail views from `openrig/index.html` into native ES modules (−873 lines from `openrig/index.html`) with dedicated unit test suites (`158 / 158 PASS` across 27 suites).

### Fixed
- **Anti-Vertical-Collinearity Topology Layout (`openrig/assets/domain/topology-layout.js`):**
  - Prevented 3-tier `[1, 1, 1]` and mixed `[1, 3, 1]` topologies from collapsing onto a single vertical center line where `owner → check` routes sliced through middle cards; unified wide Command-apex triangle geometry across Dynamic and Fixed modes.
- **Live-UX, Antigravity CLI (`agy`) & Rig-Filter Scoping (`openrig/assets/domain/prompt-parser.js`, `openrig/server.mjs`, `openrig/index.html`, `openrig/assets/styles/deck.css`):**
  - Added `getLiveHitlOptions()` backed by `detectLiveHitlPrompt()` so normal Markdown numbered lists on idle agents never render bogus `⚡ PROMPT OPTIONS` buttons, hijack operator chat input into raw keystrokes, or falsely escalate Tier 0 AI Evaluator / Telegram HITL payloads.
  - Added active background-task detection (`○ Running`, `● [HH:MM:SS] ... running`) and terminal model extraction (`agy • Gemini 4 Neon (xhigh)`) for terminal-hosted Antigravity CLI seats.
  - Scoped Top-3 Triage Strip, Slice Filter Chips, and Slice Swimlanes strictly to the selected rig (`sliceStats.rigs`), eliminated left Wait Radar header mid-character clipping in EN/RU, and synced the Command Deck version badge dynamically.

---

## [3.3.0] - 2026-11-25

### Added
- **SSE Push Stream & Deduplicated Live TMUX Streaming (`openrig/lib/sse-hub.mjs`, `openrig/server.mjs`, `openrig/index.html`, ADR-0016):**
  - Added zero-dependency `SsePushHub` serving `GET /api/events` (SHA-1 telemetry delta push, `18s` heartbeat, `MAX_SSE_CLIENTS = 32`, `0%` idle CPU) and `GET /api/capture/stream` (shared per-seat 80-line TMUX watcher across tabs with adaptive `650ms -> 1500ms` backoff and immediate post-`/api/send` re-capture at `120ms` / `520ms`).
  - Added `● LIVE SSE` connection badge, `⚡ STREAM` / `⚡ ПОТОК` pill in Inspector & Live TMUX modal, instant cached-screen hydration on modal open, slowed fallback polling when SSE is live, and zero `EventSource` requests on offline `/demo`.
- **OpenRig L3 Playbook & Three-Tier Documentation Hygiene (`openrig/docs/openrig-playbook.md`, `landing/guide.html`, `landing/passport.html`, `AGENTS.md`, `scripts/audit-exposure.mjs`):**
  - Added sanitized OpenRig Playbook (`@openrig/cli` L0–L3 model, honest recovery statuses, `rig send` vs `rig queue`, 10 advanced flows, Top 7 anti-patterns) as Markdown and bilingual RU/EN Section 9 `#openrig-playbook` in User Guide.
  - Upgraded `/passport` to a 100% bilingual executive Architecture & Security Passport (`125 / 125 PASS`), generalized `openrig/docs/architecture.md`, isolated internal R&D blueprints in gitignored `.private-docs/`, excluded `openrig/docs/**` from the npm tarball, and added `npm run audit:exposure`.
- **`⌘K` Command Palette, Safe Queue Triage & Anti-Collinear Graph Layout (`openrig/assets/domain/command-palette.js`, `openrig/assets/domain/topology-layout.js`, ADR-0015):**
  - Added fuzzy-scored `⌘K` Command Palette with scoped queries (`seat:`, `slice:`, `queue:`, `act:`), MRU ranking, and deduplicated Safe Queue Triage (noise filtering, hidden infra seat resolution, stale `PARKED` handling).
  - Hardened Dynamic & Fixed graph layout with anti-collinear arch staggering for `3+` node rows and full-segment edge-through-node repulsion.
- **Shift Catch-Up / Overnight Digest (`openrig/lib/shift-history.mjs`, `openrig/assets/domain/shift-digest.js`, ADR-0014):**
  - Added edge-triggered snapshot diffing and `0600` append-only JSONL history (`~/.config/rig-commander/shift-events.jsonl`) with secret/path redaction, corrupt-line resilience, and EN/RU Markdown shift digest export.
- **Git Worktree & Conflict Radar (`openrig/lib/git-radar.mjs`, `openrig/assets/domain/git-radar.js`, ADR-0013):**
  - Added out-of-band Git worktree scanner detecting dirty files, branch ahead/behind status, and cross-seat file-overlap conflicts with inline diff modal inspection.
- **Full-Stack Performance & Memory Optimization (`openrig/server.mjs`, `ring-buffer.mjs`, `deck.css`, `openrig/index.html`):**
  - **Single-Flight + Stale-While-Revalidate `/api/telemetry` & Incremental `historyRev`/`guidanceRev`:** coalesces concurrent clients, pre-warms telemetry on startup, moves heavy OpenRig CLI scans (`rig queue list -a`, `rig parked`, `rig capture`) off the HTTP critical path with bounded concurrency (`3`) and tiered prompt probe TTLs (`4s` active/terminal, `10s` resting), and serves `~31 KB` gzipped incremental updates (`7–15 ms`, **84×–111× faster**, **-83% traffic**) with full SHA-1 queue fingerprinting and immediate cache invalidation on all write-back actions (`?force=1` on manual refresh & post-send reconciliation).
  - **Bounded `TelemetryRingBuffer` (`maxSnapshots = 30`, slim snapshots) & Chunked `2 MB` JSONL Reader:** slashes 20-minute V8 Heap retention from `+182 MB` to `<3 MB` and avoids single-buffer memory spikes on 100 MB+ transcripts; adds `gzip` compression + mtime caching for static HTML/CSS/JS assets (`-75%` initial transfer).
  - **Zero-Thrash Dark Cockpit Rendering:** converted `@keyframes zzz-float` and `heartbeat-pulse` to GPU compositor-only transforms (removing animated `text-shadow` & `backdrop-filter` from tiny `.status-led` pills — dropping idle layouts from `1,198 → 6` per 10s, **200× fewer layouts**), stepped `.edge-stream` (`steps(22)`), eliminated Forced Synchronous Layout in `stepTween()`, pre-indexed Gantt rows `O(M)` and capped default `#queuePacketsList` to 24 prioritized rows (`1,537 → 381` DOM nodes), and added visibility-aware polling (`4s` visible / `16s` hidden).
- **Shared Context Lineage, Live Envelope Inspector & S2 Context Enrichment (`openrig/assets/domain/context-lineage.js`, `openrig/server.mjs`, `openrig/index.html`):**
  - Pure zero-DOM lineage engine (`extractItemContextMeta`, `extractContextArtifacts`, `buildSharedContextGraph`, `getContextDriftSignals`, `matchRelatedDecisions`) parsing OpenRig scope metadata (`blockedOn`, `handedOffFrom`/`handedOffTo`, `parent`, `project`, `mission`, `gate`, `body-context:*`, `evidenceRef`, `targetRepo`) and extracting spec/ADR paths, commit SHAs, and cross-referenced `qitem-*` links.
  - Lazy read-only `GET /api/queue/item?id=<qitemId>` endpoint (8s cache, strict `qitem-*` validation) fetching full transferred envelope bodies via `rig queue show <id> --full --json`, plus full `RECAP.md` exposure (`recapText`) in Node Inspector → Memory tab.
  - Interactive **`#contextLineageModal`** (`📄 Context` buttons in Edge X-Ray, Gantt Span Detail, and Active Queue Envelopes) displaying scope chips, `body-context` drift alerts, clickable blockers/dependents/lineage chain, related `decisions.md` entries, extracted artifacts, and full transferred body; also enriches AI Evaluator System 2 redacted bundles with `recapExcerpt`, queue context metadata, and `relatedDecisions`.
- **Non-Linear Exponential Thermal Curve, Anchored Route X-Ray & Persistent Node Focus Ring (`thermal.js`, `topology-layout.js`, `deck.css`, `openrig/index.html`):**
  - Replaced flat bottom context rail with a bottom-anchored exponential SVG thermal wedge (`0..35%` flat baseline, `k=1.3` smooth rise beneath card text and above card background) so context pressure reads intuitively at a glance.
  - Anchored Edge X-Ray popover (`computeAnchoredPopoverRect`) directly beside the clicked highway badge with automatic vertical flip, horizontal edge clamping, and empty-canvas click dismissal.
  - Added a persistent external cyan selection ring (`.agent-node.selected`) and paired Inspector header pill (`◎ <NODE>`) that remain clearly visible regardless of node state (`working`/`waiting`/`urgent`/`dormant`).
- **Safe `rig send --raw` Delivery with Screen-Verified Wrapper Fallback & Paced TUI Guard (`openrig/server.mjs`):**
  - `dispatchRawCommand` sends OpenRig raw commands via native `rig send --raw` (preventing Codex `/compact` slash-autocomplete collision) and returns `409` on real dirty-input/HITL refusals.
  - When OpenRig refuses solely due to a foreground shell wrapper (`behind a wrapper`), verifies the live screen with `classifyTerminalScreen()` — strictly refusing bare OS shells (`shellExited`) or HITL prompts with `409`, and otherwise delivering via paced TUI-safe `tmux` sequence (`Escape → C-e → C-u → -l → Enter`).
- **Landing v3.2 Update (`landing/index.html`, `landing/passport.html`):**
  - Expanded Landing Bento Grid to 4 symmetric rows (8 tiles) showcasing **3-Tier AI Evaluator** (`/demo?track=evaluator`) and **Shared Context Lineage**, refreshed EN/RU copy and Passport v3.2 matrix to **106 / 106 PASS across 20 test suites** and **16 pure domain modules**.
- **3-Tier Cognitive AI Evaluator (`Heuristic + Symbolic Expert ➔ Non-Generative System 1 ➔ Deliberative System 2`, ADR-0012, Ontology v2.2):**
  - **Tier 0 (`openrig/lib/ai-evaluator/expert-rules.mjs`):** continuous Heuristic Signal Scorer (`U0` epistemic uncertainty) + Symbolic Expert Rule Table (`E-VETO-*`, `E-RES-*`, `E-ESC-*`) with non-overridable **Hard Safety Vetoes** (`rm -rf`, `git push --force`, SQL DDL, `shellExited`, `Pi /compact`) and closed-loop anti-repeat feedback from `ActionAuditLog` (`unchanged` records).
  - **Tier 1 `System1Port` (`openrig/lib/ai-evaluator/s1-adapters.mjs`):** zero-prose, single-pass probabilistic decision tensor (`choice` + `noul` heads + normalized Shannon Entropy `H_norm` escalation gate) with unified `/v1/systemone` wire protocol (**TypeSafe AI Jev**, local Apache-2.0 **Laya**, local ~15ms CPU **Von**), plus **GLiClass-Modern-v3.0** (`Infinity`/`TEI`), **EmbeddingGemma-300M / Qwen3-Embedding-0.6B** cosine prototype router, and optional fast enum fallback (**GLM-4.7-Flash** / **GPT-6 Luna**).
  - **Tier 2 `System2Port` (`openrig/lib/ai-evaluator/s2-adapters.mjs`):** independent deliberative reasoner slot supporting **Gemini 4 Hydrogen / Carbon** (`thinkingConfig.thinkingLevel`), **GLM-5.3** (`thinking.type`), **GPT-6.2 Sol / Astra** (`reasoning_effort`), **Claude 5.5 Sonnet / Fable 5.2**, and local Apple Silicon MLX/Ollama (**Qwen3.8-27B**, **Qwen3.6-35B-A3B MoE**, **Qwen3.5-9B**, **Liquid LFM2.5**) with `<think>` stripping and `verifyEvidenceGrounding`.
  - **Security & Dark Cockpit UI:** `SecretRedactor` + per-call nonce `<UNTRUSTED_TELEMETRY_DATA>`, default `local_only` privacy mode, `0600` config persistence (`~/.config/rig-commander/ai-evaluator.json`), strictly Advisory-Only (zero auto-execute), inline `⚡ S1` / `🧠 S2` controls in Node Inspector, Live TMUX modal, Task Gantt Span Detail, Hardware/Subscription Slot Configurator tab, and offline `/demo?track=evaluator` showcase.
- **Operational Ontology v2.1, Architectural Passport v3.2 & ADRs 0010–0011:**
  - Canonicalized `nudge_queue` (`buildNudgeQueueAction` + `resolveActionFromFinding` + `shellExited` protection) inside `openrig/assets/ontology/actions.js` and added explicit `nudge_queue` inference & postcondition verification in `openrig/lib/action-audit.mjs`.
  - Upgraded `openrig/docs/operational-ontology.md` to **v2.1** (covering `shellExited`, `activityTier` with 12s hysteresis, 6-band Inferno/Plasma thermal spectrum, `subRow` bin-packing, `isNoise`, `HandoffSequence`, `SeatDiagnosis`, `ActionFlightGuard` / `ServerIdempotencyCache`, and 10 canonical actions).
  - Added `openrig/docs/adr/0010-control-plane-idempotency-remote-pwa-and-self-update.md` and `openrig/docs/adr/0011-adaptive-graph-seat-diagnosis-and-sublane-gantt.md` and registered them in `openrig/docs/adr/README.md`.
  - Upgraded `/passport` (`landing/passport.html`) to **Passport v3.2** (exact **88 / 88 PASS** across **18** test suites, all **14** pure `assets/domain/*` modules, **6** Fleet Intelligence detectors, Remote PWA + `409` idempotency controls) and refreshed `/guide` (`landing/guide.html`) + `docs/USER_GUIDE.md` to **v3.2**.
- **Operational Task Gantt & Chronological Handoff Flow (`openrig/assets/domain/gantt-model.js`, `openrig/index.html`, `deck.css`):**
  - **Sub-lane interval bin packing (`packLaneIntervals`):** concurrent tasks on the same agent or slice expand cleanly into non-overlapping sub-rows (eliminating smashed overlapping labels).
  - **Dual Timeline Grouping (`[By Agent | By Slice]`):** switch between agent utilization/concurrency and per-slice Trace Waterfall with QA bounce-back counters.
  - **Chronological Handoff Flow (`[📊 Timeline | 🔀 Handoff Flow]`):** lightweight sequence trace scoped strictly to the 2–5 agents participating in the selected slice, annotating every handoff with wait duration, work duration, and QA bounce-back arrows (`🪃`).
  - **Wait-vs-Work KPI Strip, Signal/Noise Filter & Interactive Span Inspector:** hides `Wake escalation` / `recovery-for` / `stuck-sweep` noise by default with 1-click toggle, surfaces Wait % vs Work % and a clickable `🔥 Top delay` chip, adds `30m/1h/6h/24h` + `1×/2×/4×` zoom, instant hover popover, and bottom Span Detail drawer (`Open Flow`, `Seat`, `Screen`, `rig queue show`).
- **Dual Graph Layout Modes (`Dynamic` vs `Fixed`) & Ultra-Compact Dormant Nodes (`openrig/assets/domain/topology-layout.js`, `deck.css`, `openrig/index.html`):**
  - Added pure pixel-aware topology layout engine (`computeTopologyLayout`) with a header switcher (`[Dynamic | Fixed]` / `[Динам | Фикс]`) persisted in `rigcommander_prefs_v1.graphLayout`.
  - **Dynamic mode (default):** gives working, urgent, and actively communicating nodes the upper Active Stage with guaranteed collision & edge-badge clearance (`≥130px` clear span) plus 12s stage hysteresis and 60fps lockstep node+edge glide transitions, while docking sleeping/non-communicating nodes into a compact bottom bench (`DORMANT · N`).
  - **Fixed mode:** preserves deterministic role-tiered coordinates invariant to `idle ↔ working` transitions while enforcing pixel-aware collision-free spacing (preventing `dev-owner` / `dev-senior-architect` crowding).
  - **Ultra-compact dormant capsules (both modes):** shrinks idle/non-communicating nodes to single-row untruncated pills (`min-width: 0`, inline `🟠`/`⚠️` flag, 2px thermal rail, quiet `opacity: 0.14` ghost web) with edge-aware hover expansion so bottom/side cards never clip.
- **Auto-Update & npmjs Release Watcher:**
  - Shared zero-dependency SemVer & npmjs release module (`openrig/assets/domain/semver.js`) and server-side `SelfUpdater` (`openrig/lib/self-update.mjs`) polling `https://registry.npmjs.org/rig-commander/latest` (30-min cache + manual check).
  - Live RigCommander `⬆ Update vX.Y.Z` button + modal (`#updateModal`) with safe 1-click self-update per install mode (`global-npm`, `npx-cache`, `git-checkout`), graceful supervisor restart (`exit 75` in `bin/cli.mjs`), and automatic browser reconnect.
  - Dismissible website release notice (`✨ New vX.Y.Z`) on the landing page with `localStorage` persistence per version.
- **Control-Primitive Double-Click & Idempotency Guard (`openrig/assets/domain/action-guard.js`):**
  - Client-side `ActionFlightGuard` with exclusive per-seat in-flight locks, post-send cooldowns (`1.8s`–`2.2s`), DOM lock synchronization (`disabled`, `aria-busy`, `data-ctrl-busy="1"`) that survives 4s telemetry re-renders, and form input preservation on blocked retries.
  - Server-side `ServerIdempotencyCache` on `POST /api/send` supporting `X-Idempotency-Key` replay (30s TTL) and `409 Conflict` suppression of concurrent or rapid semantic duplicate commands (`1.5s`).
- **Changelog:** Added `CHANGELOG.md` linked from `README.md`, npm package, and `/guide`.

### Changed
- **Actionable Seat Diagnosis in Node Inspector, Clean Triage Cards & Noise-Free `BottleneckDetector`:**
  - Added `#inspSeatDiagnosis` (**Диагноз и что исправить** / **Diagnosis & What to Fix**) at the top of the Node Inspector showing the full active finding, exact waiting queue items (`slice`, sender, summary), plain-language remediation steps, and 1-click fixes (including **`📨 Разобрать очередь`** sending an explicit queue-review prompt for idle prompts where bare `Enter` fails, **`📊 Гант`**, and **`Cmd`**).
  - Compacted Top-3 Triage Strip cards (`P0`/`P1`/`P2` pills + seat-first `shortTitle` so headlines never truncate to 1 character), deduplicated per-seat slots in both `advisory.mjs` and `renderTriageStrip`, auto-expanded collapsed Inspector on click, and added spotlight focus highlight.
  - Hardened `computeQueueKinetics` and `BottleneckDetector`: deduplicated `activeQueue` + `recentQueue` by `qitemId`, separated real pending tasks from `stuck-sweep`/`undelivered-wake` system noise (downgrading pure sweep noise to `p2_medium` cleanup instead of false `p0_urgent`), and fixed broken `WWR = 1` copy.
- **Single-Card Graph Node Telemetry, Clean Hover Meta & 6-Band Thermal Spectrum (`thermal.js`, `deck.css`, `openrig/index.html`):**
  - Removed the dangling external neon `.node-bottom-badge` pill below graph nodes and integrated all telemetry cleanly inside one unified Dark-Cockpit card (Row 1: seat name + tabular context %; Row 2: quiet `K/K` token quota + `↓in ↑out` queue envelope traffic with tooltips; 3px progressive 6-band thermal rail via `clip-path`).
  - Replaced legacy 4-chip rainbow hover bar with a calm single-line typographic spec footer (`codex · gpt-6.2-sol`), fixed hardcoded bogus `Spec & Arch` badge on dynamic seats, removed duplicate `ctx%` thermal pill & fabricated `20%/h` idle ETA, and capped compact hover width (`max-width: 256px`).
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
