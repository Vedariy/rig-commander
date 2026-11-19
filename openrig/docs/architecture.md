# Как устроен и работает наш OpenRig (`core-platform`)

Ниже — живая карта вашего локального конвейера разработки на базе **OpenRig Daemon (`:7437`)**, собранная по текущей топологии (`rig ps`), очереди (`rig queue`) и правилам из [CULTURE.md](~/openrig-lab/core-platform/CULTURE.md) и [AGENTS.md](~/www/EnterpriseCore/cores/CorePlatform/core-platform/AGENTS.md).

---

## 1. Общая топология: Kernel + CorePlatform Pod

Вся система крутится вокруг демона OpenRig (`127.0.0.1:7437`), который связывает агентов в разных терминалах (`tmux`) через общую очередь задач **L3 Queue (`rig queue`)** и прямую отправку в терминал (`rig send`).

```mermaid
flowchart TB
    subgraph Human["👤 Человек (Оператор / Владелец продукта)"]
        U["Lead Operator (Intent, Decisions, Approvals)"]
    end

    subgraph Kernel["🧠 Rig: kernel (Управление и маршрутизация)"]
        OP_H["operator-human@kernel"]
        OP_A["operator-agent@kernel\n(Codex · gpt-6.1-sol)"]
        QW["queue-worker@kernel\n(Codex · gpt-6.1-sol)"]
        ADV["advisor-lead@kernel"]
    end

    subgraph SD["🚀 Rig: core-platform (Pod: dev)"]
        direction TB
        DEV_OP["🧭 dev-operator\n(Codex · gpt-6.1-sol)\nОбход каждые 15м (Watchdog)\nТребования, очередь, контекст"]
        OWNER["🏛️ dev-owner\n(Codex · gpt-6.1-sol / Claude)\nАрхитектор и Оркестратор:\nПостановка, Приёмка, Rebase & Push"]

        subgraph Coders["⚙️ Пул Кодеров (параллельные ветки / воркспейсы)"]
            C1["💻 dev-coder (Основной)\nClaude Code · glm-5.3-flash\ncwd: core-platform\nPW_PORT: 4173 / 5199"]
            C3["🔧 dev-coder3 (Резерв / Параллель)\nPi Coding Agent · z.ai\ncwd: core-platform-coder3\nPW_PORT: 4174 / 5200"]
            C4["⚡ dev-coder4 (Параллельный слайс)\nCodex · gpt-6.1-sol\ncwd: core-platform-coder4\nPW_PORT: 4175 / 5201"]
            C2["⏸️ dev-coder2 (Пилот на паузе)\nruntime: terminal"]
        end

        CHECK["🛡️ dev-check (Независимый QA)\nCodex · gpt-6.1-terra (high) via APIKO\nПадающие тесты, негативный контроль,\nтаблица границ (testing/boundary)"]
    end

    subgraph Tools["🧰 Внешние контуры и инструменты"]
        JEV["🔍 Jev Route & Design\n(Проверка постановки и сверка с Figma)"]
        GIT["📦 Git (origin/dev) + Woodpecker CI\n(Push = Deploy)"]
    end

    U <-->|"Цели / Эскалации"| OP_A
    U <-->|"Решения / Правила"| DEV_OP
    OP_A ==>|"Задачи (rig queue)"| OWNER
    DEV_OP -.->|"Watchdog 15m / context-sweep.py"| OWNER
    DEV_OP -.->|"Следит за очередью и лимитами"| Coders

    OWNER -->|"1. Проверка спеки"| JEV
    OWNER ==>|"2. Постановка (rig queue)"| C1 & C3 & C4
    C1 & C3 & C4 ==>|"3. Кандидат (rig queue handoff)"| CHECK
    CHECK -.->|"4a. Находки P1–P3 + падающий тест"| C1 & C3 & C4
    CHECK ==>|"4b. Чистый вердикт"| OWNER
    OWNER ==>|"5. Cherry-pick / Rebase / e2e / Push"| GIT
```

> [!NOTE]
> **Разнообразие рантаймов и провайдеров:**
> Команда специально разведена по разным квотам и провайдерам, чтобы не выбивать один общий 5-часовой лимит:
> - `dev-coder` сидит на подписке **GLM Coding Plan** (`glm-5.3-flash` через `~/.claude-glm`).
> - `dev-coder3` работает в рантайме **Pi** на балансе `z.ai`.
> - `dev-check` работает в **Codex** на модели `gpt-6.1-terra` (`effort: high`) через баланс **APIKO** (с автоматическим фолбэком на ChatGPT Sol через `check-provider.sh`).
> - `dev-owner`, `dev-operator` и `dev-coder4` работают на **Codex (`gpt-6.1-sol`)**.

---

## 2. Жизненный цикл одного слайса (От идеи до `origin/dev`)

Вся работа движется **строго через строки очереди (`rig queue`)**, а не устными сообщениями в чате. Любой круг правок (даже мелкий 3-й раунд) обязательно проходит через `dev-check`.

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 Пользователь / Оператор
    participant Owner as 🏛️ dev-owner
    participant Jev as 🔍 Jev (Route / Design)
    participant Coder as 💻 dev-coder (1 / 3 / 4)
    participant Check as 🛡️ dev-check (QA)
    participant Git as 📦 Git + CI

    User->>Owner: Постановка задачи / слайса
    Owner->>Owner: Пишет docs/tasks/<slice>.md (при необходимости читает Figma)
    Owner->>Jev: jev-route.py docs/tasks/<slice>.md
    Jev-->>Owner: Оценка риска (ok / split / return-to-owner)
    
    Owner->>Coder: rig queue (назначение слайса)
    Note over Coder: rig queue claim<br/>Реализация + точечные тесты<br/>Перед сдачей: полный набор<br/>(test, lint, tsc, DEV, PRD, e2e)
    
    alt Есть неясность в постановке
        Coder->>Owner: rig send "1 фраза + варианты" (без 7-минутных раздумий)
        Owner-->>Coder: Быстрое решение
    end

    opt Слайс меняет UI
        Owner->>Jev: tools/design/run.sh (сверка /__gallery с Figma)
    end

    Coder->>Check: rig queue handoff (дифф / SHA кандидата + отчёт)
    
    Note over Check: 1. Выписывает все «Внешние вводы» (файл:строка)<br/>2. Прогоняет матрицу «Границы» (testing/boundary)<br/>3. Делает свой негативный контроль (ломает код → тест краснеет → откатывает)<br/>4. Браузер гоняет через обёртку check-pw

    alt Найдены баги (P1–P3)
        Check->>Coder: Возврат с воспроизводимым падающим тестом в docs/tasks/qa/<slice>/check/
        Coder->>Check: Исправление + повторный handoff (перепроверка)
    else Всё чисто (Вердикт принят)
        Check->>Owner: Вердикт QA + отчёт с таблицей границ
    end

    Note over Owner: Приёмка в чистой копии (/tmp, порт 4176)<br/>Запись в decisions/YYYY-MM-DD.tsv<br/>git pull --rebase → e2e → git push origin dev
    Owner->>Git: Push в dev (запуск Woodpecker CI)
    Owner->>Coder: Сброс контекста (/clear или перезапуск Pi)
    Owner->>Check: rig send "/new" --raw (новая сессия Codex)
    Owner->>Owner: rig compact (сжатие контекста на границе слайса)
```

---

## 3. Изоляция рабочих копий и портов

Чтобы параллельные кодеры и проверяющий не конфликтовали за файлы и порты Playwright/Vite, среда разделена физически:

| Участник | Рабочая директория (`cwd`) | Порты Playwright (`PW_PORT` / `PW_DEV_PORT`) | Как сдаёт и чистит контекст |
| :--- | :--- | :---: | :--- |
| **`dev-owner`** | `core-platform` *(+ `/tmp` для приёмки)* | `4173` / `5199` *(приёмка: `4176` / `5202`)* | Принимает, делает `git pull --rebase` и пушит. Сжимается через `rig compact` |
| **`dev-coder`** | `core-platform` (основная) | `4173` / `5199` | Оставляет изменения в дереве, получает `/clear --raw` от owner |
| **`dev-coder3`** | `core-platform-coder3` (отдельная копия) | `4174` / `5200` | Работает в `detached HEAD`, сдаёт SHA коммита; сброс — перезапуск ноды оператором |
| **`dev-coder4`** | `core-platform-coder4` (отдельная копия) | `4175` / `5201` | Перед работой `git fetch && git checkout --detach origin/dev`, сдаёт SHA для `cherry-pick` |
| **`dev-check`** | `core-platform` | Через `tools/check-pw <PORT> <DEV_PORT>` (напр. `4178` / `5204`) | После слайса получает `/new --raw` + подтверждение Enter |

---

## 4. Что происходит прямо сейчас в очереди (Live Snapshot)

На текущий момент в `rig queue` одновременно крутятся **3 параллельных потока**:

```mermaid
flowchart LR
    subgraph S1["Слайс 1: ELB-001 (Выбранный пресет при позднем load)"]
        Q1["operator-agent@kernel"] -->|"blocked (ждёт кодера)"| OW1["dev-owner"]
        OW1 -->|"in-progress (qitem-...2c72)"| CD1["🟢 dev-coder (работает)"]
    end

    subgraph S2["Слайс 2: editor-load-boundaries (ELB-002)"]
        CD3["dev-coder3"] -->|"pending (qitem-...89f1)\nunit 1247/1247, e2e 96/96"| CHK1["🟡 dev-check (в очереди на QA)"]
    end

    subgraph S3["Слайс 3: tts-strict-chunked"]
        CD4["dev-coder4"] -->|"in-progress (qitem-...fd17)\nTTS 216 passed"| CHK2["🟢 dev-check (проверяет сейчас)"]
    end
```

---

## 5. Четыре главных защитных механизма («Уроки в механику»)

1. **Доказательный QA (`dev-check`):**
   - Никаких «по коду кажется, что упадёт». Каждая находка P1–P3 обязана иметь **падающий тест** в `docs/tasks/qa/<slice>/check/`.
   - Обязательный **негативный контроль**: проверяющий сам временно ломает проверяемую фичу, убеждается, что тест краснеет, и возвращает файл обратно.
   - Обязательная **матрица границ** по `testing/boundary/values.json` без пустых клеток.
2. **Защита от раздувания контекста (Token Burn Protection):**
   - Кодеры получают `/clear` после каждого слайса.
   - `dev-check` получает `/new --raw` с проверкой появления нового `rollout-*.jsonl`.
   - Каждые 15 минут сторож (`watchdog`) будит `dev-operator`, а скрипт `context-sweep.py` следит за тем, чтобы свободные ноды не копили сотни тысяч токенов кэша.
3. **Песочница без лишних остановок:**
   - Никаких `python3 -c` или пайпов `| tail` / `2>&1` в тестовых командах, чтобы не триггерить запрос разрешений и не останавливать конвейер.
   - Браузерные прогоны у `dev-check` идут строго через обёртку `tools/check-pw`.
4. **Два журнала правды:**
   - **Что произошло** — хранится в `rig queue` и `docs/tasks/qa/<slice>/`.
   - **Почему принято решение** (приёмка, ещё круг, фолбэк провайдера) — пишется в `~/openrig-lab/core-platform/decisions/YYYY-MM-DD.tsv`.

---

## 6. Архитектура синхронизации дашборда (`index.html` ⇄ `server.mjs` ⇄ OpenRig)

Дашборд [index.html](./openrig/index.html) синхронизируется с ригом через легковесный мост [server.mjs](./openrig/server.mjs) (`127.0.0.1:7440`), который напрямую опрашивает демон OpenRig (`127.0.0.1:7437`), CLI `rig` и TSV-журнал решений:

```mermaid
sequenceDiagram
    autonumber
    participant UI as 🌐 Браузер (index.html)
    participant Srv as ⚡ server.mjs (:7440)
    participant Dm as 🧠 OpenRig Daemon (:7437)
    participant CLI as 🔧 rig queue / rig capture
    participant TSV as 📜 decisions/*.tsv

    loop Каждые 4 секунды (refreshTelemetryNow)
        UI->>Srv: GET /api/telemetry
        par Параллельный сбор (Promise.all)
            Srv->>Dm: GET /api/rigs/:id/nodes (core-platform + kernel)
            Dm-->>Srv: Узлы (contextUsage.usedPercentage, activityState, model)
        and
            Srv->>CLI: rig queue list -A --json (+ кэш истории 20с)
            CLI-->>Srv: Активные конверты + статистика пар и QA-кругов
        and
            Srv->>TSV: Чтение последних строк 2026-11-04.tsv
            TSV-->>Srv: Последние архитектурные решения
        end
        Srv-->>UI: JSON { timestamp, nodes, activeQueue, decisions, history }
        Note over UI: In-place обновление карточек (❤️ / Zzz...),<br/>пересчёт активных стрелок и Паспорта узла
    end

    opt При клике на узел или кнопке «🔄 Экран»
        UI->>Srv: GET /api/capture?seat=<id>&lines=32
        Srv->>CLI: rig capture <seat> --lines 32
        CLI-->>Srv: Живой буфер экрана tmux
        Srv-->>UI: Отображение в #tmuxScreenBox Паспорта узла
    end
```


## 7. Deck v3.2: что добавлено поверх 4-секундного цикла

| Функция | Источник данных | Где в коде |
|---|---|---|
| Живой радар «Кто кого держит» | `activityState.needsInput`, `activeQueue`, `contextUsage.usedPercentage ≥ 70`, `state=working` без строки очереди | `buildLiveRadar()` |
| Темп выгорания контекста и время с последнего свапа | история замеров `ctxPct` в браузере (сбрасывается при падении >5%), `activityState.lastSwap.at` | `computeBurn()`, Паспорт узла |
| Auto-Follow терминала | `/api/capture?lines=32` каждые 4 с, если выбранный агент `working`/`urgent` | `fetchTerminalCapture(id, silent)` |
| Терминал на 80 строк | `/api/capture?lines=80`, обновляется в цикле, пока окно открыто | `openTerminalModal()` |
| Рентген стрелки | `history.pairEnvelopes` (последние 4 конверта на пару, из `rig queue list -a --limit 300`) + открытые строки очереди | `selectEdge()`, `renderEdgeXray()` |
| Аудио-радар и заголовок вкладки | новые `ATTN` / `CTX ≥ 75%` (сигнал только при появлении, без повтора) | `updateAlertsAndTitle()`, `playBeep()` |

Темп выгорания считается только по замерам, накопленным с момента открытия страницы. После перезагрузки страницы ему нужно несколько минут, чтобы появилась оценка.

---

## 8. Контекстная диаграмма (C4 Level 1 — System Context & Trust Boundaries)

Показывает границы системы **RigCommander**, разделение **read-only телеметрии** и **защищённого write-back контура**, а также режим статического демо на Vercel.

```mermaid
flowchart LR
    OP["👤 Оператор (Браузер)"]

    subgraph LOCAL["Локальный контур доверия (127.0.0.1)"]
        DECK["💠 RigCommander Deck (server.mjs :7440)"]
        GATE["🛡️ Security Gate (DECK_TOKEN + Origin + Key Allowlist + 413)"]
        DAEMON["🧠 OpenRig Daemon (:7437 HTTP)"]
        CLI["🔧 rig CLI (ps, queue, parked, capture)"]
        TMUX["🖥️ tmux / rig send (Write-Back)"]
        FS["📂 Локальная ФС (JSONL транскрипты, decisions/*.tsv, RECAP.md)"]
    end

    subgraph CLOUD["Статический хостинг (Vercel)"]
        DEMO["🌐 Public Landing & Demo (/ , /demo, /deck)"]
    end

    OP -->|"HTTP UI + Polling 4s"| DECK
    OP -->|"HTTPS (read-only демо)"| DEMO
    OP -->|"Действия HITL (POST /api/send)"| GATE
    GATE -->|"Валидированный write-back"| TMUX

    DECK -->|"GET /api/rigs, /nodes (read-only)"| DAEMON
    DECK -->|"execFile (read-only)"| CLI
    DECK -->|"Инкрементальное чтение по offset (read-only)"| FS
```

### Инварианты границ доверия
- **Нет внешнего биндинга:** сервер слушает строго `127.0.0.1:7440`.
- **Разделение чтения и записи:** весь сбор телеметрии идёт без мутации состояния агентов; любая запись проходит через `POST /api/send` с per-process `DECK_TOKEN` (`timingSafeEqual`), проверкой `Origin`, ограничением тела `64KB` (`413`) и allowlist клавиш (`parseAllowedTmuxKeys`).
- **Изоляция статики:** `resolveSafeStaticPath` блокирует `..`, скрытые файлы (`.env`, `.git`) и исходники `.mjs`.

---

## 9. Компонентная диаграмма и карта зависимостей (C4 Level 3 — Components)

Описывает фактическую модульную структуру проекта и целевые границы при дальнейшей декомпозиции (связано с [Операционной онтологией](operational-ontology.md)).

```mermaid
flowchart TD
    subgraph FE["Frontend (openrig/)"]
        HTML["index.html (Проекции: Граф, Гант, Радар, Инспектор, Бюджет)"]
        CSS["assets/styles/deck.css (Токены и стили панелей)"]
        DOM["assets/domain/* (Чистые ES-модули: prompt-parser, thermal, audio, gantt-model)"]
        ONT["assets/ontology/* (Целевой слой: actions.js, snapshot.js)"]
    end

    subgraph BE["Backend BFF (openrig/server.mjs + lib/)"]
        SEC["HTTP Router & Security (resolveSafeStaticPath, parseAllowedTmuxKeys, DECK_TOKEN)"]
        ADP["Adapters & Caches (buildGanttItems, readTranscriptTokenUsage, boundedMapSet)"]
        FIE["lib/fleet-intelligence/ (Facade + RingBuffer + 5 Detectors + per-rig Advisory)"]
    end

    subgraph DEV["Доставка и тесты"]
        SYNC["scripts/sync-public.mjs -> public/ (Vercel)"]
        TEST["tests/*.test.mjs (node --test, zero-dep)"]
    end

    HTML --> CSS
    HTML --> DOM
    HTML -.->|"Этап A/B"| ONT
    ONT -.-> DOM
    HTML -->|"GET /api/telemetry, /capture; POST /api/send"| SEC
    SEC --> ADP
    ADP -->|"setImmediate ingest"| FIE
    FIE -->|"per-rig report"| SEC

    SYNC -.->|"копирует index.html + assets/"| FE
    TEST -->|"прямой import"| DOM
    TEST -->|"прямой import"| ADP
    TEST -->|"прямой import"| SEC
    TEST -->|"прямой import"| FIE
```

### Правила зависимостей (Dependency Rules)
1. **`assets/domain/` не зависит от DOM и `window`:** все модули чистые, детерминированные и импортируются напрямую в `node --test`.
2. **Один источник правды для копий:** правки вносятся только в `openrig/` и `landing/`, а `public/` обновляется командой `npm run sync:public`.
3. **Аналитика не блокирует HTTP:** `FleetIntelligenceEngine.ingestSnapshot` выполняется через `setImmediate` с троттлингом и кэшем по `rigId`.
4. **Действия строго по предусловию:** кнопки write-back в UI появляются только при наличии конкретной причины (`urgent`, `working`, `ctxPct >= 65%`, `parked`) и в дальнейшем сводятся в единый реестр `assets/ontology/actions.js`.
