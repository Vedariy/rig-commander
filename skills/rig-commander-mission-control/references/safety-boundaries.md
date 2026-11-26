# RigCommander Safety & Trust Boundaries

Public trust model and non-overridable safety guarantees for operating RigCommander locally and over paired HTTPS tunnels.

## Loopback-First & Authenticated Control

- **Loopback default:** The local bridge binds strictly to `127.0.0.1` by default — unreachable from LAN or external networks.
- **No cloud dependency:** Live fleet observation requires no cloud account and performs no default external telemetry uploads.
- **Observation without writes:** Reading topology, Gantt timelines, worktree status, FinOps, and Fleet Advisor recommendations never writes to agent terminals.
- **Strict `--read-only` inspection mode:** Starting RigCommander with `--read-only` enforces a server-wide write block across all mutating control endpoints, forces Auto-Consent disabled, and prevents automated terminal interrupts while keeping read-only telemetry, diffs, and live screen inspection fully functional.
- **Guarded write-back:** Control requests require per-process session authentication, strict `Origin` checks, duplicate-send protection, and allowlisted `tmux` keystrokes (preventing flag injection and double-sends).

## Remote Mobile PWA & Telegram Boundaries

- **Explicit HTTPS + pairing:** Remote phone access requires an external HTTPS tunnel (Tailscale Serve or Cloudflare Tunnel) combined with RigCommander's single-use QR and pairing PIN.
- **Fail-closed remote gate:** Unpaired remote clients are rejected without leaking live fleet telemetry or control tokens.
- **Brute-force lockout & 1-click revoke:** Repeated wrong pairing attempts invalidate the challenge; paired sessions use `HttpOnly; Secure` cookies, store only hashed session records locally with owner-only file permissions, and can be revoked globally in one click.
- **Authorized Telegram chat only:** The optional Telegram HITL bridge ignores unauthorized chats, uses single-use inline approval callbacks, and supports remote `/pause_auto`, `/status`, `/budget`, `/stop <seat>`, and `/arm_breaker`.

## Local Storage, Plaintext Vault & Redaction

- **Owner-only plaintext vault:** Local recovery manifests, shift history, and config files use owner-only OS file permissions and are stored in **plaintext** (not encrypted at rest). Rely on full-disk encryption and host OS account security.
- **Automatic secret redaction:** API keys, tokens, private key blocks, and personal local file paths are scrubbed before persisting shift logs or calling any optional evaluator.
- **Privacy-safe exports:** Live Daily Fleet Receipt (Share Card) exports anonymize rig and seat names by default.

## Advisory-Only AI Evaluator & Guardrails

- **Strictly advisory:** The optional multi-tier AI Evaluator provides recommendations only and never auto-executes terminal commands.
- **Deterministic veto priority:** Non-overridable safety rules always take precedence over model recommendations.
- **Budget & rework circuit-breaker:** Operator-configured spend and QA-rework caps can alert or pause runaway work according to chosen policy.

## Fail-Closed Auto-Consent Invariants

- **Off / Dry-Run by default:** Live auto-approval is never active until explicitly opted in and armed by the operator.
- **Deny-wins scope hierarchy:** `Global → Project → Agent → Ephemeral Session`; an explicit Manual Only override on a project or seat is never bypassed by a parent scope.
- **Single-use Option-1 only:** Never selects persistent "Always allow" options or modifies harness permission files, keeping revocation immediate.
- **RAM-only ephemeral grants:** Time- and count-bounded session grants live strictly in memory and auto-invalidate on seat restart or bridge restart.
- **Countdown + live re-verification:** Every eligible prompt shows a visible cancel countdown and re-verifies the live terminal right before dispatch, aborting with zero writes if the prompt changed.
- **Hard vetoes & thermal pause:** Destructive commands, remote pushes/releases, secret access, schema changes, and operator questions always escalate to a human; hot context automatically pauses Auto-Consent for that seat; package installs and external network calls stay escalated by default.
- **Instant global pause:** Top-HUD `⏸ PAUSE` and Telegram `/pause_auto` immediately halt all pending auto-approvals.

## Runtime & Supply-Chain Footprint

- **Zero npm runtime dependencies:** Built exclusively on Node.js `>= 18` standard ESM modules (`"dependencies": {}`).
- **Idle-silent execution:** `0%` background CPU target for telemetry polling when no active clients are connected.
- **Isolated offline demo:** `/demo` never issues live fleet telemetry or terminal stream requests.
