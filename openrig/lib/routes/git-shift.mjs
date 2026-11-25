import { fetchSeatGitDiff } from '../git-radar.mjs';
import { buildShiftDigest, formatShiftDigestMarkdown } from '../../assets/domain/shift-digest.js';

const GIT_DIFF_CACHE_TTL_MS = 5000;

export function registerGitShiftRoutes({ get, post }, {
  getPort, remoteAccess, selfUpdater, getFleetSnapshot, boundedMapSet, getTelemetryBundle, shiftHistory, actionAudit
}) {
  const gitDiffCache = new Map();

  get('/api/git/diff', async ({ url, json }) => {
    const seatId = String(url.searchParams.get('seat') || '').trim();
    const file = String(url.searchParams.get('file') || '').trim();
    if (!seatId || !/^[a-zA-Z0-9._@-]{2,140}$/.test(seatId)) {
      await json(400, { ok: false, error: 'Invalid seat identifier' });
      return;
    }
    const cacheKey = `${seatId}|${file}`;
    const cached = gitDiffCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < GIT_DIFF_CACHE_TTL_MS) {
      await json(200, { ...cached.payload, cached: true });
      return;
    }
    const snap = getFleetSnapshot() || {};
    const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
    const node = nodes.find(n => (n.canonicalSessionName || n.logicalId) === seatId) || null;
    if (!node || !node.cwd) {
      await json(404, { ok: false, error: `Workspace path unavailable for ${seatId}` });
      return;
    }
    const detail = await fetchSeatGitDiff({ seatId, cwd: node.cwd, file });
    if (detail.ok) {
      boundedMapSet(gitDiffCache, cacheKey, { ts: Date.now(), payload: detail }, 60);
    }
    await json(detail.statusCode || (detail.ok ? 200 : 400), detail);
  });

  async function digest({ url, json }) {
    const requestedRig = url.searchParams.get('rig') || 'all';
    const rawHours = Number(url.searchParams.get('hours'));
    const windowHours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(168, Math.max(0.25, rawHours)) : 8;
    const rawSinceMs = Number(url.searchParams.get('sinceMs'));
    const sinceMs = Number.isFinite(rawSinceMs) && rawSinceMs > 0 ? rawSinceMs : 0;
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ru';
    const nowMs = Date.now();
    const effectiveCutoff = sinceMs > 0 && sinceMs < nowMs ? sinceMs : (nowMs - windowHours * 3600 * 1000);

    const bundle = await getTelemetryBundle(requestedRig, { forceRefresh: false });
    const snap = (bundle && bundle.payload) || getFleetSnapshot() || {};
    const events = shiftHistory.queryEvents({ sinceMs: effectiveCutoff, untilMs: nowMs, rigId: requestedRig, limit: 1000 });
    const digest = buildShiftDigest({
      windowHours,
      sinceMs,
      nowMs,
      rigFilter: requestedRig,
      events,
      ganttItems: (snap.history && snap.history.ganttItems) || [],
      activeQueue: snap.activeQueue || [],
      decisions: snap.decisions || [],
      nodes: snap.nodes || [],
      parkedSeats: snap.parkedSeats || {},
      seatUsage: snap.seatUsage || {},
      fleetUsageSummary: snap.fleetUsageSummary || {},
      gitRadar: snap.gitRadar || null,
      actionAudit: actionAudit.list(100),
      intelligence: snap.intelligence || null,
      historyMeta: shiftHistory.getSummaryMeta()
    });
    const markdown = formatShiftDigestMarkdown(digest, lang);
    await json(200, { ok: true, digest, markdown });
  }

  get('/api/digest', digest);
  get('/api/shift/digest', digest);

  get('/api/history/events', async ({ url, json }) => {
    const requestedRig = url.searchParams.get('rig') || 'all';
    const rawHours = Number(url.searchParams.get('hours'));
    const windowHours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(168, Math.max(0.25, rawHours)) : 24;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const sinceMs = Date.now() - windowHours * 3600 * 1000;
    const events = shiftHistory.queryEvents({ sinceMs, rigId: requestedRig, limit });
    await json(200, { ok: true, events, meta: shiftHistory.getSummaryMeta() });
  });

  get('/api/remote/status', async ({ json }) => {
    await json(200, { ok: true, localPort: getPort(), ...remoteAccess.getStatus() });
  });

  post('/api/remote/config', async ({ body, json }) => {
    const out = remoteAccess.setPublicUrl(body.publicUrl || '');
    if (!out.ok) {
      await json(400, { ok: false, error: out.error });
      return;
    }
    await json(200, { ok: true, localPort: getPort(), ...out.status });
  });

  post('/api/remote/pair', async ({ json }) => {
    remoteAccess.mintPairingCode();
    await json(200, { ok: true, localPort: getPort(), ...remoteAccess.getStatus() });
  });

  post('/api/remote/revoke', async ({ json }) => {
    const st = remoteAccess.revokeAllSessions();
    await json(200, { ok: true, localPort: getPort(), ...st });
  });

  get('/api/update/status', async ({ isRemote, json }) => {
    await json(200, { ok: true, isRemote, ...selfUpdater.getStatus() });
  });

  post('/api/update/check', async ({ json }) => {
    const st = await selfUpdater.check({ force: true });
    await json(200, { ok: true, ...st });
  });

  post('/api/update/apply', async ({ json }) => {
    const out = await selfUpdater.applyUpdate();
    await json(out.ok ? 200 : 500, out);
  });
}
