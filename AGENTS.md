# AGENTS.md — RigCommander (`rig-commander`)

Engineering rules and documentation boundaries for all agents and contributors working in this repository.

## 1. Core Architectural Invariants
- **Zero npm dependencies:** `"dependencies": {}` in `package.json`. Use Node.js `>= 18` built-in ESM modules only.
- **Zero-Build Frontend:** Native ES modules in `openrig/assets/domain/` (pure, zero DOM/`window` coupling, directly importable in `node --test`) and `openrig/assets/ontology/`.
- **Single Source of Truth:** Edit only `openrig/` and `landing/`. Never hand-edit generated files in `public/`, `openrig/guide.html`, or `openrig/passport.html` — regenerate them deterministically via `npm run sync:public`.
- **EN / RU Parity:** Every user-facing string in the Deck (`openrig/assets/domain/i18n.js`), Landing (`landing/index.html`), Guide (`landing/guide.html`), and Passport (`landing/passport.html`) must ship with matching English and Russian copy.
- **Idle-Silent & Non-Blocking:** `0%` background CPU when no active clients are connected; offline `/demo` must never fire live `/api/events` or `/api/capture/stream` requests.
- **ACTION BUTTON HONESTY RULE (HARD UX INVARIANT):** Кнопки, на которых написано действие и нет явного суффикса `Cmd` со значком копирования (`📋`), **НИКОГДА НЕ ДОЛЖНЫ** копировать команду терминала в буфер обмена — они обязаны выполнять реальное действие внутри приложения (или открывать интерактивный модал/план выполнения). Any button labeled as an action without an explicit `Cmd 📋` copy suffix MUST NEVER copy a CLI command to the clipboard.

## 2. Three-Tier Documentation & Exposure Boundary
This repository is **public (MIT Open Source)** and powers both the static showcase (`https://rig-commander.vercel.app`) and the npm CLI (`npx rig-commander@latest`). Follow this strict separation:

1. **Tier 1 — Public Product Showcase (`landing/` → `public/` on Vercel):**
   - Audience: engineers evaluating or operating RigCommander.
   - Allowed: product capabilities, C4 Level 1–2 trust boundaries, security & privacy guarantees, OpenRig CLI Playbook, user guides, summary verification status.
   - **Forbidden on `landing/` & `public/`:** internal file trees (`assets/domain/*`, `lib/ai-evaluator/*`, `tests/*.test.mjs`), internal symbol names, exact brute-force attempt thresholds, raw HTTP deduplication codes, internal wire protocols, or code-level predicate dumps.
2. **Tier 2 — Open-Source Engineering Docs (`openrig/docs/`, GitHub only, excluded from `public/` and npm tarball):**
   - Audience: contributors, security auditors, and agents working on the core bridge & UI.
   - Contains: `openrig/docs/architecture.md`, `openrig/docs/openrig-playbook.md`, core ADRs (`0001–0008`, `0010`, `0011`, `0013–0016`), and contributor guides.
   - **Strictly forbidden:** personal OS home directory paths, private commercial project names, internal CI/provider/VPN details, API keys, tokens, real production slice names, or deep R&D heuristic/evaluator/detector blueprints.
3. **Tier 3 — Private Companion Documentation (`.private-docs/`, gitignored):**
   - Audience: repository owner and private team only.
   - Contains: deep R&D specs & heuristics (`AI Evaluator` cascade/prompts/centroids, `Fleet Intelligence` detector formulas, `Safe Playbook Automation` / Iteration 5 specs, C4 Level 3 internal passport, cognitive load analyses, diligence reviews), commercial roadmap, pricing/GTM, private rig configs, provider quotas/keys, and future Team/Enterprise specs.
   - `.private-docs/` **must remain in `.gitignore`** and must never be tracked by Git or packaged into npm.

## 3. Mandatory Pre-Commit & Pre-Publish Verification Gate
Before committing or pushing any change:
```bash
npm run sync:public
npm test
npm run audit:exposure
```
All unit tests must pass (`0 fail`) and `npm run audit:exposure` must exit `0` (`EXPOSURE_AUDIT_PASS`).

- **Visual Concept Sign-Off Before Publish:** Before pushing or publishing any change that affects the visual concept (layout, hero framing, default `/demo` mode, navigation, modals, or design tokens), first show the user a local screenshot or live local preview URL (e.g., `http://127.0.0.1:7440`) and get explicit sign-off before `git push` / tagging / publishing.
