# AGENTS.md — RigCommander (`rig-commander`)

Engineering rules and documentation boundaries for all agents and contributors working in this repository.

## 1. Core Architectural Invariants
- **Zero npm dependencies:** `"dependencies": {}` in `package.json`. Use Node.js `>= 18` built-in ESM modules only.
- **Zero-Build Frontend:** Native ES modules in `openrig/assets/domain/` (pure, zero DOM/`window` coupling, directly importable in `node --test`) and `openrig/assets/ontology/`.
- **Single Source of Truth:** Edit only `openrig/` and `landing/`. Never hand-edit generated files in `public/`, `openrig/guide.html`, or `openrig/passport.html` — regenerate them deterministically via `npm run sync:public`.
- **EN / RU Parity:** Every user-facing string in the Deck (`openrig/assets/domain/i18n.js`), Landing (`landing/index.html`), Guide (`landing/guide.html`), and Passport (`landing/passport.html`) must ship with matching English and Russian copy.
- **Idle-Silent & Non-Blocking:** `0%` background CPU when no active clients are connected; offline `/demo` must never fire live `/api/events` or `/api/capture/stream` requests.

## 2. Three-Tier Documentation & Exposure Boundary
This repository is **public (MIT Open Source)** and powers both the static showcase (`https://rig-commander.vercel.app`) and the npm CLI (`npx rig-commander@latest`). Follow this strict separation:

1. **Tier 1 — Public Product Showcase (`landing/` → `public/` on Vercel):**
   - Audience: engineers evaluating or operating RigCommander.
   - Allowed: product capabilities, C4 Level 1–2 trust boundaries, security & privacy guarantees, OpenRig CLI Playbook, user guides, summary verification status.
   - **Forbidden on `landing/` & `public/`:** internal file trees (`assets/domain/*`, `lib/ai-evaluator/*`, `tests/*.test.mjs`), internal symbol names, exact brute-force attempt thresholds, raw HTTP deduplication codes, internal wire protocols, or code-level predicate dumps.
2. **Tier 2 — Open-Source Engineering Docs (`openrig/docs/`, GitHub only, excluded from `public/` and npm tarball):**
   - Audience: contributors, security auditors, and agents developing RigCommander itself.
   - Contains: `openrig/docs/architecture.md`, `openrig/docs/engineering-passport-internal.md` (C4 Level 3 & full test matrix), `openrig/docs/adr/0001..NNNN`, `openrig/docs/openrig-playbook.md`.
   - **Strictly forbidden:** personal OS home directory paths, private commercial project names, internal CI/provider/VPN details, API keys, tokens, or real production slice names.
3. **Tier 3 — Private Companion Documentation (`.private-docs/`, gitignored):**
   - Audience: repository owner and private team only.
   - Contains: commercial roadmap, pricing/GTM, private rig configs, provider quotas/keys, closed R&D notes, and future Team/Enterprise specs.
   - `.private-docs/` **must remain in `.gitignore`** and must never be tracked by Git or packaged into npm.

## 3. Mandatory Pre-Commit Verification Gate
Before committing or pushing any change:
```bash
npm run sync:public
npm test
npm run audit:exposure
```
All unit tests must pass (`0 fail`) and `npm run audit:exposure` must exit `0` (`EXPOSURE_AUDIT_PASS`).
