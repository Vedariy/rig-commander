# Руководство разработчика — OpenRig Neural Command Deck

Техническое руководство по внутренней архитектуре, протоколам синхронизации и расширению **OpenRig Neural Command Deck**.

---

## 1. Структура проекта

```
agenticos/openrig/
├── index.html                   # Одностраничное приложение (Pure Vanilla JS + SVG Canvas + CSS)
├── server.mjs                   # Сервер телеметрии и командный мост (Node.js ESM, port 7440)
├── README.md                    # Базовое описание и инструкция запуска
└── docs/
    ├── adr/                     # Архитектурные решения (ADR-0001 .. ADR-0005)
    ├── product/                 # Продуктовое видение и карта возможностей
    ├── user-guide/              # Руководство оператора по управлению ригом
    ├── dev-guide/               # Руководство разработчика (этот документ)
    └── information-architecture.md # Семиотика цветов, дизайн-токены и лейаут
```

---

## 2. Протокол взаимодействия и API (`server.mjs`)

Сервер слушает на `http://127.0.0.1:7440`.

### 1. `GET /api/telemetry`
Возвращает сводный снимок состояния всей системы каждые 4 секунды.

```typescript
interface TelemetryResponse {
  timestamp: string;               // ISO 8601 время синхронизации
  nodes: LiveNode[];               // Живые узлы из daemon API /api/rigs/:id/nodes
  activeQueue: QueueItem[];        // Открытые строки из rig queue list -A
  decisions: DecisionRow[];        // Последние суждения из decisions/*.tsv
  history: {
    pairCounts: Record<string, number>;    // Частота вызовов между парами агентов
    pairEnvelopes: Record<string, any[]>;  // Свежие конверты между парами
    coderStats: Record<string, CoderStat>; // Статистика кругов QA (avgRounds, firstPassPct, returnCount)
    nodeTraffic: Record<string, { in: number; out: number }>; // Реальный трафик узлов
    sliceStats: Record<string, any>;       // Сводка по слайсам
  };
  parkedSeats: Record<string, ParkedSeat>; // Диагностика rig parked
  seatCompactions: Record<string, {        // Реальное число сжатий из recap-superseded
    compactionsCount: number;
    recapSnippet: string;
  }>;
  seatGuidance: Record<string, SeatGuidance>; // Обязанности, границы, рантайм, фолбэки
}
```

### 2. `GET /api/capture`
Возвращает текстовый снимок виртуального экрана `tmux`.

- **Параметры:**
  - `seat`: канонический идентификатор сессии (например, `dev-owner@core-platform`);
  - `lines`: количество строк (по умолчанию `32`, в модальном окне `80`).
- **Ответ:** `{ seat: string, screen: string }`.

### 3. `POST /api/send`
Передаёт команду или клавишу в консоль агента.

- **Требования безопасности (ADR-0004):**
  - Заголовок `Origin` строго равен `http://127.0.0.1:7440` или `http://localhost:7440`;
  - Заголовок `X-Deck-Token` строго совпадает с секретным per-process токеном, инжектированным в `<meta name="deck-token">`.
- **Тело запроса (JSON):**
  - `seat`: ID сессии;
  - `text`: текст команды;
  - `raw`: опционально, для клавиш (`C-c`, `Escape`, `Enter`).

---

## 3. Математика холста топологии (`index.html`)

Топология объединяет HTML-ноды и векторные SVG-магистрали:

1. **Координатная сетка:**
   Положение карточек агентов задаётся в процентах от размеров родительского контейнера:
   - `cx = (node.x / 100) * canvasWidth`
   - `cy = (node.y / 100) * canvasHeight`

2. **Отсечение луча по рамке карточки (`intersectNodeBorder`):**
   Чтобы стрелки магистралей не уходили под центр карточки, луч отсекается ровно по внешнему контуру прямоугольника агента:
   ```javascript
   function intersectNodeBorder(cx, cy, hw, hh, vx, vy, pad) {
     const w = hw + pad;
     const h = hh + pad;
     const tx = Math.abs(vx) > 1e-5 ? w / Math.abs(vx) : 1e9;
     const ty = Math.abs(vy) > 1e-5 ? h / Math.abs(vy) : 1e9;
     const t = Math.min(tx, ty);
     return { x: cx + vx * t, y: cy + vy * t };
   }
   ```
   Это гарантирует идеальное прилегание маркеров стрелок `marker-end` к внешнему бордеру карточки независимо от угла наклона связи.

3. **Двухслойная отрисовка магистралей:**
   Каждая связь рисуется двумя путями `<path>`:
   - Нижний полупрозрачный широкий ствол (`.edge-trunk`), толщина пропорциональна `Math.log(calls + 1)`;
   - Верхний анимированный неоновый поток (`.edge-stream`), активирующийся только при наличии реального движения задач в очереди.

---

## 4. Рекомендации по расширению

- **Добавление новых типов узлов:** при необходимости добавления уникальных ролей достаточно дополнить сопоставление в `ensureDynamicAgent` и словарь `SEAT_GUIDANCE` в `server.mjs`.
- **Интеграция новых проверок:** для создания дополнительных предупреждений в блоке «Тревожные знаки» добавьте логику в функцию рендера панели в `renderInspectorAndScorecards`.
