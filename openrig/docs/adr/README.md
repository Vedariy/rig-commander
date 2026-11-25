# Архитектурные решения (ADR) — OpenRig Neural Command Deck

В этом разделе фиксируются фундаментальные архитектурные решения по дашборду **OpenRig Neural Command Deck**.

Каждое решение оформляется отдельным документом по стандарту:
`Контекст и проблема` ➔ `Рассмотренные альтернативы` ➔ `Принятое решение` ➔ `Последствия (плюсы, минусы, ограничения)`.

Решения не переписываются задним числом. Если решение меняется или устаревает, создаётся новый ADR со ссылкой на старый, а старый получает статус `[SUPERSEDED]`.

---

## Реестр архитектурных решений

| ADR | Статус | Название | Ключевой смысл |
|---|---|---|---|
| [0001](0001-pure-vanilla-svg-architecture.md) | `[ACCEPTED]` | Pure Vanilla JS + SVG Canvas (Zero-Build) | Отказ от React, Vite и бандлеров: мгновенный старт, нулевые зависимости, надёжная работа прямо из файловой системы. |
| [0002](0002-three-tier-telemetry-bridge.md) | `[ACCEPTED]` | Трёхзвенный мост телеметрии (`server.mjs`) | Лёгкий Node.js-прокси связывает веб-страницу с демоном OpenRig (`:7437`), очередью `rig queue` и буфером `tmux`. |
| [0003](0003-in-place-dom-mutations.md) | `[ACCEPTED]` | In-place DOM Patching при автообновлении | Точечные мутации атрибутов DOM-узлов и SVG-путей каждые 4с вместо полного перерендера: сохранение фокуса, скролла и анимаций. |
| [0004](0004-secure-local-control-plane.md) | `[ACCEPTED]` | Безопасность командного интерфейса (`/api/send`) | Защита от CSRF-атак из браузера: строгая валидация `Origin`, отказ от wildcard CORS и одноразовый per-process токен `X-Deck-Token`. |
| [0005](0005-dynamic-rig-topology-discovery.md) | `[ACCEPTED]` | Динамический подхват актуальной топологии рига | Автоматическое обнаружение любых новых агентов контура (`ensureDynamicAgent`), расчёт связей (`ensureEdge`) и эвристика бесконфликтной расстановки по ярусам. |
| [0006](0006-action-first-visual-hierarchy.md) | `[ACCEPTED]` | Action-First визуальная иерархия и триаж-стрип | Перестройка порядка чтения: стрип «Топ-3 внимания» в шапке, сегрегация «Живой полёт vs Архивные связи», прямые термобейджи на карточках нод. |
| [0007](0007-universal-rig-decoupling.md) | `[ACCEPTED]` | Универсальная отвязка от рига и архитектура @openrig/deck | Устранение хардкода: динамический Seat Guidance из манифестов рига, адаптивные пулы квот моделей, отказоустойчивость путей и автономный CLI-пакет. |
| [0008](0008-harness-aware-command-dispatching.md) | `[ACCEPTED]` | Harness-Aware диспетчеризация команд и гигиена терминального ввода | Устранение проблемы склейки слэш-команд (`/compact/compact`), очистка строки `C-u`, дедупликация токенов, адаптивные клавиатуры под Codex, Claude, Pi и AGY. |
| 0009 | `[INTERNAL]` | Fleet Intelligence & Advisory Engine | *Спецификация алгоритмов и формул детекторов перенесена в закрытую документацию (`.private-docs/`).* |
| [0010](0010-control-plane-idempotency-remote-pwa-and-self-update.md) | `[ACCEPTED]` | Идемпотентность управления, защищённый Live Mobile PWA и самообновление | `ActionFlightGuard` + `ServerIdempotencyCache` (`X-Idempotency-Key` / `409`), динамический Live PWA с QR+PIN и SHA-256 cookie, `SelfUpdater` с безопасным рестартом `exit 75`. |
| [0011](0011-adaptive-graph-seat-diagnosis-and-sublane-gantt.md) | `[ACCEPTED]` | Адаптивный граф, действенный диагноз узла и поддорожечный Гант + Handoff Flow | Режимы графа `Динам/Фикс` (`topology-layout.js`), 6-цветная термошкала в единой карточке, петля Триаж → `SeatDiagnosis` (`nudge_queue`), поддорожечный Гант и хронологический `Handoff Flow` (`gantt-model.js`). |
| 0012 | `[INTERNAL]` | 3-Tier Advisory AI Evaluator | *Внутренняя R&D-спецификация каскада, эвристик, промптов и центроидов перенесена в закрытую документацию (`.private-docs/`).* |
| [0013](0013-git-worktree-and-conflict-radar.md) | `[ACCEPTED]` | Радар Git Worktree, кросс-конфликтов и Read-Only Diff | Унификация linked worktrees и отдельных клонов по `repoKey`, 12s SWR + `gitRadarRev` (0 ms деградации `/api/telemetry`), Detector #7 (`GitConflictDetector`), L1-сигнал конфликтов, L2 `#inspGitWorktree`, L3 `#gitDiffModal` с `SecretRedactor` и вкладка `🌿 Worktrees`. |
| [0014](0014-shift-catchup-digest-and-jsonl-history.md) | `[ACCEPTED]` | Сводка смены (Shift Catch-Up Digest) и персистентная JSONL-история | Неблокирующий append-only журнал `~/.config/rig-commander/shift-events.jsonl` (`0600`, `SecretRedactor`, атомарная компакция), edge-triggered переходы состояний, `GET /api/digest`, сводка за `1ч/4ч/8ч/24ч` и «с последнего визита» + экспорт в Markdown. |
| [0015](0015-command-palette-and-safe-queue-triage.md) | `[ACCEPTED]` | Палитра команд (⌘K) и безопасный триаж очереди | Zero-dep fuzzy-палитра со скоупами `> @ # /`, MRU и подсветкой; классификация зависших передач (HITL/shell/parked/orphan/stale/blocked/stuck) без деструктивных мутаций очереди, один защищённый `nudge_queue` на сиденье и двухшаговое подтверждение любой записи. |
| [0016](0016-sse-push-and-live-tmux-streaming.md) | `[ACCEPTED]` | SSE Push Stream (`/api/events`) и живой TMUX-стриминг | Zero-dep `SsePushHub` с SHA-1 дедупликацией флота и экранов TMUX (`650ms -> 1500ms` адаптивный backoff, мгновенный re-capture после `/api/send`, 0% idle CPU, автооткат на polling). |
