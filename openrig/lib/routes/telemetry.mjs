export function registerTelemetryRoutes({ get }, {
  getTelemetryBundle, getSerializedTelemetryVariant, markTelemetryClient, fleetIntelligence,
  fetchQueueItemContextDetail, sseHub, captureSeatScreen
}) {
  get('/api/telemetry', async ({ req, res, url }) => {
    const requestedRig = url.searchParams.get('rig') || 'all';
    const clientHistoryRev = url.searchParams.get('historyRev') || '';
    const clientGuidanceRev = url.searchParams.get('guidanceRev') || '';
    const clientGitRadarRev = url.searchParams.get('gitRadarRev') || '';
    const forceRefresh = url.searchParams.get('force') === '1';
    markTelemetryClient();

    const bundle = await getTelemetryBundle(requestedRig, { forceRefresh });
    const skipHistory = Boolean(clientHistoryRev && clientHistoryRev === bundle.historyRev);
    const skipGuidance = Boolean(clientGuidanceRev && clientGuidanceRev === bundle.guidanceRev);
    const skipGitRadar = Boolean(clientGitRadarRev && clientGitRadarRev === bundle.gitRadarRev);
    const serialized = await getSerializedTelemetryVariant(bundle, { skipHistory, skipGuidance, skipGitRadar });

    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (acceptEncoding.includes('gzip') && serialized.gzip) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-store'
      });
      res.end(serialized.gzip);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(serialized.json);
  });

  get('/api/intelligence/recommendations', async ({ url, json }) => {
    const requestedRig = url.searchParams.get('rig') || 'all';
    const report = fleetIntelligence.getLatestReport(requestedRig);
    await json(200, report);
  });

  async function queueContext({ url, json }) {
    const id = url.searchParams.get('id') || '';
    const detail = await fetchQueueItemContextDetail(id);
    await json(detail.statusCode || (detail.ok ? 200 : 400), detail);
  }

  get('/api/queue/item', queueContext);
  get('/api/queue/context', queueContext);

  get('/api/events', async ({ req, res, url }) => {
    const requestedRig = url.searchParams.get('rig') || 'all';
    markTelemetryClient();
    sseHub.subscribeEvents(req, res, { rigKey: requestedRig });
  });

  get('/api/capture/stream', async ({ req, res, url }) => {
    const seat = url.searchParams.get('seat') || '';
    const lines = url.searchParams.get('lines') || '80';
    markTelemetryClient();
    sseHub.subscribeTmux(req, res, { seatId: seat, lines });
  });

  get('/api/capture', async ({ url, json }) => {
    const seat = url.searchParams.get('seat') || 'dev-owner@core-platform';
    const lines = url.searchParams.get('lines') || '38';
    if (!/^[a-zA-Z0-9._@-]+$/.test(seat)) {
      await json(400, { error: 'Invalid seat identifier' });
      return;
    }
    const screen = await captureSeatScreen(seat, lines);
    await json(200, { seat, timestamp: new Date().toISOString(), screen });
  });
}
