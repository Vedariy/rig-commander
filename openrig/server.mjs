#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { FleetIntelligenceEngine } from './lib/fleet-intelligence/index.mjs';
import { ActionAuditLog, extractSeatBaseline } from './lib/action-audit.mjs';

// Per-process secret: injected into index.html on load, required on /api/send.
const DECK_TOKEN = crypto.randomBytes(24).toString('hex');
const fleetIntelligence = new FleetIntelligenceEngine({ maxSnapshots: 300, evalThrottleMs: 3000 });
const actionAudit = new ActionAuditLog({ maxRecords: 100 });
const latestSeatBaselines = new Map();

function tokenMatches(got) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(DECK_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(zlib.gzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7440);
const RIG_BIN = process.env.RIG_BIN || (process.env.HOME ? path.join(process.env.HOME, '.local/bin/rig') : 'rig');
const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const DAEMON_URL = process.env.OPENRIG_DAEMON_URL || 'http://127.0.0.1:7437';
const DECISIONS_DIR = process.env.OPENRIG_DECISIONS_DIR || (process.env.HOME ? path.join(process.env.HOME, 'openrig-lab/core-platform/decisions') : path.join(process.cwd(), 'decisions'));
const RIGS_TOPOLOGY_DIR = process.env.OPENRIG_TOPOLOGY_DIR || (process.env.HOME ? path.join(process.env.HOME, '.openrig/topology/rigs') : path.join(process.cwd(), '.openrig/topology/rigs'));

const DEFAULT_SEAT_GUIDANCE = {
  'dev-owner@core-platform': {
    roleName: 'Архитектор и Оркестратор',
    specRef: 'orchestration/orchestrator',
    duties: [
      'Ведёт продуктовые цели CorePlatform через слайсы очереди rig queue',
      'Оркестрация и декомпозиция задач (docs/tasks/<slice>.md)',
      'Локальная приёмка готовых кандидатов после вердикта dev-check (GREEN)',
      'Финальный прогон npm run e2e, git pull --rebase, коммит и git push в origin/dev'
    ],
    boundaries: [
      'Запрещён push в dev без зелёных тестов и независимого отчёта QA',
      'Запрещено передавать в работу слайс без согласованной постановки',
      'Не коммитит напрямую чужую недопроверенную работу'
    ],
    harness: 'codex (gpt-6.1-sol medium)',
    profile: 'sd-owner-chatgpt (ChatGPT OAuth Pro 100)',
    fallbackRoute: 'При исчерпании квоты: tools/owner-provider.sh -> APIKO Sol medium (prepaid)'
  },
  'dev-senior-architect@core-platform': {
    roleName: 'Старший Архитектор (Spec & Arch)',
    specRef: 'agents/senior-architect',
    duties: [
      'Проектирование схем БД, API и доменной декомпозиции (docs/adr/)',
      'Применение методологии arch-insight-analyzer и паттернов api-gateway',
      'Конвенции: TimeTick BIGINT primary keys, database-first, minimal tables',
      'Ревью интеграционных контрактов и архитектурных границ модулей'
    ],
    boundaries: [
      'Запрещено накатывать DDL/миграции или выполнять реальные записи в БД',
      'Запрещены бекенд-деплои, манипуляции с платежами и смена custody очереди',
      'Не коммитит и не пушит код'
    ],
    harness: 'codex (gpt-6.1-sol)',
    profile: 'default (OpenAI subscription)',
    fallbackRoute: 'Резерв: claude-code Sonnet / APIKO Terra'
  },
  'dev-operator@core-platform': {
    roleName: 'Оператор рига • Watchdog 15m',
    specRef: 'orchestration/orchestrator',
    duties: [
      'Периодический обход очереди и здоровья агентов каждые 15 минут',
      'Наблюдение за context-usage: превентивный компакт свободных агентов',
      'Контроль watchdog 75% на dev-check и маршрутизация задач',
      'Сверка зависших обязательств (parked seats diagnosis)'
    ],
    boundaries: [
      'Только чтение и координация: не пишет продуктовый код',
      'Не меняет статус задач в обход владельца очереди'
    ],
    harness: 'codex (gpt-6.1-sol medium)',
    profile: 'default',
    fallbackRoute: 'Watchdog scheduler в OpenRig daemon'
  },
  'dev-check@core-platform': {
    roleName: 'Доказательный QA • Проверяющий',
    specRef: 'development/qa',
    duties: [
      'Доказательная независимая проверка (proof, not code reading)',
      'Свой негативный контроль: временно ломает поведение, доказывая реакцию теста',
      'Обязательная таблица границ ввода (empty, negative, huge, wrong type, framing)',
      'Каждая находка P1–P3 воспроизводится падающим тестом в отчёте'
    ],
    boundaries: [
      'Браузерные прогоны — ТОЛЬКО через обёртку tools/check-pw (вне песочницы)',
      'Запрещены конвейеры shell (| && ;) — только одиночные команды',
      'Не правит код слайса сам — только findings с падающими тестами'
    ],
    harness: 'codex (deepseek-v4-pro / gpt-6.1-terra)',
    profile: 'sd-check (APIKO prepaid Terra high / Direct DeepSeek)',
    fallbackRoute: 'tools/check-provider.sh apiko|chatgpt (переключение за секунду)'
  },
  'dev-coder@core-platform': {
    roleName: 'Основной кодер (Main Copy)',
    specRef: 'development/implementer',
    duties: [
      'Реализация слайса строго по постановке docs/tasks/<slice>.md',
      'Локальные точечные тесты (npx vitest <file>, npx playwright test <spec>)',
      'Сдача через rig queue handoff на dev-check с описанием диффа',
      'Новый чистый контекст (/clear) на каждый новый слайс'
    ],
    boundaries: [
      'НЕ коммитит и НЕ пушит (это делает dev-owner после приёмки)',
      'Без shell-конвейеров (| && ;) — команды запускать по одной',
      'Запрещено читать и трогать .env*, ~/.ssh, секреты'
    ],
    harness: 'claude-code (glm-5.3-flash, 1M окно)',
    profile: 'GLM Coding Plan (flat)',
    fallbackRoute: 'Claude Sonnet 5.5 / Codex gpt-6.1-sol'
  },
  'dev-coder3@core-platform': {
    roleName: 'Кодер 3 (Pi Isolated)',
    specRef: 'development/implementer',
    duties: [
      'Параллельная реализация изолированных слайсов в core-platform-coder3',
      'Работа в рантайме Pi на DeepSeek flash',
      'Сдача диффа на dev-check по процедуре рига'
    ],
    boundaries: [
      'Не коммитит, не пушит, не трогает секреты',
      'Без shell конвейеров'
    ],
    harness: 'pi (deepseek-flash)',
    profile: 'DeepSeek API direct (Keychain key)',
    fallbackRoute: 'z.ai PAYG резервная запись в Pi'
  },
  'dev-coder4@core-platform': {
    roleName: 'Кодер 4 (Parallel Worktree)',
    specRef: 'development/implementer',
    duties: [
      'Параллельная реализация задач в core-platform-coder4',
      'Строгая TDD-разработка, локальные тесты vitest',
      'Handoff на dev-check'
    ],
    boundaries: [
      'Не коммитит, не пушит, не трогает секреты',
      'Без shell конвейеров'
    ],
    harness: 'codex (gpt-6.1-sol)',
    profile: 'default (OpenAI ChatGPT plan)',
    fallbackRoute: 'Делит квоту ChatGPT Pro 100 / резерв Sonnet'
  },
  'dev-coder5@core-platform': {
    roleName: 'Кодер 5 • Terminal Seat (AGY)',
    specRef: 'builtin:terminal',
    duties: [
      'Интерактивное терминальное сиденье agy (Antigravity CLI)',
      'Быстрая реализация и правка слайсов (режим accept-edits)',
      'Локальная верификация и handoff на dev-check'
    ],
    boundaries: [
      'Не коммитит напрямую, сдаёт через очередь на dev-check',
      'Не выходит за границы рабочей копии'
    ],
    harness: 'terminal / agy (Gemini 3.8 Flash / Gemini 4 Argon)',
    profile: 'Google AI Pro (OAuth via Antigravity)',
    fallbackRoute: 'Переключение моделей через agy /effort или /model'
  },
  'operator-agent@kernel': {
    roleName: 'Диспетчер ядра OpenRig',
    specRef: 'orchestration/orchestrator',
    duties: [
      'Координация уровня ядра OpenRig и мост между ригами',
      'Помощь человеку-оператору в формулировании команд рига',
      'Взаимодействие с dev-owner и queue-worker'
    ],
    boundaries: [
      'Не правит код сервисов продуктов',
      'Соблюдает границы ядра OpenRig'
    ],
    harness: 'codex (gpt-6.1-sol)',
    profile: 'default',
    fallbackRoute: 'TUI / operator-human'
  }
};

const seatGuidanceCache = new Map();
const transcriptUsageCache = new Map();
const MAX_GUIDANCE_CACHE = 200;
const MAX_TRANSCRIPT_CACHE = 100;

function boundedMapSet(map, key, value, maxSize) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

const MODEL_PRICING_PER_M = [
  { match: /opus/i, in: 15.0, cached: 1.5, out: 75.0, tier: 'Tier 3' },
  { match: /sonnet/i, in: 3.0, cached: 0.3, out: 15.0, tier: 'Tier 2' },
  { match: /haiku/i, in: 0.8, cached: 0.08, out: 4.0, tier: 'Tier 1' },
  { match: /gpt-6\.1-terra|terra|mini/i, in: 1.5, cached: 0.15, out: 6.0, tier: 'Tier 2' },
  { match: /gpt-6|gpt-5|codex|sol/i, in: 2.5, cached: 0.25, out: 15.0, tier: 'Tier 3' },
  { match: /glm|flash/i, in: 0.5, cached: 0.1, out: 2.0, tier: 'Tier 1' },
  { match: /deepseek|qwen/i, in: 0.28, cached: 0.03, out: 0.42, tier: 'Tier 1' }
];

function getModelPricing(modelName) {
  const m = String(modelName || '');
  return MODEL_PRICING_PER_M.find(p => p.match.test(m)) || { in: 2.0, cached: 0.2, out: 10.0, tier: 'Tier 2' };
}

function ingestTranscriptLine(line, state) {
  if (!line) return;
  if (!line.includes('token_count') && !line.includes('"usage"')) return;
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count' && obj.payload.info && obj.payload.info.total_token_usage) {
      state.codexTotals = obj.payload.info.total_token_usage;
    } else if (obj.message && obj.message.usage) {
      const msgId = obj.message.id || `line-${state.claudeByMsgId.size}`;
      if (obj.message.model) state.lastModel = obj.message.model;
      state.claudeByMsgId.set(msgId, obj.message.usage);
    }
  } catch {
    // ignore malformed JSONL line
  }
}

function summarizeTranscriptState(state) {
  if (state.codexTotals) {
    const totalInput = Number(state.codexTotals.input_tokens) || 0;
    const cachedInput = Number(state.codexTotals.cached_input_tokens) || 0;
    const uncachedInput = Math.max(0, totalInput - cachedInput);
    const output = Number(state.codexTotals.output_tokens) || 0;
    return {
      source: 'codex_jsonl',
      model: state.lastModel,
      inputTokens: totalInput,
      uncachedInputTokens: uncachedInput,
      cachedInputTokens: cachedInput,
      outputTokens: output,
      totalTokens: totalInput + output
    };
  }
  if (state.claudeByMsgId.size > 0) {
    let uncachedInput = 0;
    let cachedInput = 0;
    let output = 0;
    for (const u of state.claudeByMsgId.values()) {
      uncachedInput += (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
      cachedInput += Number(u.cache_read_input_tokens) || 0;
      output += Number(u.output_tokens) || 0;
    }
    const totalInput = uncachedInput + cachedInput;
    return {
      source: 'claude_jsonl',
      model: state.lastModel,
      inputTokens: totalInput,
      uncachedInputTokens: uncachedInput,
      cachedInputTokens: cachedInput,
      outputTokens: output,
      totalTokens: totalInput + output
    };
  }
  return null;
}

async function readTranscriptTokenUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let fh = null;
  try {
    const stat = await fs.stat(transcriptPath);
    const cached = transcriptUsageCache.get(transcriptPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.data;
    }

    const canResume = Boolean(cached && stat.size >= cached.size && cached.offset <= stat.size);
    const state = canResume
      ? {
          codexTotals: cached.codexTotals,
          claudeByMsgId: cached.claudeByMsgId,
          lastModel: cached.lastModel
        }
      : {
          codexTotals: null,
          claudeByMsgId: new Map(),
          lastModel: null
        };
    let readOffset = canResume ? cached.offset : 0;
    const bytesToRead = stat.size - readOffset;

    let tailLine = '';
    if (bytesToRead > 0) {
      fh = await fs.open(transcriptPath, 'r');
      const buf = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await fh.read(buf, 0, bytesToRead, readOffset);
      const slice = buf.subarray(0, bytesRead);
      const lastNl = slice.lastIndexOf(0x0a);
      if (lastNl !== -1) {
        const completeText = slice.subarray(0, lastNl + 1).toString('utf-8');
        for (const line of completeText.split('\n')) {
          ingestTranscriptLine(line, state);
        }
        readOffset += lastNl + 1;
        tailLine = slice.subarray(lastNl + 1).toString('utf-8').trim();
      } else {
        tailLine = slice.toString('utf-8').trim();
      }
    }

    let data;
    if (tailLine) {
      const snapState = {
        codexTotals: state.codexTotals,
        claudeByMsgId: new Map(state.claudeByMsgId),
        lastModel: state.lastModel
      };
      ingestTranscriptLine(tailLine, snapState);
      data = summarizeTranscriptState(snapState);
    } else {
      data = summarizeTranscriptState(state);
    }

    boundedMapSet(transcriptUsageCache, transcriptPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      offset: readOffset,
      codexTotals: state.codexTotals,
      claudeByMsgId: state.claudeByMsgId,
      lastModel: state.lastModel,
      data
    }, MAX_TRANSCRIPT_CACHE);
    return data;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function buildSeatUsageReport(nodes) {
  const seatUsage = {};
  let totalUncached = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalUsd = 0;

  await Promise.all((nodes || []).map(async (node) => {
    const seatId = node.canonicalSessionName || node.logicalId;
    if (!seatId) return;
    const cu = node.contextUsage || {};
    const parsed = await readTranscriptTokenUsage(cu.transcriptPath);
    const modelName = (node.modelObservation && node.modelObservation.model) || node.model || (parsed && parsed.model) || '';
    const pricing = getModelPricing(modelName);

    let uncached = 0;
    let cached = 0;
    let output = 0;
    let source = 'none';

    if (parsed) {
      uncached = parsed.uncachedInputTokens;
      cached = parsed.cachedInputTokens;
      output = parsed.outputTokens;
      source = parsed.source;
    } else if (typeof cu.totalInputTokens === 'number' || typeof cu.totalOutputTokens === 'number') {
      uncached = Number(cu.totalInputTokens) || 0;
      output = Number(cu.totalOutputTokens) || 0;
      source = 'daemon_ctx';
    } else {
      return;
    }

    const totalInput = uncached + cached;
    const totalTokens = totalInput + output;
    const cachedPct = totalInput > 0 ? Math.round((cached / totalInput) * 100) : 0;
    const estUsd = (uncached / 1e6) * pricing.in + (cached / 1e6) * pricing.cached + (output / 1e6) * pricing.out;

    seatUsage[seatId] = {
      model: modelName || 'unknown',
      tier: pricing.tier,
      source,
      inputTokens: totalInput,
      uncachedInputTokens: uncached,
      cachedInputTokens: cached,
      outputTokens: output,
      totalTokens,
      cachedPct,
      estUsd: Number(estUsd.toFixed(4))
    };

    totalUncached += uncached;
    totalCached += cached;
    totalOutput += output;
    totalUsd += estUsd;
  }));

  const totalInput = totalUncached + totalCached;
  const fleetUsageSummary = {
    totalTokens: totalInput + totalOutput,
    totalInputTokens: totalInput,
    totalUncachedInputTokens: totalUncached,
    totalCachedInputTokens: totalCached,
    totalOutputTokens: totalOutput,
    cachedPct: totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0,
    totalEstUsd: Number(totalUsd.toFixed(2)),
    seatCount: Object.keys(seatUsage).length
  };

  return { seatUsage, fleetUsageSummary };
}

async function parseAgentsDoc(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    const lines = text.split('\n');
    const sections = {};
    let curRole = null;
    let curType = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const hMatch = line.match(/^##+\s+(.+)$/i);
      if (hMatch) {
        curRole = hMatch[1].toLowerCase();
        sections[curRole] = sections[curRole] || { duties: [], boundaries: [] };
        curType = 'duties';
        continue;
      }
      if (line.includes('Границы') || line.includes('Запрещено') || line.includes('Нельзя') || line.includes('boundaries')) {
        curType = 'boundaries';
      } else if (line.includes('Обязанности') || line.includes('duties')) {
        curType = 'duties';
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const item = line.replace(/^[-*]\s+/, '').trim();
        if (curRole && curType && item) {
          sections[curRole][curType].push(item);
        }
      }
    }
    return sections;
  } catch {
    return null;
  }
}

async function resolveSeatGuidance(seatId, liveNode) {
  if (DEFAULT_SEAT_GUIDANCE[seatId]) {
    return DEFAULT_SEAT_GUIDANCE[seatId];
  }
  if (seatGuidanceCache.has(seatId)) {
    return seatGuidanceCache.get(seatId);
  }

  const shortName = seatId.split('@')[0];
  const modelName = (liveNode && liveNode.modelObservation && liveNode.modelObservation.model) ||
                    (liveNode && liveNode.model) || 'unknown';
  const harnessName = (liveNode && liveNode.runtime) || 'terminal';

  let docDuties = [];
  let docBoundaries = [];
  if (liveNode && liveNode.cwd) {
    const candidates = [
      path.join(liveNode.cwd, 'AGENTS.md'),
      path.join(liveNode.cwd, 'CULTURE.md'),
      path.join(liveNode.cwd, 'docs', 'AGENTS.md')
    ];
    for (const cPath of candidates) {
      const parsed = await parseAgentsDoc(cPath);
      if (parsed) {
        for (const [key, sec] of Object.entries(parsed)) {
          if (key.includes(shortName.toLowerCase()) || 
              (shortName.includes('coder') && key.includes('кодер')) ||
              (shortName.includes('check') && key.includes('check')) ||
              (shortName.includes('owner') && (key.includes('owner') || key.includes('архитектор')))) {
            docDuties = sec.duties;
            docBoundaries = sec.boundaries;
            break;
          }
        }
        if (docDuties.length || docBoundaries.length) break;
      }
    }
  }

  let roleName = shortName;
  const duties = docDuties.length ? [...docDuties] : [];
  const boundaries = docBoundaries.length ? [...docBoundaries] : [];

  if (shortName.includes('owner') || shortName.includes('architect')) {
    roleName = 'Архитектор и Оркестратор';
    if (!duties.length) duties.push('Оркестрация и ведение задач через очередь rig queue', 'Приёмка готовых кандидатов', 'Контроль архитектурной целостности');
    if (!boundaries.length) boundaries.push('Запрещён push без зелёных тестов и проверки', 'Действует в рамках согласованных постановок');
  } else if (shortName.includes('check') || shortName.includes('qa')) {
    roleName = 'Доказательный QA • Проверяющий';
    if (!duties.length) duties.push('Доказательная независимая проверка гипотез', 'Негативный контроль и проверка граничных условий', 'Воспроизведение находок падающими тестами');
    if (!boundaries.length) boundaries.push('Не правит код слайса сам — только findings', 'Одиночные команды без неконтролируемых конвейеров');
  } else if (shortName.includes('coder')) {
    roleName = `Кодер (${shortName})`;
    if (!duties.length) duties.push('Реализация задач строго по постановке', 'Локальные точечные тесты перед сдачей', 'Handoff на проверяющего');
    if (!boundaries.length) boundaries.push('Не коммитит напрямую в прод-ветку', 'Не трогает секреты и файлы вне рабочей директории');
  } else if (shortName.includes('operator')) {
    roleName = 'Оператор рига';
    if (!duties.length) duties.push('Мониторинг очереди и здоровья агентов', 'Контроль context usage и триаж ситуаций', 'Сверка зависших обязательств (parked seats)');
    if (!boundaries.length) boundaries.push('Только чтение и координация: не пишет продуктовый код');
  } else {
    if (!duties.length) duties.push('Штатные обязанности агента OpenRig');
    if (!boundaries.length) boundaries.push('Действует в рамках прав своего воркспейса');
  }

  const result = {
    roleName,
    specRef: `rig/${shortName}`,
    duties,
    boundaries,
    harness: `${harnessName} (${modelName})`,
    profile: 'active-session',
    fallbackRoute: 'OpenRig daemon auto-rotation'
  };

  boundedMapSet(seatGuidanceCache, seatId, result, MAX_GUIDANCE_CACHE);
  return result;
}

async function sendJson(req, res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (acceptEncoding.includes('gzip')) {
    try {
      const gzipped = await gzipAsync(Buffer.from(jsonStr));
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-store'
      });
      res.end(gzipped);
      return;
    } catch {}
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(jsonStr);
}

async function readSeatCompactions() {
  const result = {};
  try {
    const rigs = await fs.readdir(RIGS_TOPOLOGY_DIR);
    for (const rigName of rigs) {
      if (rigName.startsWith('.')) continue;
      const seatsDir = path.join(RIGS_TOPOLOGY_DIR, rigName, 'seats');
      try {
        const seats = await fs.readdir(seatsDir);
        for (const seatName of seats) {
          if (seatName.startsWith('.')) continue;
          const fullSeatId = `${seatName}@${rigName}`;
          const seatPath = path.join(seatsDir, seatName);
          try {
            const files = await fs.readdir(seatPath);
            let count = 0;
            let recapSnippet = '';
            if (files.includes('recap-superseded')) {
              try {
                const sup = await fs.readdir(path.join(seatPath, 'recap-superseded'));
                count += sup.filter(f => !f.startsWith('.')).length;
              } catch {}
            }
            if (files.includes('RECAP.md')) {
              count += 1;
              try {
                const content = await fs.readFile(path.join(seatPath, 'RECAP.md'), 'utf-8');
                const firstLine = content.split('\n').find(l => l.trim().length > 0 && !l.startsWith('#')) || '';
                recapSnippet = firstLine.slice(0, 160);
              } catch {}
            }
            result[fullSeatId] = {
              compactionsCount: count,
              recapSnippet: recapSnippet
            };
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return result;
}

let cachedRigs = { ts: 0, data: [] };
async function getRunningRigs() {
  if (Date.now() - cachedRigs.ts < 8000 && Array.isArray(cachedRigs.data) && cachedRigs.data.length > 0) {
    return cachedRigs.data;
  }
  const rigs = await safeJsonExec(RIG_BIN, ['ps', '--json']);
  if (Array.isArray(rigs) && rigs.length > 0) {
    cachedRigs = { ts: Date.now(), data: rigs };
    return rigs;
  }
  return cachedRigs.data || [];
}

async function fetchDaemonJson(endpoint) {
  try {
    const res = await fetch(`${DAEMON_URL}${endpoint}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function safeJsonExec(bin, args) {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 10000, maxBuffer: 15 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

async function safeTextExec(bin, args) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 8000, maxBuffer: 5 * 1024 * 1024 });
    return stdout || stderr || '';
  } catch (err) {
    return (err && err.stdout) || (err && err.stderr) || (err && err.message) || '';
  }
}

async function readRecentDecisions(limit = 12, nodes = []) {
  try {
    let decisionsDir = process.env.OPENRIG_DECISIONS_DIR;
    if (!decisionsDir) {
      for (const n of nodes) {
        if (n && n.cwd) {
          const candidate = path.join(n.cwd, 'decisions');
          try {
            const st = await fs.stat(candidate);
            if (st.isDirectory()) { decisionsDir = candidate; break; }
          } catch {}
        }
      }
    }
    if (!decisionsDir) {
      decisionsDir = DECISIONS_DIR;
    }
    const files = (await fs.readdir(decisionsDir))
      .filter(f => f.endsWith('.tsv'))
      .sort()
      .reverse();
    const rows = [];
    for (const file of files.slice(0, 2)) {
      const content = await fs.readFile(path.join(decisionsDir, file), 'utf-8');
      const lines = content.trim().split('\n').reverse();
      for (const line of lines) {
        if (!line.trim() || line.startsWith('время\t')) continue;
        const cols = line.split('\t');
        if (cols.length >= 4) {
          rows.push({
            dateFile: file.replace('.tsv', ''),
            time: cols[0] || '',
            slice: cols[1] || '',
            decision: cols[2] || '',
            reason: cols[3] || '',
            evidence: cols[4] || '',
            outcome: cols[5] || ''
          });
          if (rows.length >= limit) return rows;
        }
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function computeHistoryStats(allQueue) {
  if (!Array.isArray(allQueue)) return { pairCounts: {}, pairEnvelopes: {}, coderStats: {}, sliceStats: {}, nodeTraffic: {} };
  const pairCounts = {};
  const pairEnvelopes = {};
  const sliceMap = {};
  const nodeTraffic = {};

  for (const q of allQueue) {
    const src = q.sourceSession || 'unknown';
    const dst = q.destinationSession || 'unknown';
    const sliceTag = (q.tags || []).find(t => t.startsWith('slice:'));
    const sName = sliceTag ? sliceTag.replace('slice:', '') : '';

    if (src && src !== 'unknown') {
      if (!nodeTraffic[src]) nodeTraffic[src] = { in: 0, out: 0 };
      nodeTraffic[src].out += 1;
    }
    if (dst && dst !== 'unknown') {
      if (!nodeTraffic[dst]) nodeTraffic[dst] = { in: 0, out: 0 };
      nodeTraffic[dst].in += 1;
    }

    if (src !== dst) {
      const key = [src, dst].sort().join(' <-> ');
      pairCounts[key] = (pairCounts[key] || 0) + 1;
      if (!pairEnvelopes[key]) pairEnvelopes[key] = [];
      if (pairEnvelopes[key].length < 4) {
        pairEnvelopes[key].push({
          id: q.qitemId || q.id || '',
          from: src,
          to: dst,
          slice: sName,
          state: q.state || 'done',
          summary: q.summary || '',
          updatedAt: q.updatedAt || q.createdAt || ''
        });
      }
    }
    if (sliceTag) {
      if (!sliceMap[sName]) {
        sliceMap[sName] = { slice: sName, turns: 0, checkRounds: 0, coders: new Set(), lastSummary: q.summary || '' };
      }
      sliceMap[sName].turns += 1;
      if (dst.startsWith('dev-check@')) sliceMap[sName].checkRounds += 1;
      if (src.startsWith('dev-coder')) sliceMap[sName].coders.add(src);
      if (dst.startsWith('dev-coder')) sliceMap[sName].coders.add(dst);
    }
  }

  const coderSlices = {};
  for (const s of Object.values(sliceMap)) {
    const rounds = Math.max(1, s.checkRounds);
    for (const c of s.coders) {
      if (!coderSlices[c]) coderSlices[c] = [];
      coderSlices[c].push({ slice: s.slice, rounds, turns: s.turns });
    }
  }

  const coderStats = {};
  for (const [coder, list] of Object.entries(coderSlices)) {
    const roundsArr = list.slice(0, 6).map(x => x.rounds);
    const avg = roundsArr.length
      ? Number((roundsArr.reduce((a, b) => a + b, 0) / roundsArr.length).toFixed(1))
      : 1.0;
    const firstPass = roundsArr.length
      ? Math.round((roundsArr.filter(r => r === 1).length / roundsArr.length) * 100)
      : 100;
    const returnCount = roundsArr.filter(r => r > 1).length;
    coderStats[coder] = {
      avgRounds: avg,
      firstPassPct: `${firstPass}%`,
      recentRounds: roundsArr,
      sliceCount: list.length,
      returnCount
    };
  }

  return {
    pairCounts,
    pairEnvelopes,
    coderStats,
    nodeTraffic,
    ganttItems: buildGanttItems(allQueue),
    sliceStats: Object.fromEntries(
      Object.entries(sliceMap).map(([k, v]) => [k, { ...v, coders: Array.from(v.coders) }])
    )
  };
}

const GANTT_OPEN_STATES = new Set(['pending', 'in-progress', 'claimed']);
const GANTT_STALE_OPEN_MS = 6 * 3600 * 1000;

function isGanttSystemNoise(q) {
  const id = q.qitemId || q.id || '';
  if (id.startsWith('qitem-opgate-')) return true;
  if (q.sourceSession === 'operator-change-detector@external') return true;
  if (Array.isArray(q.tags) && q.tags.includes('stuck-sweep-finding')) return true;
  return false;
}

function buildGanttItems(allQueue) {
  if (!Array.isArray(allQueue)) return [];
  const rows = allQueue.filter(q => q && q.destinationSession && (q.tsCreated || q.createdAt) && !isGanttSystemNoise(q));

  // Union-find over qitem links (handoff / recovery-for) to group untagged rows into chains
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const union = (a, b) => {
    if (!a || !b) return;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const q of rows) {
    const id = q.qitemId || q.id;
    if (!id) continue;
    if (!parent.has(id)) parent.set(id, id);
    for (const ref of [q.handedOffFrom, q.handedOffTo]) {
      if (typeof ref === 'string' && ref.startsWith('qitem-')) union(ref, id);
    }
    for (const t of (q.tags || [])) {
      const m = /^recovery-for:(qitem-[\w-]+)$/.exec(t);
      if (m) union(m[1], id);
    }
  }

  // Track next task createdAt per destinationSession to cap stale superseded open rows
  const byDestTimes = new Map();
  for (const q of rows) {
    const t = Date.parse(q.tsCreated || q.createdAt || '');
    if (!Number.isFinite(t)) continue;
    if (!byDestTimes.has(q.destinationSession)) byDestTimes.set(q.destinationSession, []);
    byDestTimes.get(q.destinationSession).push(t);
  }
  for (const arr of byDestTimes.values()) arr.sort((a, b) => a - b);

  const nowMs = Date.now();
  return rows.map(q => {
    const id = q.qitemId || q.id || '';
    const sliceTag = (q.tags || []).find(t => typeof t === 'string' && t.startsWith('slice:'));
    const slice = sliceTag ? sliceTag.slice('slice:'.length) : '';
    const state = q.state || 'done';
    const createdStr = q.tsCreated || q.createdAt || null;
    const createdMs = Date.parse(createdStr || '');
    const updatedStr = q.closedAt || q.tsUpdated || q.updatedAt || null;
    const lastTouchMs = Date.parse(updatedStr || q.claimedAt || createdStr || '');

    const destTimes = byDestTimes.get(q.destinationSession) || [];
    const nextCreatedMs = Number.isFinite(createdMs) ? destTimes.find(t => t > createdMs) : undefined;
    const hasLaterTask = Number.isFinite(nextCreatedMs);
    const isStaleOpen = Number.isFinite(lastTouchMs) && (nowMs - lastTouchMs > GANTT_STALE_OPEN_MS);

    let endAt = null;
    if (!GANTT_OPEN_STATES.has(state)) {
      endAt = updatedStr || q.claimedAt || createdStr;
    } else if (hasLaterTask || isStaleOpen) {
      endAt = updatedStr || (hasLaterTask ? new Date(nextCreatedMs).toISOString() : null) || q.claimedAt || createdStr;
    }

    return {
      id,
      from: q.sourceSession || '',
      to: q.destinationSession,
      chain: slice ? `slice:${slice}` : `q:${id ? find(id) : id}`,
      slice,
      summary: (q.summary || '').slice(0, 240),
      state,
      createdAt: createdStr,
      claimedAt: q.claimedAt || null,
      endAt
    };
  });
}

let cachedHistory = { ts: 0, data: null };
async function getHistoryStats() {
  if (Date.now() - cachedHistory.ts < 20000 && cachedHistory.data) {
    return cachedHistory.data;
  }
  const allQueue = await safeJsonExec(RIG_BIN, ['queue', 'list', '-a', '-A', '--limit', '800', '--json']);
  const data = computeHistoryStats(allQueue);
  cachedHistory = { ts: Date.now(), data };
  return data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // 1. Live telemetry endpoint — directly queries OpenRig Daemon /api/rigs/:id/nodes (exact same source as TUI!)
  if (url.pathname === '/api/telemetry') {
    const requestedRig = url.searchParams.get('rig') || 'all';
    const allRigs = await getRunningRigs();

    // Determine target rigs to fetch from daemon
    const targetRigs = (requestedRig === 'all' || !requestedRig)
      ? allRigs
      : allRigs.filter(r => r.rigId === requestedRig || r.name === requestedRig || r.rigName === requestedRig);

    // Fallback if no rigs found via `rig ps --json`: query daemon /api/rigs directly
    let effectiveRigs = targetRigs;
    if (effectiveRigs.length === 0) {
      const daemonRigs = await fetchDaemonJson('/api/rigs');
      if (Array.isArray(daemonRigs)) {
        const mapped = daemonRigs
          .filter(r => r && (r.id || r.rigId))
          .map(r => ({
            rigId: r.id || r.rigId,
            name: r.name || r.rigName || r.id,
            rigName: r.name || r.rigName || r.id
          }));
        effectiveRigs = (requestedRig === 'all' || !requestedRig)
          ? mapped
          : mapped.filter(r => r.rigId === requestedRig || r.name === requestedRig);
      }
    }

    const nodesPromises = effectiveRigs.map(r => fetchDaemonJson(`/api/rigs/${r.rigId}/nodes`));
    const parkedPromises = effectiveRigs.map(r => safeJsonExec(RIG_BIN, ['parked', '--rig', r.name || r.rigName, '--json']));

    const [
      nodesArrays,
      parkedArrays,
      activeQueue,
      history,
      seatCompactions
    ] = await Promise.all([
      Promise.all(nodesPromises),
      Promise.all(parkedPromises),
      safeJsonExec(RIG_BIN, ['queue', 'list', '-A', '--json']),
      getHistoryStats(),
      readSeatCompactions()
    ]);

    const nodes = nodesArrays.flatMap(arr => Array.isArray(arr) ? arr : []);
    const [decisions, usageReport] = await Promise.all([
      readRecentDecisions(15, nodes),
      buildSeatUsageReport(nodes)
    ]);

    const guidanceMap = Object.assign({}, DEFAULT_SEAT_GUIDANCE);
    for (const node of nodes) {
      const seatName = node.canonicalSessionName || node.logicalId;
      if (seatName && !guidanceMap[seatName]) {
        guidanceMap[seatName] = await resolveSeatGuidance(seatName, node);
      }
    }

    const parkedSeats = {};
    for (const p of parkedArrays) {
      if (p && p.rig && Array.isArray(p.rig.seats)) {
        for (const s of p.rig.seats) {
          if (s.sessionName) {
            parkedSeats[s.sessionName] = {
              parked: s.parked === true,
              reason: s.reason || '',
              heldCount: (s.obligations && s.obligations.heldCount) || 0,
              openCount: (s.obligations && s.obligations.openCount) || 0,
              unhealthyHeldCount: (s.obligations && s.obligations.unhealthyHeldCount) || 0
            };
          }
        }
      }
    }

    // Update latest per-seat baselines & reconcile pending action postconditions
    for (const node of nodes) {
      const seatId = node && node.canonicalSessionName;
      if (seatId) {
        boundedMapSet(latestSeatBaselines, seatId, extractSeatBaseline(node, parkedSeats[seatId] || null), MAX_GUIDANCE_CACHE);
      }
    }
    actionAudit.reconcileWithTelemetry(nodes, parkedSeats);

    const payload = {
      timestamp: new Date().toISOString(),
      requestedRig,
      availableRigs: allRigs.map(r => ({
        id: r.rigId,
        name: r.name || r.rigName,
        status: r.status,
        nodeCount: r.nodeCount,
        runningCount: r.runningCount,
        activeCount: r.activeCount,
        hasWorkCount: r.hasWorkCount
      })),
      nodes,
      activeQueue: Array.isArray(activeQueue) ? activeQueue : [],
      decisions,
      history,
      parkedSeats,
      seatCompactions: seatCompactions || {},
      seatGuidance: guidanceMap,
      seatUsage: usageReport.seatUsage,
      fleetUsageSummary: usageReport.fleetUsageSummary,
      actionAudit: actionAudit.list(30),
      intelligence: fleetIntelligence.getLatestReport(requestedRig)
    };

    // Asynchronously ingest snapshot into Fleet Intelligence engine (zero blocking!)
    setImmediate(() => {
      fleetIntelligence.ingestSnapshot(payload);
    });

    await sendJson(req, res, 200, payload);
    return;
  }

  // 1.1 Dedicated Fleet Intelligence recommendations & scorecards endpoint
  if (url.pathname === '/api/intelligence/recommendations') {
    const requestedRig = url.searchParams.get('rig') || 'all';
    const report = fleetIntelligence.getLatestReport(requestedRig);
    await sendJson(req, res, 200, report);
    return;
  }

  // 1.2 Action Audit Log endpoint (read-only)
  if (url.pathname === '/api/audit') {
    const seat = url.searchParams.get('seat') || null;
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    await sendJson(req, res, 200, {
      timestamp: new Date().toISOString(),
      records: actionAudit.list(limit, seat)
    });
    return;
  }

  // 2. Live tmux terminal capture endpoint
  if (url.pathname === '/api/capture') {
    const seat = url.searchParams.get('seat') || 'dev-owner@core-platform';
    const lines = url.searchParams.get('lines') || '38';
    if (!/^[a-zA-Z0-9._@-]+$/.test(seat)) {
      await sendJson(req, res, 400, { error: 'Invalid seat identifier' });
      return;
    }
    const screen = await safeTextExec(RIG_BIN, ['capture', seat, '--lines', String(Number(lines) || 38)]);
    await sendJson(req, res, 200, { seat, timestamp: new Date().toISOString(), screen });
    return;
  }

  // 3. Interactive send command/keystroke to seat endpoint
  // Guarded: same-origin only (no CORS grant) + per-process token from the served page.
  if (url.pathname === '/api/send') {
    const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
    const origin = req.headers.origin || '';
    const deny = async (code, error) => {
      await sendJson(req, res, code, { ok: false, error });
    };
    if (req.method !== 'POST') return deny(405, 'Method not allowed');
    if (!allowedOrigins.has(origin)) return deny(403, 'Forbidden origin');
    if (!tokenMatches(req.headers['x-deck-token'])) return deny(403, 'Bad or missing deck token');
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return deny(415, 'JSON only');

    {
      let bodyStr = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (tooLarge) return;
        bodyStr += chunk;
        if (bodyStr.length > 64 * 1024) {
          tooLarge = true;
          sendJson(req, res, 413, { ok: false, error: 'Payload too large' }).catch(() => {});
          req.resume();
        }
      });

      req.on('end', async () => {
        if (tooLarge) return;
        try {
          const payload = JSON.parse(bodyStr || '{}');
          const seat = String(payload.seat || '').trim();
          const text = String(payload.text || '');
          const type = String(payload.type || 'msg').trim(); // 'msg' | 'raw' | 'key' | 'interact'
          const actionId = String(payload.actionId || '').trim();
          const baseline = latestSeatBaselines.get(seat) || null;

          if (!/^[a-zA-Z0-9._@-]+$/.test(seat)) {
            await sendJson(req, res, 400, { ok: false, error: 'Invalid seat identifier' });
            return;
          }

          let output = '';
          if (type === 'key') {
            // Specific tmux keystrokes validated against strict allowlist (prevents flag injection)
            const keyArgs = parseAllowedTmuxKeys(text);
            if (!keyArgs) {
              actionAudit.record({ actionId, seatId: seat, type, payload: text, httpStatus: 400, ok: false, baseline });
              await sendJson(req, res, 400, { ok: false, error: 'Disallowed tmux keystroke' });
              return;
            }
            output = await safeTextExec(TMUX_BIN, ['send-keys', '-t', seat, ...keyArgs]);
          } else if (type === 'raw') {
            // Harness-aware hygiene and deduplication:
            // 1. Normalize and deduplicate repeated slash commands (e.g. /compact/compact -> /compact)
            let cleanText = text.trim();
            cleanText = cleanText.replace(/(\/[a-zA-Z0-9_-]+)\1+/g, '$1');

            // 2. Pi harness guard: Pi (DeepSeek) does not support slash commands
            if ((seat.includes('coder3') || seat.includes('pi')) && cleanText.startsWith('/compact')) {
              actionAudit.record({ actionId, seatId: seat, type, payload: cleanText, httpStatus: 400, ok: false, baseline });
              await sendJson(req, res, 400, { ok: false, error: 'Харнес Pi (DeepSeek) не поддерживает команду /compact. Используйте ротацию сиденья.' });
              return;
            }

            // 3. Prompt line hygiene: Send C-u first to clear any dirty/pending input in the terminal buffer!
            // This prevents duplicate concatenation like /compact/compact when prompt already had a slash.
            await safeTextExec(TMUX_BIN, ['send-keys', '-t', seat, 'C-u']);
            await safeTextExec(TMUX_BIN, ['send-keys', '-t', seat, '-l', cleanText]);
            output = await safeTextExec(TMUX_BIN, ['send-keys', '-t', seat, 'Enter']);
          } else if (type === 'interact') {
            output = await safeTextExec(RIG_BIN, [
              'send',
              '--dangerously-interact',
              '--reason', 'Dashboard interactive prompt answer',
              seat,
              text
            ]);
            if (!output || output.includes('Error') || output.includes('refused')) {
              await safeTextExec(TMUX_BIN, ['send-keys', '-t', seat, '-l', text]);
              output += '\n' + await safeTextExec(TMUX_BIN, ['send-keys', '-t', seat, 'Enter']);
            }
          } else {
            // Standard rig send with messaging envelope
            output = await safeTextExec(RIG_BIN, ['send', seat, text]);
          }

          const auditRec = actionAudit.record({ actionId, seatId: seat, type, payload: text, httpStatus: 200, ok: true, baseline });
          await sendJson(req, res, 200, { ok: true, execId: auditRec.execId, seat, type, text, output: (output || '').trim() });
        } catch (err) {
          await sendJson(req, res, 500, { ok: false, error: err.message });
        }
      });
      return;
    }
  }

  // 3. Static files (strictly contained within __dirname, safe extensions only)
  const staticTarget = resolveSafeStaticPath(__dirname, url.pathname);
  if (!staticTarget) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  const { resolved: filePath, rel: safeRel, ext } = staticTarget;
  try {
    let data = await fs.readFile(filePath);
    if (safeRel === 'index.html') {
      data = Buffer.from(
        data.toString('utf-8').replace('<head>', `<head>\n  <meta name="deck-token" content="${DECK_TOKEN}">`)
      );
    }
    const mime =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.md' ? 'text/markdown; charset=utf-8' :
      ext === '.js' ? 'text/javascript; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.svg' ? 'image/svg+xml' :
      ext === '.png' ? 'image/png' :
      'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

const ALLOWED_TMUX_KEY_RE = /^([1-9]|[a-zA-Z]|Enter|Escape|Tab|Space|BSpace|Up|Down|Left|Right|C-c|C-u|C-d|C-z|C-l)$/;
const ALLOWED_STATIC_EXTS = new Set(['.html', '.css', '.js', '.json', '.svg', '.png', '.ico', '.md', '.txt']);

function parseAllowedTmuxKeys(text) {
  const keys = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (keys.length === 0 || keys.length > 6) return null;
  for (const k of keys) {
    if (k.startsWith('-') || !ALLOWED_TMUX_KEY_RE.test(k)) return null;
  }
  return keys;
}

function resolveSafeStaticPath(baseDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || '/'));
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const segments = rel.split(/[\\/]+/);
  if (segments.some(s => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
    return null;
  }
  const baseResolved = path.resolve(baseDir);
  const resolved = path.resolve(baseResolved, rel);
  const rootPrefix = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
  if (!resolved.startsWith(rootPrefix)) return null;
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_STATIC_EXTS.has(ext)) return null;
  return { resolved, rel, ext };
}

export {
  buildGanttItems,
  isGanttSystemNoise,
  readTranscriptTokenUsage,
  buildSeatUsageReport,
  getModelPricing,
  boundedMapSet,
  parseAllowedTmuxKeys,
  resolveSafeStaticPath,
  transcriptUsageCache,
  seatGuidanceCache
};

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`💠 RigCommander // Neural Command Deck v3.1 at http://127.0.0.1:${PORT}`);
  });
}
