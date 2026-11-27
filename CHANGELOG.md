# Changelog

All notable changes to **RigCommander** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [3.14.2] - 2026-11-27

### Fixed & Improved
- **Coordinated Fleet Topology as Default `/demo` Showcase (`openrig/index.html`, `openrig/assets/domain/i18n.js`, `openrig/assets/styles/deck.css`):**
  - Switched the default `/demo` preset to `Fleet (OpenRig)` / `Флот (OpenRig)` with the left Radar collapsed on first visit so visitors immediately see the full multi-agent call-highway topology, bottleneck highlighting (`dev-check (QA)` HITL + `79%` CTX), dormant bench, quiet clusters, and cross-seat Git worktree overlap in one glance.
  - Made the top-bar mode switcher (`Fleet (OpenRig)` | `Plain tmux` / `Флот (OpenRig)` | `Обычный tmux`) visibly highlighted and self-explanatory, keeping `?preset=universal` / `?preset=tmux` directly accessible.
- **Explicit Universal TMUX Framing on Landing Hero (`landing/index.html`):**
  - Added a clear mode kicker above the landing hero simulator (`CASE 1: UNIVERSAL TMUX` / `КЕЙС 1: UNIVERSAL TMUX (БЕЗ ФРЕЙМВОРКОВ)`) paired with a direct link to the coordinated Fleet Graph in `/demo`.
  - Replaced the working `gemini-docs` card in the hero Wait Radar with `+ 2 running normally` and aligned the mobile `390×844` hero preview buttons 1-to-1 with `/demo` (vertical Cancel + dashed de-escalated `▸ Always (dir)`).

---

## [3.14.1] - 2026-11-27

### Fixed & Improved
- **Unified Terminal Disclosure & Distinct HITL Hierarchy (`openrig/assets/ui/inspector-view.js`, `openrig/assets/styles/deck.css`, `openrig/index.html`, `openrig/assets/domain/i18n.js`):**
  - Merged duplicate `80 lines TMUX` and `Raw TMUX & manual keys` triggers into one unified `Terminal (80 lines) & manual keys` disclosure hosting inline capture, manual keys, and full 80-line modal expand — freeing ~100px vertically so `⚡ Auto-Consent` stays above the fold on `1280×720` laptops.
  - Separated Option 2 (`▸ Always (dir)`) into a compact lower-weight inline row alongside its high-contrast scope note so safe 1-time Allow, Cancel, and persistent Always rules have unmistakable visual hierarchy.
  - Removed visual echo on `/demo` (double `P0` prefix in Triage card, duplicate `HITL waiting` sub-badge on `codex-tests`, truncated `claude-refactor` role), lifted dark-mode contrast on secondary metadata, separated `⏸ Hold Sends` / `⏸ Пауза ввода` into a cool slate control (zero amber collision with FinOps telemetry), and aligned mobile hold label (`Пауза` / `Hold`).
- **Auto-Consent Effective-vs-Draft Clarity & Compact Empty Logs (`openrig/assets/ui/auto-consent-view.js`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/i18n.js`):**
  - Added an explicit 1-line `Active now: OFF (0 automated sends) · Settings below are a staged draft` banner, styled draft switches with dashed muted tracks and explicit `(draft · inactive while OFF)` wording, collapsed empty ephemeral session grants & audit logs into one compact disclosure (`0 temporary sessions · 0 audit decisions`), and added an explicit `Cancel` button beside `Save Draft (Keep OFF)`.
- **Landing, Guide & Passport Trust Polish (`landing/index.html`, `landing/guide.html`, `landing/passport.html`):**
  - Linked `--tmux-socket` isolation directly under the hero CLI command, tightened mobile `390×844` hero preview spacing so all buttons fit cleanly above the fold, and replaced Russian copy calques (`по сиденьям` → `по агентам и сессиям`, `автономные рои` → `4–8 параллельных агентов в tmux`).
  - Removed duplicate sidebar links in `/guide`, documented honest regex secret-redaction boundaries with a direct link to the public test suite, made `379/379 PASS` in `/passport` a direct link to GitHub Actions CI, and renamed the right trust-boundary column to `Mode / Verification`.

---

## [3.14.0] - 2026-11-27

### Added
- **Strict TMUX Socket & Session Allowlist Isolation (`bin/cli.mjs`, `openrig/server.mjs`, `openrig/lib/universal-discovery.mjs`):**
  - Added `--tmux-socket <name>` (`RIGCOMMANDER_TMUX_SOCKET`) to restrict every `tmux` discovery, capture, and send invocation to a dedicated isolated server socket (`tmux -L <name>`), validated against safe socket identifiers.
  - Added `--tmux-session <prefix[,prefix]>` (`RIGCOMMANDER_TMUX_SESSIONS`) allowlist filtering: non-matching sessions (such as adjacent production SSH or `.env` panes) are excluded before `capture-pane` is ever invoked, and direct capture/send routes reject out-of-scope seats with `403` (`TMUX_SCOPE_DENIED`).
  - Documented `--tmux-socket` & `--tmux-session` isolation across `--help`, `/guide`, `/passport`, and `llms.txt`, and restored inline visibility for the 30-second Sigstore verification one-liner in `/guide`.

### Fixed & Improved
- **Exception-Only Dark Cockpit Triage & Borderless Tonal Inspector (`openrig/index.html`, `openrig/assets/ui/topology-view.js`, `openrig/assets/ui/inspector-view.js`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/i18n.js`):**
  - Renamed the left panel to `TRIAGE` / `ТРИАЖ` in flat `tmux / Universal` mode and folded healthy working panes into a single quiet summary line (`+ N running normally`) to eliminate 4× screen duplication while keeping blockers front and center.
  - Renamed global `⏸ Pause` to explicit `⏸ Hold Sends` / `⏸ Пауза ввода`, echoed the exact command name inside the primary green Allow Once button (`✓ 1. Allow npm test once (y)`), flattened nested Inspector borders into a calm tonal surface, and compacted `80 lines TMUX` + `AI Risk: OFF` into a single borderless utility row.
- **Mobile `390×844` Hero CLI Wrap & Honest Auto-Consent Modal (`landing/index.html`, `landing/passport.html`, `openrig/assets/ui/auto-consent-view.js`, `openrig/assets/styles/deck.css`):**
  - Fixed mobile hero CLI truncation by wrapping `npx rig-commander@3.14.0 --read-only --no-session-logs` cleanly across lines above a full-width Copy button on `<= 640px` viewports, and aligned mobile hero preview buttons 1-to-1 with `/demo`.
  - Replaced bright cyan switches and bordered status pills in master-OFF Auto-Consent with calm monochrome switch states, renamed the `Safe Read-Only` profile legend honestly to `Read-Only & Local Tests`, and collapsed identical inherited OFF agent rows into a `<details>` disclosure so `Active Ephemeral Session Grants` is never clipped.
  - Flattened static condition badges in `/passport` (`BY DEFAULT`, `WITH --read-only`, `SIGSTORE`) into crisp unbordered labels.

---

## [3.13.2] - 2026-11-27

### Fixed & Improved
- **Landing Hero Parity & `1280×720` Above-the-Fold Fit (`landing/index.html`, `landing/guide.html`):**
  - Unified the primary copyable CLI command across `/` and `/guide` to `npx rig-commander@3.13.2 --read-only --no-session-logs`, replaced the dim clipboard emoji with an explicit bordered `Copy` / `Копировать` button, and wrapped `--read-only` in `white-space: nowrap` so the flag never splits across lines.
  - Replaced the tall hero diamond mockup with a compact 2×2 `TMUX Panes` preview (`claude-api`, `codex-tests`, `gemini-docs`, `claude-refactor`) matching `/demo` 1-to-1 and labeled `PREVIEW` / `ПРИМЕР`, keeping the P0 node and all 3 HITL buttons cleanly above the fold on `1280×720`.
  - Folded the 14-line Sigstore `mktemp` verification snippet on `/guide` into a clean collapsible `<details>` disclosure and unified the static-site header CTA (`Live Demo →`).
- **Dark Cockpit Header Isolation, Triage Calm & Compact Inspector (`openrig/index.html`, `openrig/assets/ui/topology-view.js`, `openrig/assets/ui/inspector-view.js`, `openrig/assets/ui/auto-consent-view.js`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/i18n.js`):**
  - Hid inactive (`OFF`) Auto-Consent from the desktop/laptop/mobile top bar (surfaces when active/paused), isolated `⏸ Pause` with dedicated visual spacing, and collapsed the unconfigured Inspector Auto-Consent block into a 1-line row (`Auto-Consent · Off · Configure`), reclaiming ~70px so the entire Inspector fits cleanly on `1280×720`.
  - Collapsed the 4-badge Wait Radar P0/P1 alert stack into a 2-line aviation-grade triage card, renamed the center tab button to `PANES` / `ПАНЕЛИ` when rendering flat `tmux` panes, allowed 2-line role wrap on cards (zero truncation), and reduced decorative emoji noise.
- **Auto-Consent Modal Semantic Switch Clarity (`openrig/assets/ui/auto-consent-view.js`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/i18n.js`):**
  - Renamed the modal status badge to `AUTO-CONSENT OFF` / `АВТО-СОГЛАСИЕ ВЫКЛ`, replaced blanket opacity dimming with distinct semantic ON-armed (muted cyan + `ON (armed)` pill) vs OFF (graphite + `OFF` pill) states, elevated `Save Policy` to a primary button, and documented the wrapper-script boundary caveat inside Hard Vetoes.

---

## [3.13.1] - 2026-11-27

### Fixed & Improved
- **Inspector HITL De-Duplication & Safety (`openrig/assets/ui/inspector-view.js`, `openrig/assets/styles/deck.css`, `openrig/index.html`):**
  - Removed `🛑 Ctrl+C` from the Inspector header next to safe `📋 Attach` to eliminate accidental-SIGINT risk and duplicate controls; collapsed the redundant raw `🖥️ TMUX` block by default when an inline P0 HITL prompt card is active (`<details class="insp-raw-tmux-disclosure">`), freeing ~260px on `1280×720` laptops.
  - Replaced competing cyan+red double borders on selected urgent cards with a calm elevated dark-crimson surface, dropped redundant `"working"` text on 1-line routine radar rows so `gemini-docs` never truncates on `1280×720`, and shortened `AI Risk: OFF` for clean chevron spacing.
- **Mobile Header Clarity & Auto-Consent Modal (`openrig/assets/ui/auto-consent-view.js`, `openrig/assets/styles/deck.css`):**
  - Hid inactive (`OFF`) Auto-Consent from the `390×844` mobile top bar (remains accessible in Tools and surfaces in the bar when active), giving `⏸ Pause` a full readable label and touch target.
  - Replaced the card-like 3-column legend and defensive `(NOT BUTTONS)` caption in Auto-Consent with a flat inline text legend + dedicated veto strip, truly desaturated sub-switch thumbs when global Auto-Consent is OFF, and added an explicit `"Applies when enabled"` note.
- **Landing Hero, Guide & Passport Polish (`landing/index.html`, `landing/guide.html`, `landing/passport.html`):**
  - Hid the duplicate navbar `Live Demo →` button while the primary Hero CTA is visible above the fold, synced the desktop hero simulator button order with `/demo` (`Allow once → Cancel → Always`), and tightened hero height for `1280×720`.
  - Updated `/guide` primary copyable zero-write inspection command to `npx rig-commander@3.13.1 --read-only --no-session-logs` and calmed inline code badges; added an above-the-fold maintainer/source/security bar and per-process session token detail to `/passport`.

---

## [3.13.0] - 2026-11-27

### Added
- **Live Server-Side Secret Redaction on `/api/capture` & `/api/capture/stream` SSE (`openrig/server.mjs`):**
  - Enabled automatic redaction of API keys, Bearer/JWT tokens, PEM private keys, `.env` secret assignments, and SSH host IPs before live terminal output reaches the browser over SSE (`redactLiveCaptureScreen`), while keeping workspace paths readable for the local operator. Opt out via `--raw-capture` / `RIGCOMMANDER_RAW_CAPTURE=1`.
- **Strict `--no-session-logs` Opt-Out Flag (`bin/cli.mjs`, `openrig/server.mjs`, `openrig/lib/universal-discovery.mjs`):**
  - Added `--no-session-logs` (and `RIGCOMMANDER_NO_SESSION_LOGS=1`) so operators can completely skip reading `~/.claude/` and `~/.codex/` transcripts and restrict discovery strictly to live local `tmux` panes.
- **Global Fleet Safety Pause (`⏸ Pause` / `Shift+Space`) & Header `🛑 Ctrl+C` (`openrig/index.html`, `openrig/assets/ui/inspector-view.js`, `openrig/assets/styles/deck.css`):**
  - Added a visible `⏸ Pause` toggle in the top bar (desktop, laptop & mobile) that pauses Auto-Consent and locks terminal sends until resumed, plus a compact `🛑 Ctrl+C` button in the Inspector header above the fold.

### Changed
- **Adaptive Standalone TMUX Panes Grid & Wide Decision Inspector (`openrig/assets/ui/topology-view.js`, `openrig/assets/styles/deck.css`, `openrig/index.html`):**
  - When a fleet has 0 call-highway edges (`tmux / Universal` mode), the center canvas automatically switches from an empty 2D graph void to a structured 2-column `TMUX PANES` grid, hiding unused graph/layout toggles and expanding the Decision Inspector (`+90–100px`) so Git Worktree and live TMUX preview stay above the fold.
  - Collapsed routine healthy working agents in Wait Radar into quiet 1-line rows (`Management-by-Exception`), deduplicated the P0 HITL Inspector header, vertically separated `Always (dir)` below `Cancel (esc)` with a dashed divider, labeled optional `🧠 AI Risk · OFF (opt-in)` honestly, and removed synthetic queue-envelope counts on standalone `tmux` demo panes.
- **Auto-Consent Modal & Public Docs Clarity (`openrig/assets/ui/auto-consent-view.js`, `landing/index.html`, `landing/guide.html`, `landing/passport.html`):**
  - Dimmed dependent Auto-Consent controls & desaturated active sub-toggles when the global master switch is OFF, labeled the 3-column profile strip explicitly as a flat read-only reference, and expanded the agents policy viewport so all 4 agents fit without clipping.
  - Removed landing hero neon glow, eyebrow pill, and nested CTA badge so the interactive preview lifts into `1280×720` / `1440×900` viewports; replaced jargon in `/passport` intro, added a dedicated C4 row for Live TMUX SSE redaction & `--no-session-logs`, and documented maintainer/security contact channels.

---

## [3.12.2] - 2026-11-27

### Fixed & Improved
- **Live 3-Line Terminal Context Directly Inside P0 HITL Card (`openrig/assets/domain/prompt-parser.js`, `openrig/assets/ui/inspector-view.js`, `openrig/assets/styles/deck.css`):**
  - Extracted up to 3 redacted terminal context lines directly before the active prompt menu (`extractPromptContextLines`) and rendered them inline above the primary Allow Once button so operators on `1280×720` laptop and `390×844` mobile see live terminal context before approving without scrolling.
  - Collapsed redundant nested yellow frame inside `.diag-inline-hitl` and hid the duplicate `#panelRight > .panel-header` on mobile (`<= 768px`) to reclaim vertical space above the fold.
- **No False Button Affordance in Wait Radar & Clean Card Wrapping (`openrig/index.html`, `landing/index.html`, `landing/passport.html`):**
  - Removed the non-interactive `→ Selected right` pseudo-button in Wait Radar in favor of crisp `.wait-card.is-selected-card` border highlighting so active cards never mimic mutating `/compact` buttons.
  - Enforced `overflow-wrap: anywhere` / `white-space: normal` on `.sec-guarantee-desc code` and `.guarantees-table code` and linked the `SIGSTORE PROVENANCE` card directly to the copyable `/guide#quickstart` 1-liner, eliminating card border overflow on desktop.

---

## [3.12.1] - 2026-11-27

### Fixed & Improved
- **Reproducible Pre-Run Supply-Chain Verification & Honest `npx` Boundary (`landing/guide.html`, `landing/passport.html`, `landing/index.html`, `landing/llms*.txt`):**
  - Replaced ambiguous `npm audit signatures` snippet with a self-contained clean-temp-directory command (`npm install --ignore-scripts rig-commander@3.12.1 && npm audit signatures`) plus expected attestation output, distinct copy button labels, and collapsed interactive mode disclosure on `/guide`.
  - Moved the C4 Trust Boundaries & Security Guarantees table above the KPI cards on `/passport`, explicitly separated `npx` package fetch from running-process zero-network guarantees, and synced the test-suite badge (`44` suites).
  - Removed competing navbar glow on `landing/index.html` and aligned mobile hero preview button order (`Cancel (esc)` left, `Always (dir)` right) with `/demo`.
- **Clearer Fleet Status & HITL Ergonomics on Desktop, Laptop & Mobile (`openrig/index.html`, `openrig/assets/ui/inspector-view.js`, `openrig/assets/domain/i18n.js`, `openrig/assets/styles/deck.css`):**
  - Replaced raw `1 P0 · 1 P1` header counts with human-readable status (`1 awaiting input · 1 CTX` / `1 ждёт ответа · 1 CTX`), surfaced a compact `Auto: OFF` / `Авто: ВЫКЛ` pill on mobile (`390×844`), labeled local seat health explicitly (`Seat: nominal` / `Узел: штатно`), shortened single-run primary CTA to stay single-line on `1280×720`, and styled `Always (dir)` as a lower-emphasis ghost button with explicit CLI folder-rule scope & revocation note.

---

## [3.12.0] - 2026-11-27

### Added
- **Control-Plane Watchdog & 2-Step Queue Hygiene (`openrig/assets/domain/control-plane-model.js`, `openrig/lib/control-plane-probe.mjs`, `openrig/lib/fleet-intelligence/detectors/control-plane-hygiene.mjs`, `openrig/lib/resilience/hygiene-gate.mjs`, `openrig/assets/ui/resilience-view.js`):**
  - Monitors OpenRig daemon probe latencies (avg/p95/consecutive slow probes), bounded `<= 32KB` `mtimeMs`-cached `daemon.log` tail error patterns, `openrig.sqlite` size, `qitem-opgate-*` age buckets (`24h`/`72h`/`168h`), detached target seats, and `stale_runtime_hook` (`DAEMON_DEGRADED`, `QUEUE_ZOMBIE_STORM`, `BROKEN_ESCALATION_ROUTE`).
  - Added 2-step `/api/resilience/hygiene/{plan,execute}` Crash-Cart preview/confirm workflow (`5`-min single-use SHA-256 `planHash`, `X-Idempotency-Key` deduplication, `crossRigWarning`, official `rig queue update --state done --closure-reason canceled` previews, safe copy-and-truncate `daemon.log` rotation, `--read-only` enforcement, and honest `cleaned`/`partial`/`failed`/`unknown` receipts).
- **Additive Multi-Vendor Swarm Discovery & Provider Drift Guard (`openrig/assets/domain/swarm-model.js`, `openrig/lib/swarm-discovery.mjs`, `openrig/lib/provider-contracts.json`, `openrig/lib/provider-drift-guard.mjs`, `scripts/verify-providers.mjs`):**
  - Read-only additive discovery of native Antigravity `/swarm`, Claude Teams, and Codex subagents alongside OpenRig & `tmux` (`🐝 SWARM · @swarm-*` clusters, `@mention` Call Highways edges, Swarm Gantt items, redacted `boardTail` in Inspector, strict `capabilities.canSendKeys: false` write/tmux disablement, and hard `VETO_NON_TMUX_SEAT` in `AutoConsentEngine`).
  - Two-contour Provider Drift Guard verifying CLI version ranges & JSON/JSONL contracts (`npm run verify:providers -- --json`), surfacing `SCHEMA DRIFT` / `UNVERIFIED VER` pills and showing `unknown (schema_drift)` instead of `0` on incompatible outputs.

### Fixed
- **HITL Inspector Deduplication & Credibility Alignment (`openrig/assets/ui/inspector-view.js`, `openrig/assets/domain/{prompt-parser,i18n}.js`, `openrig/index.html`, `landing/{index,guide,passport}.html`, `landing/llms*.txt`):**
  - Deduplicated bottom `#inspectorPromptOptionsBar` whenever top P0 `#inspDiagInlineHitl` is active across full render, `fetchTerminalCapture`, and `applyIncomingTmuxScreen`.
  - Replaced truncated `Always in repo...` with untruncated `Always (dir)` / `Всегда (папка)`, updated `codex-tests` capture to authentic Codex `$ npm test`, fixed multi-line `$ <cmd>` prompt extraction in `prompt-parser.js`, and aligned landing `0% CPU (no tabs)` / `tmux (or OpenRig)` phrasing.
- **Test Verification:** Expanded automated test coverage to **`372 / 372 PASS` across `44` test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS` and `verify:providers` `ok: true`.

---

## [3.11.0] - 2026-11-27

### Added
- **Default `tmux / Universal` `/demo` Mode & Native Mobile P0 Preview (`openrig/index.html`, `landing/index.html`):**
  - Switched `/demo` default preset to **`tmux / Universal`** (4 standalone `tmux` sessions led by `codex-tests` P0 `npm test` in `~/projects/payments-api`, zero OpenRig jargon, `0` `/api/*` calls), while keeping `OpenRig Pod` 1 click away (`?preset=openrig` / switcher).
  - Replaced desktop chrome frames on narrow mobile (`<= 640px`) on the landing hero with a crisp native mobile P0 HITL preview card and unified the landing hero preview bar with the real `/demo` cockpit (left-aligned monospace terminal log, synchronized mini-bar, zero fake macOS traffic dots or phantom toolbar buttons).
- **Explicit Pre-Run Verification & TOCTOU / Redaction Disclosure (`landing/guide.html`, `landing/passport.html`, `landing/index.html`, `landing/llms*.txt`):**
  - Updated `/guide` quickstart callout to **`✓ READ-ONLY INSPECTION (ZERO TERMINAL WRITES)`** / **`✓ ОСМОТР БЕЗ ЗАПИСИ В ТЕРМИНАЛ`** with an explicit 3-bullet Reads/Writes/30s `npm audit signatures` + `dist.attestations` verification block.
  - Added accurate distinction between strictly allowlisted quick-action keys and explicit collapsed manual operator commands (hard-blocked under `--read-only`), plus factual SHA-256 TOCTOU prompt-drift abort & secret-redaction disclosures.

### Fixed & Improved
- **HITL Fat-Finger Safety & Anti-Misclick Guard (`openrig/assets/ui/inspector-view.js`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/i18n.js`, `tests/inspector-view.test.mjs`):**
  - Rendered **`1. Yes, allow once (y)`** as the sole full-width emerald primary button above a `16px` safety gap, separating **`Cancel (esc)`** and **`Always in folder...`** below with a **4s 2-step inline confirmation guard** before Option `2` can dispatch.
  - Added an explicit destination + scope mono header line above the command box, upgraded 80-line TMUX & AI Risk disclosures to pill affordances with `›` chevrons, removed the duplicate header `Screen` trigger, hid desktop `Copy attach` on mobile, and tucked manual command input inside a collapsed `<details>` disclosure.
- **54px Single-Row Chrome, Strict `Red = P0 Only` Discipline & De-Noised Modal (`openrig/index.html`, `openrig/assets/ui/{auto-consent-view,topology-view}.js`, `tests/{auto-consent-view,topology-view}.test.mjs`):**
  - Collapsed desktop/laptop `/demo` top chrome into one **`54px`** row (`<= 24` interactive targets above fold, `0` tiny targets; `50px` mobile bar), consolidated multi-signal agents into one Wait Radar card per agent, restricted crimson styling strictly to P0 HITL blockers (P1 context heat & non-P0 worktree overlap chips amber), raised `#acCtxThresholdInput` (`76×32px`) and OpenRig swimlane toggle (`32×32px`), removed redundant switch pills & `Session +60m` clutter when global Auto-Consent is OFF, and aligned the unified Guardrails modal header + sticky footer.
- **Test Verification:** Expanded automated test coverage to **`355 / 355 PASS` across `41` test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

---

## [3.10.0] - 2026-11-27

### Added
- **Universal `tmux` Demo Preset (`openrig/index.html`, `openrig/assets/domain/i18n.js`):**
  - Added an explicit **`tmux / Universal` | `OpenRig Pod`** preset toggle inside the offline `/demo` header. Switching to `tmux / Universal` renders 4 standalone `tmux` sessions (`claude-api`, `codex-tests` HITL `npm test`, `gemini-docs`, `claude-refactor` CTX `78%`) with zero OpenRig jargon and `0` live `/api/*` requests.
- **Triage-First Mobile `/demo` (`390×844`, `openrig/assets/styles/deck.css`, `openrig/index.html`):**
  - Mobile `/demo` now opens directly onto the active P0 HITL triage card (`dev-check (QA)`) beneath a single `50px` top bar (`Brand + P0/P1 badge + Tools + EN|RU`) with thumb-friendly `44px` Option 1/2/3 HITL buttons above the fold, `0px` horizontal overflow, and a 3-tab bottom bar (`Triage`, `Map`, `Inspector`).
- **Trust & Supply-Chain Transparency (`landing/index.html`, `landing/passport.html`, `landing/guide.html`, `landing/llms*.txt`):**
  - Unified pinned `npx rig-commander@{{APP_VERSION}} --read-only` as the primary first-run command across `/`, `/guide`, `/passport`, and `llms*.txt`, added an explicit **Local HTTP→TMUX CSRF & DNS-Rebinding Protection** row and **Verified Supply Chain & 30-Second Audit** (npm Sigstore provenance via GitHub Actions OIDC, `0` runtime dependencies, pinned source tags) to `/` and `/passport`.

### Fixed & Improved
- **Collapsed Desktop/Laptop `/demo` Chrome (`216px → 85px`) & Inline HITL Above Fold (`openrig/index.html`, `openrig/assets/styles/deck.css`, `openrig/assets/ui/inspector-view.js`, `tests/inspector-view.test.mjs`):**
  - Replaced the bulky 3-card FinOps header strip with a compact inline FinOps & Peak CTX popover pill (`⚡ $6.63 · CTX 79% ▾`), harmonized P0/P1 counts across top bar, Wait Radar, and mobile tabs, replaced scattered `16×16px` `?` badges with a single `28×28` `?` shortcuts popover, and cut above-the-fold controls with `0` tiny targets.
  - All 3 inline HITL Option 1/2/3 buttons finish cleanly above the `1280×720` fold (`582px <= 720px`) with the redundant red `🚨 Resolve HITL prompt` CTA replaced by a muted `📺 Open 80-line TMUX screen` link.
- **Dark Cockpit Topology Calm & Auto-Consent Modal Isolation (`openrig/assets/ui/{topology-view,auto-consent-view}.js`, `tests/{topology-view,auto-consent-view}.test.mjs`):**
  - Placed node context thermal sparklines into a dedicated in-flow row cleanly below `↓57 ↑46` metrics (`0` overlap), recolored routine `Active` / `В работе` edges to calm cyan while reserving crimson strictly for P0 HITL edges.
  - Polished the Auto-Consent modal: fixed RU heading (`Политики агентов`), added a 3-column **Allowed vs Hard-Vetoed Commands** summary strip (EN & RU), separated the `💾 Save Policy` footer from `⏸ PAUSE` (hidden when OFF, emergency style when ARMED), added a `max-height: 240px` scrollable agents list, switched Dry-Run mode styling to calm cyan, and enforced `inert` + `aria-hidden="true"` on background panels while the modal is open.
- **Unified `56px` Sticky Site Header & `1280×720` Hero (`landing/{index,guide,passport}.html`, `tests/ai-discovery.test.mjs`):**
  - Replaced the floating pill navbar on `/` with a unified `56px` sticky header matching `/guide` and `/passport` (`0` `fixedOverlayOverlaps`, `0px` horizontal overflow across `1440×900`, `1280×720`, `390×844` in EN & RU), tightened hero spacing so interactive simulator cards render above the `1280×720` fold, raised `.lang-btn` touch targets to `>= 36×36px`, and replaced `Cmd ⧉` on `/guide` with explicit `Copy` / `Копировать` labels.
- **Test Verification:** Expanded automated test coverage to **`353 / 353 PASS` across `41` test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

---

## [3.9.0] - 2026-11-26

### Added
- **Strict `--read-only` Zero-Write Inspection Mode (`bin/cli.mjs`, `openrig/server.mjs`, `openrig/lib/remote-access.mjs`, `openrig/lib/shift-history.mjs`, `tests/read-only-mode.test.mjs`):**
  - Added `--read-only` CLI flag (`RIGCOMMANDER_READ_ONLY=1`) enforcing a centralized `403 READ_ONLY_MODE` write-block gate across all mutating `/api/*` endpoints and `/pair` (including `GET /pair?code=`), preventing disk writes on `--public-url` startup, disabling Auto-Consent dispatches, Telegram wake egress, playbook mutations, and shift-history disk queues while keeping all live read-only observation & SSE endpoints 100% functional.
  - Surfaced a dedicated `🔒 READ-ONLY` badge in the top HUD when `telemetry.readOnlyMode` is active and documented `--read-only` across the CLI, `/guide`, `/passport`, `llms*.txt`, and the Tier-1 Agent Skill (`skills/rig-commander-mission-control/`).
- **Security Guarantees Strip, Universal Comparison Table & Inline HITL Preview (`landing/index.html`, `landing/passport.html`, `openrig/assets/ui/inspector-view.js`):**
  - Added an at-a-glance bilingual Security & Privacy Guarantees table on both the landing page and `/passport`, plus a 3-column **Raw tmux vs Cloud Tracing (LangSmith/Langfuse) vs RigCommander** comparison table.
  - Added inline parsed command previews and allowlisted Option 1/2/3 HITL actions directly inside the Seat Inspector diagnosis card above the fold for `NEEDS INPUT` nodes.

### Fixed & Improved
- **Mobile Landing (`390×844`), Laptop Header (`1280×720`), Zero-External-Font Load & Guide/Passport Parity (`landing/{index,guide,passport}.html`, `openrig/index.html`, `tests/ai-discovery.test.mjs`):**
  - Removed all external `fonts.googleapis.com` / `fonts.gstatic.com` stylesheet links across landing, guide, passport, and deck (eliminating CORS errors and slow font stalls with local zero-network UI + mono font stacks).
  - Eliminated `230px` mobile horizontal overflow on `/` (`0px` overflow at `390×844` across header, hero, and wrapped footer), hid the Phone QR CTA on mobile viewports, fixed single-row `1280×720` headers with `>= 32px` nav targets, synced `v{{APP_VERSION}}` badges across the hero & preview, simplified hero copy in plain EN/RU, standardized `EN | RU` toggle order across all surfaces, moved `/guide` Quickstart above the fold ahead of section #10 Recovery, and completed RU localization & contrast upgrades on `/passport`.
- **Detailed-Card Vertical Overlap, `1280×720` Ergonomics & Dark Cockpit Calm (`openrig/assets/domain/topology-layout.js`, `openrig/assets/ui/{topology-view,auto-consent-view}.js`, `openrig/assets/styles/deck.css`, `openrig/index.html`):**
  - Fixed vertical card overlap in `DETAILED` (`!compact`) mode across multi-rig clusters (accurate detailed card heights + `enforceHardClearance` post-pass) and eliminated `1280×720` node-border & spline-over-metric collisions.
  - Collapsed the `/demo` Mini-Quest dock by default (still accessible via `🎯 10s Mission`), raised critical operational Fitts targets, fixed `1280×720` P2 triage card right-edge clipping and duplicate P1 ETA text, muted routine node neon glow and replaced decorative heart badges with calm status dots, kept `#btnAutoConsentTop` directly accessible, and moved `#autoConsentInspectorRoot` below the primary node header/diagnosis card.
- **Test Verification:** Expanded automated test coverage to **`349 / 349 PASS` across `41` test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

---

## [3.8.1] - 2026-11-26

### Added
- **Public Tier-1 Agent Skill (`skills/rig-commander-mission-control/SKILL.md`, `references/{operator-runbook,safety-boundaries}.md`, `scripts/audit-exposure.mjs`, `tests/agent-skill.test.mjs`, `README.md`):**
  - Published `agentskills.io` / `npx skills add Vedariy/rig-commander` standard skill package (excluded from npm CLI tarball) with verified CLI flags, L0–L3 triage loop, 2-step Crash-Cart recovery, fail-closed Auto-Consent guidance, and permanent Tier-1 exposure audit coverage in `scripts/audit-exposure.mjs`.

### Fixed & Improved
- **Auto-Consent Ergonomics, Safe Test-Log Redirects & Scoped Worktree Conflicts (`openrig/assets/domain/auto-consent-model.js`, `openrig/assets/ui/auto-consent-view.js`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/i18n.js`, `openrig/index.html`, `openrig/server.mjs`):**
  - Replaced native modal checkboxes with accessible tactile pill toggle switches (`role="switch"`) featuring immediate apply, a 2.5s per-control cooldown updated in-place (preserving sibling focus/inputs and `0%` idle CPU), and an unblocked instant `⏸ PAUSE` kill-switch bypass.
  - Added a direct top-bar `#btnAutoConsentTop` button with live localized status badge, localized Guardrails modal status badge, clickable Seat Inspector `Off → Enable` chip, inline master-OFF & Dry-Run CTAs, and uniform 2-row project policy cards.
  - Allowed safe single trailing `.log`/`.txt`/`.out` redirection (with optional `2>&1`) on recognized read-only/test/lint/build commands strictly inside `trusted_dev` while keeping `safe_readonly` zero-metacharacter and blocking traversal/dotfile/system/secret paths.
  - Fixed `hasWorktreeConflictForSeat` to scope against real `gitRadar.workspaces[].seatIds` & `unmergedWorkspaces`, ignore non-unmerged `AGENTS.md`/`CLAUDE.md` overlays, and permit single read-only/test commands on non-unmerged code overlaps while still escalating hard merge conflicts and mutating edits/commits.
- **Test Verification:** Expanded automated test coverage to **`333 / 333 PASS` across `40` test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

---

## [3.8.0] - 2026-11-26

### Added
- **Iteration 10 — Scoped Opt-In Auto-Consent Policy Engine (Pure Domain, `openrig/assets/domain/auto-consent-model.js`, `openrig/lib/ai-evaluator/expert-rules.mjs`, `openrig/assets/domain/i18n.js`):**
  - Added a pure, zero-DOM Auto-Consent policy domain sharing destructive command vetoes and the read-only classifier with `expert-rules.mjs`, plus 61 matching EN/RU localization keys.
  - Enforced fail-closed `OFF / dry_run` defaults, 4-level scope inheritance (`masterPaused > SessionGrant > Agent > Project > Global`) with `manual_only` deny-wins precedence, the Option-1-Only gate, the Permission-vs-Question gate, context-overheat auto-pause, and conservative `trusted_dev` escalation for package installs and external network access by default.
- **Runtime Engine, TOCTOU Grace Window & Kill-Switch (`openrig/lib/auto-consent-engine.mjs`, `openrig/lib/routes/auto-consent.mjs`, `openrig/lib/telegram-bridge.mjs`, `openrig/server.mjs`):**
  - Added the runtime Auto-Consent engine with a configurable 3s countdown grace window, live TMUX re-capture and `sha256` `promptHash` drift verification, live `tmux:%pane:pid` epoch binding, atomic synchronous quota/rate reservation, `0600` local policy persistence (with strictly RAM-only session grants), and `0%` idle CPU.
  - Added SSE push events (`auto_consent_state`, `auto_consent_pending`, `auto_consent_resolved`), authenticated `/api/auto-consent/*` endpoints sharing single-flight send locking with manual `/api/send`, and the authorized Telegram `/pause_auto` kill-switch.
- **Modular Deck UI, Offline `/demo?track=auto-consent` & Tier-1 Operator Guide (`openrig/assets/ui/auto-consent-view.js`, `openrig/assets/styles/deck.css`, `openrig/index.html`, `landing/guide.html`):**
  - Added the active HUD Auto-Consent status pill with 1-click `⏸ PAUSE`, a 3s cancelable countdown toast, the Guardrails `⚡ Auto-Consent` settings & redacted audit tab, Seat Inspector policy picker, and HITL `⚡ Allow + Trust Session 60m` action.
  - Added an interactive offline `/demo?track=auto-consent` tour firing `0` live `/api/*` requests and a bilingual EN/RU Tier-1 Auto-Consent operator guide section in `landing/guide.html`.
- **Test Verification:** Expanded automated test coverage to **`322 / 322 PASS` across 39 test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

---

## [3.7.0] - 2026-11-26

### Added
- **Offline `/demo` First-Impression Polish & Bilingual Sandbox Parity (`openrig/index.html`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/i18n.js`, `openrig/assets/ui/topology-view.js`):**
  - Replaced alarmist offline indicators with a calm sandbox badge and direct Back-to-site link (`#demoBackLink`), non-overlapping Mini-Quest placement, collapsed swimlanes by default, default `dev-check` QA selection in Dynamic layout with hidden sleepers, and a compact triage tools drawer (including separated mobile triage controls).
  - Upgraded offline fixtures with realistic multi-harness agent pairings, full EN/RU localization across live language round-trips (including sandbox send fallbacks and clipboard-only `Cmd` toasts), and strict client-side enforcement firing `0` live API or remote discovery calls.
- **Landing AI-Bot / GEO Discovery & Structured Metadata (`landing/llms.txt`, `landing/llms-full.txt`, `landing/robots.txt`, `landing/sitemap.xml`, `landing/{index,guide,passport}.html`, `vercel.json`, `scripts/sync-public.mjs`, `scripts/audit-exposure.mjs`):**
  - Published bilingual `llms.txt` and `llms-full.txt` operator references, an Open-All `robots.txt` excluding the duplicate `/deck` alias, and a canonical 6-URL `sitemap.xml`.
  - Added `Schema.org` JSON-LD (`SoftwareApplication`/`SoftwareSourceCode`, `HowTo`, `FAQPage`, `TechArticle`, `WebSite`), canonical links, `<noscript>` quickstart fallback, and `vercel.json` discovery headers (`Link` alternate to `/llms.txt`, UTF-8 text/XML `Content-Type`, and `X-Robots-Tag: noindex, follow` scoped strictly to `/deck`).
  - Added deterministic `{{APP_VERSION}}` version synchronization in `scripts/sync-public.mjs` and expanded Tier-1 `npm run audit:exposure` checks across `llms.txt` and `llms-full.txt`.
- **CALM: ON Quiet-Cluster Auto-Minimization Dock & Multi-Rig HUD Top Clearance (`openrig/assets/domain/topology-layout.js`, `openrig/assets/ui/topology-view.js`, `openrig/assets/styles/deck.css`, `openrig/index.html`):**
  - Added `classifyQuietRigClusters()` and the docked `#quietClustersPill` bar so quiet and parked-only rig clusters auto-minimize in `CALM: ON` multi-rig view with clickable per-rig expand chips and preserved parked work-count badges, while always keeping active, urgent, hot-context, shell-exited, and selected rigs visible and never blanking the canvas.
  - Added multi-rig top-HUD clearance (`padTop = 36`) so top-row rig cluster headers never collide with floating HUD controls.

### Fixed
- **Guardrails Modal Input Width & Telegram Status Pill (`openrig/assets/styles/deck.css`, `openrig/assets/ui/guardrails-view.js`):**
  - Fixed `.ctrl-input` width collapse inside Guardrails configuration rows and kept the Telegram bridge status pill cleanly on a single line.
- **Live TMUX Verification of Daemon `needs-input` & Narrow Codex Ready Footer (`openrig/server.mjs`, `openrig/assets/domain/prompt-parser.js`):**
  - Live-verified daemon-reported `needs-input` states against actual `tmux` pane capture so stale `permission_request_unverified` projections clear automatically when the agent is idle at prompt, and detected narrow-pane wrapped Codex `Ready` footers.
- **Live-Verified Idle Fallback on Stale OpenRig Send Refusals (`openrig/server.mjs`, `openrig/assets/domain/prompt-parser.js`):**
  - Added `hasDirtyTerminalInputBox()` unsent-draft protection and a live-screen-verified idle fallback when OpenRig refuses `rig send` due to a stale interactive-prompt projection, while strictly returning `409` whenever unsent draft text, a real HITL prompt, or a bare OS shell is detected.
- **Test Verification:** Expanded automated test coverage to **`275 / 275 PASS` across 36 test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

---

## [3.6.0] - 2026-11-26

### Added
- **Lean MIT Fleet Resilience & 3-Port Extension Boundary (`openrig/assets/domain/resilience-model.js`, `openrig/lib/resilience/*`, `openrig/lib/routes/resilience.mjs`):**
  - Added pure advisory outage classification (`healthy`, `seat_exited`, `rig_down`, `daemon_down`), OpenRig SQLite UTC snapshot table parsing (`parseSnapshotTable`), sleep/wake wall-clock jump detection, per-host manifest envelope merging (Lamport clock + SHA-256 deterministic tie-breaker), and 2-step plan/receipt models.
  - Added thin, extensible `ProcessRecoveryProvider` & `StateVaultAdapter` interfaces alongside `OpenRigResilienceProvider` and atomic `0600` `LocalFsVaultAdapter` (`hosts/<hostId>/` partitions, optional `--state-dir` / `RIGCOMMANDER_STATE_DIR`).
  - Added centralized `RecoveryPolicyGate` enforcing strict 2-step human confirmation via single-use SHA-256 `planHash` (5-minute TTL, TOCTOU pre-execute revalidation, per-target `409` single-flight mutex, intentional-stop protection, honest `restored | partial | failed | unknown` receipts, and zero silent auto-resurrection).
  - Wired `/api/resilience/{status,plan,resurrect,snapshot}` routes and non-destructive sleep/wake SSE + Telegram advisories in `openrig/server.mjs` while keeping `0%` idle CPU and `"dependencies": {}`.
- **Capability-Driven Crash-Cart & WakeUp Modular UI + Offline Tour (`openrig/assets/ui/resilience-view.js`, `openrig/assets/styles/deck.css`, `openrig/index.html`, `landing/guide.html`):**
  - Added capability-gated Crash-Cart banner (hidden when healthy, collapsible on `rig_down`, always expanded on `daemon_down`), truthful Local Vault / snapshot freshness badges, 2-step Plan Preview modal with exact command preview & clipboard fallback, and offline `/demo?track=resilience` simulation firing zero live API calls.
  - Added Tier-1 EN/RU operator recovery section to `landing/guide.html`.

### Fixed
- **Handoff Lineage Chip Routing (`openrig/assets/ui/inspector-view.js`):**
  - Routed `handedOffFrom` / `handedOffTo` chips by reference type so seat addresses (`dev-check@rig-commander`) render cleanly as clickable `↘ dev-check` seat selectors instead of sliced suffixes (`↘ ommander`), while `qitem-*` IDs open queue lineage details.
- **Test Verification:** Expanded automated test coverage to **`262 / 262 PASS` across 34 test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

---

## [3.5.1] - 2026-11-26

### Fixed
- **Cubic Bezier Arrowhead Alignment & Fixed-Scale Notched Markers (`openrig/assets/domain/topology-layout.js`, `openrig/assets/ui/topology-view.js`, `openrig/index.html`):**
  - Added a collinear straight landing runway (`p2Lead → p2`, 11–16 px) to orthogonal S-curves and obstacle/parallel Bezier paths so incoming live streams align 100% with the arrowhead axis instead of entering at a sideways angle.
  - Trimmed wide translucent `.edge-trunk` paths (`trunkPathD`) back into the arrow notch and capped live `trunkWidth <= 9 px` so thick trunks never protrude past arrowheads.
  - Switched all SVG `<marker id="arr-*">` definitions to `markerUnits="userSpaceOnUse"` (`18×18` notched silhouette) so arrowheads stay crisp and proportional across all traffic volumes (`223 / 223 PASS`, `EXPOSURE_AUDIT_PASS`).

---

## [3.5.0] - 2026-11-26

### Added
- **Zero-Build UI & BFF Modularization — Phase 2 (`openrig/assets/ui/topology-view.js`, `openrig/assets/ui/inspector-view.js`, `openrig/lib/routes/{telemetry,guardrails,playbooks,git-shift}.mjs`):**
  - Completed full extraction of Topology / Swimlanes / Route X-Ray and Seat Inspector / Diagnosis / Live TMUX modal renderers out of `openrig/index.html` (~2,700 lines extracted across Iteration 6) into zero-dependency native ES modules with dedicated unit test suites.
  - Extracted BFF API routes into four focused route registries (`telemetry`, `guardrails`, `playbooks`, `git-shift`) with real loopback HTTP integration tests and safe HTTP keep-alive drain handling after `413` oversized bodies.
- **Multi-Rig Spatial Clustering, Variable-Width Shelf Packing & Adaptive Cubic Bezier Highways (`openrig/assets/domain/topology-layout.js`, `openrig/assets/ui/topology-view.js`):**
  - Partitioned active multi-rig fleets into labeled spatial cluster zones (`@<rig> · N`) stripping redundant `@<rig>` suffixes from both card titles and role subtitles inside zones while preserving full seat IDs in tooltips.
  - Added **Variable-Width Shelf Packing** with per-row optimal heights and a sub-millisecond deterministic readability scorer (`evaluateClusterReadability`) that automatically wraps wide/dense pods onto full-width rows with zero horizontal overflow or card-border escapes.
  - Added **Adaptive Cubic Bezier Edge Routing (`computeAdaptiveEdgePath`)**: strict straight lines on clean axes and unobstructed ghost links, smooth 90°-port orthogonal S-curves on active diagonals, normal-vector detour around obstacle cards, symmetric dual-lane separation for bidirectional `A ↔ B` pairs, and exact on-curve `B(0.5)` badge anchors.
  - Added Dynamic `[1, 3, 1]` upward middle-apex arch preservation and scroll-aware Route X-Ray viewport clamping.
- **Zero-Blind-Click HITL Command Preview & Modal Scroll Fidelity (`openrig/assets/domain/prompt-parser.js`, `openrig/assets/ui/inspector-view.js`, `openrig/index.html`):**
  - Surfaced exact redacted command previews on HITL confirmation buttons (Antigravity, Codex, Claude, `[Y/n]`), forced bottom-scroll alignment on modal open while preserving user scrollback/drafts/focus during live SSE refreshes, and verified desktop/mobile modal flows.
- **Honest Highway Semantics, Shell-Exit Triage Priority, Per-Rig Health & Stale-Tab Pill (`openrig/assets/domain/edge-state.js`, `openrig/assets/ontology/actions.js`, `openrig/lib/fleet-intelligence/advisory.mjs`):**
  - Eliminated fake green animated arrows between idle/parked seats; resting high-volume pairs render thin static trunks while live work streams honestly.
  - Prioritized bare-shell exits (`⚠ SHELL`) ahead of moderate context warnings in the Top-3 Triage Strip, exposed per-rig health score breakdowns (`rigHealthById`), and added a 1-click reload pill when a browser tab falls behind a restarted bridge version.
- **Compact & Collapsible Slice Swimlanes (`openrig/assets/ui/topology-view.js`, `openrig/assets/styles/deck.css`, `openrig/assets/domain/preferences.js`):**
  - Compacted desktop swimlane rows (~41 px single-line stages with EN/RU labels) and added a persistent 1-click collapse toggle (`swimlanesCollapsed`) turning the section into a 33 px inline-chip summary strip (`● slice · 5/6`) that reclaims ~180 px of vertical canvas height.

### Fixed
- **Runtime-Driven Pi Guard & Real OpenRig CLI Relaunch Command (`openrig/assets/ontology/actions.js`, `openrig/server.mjs`, `openrig/lib/fleet-intelligence/detectors/context-entropy.mjs`):**
  - Removed legacy `coder3` seat-name hardcodes across UI actions, `/api/send` `/compact` guard, and `ContextEntropyDetector` so Codex/Claude seats named `dev-coder3` get native `⚡ /compact` while genuine `runtime: 'pi'` seats remain protected.
  - Replaced non-existent `rig restart <seat>` clipboard payloads everywhere with the verified OpenRig CLI command `rig seat launch <seat> --fresh --stop --reason "..."`.
- **Docked Idle-Collapsed Bar & Live SSE Reconnect Debounce (`openrig/index.html`, `openrig/assets/styles/deck.css`):**
  - Docked `#idleCollapsedPill` cleanly below the topology canvas so hidden-sleeper summaries never overlap bottom cards or scrolled clusters.
  - Debounced transient `/api/telemetry` fetch blips while `LIVE SSE` is connected so the header no longer flashes a false `SNAPSHOT MODE` banner.
- **Test Verification:** Expanded automated test coverage to **`223 / 223 PASS` across 31 test suites** (`npm test`) with `EXPOSURE_AUDIT_PASS`.

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
