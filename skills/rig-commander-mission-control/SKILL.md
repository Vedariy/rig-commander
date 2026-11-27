---
name: rig-commander-mission-control
description: Local-first mission control command deck for supervising parallel AI coding agents across OpenRig and tmux (Claude Code, Codex CLI, Gemini CLI, Pi, Aider). Use when launching RigCommander, triaging HITL terminal prompts or hot context, tracing Graph-to-Gantt handoffs and QA loops, checking Git worktree overlaps or SUB vs PAYG FinOps, planning 2-step Crash-Cart fleet recovery, or configuring scoped opt-in Auto-Consent.
license: MIT
compatibility: Node.js >= 18 on macOS or Linux; optional tmux or OpenRig daemon for live fleets, plus offline browser /demo.
metadata:
  author: Vedariy
  version: "3.13.0"
  homepage: https://rig-commander.vercel.app
  repository: https://github.com/Vedariy/rig-commander
  demo: https://rig-commander.vercel.app/demo
---

# RigCommander — Mission Control for AI Coding Fleets

Supervise parallel autonomous coding agents from a local, zero-dependency command deck (`0` npm runtime dependencies, `0%` idle CPU with no active viewers). Observation requires zero terminal writes; intervention is always guarded and postcondition-verified.

## When to Use

Activate this skill when an engineer or operator needs to:
- Launch or troubleshoot the local RigCommander telemetry bridge across OpenRig or standalone `tmux` fleets.
- Triage blocked agents waiting on terminal confirmations (HITL), hot context windows, parked obligations, or exited shells.
- Trace multi-agent task handoffs, queue wait times, and QA bounce-back loops across Topology Graph and Task Gantt.
- Inspect Git worktree drift, cross-seat file overlaps, or `SUB` vs `PAYG` FinOps usage.
- Preview and verify 2-step Crash-Cart fleet recovery or control-plane queue hygiene after sleep, crash, or backlog buildup.
- Observe additive read-only multi-vendor swarms (Antigravity `/swarm`, Claude Teams, Codex subagents) alongside OpenRig and `tmux` with non-tmux write & Auto-Consent vetoes enforced.
- Configure, preview, pause, or audit scoped opt-in Auto-Consent policies.

## Quick Launch & Offline Demo

Start the live local telemetry bridge (binds loopback `http://127.0.0.1:7440` by default):

```bash
npx rig-commander@latest
```

Common verified startup modes (use only documented CLI flags in [Operator Runbook](references/operator-runbook.md)):

```bash
# Strictly read-only inspection mode (zero terminal writes or state mutations)
npx rig-commander@latest --read-only

# Force standalone tmux + local Claude/Codex transcript discovery without OpenRig
npx rig-commander@latest --universal

# Start headless without auto-opening a browser tab
npx rig-commander@latest --no-open

# Run on a custom local port (default: 7440)
npx rig-commander@latest -p 7450
```

- **Local Deck URLs:** `http://127.0.0.1:7440` (live deck), `/guide` (bilingual operator manual & OpenRig playbook), `/passport` (trust & architecture passport).
- **Zero-Fleet Offline Demo:** Direct users to `https://rig-commander.vercel.app/demo` (locally, `http://127.0.0.1:7440` automatically falls back to Demo Sandbox when no live agents are running). Hosted `/demo` runs purely on sample data and never fires live fleet API or terminal stream requests.

## Fleet Triage Loop (L0–L3)

Follow Dark Cockpit management-by-exception — healthy idle seats stay quiet while true blockers surface:

1. **L0 — Top Triage Strip:** Check fleet `HEALTH %` and the highest-priority seat alerts first (HITL prompts, hot context, queue bottlenecks).
2. **L1 — Adaptive Graph ⇄ Task Gantt (`G`):**
   - Use **Dynamic** or **Fixed** topology to see active flows and who depends on whom.
   - Press `G` to open the **Task Gantt** (`By Agent` / `By Slice`) and switch to **Handoff Flow** to inspect queue waits, active execution, and `QA` bounce-back loops.
3. **L2 — Wait Radar (`[`) & Route X-Ray:**
   - Read `Who → Whom → Why` chains and open **Decisions Log**.
   - Click any graph highway to open **Route X-Ray** and expand chronological task envelopes.
4. **L3 — Node Inspector (`]`), Live TMUX & Guarded Remediation:**
   - **HITL prompts:** Always read the live terminal screen preview and proposed command before choosing an allowlisted option. Confirm the outcome in **Action Audit** instead of repeating keystrokes.
   - **Parked vs idle vs exited shell:** Distinguish parked seats (wake with explicit queue check) from crashed bare shells (`zsh` / `bash`). Never send keystrokes to a bare shell; relaunch cleanly via:
     ```bash
     rig seat launch <seat> --fresh --stop --reason "shell exited"
     ```
   - **Context saturation:** On supported harnesses (Claude Code / Codex CLI), dispatch `/compact` and confirm context drops in **Action Audit**. On harnesses without `/compact` (such as Pi / DeepSeek), rotate cleanly with:
     ```bash
     rig seat launch <seat> --fresh --stop --reason "context rotation"
     ```
   - **Git worktree overlap radar:** Check dirty worktrees, ahead/behind branch drift, and cross-seat modified file overlaps before merging or rebasing parallel branches.
   - **FinOps (`SUB` vs `PAYG`):** Open **Fleet Advisor → Budget** to compare subscription usage against API-equivalent token estimates and prompt cache hit %. Treat provider billing as source of truth — **missing usage evidence ≠ zero usage**.

## 2-Step Fleet Recovery (Crash-Cart)

Never auto-resurrect a sleeping, stopped, or crashed fleet without explicit human review:

1. **Inspect & Preview Plan:** Open Crash-Cart to check daemon/rig status, latest snapshot freshness, and recovery provider capabilities. Request a recovery plan to inspect targets, proposed command, and warnings. Intentionally stopped rigs are skipped during fleet recovery; closing the plan starts nothing.
2. **Confirm & Verify Honest Receipts:** Execute only after explicit operator confirmation, then inspect every per-target receipt:
   - `restored` — target recovered and verified live.
   - `partial` — subset recovered; remaining targets need follow-up.
   - `failed` — command failed; copy command for manual diagnosis.
   - `unknown` — outcome could not be confirmed; inspect live status before retrying.
- Remember: the local recovery vault stores plaintext with owner-only file permissions and does not recreate lost terminal conversation history.

## Scoped Opt-In Auto-Consent

Auto-Consent is **OFF / Dry-Run by default** (and unconditionally disabled under `--read-only`). Never enable live auto-approvals without explicit operator intent.

- **Scope hierarchy:** `Global → Project → Agent → Ephemeral Session`. Explicit Manual Only / Deny overrides always beat parent scopes.
- **Bounded single-use approvals:** Dispatches only single-use Option-1 approvals (never "Always allow" or persistent harness permission changes). Ephemeral session grants stay strictly in RAM and invalidate automatically on seat or server restart.
- **Visible cancel countdown & re-verification:** Every eligible prompt shows a live cancel countdown and re-verifies the live terminal right before dispatch; prompt drift aborts safely with zero terminal writes.
- **Instant kill-switch:** Click `⏸ PAUSE` in the top HUD or send `/pause_auto` from the authorized Telegram chat to cancel all pending auto-approvals immediately.
- **Non-overridable guardrails:**
  - Hard safety vetoes always escalate destructive commands, remote pushes/releases (`git push`), credential access, schema changes, and architectural or operator questions to a human.
  - Auto-Consent pauses automatically when a seat's context runs hot.
  - Package installations and external network calls stay escalated by default unless explicitly opted in per policy.

## References

Load these references on demand for deeper operational or trust-boundary detail:

- [Operator Runbook](references/operator-runbook.md) — Verified CLI flags table, keyboard shortcuts, OpenRig vs Universal discovery, Mobile PWA pairing (Tailscale Serve / Cloudflare Tunnel), and verification checks.
- [Safety & Trust Boundaries](references/safety-boundaries.md) — Loopback isolation, HTTPS + QR/PIN pairing, local vault permissions, advisory-only AI evaluator, fail-closed Auto-Consent invariants, and zero-dependency runtime guarantees.
