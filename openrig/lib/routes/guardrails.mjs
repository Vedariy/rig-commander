import { normalizeGanttSpans, buildHandoffSequenceModel } from '../../assets/domain/gantt-model.js';

export function registerGuardrailRoutes({ get, post }, {
  guardrailStatus, actionAudit, circuitBreaker, telegramBridge, aiEvaluator, getFleetSnapshot, captureSeatScreen
}) {
  get('/api/guardrails', guardrailStatus);

  get('/api/audit', async ({ url, json }) => {
    const seat = url.searchParams.get('seat') || null;
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    await json(200, {
      timestamp: new Date().toISOString(),
      records: actionAudit.list(limit, seat)
    });
  });

  post('/api/guardrails/config', async ({ body, json }) => {
    circuitBreaker.updateConfig(body);
    await json(200, { ok: true, breaker: circuitBreaker.getState() });
  });

  post('/api/guardrails/reset', async ({ body, json }) => {
    const seatId = body.seatId ? String(body.seatId).trim() : null;
    await json(200, { ok: true, breaker: circuitBreaker.reset(seatId) });
  });

  post('/api/guardrails/telegram', async ({ body, json }) => {
    const act = String(body.action || 'connect');
    if (act === 'disconnect') {
      await json(200, { ok: true, telegram: telegramBridge.disconnect() });
      return;
    }
    if (act === 'test') {
      const resTest = await telegramBridge.sendTestMessage();
      await json(200, { ok: true, result: resTest, telegram: telegramBridge.getStatus() });
      return;
    }
    const botToken = String(body.botToken || '').trim();
    const chatId = String(body.chatId || '').trim();
    if (!botToken || !chatId) {
      await json(400, { ok: false, error: 'Bot token and Chat ID are required' });
      return;
    }
    const status = telegramBridge.configure({ botToken, chatId });
    await json(200, { ok: true, telegram: status });
  });

  get('/api/evaluator/status', async ({ json }) => {
    await json(200, {
      timestamp: new Date().toISOString(),
      ...aiEvaluator.getStatus()
    });
  });

  post('/api/evaluator/config', async ({ body, json }) => {
    const config = aiEvaluator.updateConfig(body);
    await json(200, { ok: true, config, stats: aiEvaluator.router.getUsageStats() });
  });

  post('/api/evaluator/models', async ({ body, json }) => {
    const slotRole = body.slot === 'system2' ? 'system2' : 'system1';
    const result = await aiEvaluator.discoverSlotModels(slotRole, body.binding || null);
    await json(200, { ok: true, slot: slotRole, ...result });
  });

  post('/api/evaluator/run', async ({ body, json }) => {
    const scope = ['seat', 'slice', 'fleet'].includes(body.scope) ? body.scope : 'seat';
    const targetId = String(body.targetId || '').trim().slice(0, 140);
    const requestedTier = ['auto', 'heuristic', 'system1', 'system2'].includes(body.tier) ? body.tier : 'auto';
    const lang = body.lang === 'en' ? 'en' : 'ru';
    const forceRefresh = Boolean(body.forceRefresh);

    const snap = getFleetSnapshot() || {};
    const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
    const openQueue = Array.isArray(snap.activeQueue) ? snap.activeQueue : [];
    const ganttItems = Array.isArray(snap.history?.ganttItems) ? snap.history.ganttItems : [];
    const findings = Array.isArray(snap.intelligence?.allFindings) ? snap.intelligence.allFindings : [];
    const parkedMap = snap.parkedSeats || {};

    const seatNode = scope === 'seat'
      ? (nodes.find(n => (n.canonicalSessionName || n.logicalId) === targetId) || null)
      : null;
    const seatWithParked = seatNode
      ? { ...seatNode, parkedData: parkedMap[seatNode.canonicalSessionName] || seatNode.parkedData || null }
      : null;

    let handoffSequence = null;
    let sliceMetrics = null;
    if (scope === 'slice' && ganttItems.length > 0) {
      const gModel = normalizeGanttSpans(ganttItems, { nowMs: Date.now(), windowH: 24, hideNoise: true });
      const chainKey = targetId.startsWith('slice:') || targetId.startsWith('q:') ? targetId : `slice:${targetId}`;
      handoffSequence = buildHandoffSequenceModel(gModel.allWindowSpans, { focusChain: chainKey });
      const chainSpans = gModel.allWindowSpans.filter(sp => sp.chain === handoffSequence.activeChain || sp.slice === targetId);
      const maxWaitMs = chainSpans.reduce((mx, sp) => Math.max(mx, sp.waitMs || 0), 0);
      const totalWaitMs = chainSpans.reduce((acc, sp) => acc + (sp.waitMs || 0), 0);
      const totalWorkMs = chainSpans.reduce((acc, sp) => acc + (sp.workMs || 0), 0);
      sliceMetrics = {
        qaRounds: handoffSequence.stats?.bounceCount ? handoffSequence.stats.bounceCount + 1 : 1,
        bounceCount: handoffSequence.stats?.bounceCount || 0,
        maxWaitMin: Math.round(maxWaitMs / 60_000),
        wwr: totalWorkMs > 0 ? +(totalWaitMs / totalWorkMs).toFixed(2) : 0
      };
    }

    let screenText = '';
    const screenBySeat = {};
    if (scope === 'seat' && targetId && /^[a-zA-Z0-9._@-]+$/.test(targetId)) {
      screenText = await captureSeatScreen(targetId, requestedTier === 'system2' ? 72 : 48).catch(() => '');
      if (screenText) screenBySeat[targetId] = screenText;
    } else if (scope === 'slice' && handoffSequence && Array.isArray(handoffSequence.participants)) {
      const topSeats = handoffSequence.participants.filter(s => /^[a-zA-Z0-9._@-]+$/.test(s)).slice(0, 3);
      const captures = await Promise.all(topSeats.map(s => captureSeatScreen(s, 52).catch(() => '')));
      topSeats.forEach((s, i) => { if (captures[i]) screenBySeat[s] = captures[i]; });
    }

    const verdict = await aiEvaluator.runEvaluation({
      scope,
      targetId: targetId || (scope === 'fleet' ? 'fleet' : ''),
      requestedTier,
      forceRefresh,
      seat: seatWithParked,
      nodes,
      openQueue,
      ganttItems,
      handoffSequence,
      findings,
      screenText,
      screenBySeat,
      auditRecords: actionAudit.list(20, scope === 'seat' ? targetId : null),
      seatCompactions: snap.seatCompactions || {},
      decisions: snap.decisions || [],
      sliceMetrics,
      fleetKpis: {
        healthScore: snap.intelligence?.healthScore ?? null,
        burnUsdPerHour: circuitBreaker.getState()?.burnUsdPerHour ?? 0
      },
      lang
    });

    await json(200, { ok: true, verdict, stats: aiEvaluator.router.getUsageStats() });
  });
}
