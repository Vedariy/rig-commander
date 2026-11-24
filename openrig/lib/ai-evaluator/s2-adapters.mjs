/**
 * System 2 Deliberative Generative Adapters (November 2026 Lineup, Zero npm deps).
 * Supports:
 *   1. gemini_native    -> Google Gemini 4 Hydrogen / Carbon (thinkingConfig.thinkingLevel)
 *   2. openai_compat    -> GLM-5.3 (thinking.type), GPT-6.2 Sol/Astra (reasoning_effort), MLX, LM Studio, Proxy
 *   3. ollama_native    -> Local Ollama/MLX Qwen3.8-27B, Qwen3.6-35B-A3B MoE, Qwen3.5-9B, Liquid LFM2.5
 *   4. anthropic_native -> Claude Sonnet 5.5, Opus 5.5, Fable 5.2
 *   5. mock_demo        -> Deterministic offline demo reasoning report
 * Also provides live model discovery across /v1/models, /api/tags, and /v1beta/models.
 */

import {
  EVAL_S2_DIALECTS,
  EVAL_S1_DIALECTS,
  isLoopbackEndpoint,
  extractStructuredJson
} from '../../assets/domain/evaluator-model.js';

function estimateS2CostUsd(model, inTok, outTok, isLocal) {
  if (isLocal) return 0;
  const m = String(model || '').toLowerCase();
  let rates = { in: 1.5, out: 7.5 }; // Gemini 4 Hydrogen baseline
  if (m.includes('carbon') || m.includes('argon') || m.includes('opus')) rates = { in: 4.0, out: 20.0 };
  else if (m.includes('fable') || m.includes('astra')) rates = { in: 8.0, out: 40.0 };
  else if (m.includes('sol') || m.includes('sonnet')) rates = { in: 2.0, out: 10.0 };
  else if (m.includes('flash') || m.includes('luna') || m.includes('haiku')) rates = { in: 0.15, out: 0.60 };
  else if (m.includes('glm-5')) rates = { in: 0.8, out: 3.2 };
  return +(((inTok * rates.in + outTok * rates.out) / 1_000_000)).toFixed(6);
}

/**
 * 1. Google Gemini Native API (supports Gemini 4 Hydrogen / Carbon thinkingConfig.thinkingLevel).
 */
export async function callGeminiNative(binding, { systemPrompt, userPrompt, signal, fetchImpl = fetch }) {
  const base = String(binding.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const model = String(binding.model || 'gemini-4-hydrogen').replace(/^models\//, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const headers = { 'Content-Type': 'application/json' };
  if (binding.apiKey) headers['x-goog-api-key'] = binding.apiKey;

  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens: 1200,
    responseMimeType: 'application/json'
  };
  if (/gemini-4/i.test(model) && binding.thinkingLevel && binding.thinkingLevel !== 'none') {
    generationConfig.thinkingConfig = { thinkingLevel: binding.thinkingLevel };
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig
  };

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from Gemini API${txt ? `: ${txt.slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('\n')
    || parts.map(p => p.text || '').join('\n');
  const parsed = extractStructuredJson(textPart);
  const inTok = Number(data.usageMetadata?.promptTokenCount || Math.ceil(userPrompt.length / 4));
  const outTok = Number(data.usageMetadata?.candidatesTokenCount || Math.ceil(textPart.length / 4));

  return {
    parsed,
    usage: { inputTokens: inTok, outputTokens: outTok, estUsd: estimateS2CostUsd(model, inTok, outTok, isLoopbackEndpoint(base)) },
    model
  };
}

/**
 * 2. OpenAI-Compatible Chat Completions (GLM-5.3, GPT-6.2 Sol/Astra, MLX, LM Studio, LiteLLM, Subscription Proxies).
 */
export async function callOpenAiCompat(binding, { systemPrompt, userPrompt, signal, fetchImpl = fetch }) {
  const base = String(binding.baseUrl || '').replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const model = binding.model || 'gpt-6.2-sol';
  const headers = { 'Content-Type': 'application/json' };
  if (binding.apiKey) headers.Authorization = `Bearer ${binding.apiKey}`;

  const body = {
    model,
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
  if (/^glm-[45]/i.test(model) && binding.thinkingLevel && binding.thinkingLevel !== 'none') {
    body.thinking = { type: 'enabled' };
  } else if (/^gpt-6|^o[34]/i.test(model) && binding.thinkingLevel && binding.thinkingLevel !== 'none') {
    body.reasoning_effort = binding.thinkingLevel === 'xhigh' ? 'high' : binding.thinkingLevel;
  }

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from OpenAI-compat endpoint${txt ? `: ${txt.slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractStructuredJson(content);
  const inTok = Number(data.usage?.prompt_tokens || Math.ceil(userPrompt.length / 4));
  const outTok = Number(data.usage?.completion_tokens || Math.ceil(content.length / 4));

  return {
    parsed,
    usage: { inputTokens: inTok, outputTokens: outTok, estUsd: estimateS2CostUsd(model, inTok, outTok, isLoopbackEndpoint(base)) },
    model: data.model || model
  };
}

/**
 * 3. Local Ollama / MLX Native Chat API (Qwen3.8-27B, Qwen3.6-35B-A3B MoE, Qwen3.5-9B, Liquid LFM2.5).
 */
export async function callOllamaNative(binding, { systemPrompt, userPrompt, signal, fetchImpl = fetch }) {
  const base = String(binding.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const url = base.endsWith('/api/chat') ? base : `${base}/api/chat`;
  const model = binding.model || 'qwen3.8:27b';

  const body = {
    model,
    stream: false,
    format: 'json',
    options: { temperature: 0.2, num_predict: 1200 },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from Ollama${txt ? `: ${txt.slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const content = data?.message?.content || '';
  const parsed = extractStructuredJson(content);

  return {
    parsed,
    usage: {
      inputTokens: Number(data.prompt_eval_count || Math.ceil(userPrompt.length / 4)),
      outputTokens: Number(data.eval_count || Math.ceil(content.length / 4)),
      estUsd: 0
    },
    model: data.model || model
  };
}

/**
 * 4. Anthropic Messages API (Claude Sonnet 5.5, Opus 5.5, Fable 5.2).
 */
export async function callAnthropicNative(binding, { systemPrompt, userPrompt, signal, fetchImpl = fetch }) {
  const base = String(binding.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const url = base.endsWith('/v1/messages') ? base : `${base}/v1/messages`;
  const model = binding.model || 'claude-sonnet-5-5';
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01'
  };
  if (binding.apiKey) headers['x-api-key'] = binding.apiKey;

  const body = {
    model,
    max_tokens: 1200,
    temperature: 0.2,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from Anthropic API${txt ? `: ${txt.slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const content = (Array.isArray(data.content) ? data.content : [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
  const parsed = extractStructuredJson(content);
  const inTok = Number(data.usage?.input_tokens || Math.ceil(userPrompt.length / 4));
  const outTok = Number(data.usage?.output_tokens || Math.ceil(content.length / 4));

  return {
    parsed,
    usage: { inputTokens: inTok, outputTokens: outTok, estUsd: estimateS2CostUsd(model, inTok, outTok, isLoopbackEndpoint(base)) },
    model: data.model || model
  };
}

/**
 * 5. Deterministic Offline Demo System 2 Synthesizer (for /demo?track=evaluator).
 */
export function callMockDemoS2({ bundleObj = {}, tier0 = null, lang = 'ru' } = {}) {
  const isEn = lang === 'en';
  const scope = bundleObj.scope || 'seat';
  const targetSeat = tier0?.targetSeatId || bundleObj.participantSeats?.[0]?.seatId || 'dev-coder4@core-platform';
  const firstQitem = bundleObj.handoffFlow?.[0]?.qitemId || bundleObj.openQueue?.[0]?.qitemId || '';

  if (scope === 'slice' || (tier0?.facts?.qaRounds || 0) >= 2) {
    return {
      parsed: {
        riskLevel: 'needs_review',
        confidence: 0.91,
        headline: isEn
          ? 'Root cause: boundary limit +1 mismatch across 3 QA bounce rounds'
          : 'Первопричина: расхождение граничных условий (лимит +1) на 3 кругах QA',
        rootCause: isEn
          ? 'Handoff Flow shows coder fixed the write-race in round 1 but missed boundary limit +1 validation while context climbed above 70%, triggering repeated QA bounces.'
          : 'По Handoff Flow кодер закрыл гонку записи в 1-м круге, но на перегретом контексте (>70%) пропустил проверку лимита +1, что вызвало повторные возвраты от QA.',
        hypothesesChecked: [
          {
            hypothesis: isEn ? 'Context fatigue eroding boundary checklist adherence' : 'Усталость контекста (>70%) вымыла чеклист граничных проверок',
            verdict: 'confirmed',
            why: isEn ? 'QA bounces escalated after context exceeded 68%.' : 'Повторные возвраты совпали с нагревом контекста выше 68%.'
          },
          {
            hypothesis: isEn ? 'Deadlocked external dependency' : 'Внешняя блокировка стенда',
            verdict: 'rejected',
            why: isEn ? 'Unit and boundary tests ran locally without infra errors.' : 'Тесты границ выполнялись локально без ошибок среды.'
          }
        ],
        actionSteps: [
          {
            seatId: targetSeat,
            actionId: 'compact_context',
            rationale: isEn ? 'Compact coder context before final acceptance pass' : 'Сжать контекст кодера перед финальной приёмкой'
          },
          {
            seatId: targetSeat,
            actionId: 'open_gantt_slice',
            rationale: isEn ? 'Review bounce steps in Handoff Flow' : 'Проверить возвраты на Handoff Flow'
          }
        ],
        draftPrompt: isEn
          ? 'Before handing off to QA, run boundary checks (0, limit-1, limit, limit+1) from testing/boundary/values.json and include exact exit code in handoff note.'
          : 'Перед сдачей в QA прогони граничные значения (0, лимит-1, лимит, лимит+1) из testing/boundary/values.json и приложи точный exit code в handoff.',
        rulePatchSuggestion: isEn
          ? 'Add explicit pre-handoff boundary check reminder when coder context >= 65%.'
          : 'Добавить в чеклист сдачи обязательную сверку границ при контексте кодера >= 65%.',
        evidenceRefs: firstQitem ? [
          { source: 'gantt', ref: firstQitem, quote: isEn ? 'QA round 2 bounce: boundary limit +1' : 'Повторный QA: возврат (лимит +1)' }
        ] : [],
        unknowns: [
          isEn ? 'Full git diff outside the 55-line tmux tail was not inspected.' : 'Полный git diff за пределами 55 строк tmux не анализировался.'
        ]
      },
      usage: { inputTokens: 1450, outputTokens: 320, estUsd: 0 },
      model: 'gemini-4-hydrogen-demo'
    };
  }

  return {
    parsed: {
      riskLevel: tier0?.riskLevel || 'needs_review',
      confidence: 0.88,
      headline: isEn
        ? `System 2 synthesis for ${String(targetSeat).split('@')[0]}: clear idle queue explicitly`
        : `Синтез System 2 для ${String(targetSeat).split('@')[0]}: требуется явный разбор очереди`,
      rootCause: isEn
        ? 'Seat is sitting idle at a clean prompt while queue obligations remain pending; bare Enter will not trigger queue polling.'
        : 'Узел простаивает на чистом промпте при открытой очереди; пустой Enter не запускает проверку rig queue.',
      hypothesesChecked: [
        {
          hypothesis: isEn ? 'Idle prompt awaiting explicit instruction' : 'Чистый промпт ждёт явной инструкции',
          verdict: 'confirmed',
          why: isEn ? 'No active spinner or HITL menu in tmux excerpt.' : 'В хвосте tmux нет активного спиннера или HITL-меню.'
        }
      ],
      actionSteps: [
        {
          seatId: targetSeat,
          actionId: 'nudge_queue',
          rationale: isEn ? 'Send explicit rig queue list --owned prompt' : 'Отправить явный промпт rig queue list --owned'
        }
      ],
      draftPrompt: isEn
        ? 'Run `rig queue list --owned`, pick up the highest-priority real task, and close stale sweep entries.'
        : 'Выполни `rig queue list --owned`, возьми в работу приоритетную реальную задачу и закрой устаревшие служебные строки.',
      rulePatchSuggestion: null,
      evidenceRefs: firstQitem ? [{ source: 'queue', ref: firstQitem, quote: 'pending task waiting for pickup' }] : [],
      unknowns: []
    },
    usage: { inputTokens: 1120, outputTokens: 240, estUsd: 0 },
    model: 'gemini-4-hydrogen-demo'
  };
}

/**
 * Live model discovery for both S1 and S2 endpoints (GET /v1/models, /api/tags, /v1beta/models).
 */
export async function discoverEndpointModels(binding, { privacyMode = 'local_only', fetchImpl = fetch } = {}) {
  if (!binding || !binding.baseUrl || binding.dialect === 'disabled' || binding.dialect === 'mock_demo') {
    return { ok: true, reachable: binding?.dialect === 'mock_demo', models: [], note: 'No HTTP endpoint configured' };
  }
  const base = String(binding.baseUrl).replace(/\/+$/, '');
  if (privacyMode === 'local_only' && !isLoopbackEndpoint(base)) {
    return { ok: false, reachable: false, models: [], error: 'Blocked by local_only privacy mode' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  const headers = {};
  if (binding.apiKey) {
    if (binding.dialect === EVAL_S2_DIALECTS.GEMINI_NATIVE) headers['x-goog-api-key'] = binding.apiKey;
    else if (binding.dialect === EVAL_S2_DIALECTS.ANTHROPIC_NATIVE) {
      headers['x-api-key'] = binding.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${binding.apiKey}`;
    }
  }

  try {
    let url;
    if (binding.dialect === EVAL_S2_DIALECTS.OLLAMA_NATIVE || (binding.dialect === EVAL_S1_DIALECTS.EMBED_ROUTER && /11434/.test(base))) {
      url = `${base.replace(/\/api\/(chat|embed)$/i, '')}/api/tags`;
    } else if (binding.dialect === EVAL_S2_DIALECTS.GEMINI_NATIVE) {
      url = `${base}/v1beta/models`;
    } else if (binding.dialect === EVAL_S1_DIALECTS.SYSTEMONE) {
      url = `${base.replace(/\/v1\/systemone$/i, '')}/v1/models`;
    } else {
      url = base.endsWith('/models') ? base : `${base.replace(/\/chat\/completions$/i, '')}/models`;
    }

    const res = await fetchImpl(url, { method: 'GET', headers, signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, reachable: false, models: [], error: `HTTP ${res.status} on ${url}` };
    }
    const data = await res.json();
    let models = [];
    if (Array.isArray(data.models)) {
      models = data.models.map(m => ({
        id: String(m.name || m.id || '').replace(/^models\//, ''),
        sizeGb: typeof m.size === 'number' ? +(m.size / (1024 ** 3)).toFixed(1) : null
      })).filter(m => m.id);
    } else if (Array.isArray(data.data)) {
      models = data.data.map(m => ({ id: String(m.id || m.name || ''), sizeGb: null })).filter(m => m.id);
    }
    return { ok: true, reachable: true, models: models.slice(0, 40) };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      models: [],
      error: err?.name === 'AbortError' ? 'Connection timeout (2.5s)' : (err?.message || 'Offline')
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function invokeSystem2Slot(binding, { systemPrompt, userPrompt, bundleObj, tier0, lang = 'ru', privacyMode = 'local_only', fetchImpl = fetch } = {}) {
  const t0 = Date.now();
  if (!binding || !binding.enabled || binding.dialect === EVAL_S2_DIALECTS.DISABLED) {
    return { ok: false, skipped: true, reason: 'slot_disabled', durationMs: 0 };
  }
  if (binding.dialect === EVAL_S2_DIALECTS.MOCK_DEMO) {
    const out = callMockDemoS2({ bundleObj, tier0, lang });
    return { ok: true, ...out, durationMs: Math.max(45, Date.now() - t0) };
  }
  if (!binding.baseUrl) {
    return { ok: false, skipped: true, reason: 'missing_base_url', durationMs: 0 };
  }
  if (privacyMode === 'local_only' && !isLoopbackEndpoint(binding.baseUrl)) {
    return { ok: false, blocked: true, reason: 'privacy_local_only', durationMs: 0 };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), binding.timeoutMs || 40_000);
  try {
    let out;
    if (binding.dialect === EVAL_S2_DIALECTS.GEMINI_NATIVE) {
      out = await callGeminiNative(binding, { systemPrompt, userPrompt, signal: ctrl.signal, fetchImpl });
    } else if (binding.dialect === EVAL_S2_DIALECTS.OLLAMA_NATIVE) {
      out = await callOllamaNative(binding, { systemPrompt, userPrompt, signal: ctrl.signal, fetchImpl });
    } else if (binding.dialect === EVAL_S2_DIALECTS.ANTHROPIC_NATIVE) {
      out = await callAnthropicNative(binding, { systemPrompt, userPrompt, signal: ctrl.signal, fetchImpl });
    } else if (binding.dialect === EVAL_S2_DIALECTS.OPENAI_COMPAT) {
      out = await callOpenAiCompat(binding, { systemPrompt, userPrompt, signal: ctrl.signal, fetchImpl });
    } else {
      return { ok: false, skipped: true, reason: `unsupported_dialect:${binding.dialect}`, durationMs: 0 };
    }
    return { ok: true, ...out, durationMs: Math.max(1, Date.now() - t0) };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? `Timeout (${binding.timeoutMs || 40_000}ms)` : (err?.message || String(err)),
      durationMs: Math.max(1, Date.now() - t0)
    };
  } finally {
    clearTimeout(timer);
  }
}
