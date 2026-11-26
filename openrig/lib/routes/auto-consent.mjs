/**
 * Auto-Consent Policy & Grace-Window Control API Routes (ADR-0019).
 * All POST endpoints run behind server.mjs CSRF origin + x-deck-token + JSON + 64KB guards.
 */

export function registerAutoConsentRoutes({ get, post }, {
  autoConsent, invalidateTelemetryCache = null
}) {
  const invalidate = () => {
    if (typeof invalidateTelemetryCache === 'function') invalidateTelemetryCache();
  };

  get('/api/auto-consent/state', async ({ json }) => {
    await json(200, { ok: true, state: autoConsent.getState() });
  });

  post('/api/auto-consent/policy', async ({ body, json }) => {
    const res = autoConsent.updatePolicy(body);
    if (!res.ok) {
      await json(400, { ok: false, error: res.error || 'Invalid auto-consent policy payload' });
      return;
    }
    invalidate();
    await json(200, { ok: true, state: res.state });
  });

  post('/api/auto-consent/session-grant', async ({ body, json }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      await json(400, { ok: false, error: 'Session grant payload must be a JSON object' });
      return;
    }
    const action = body.action === undefined ? 'create' : body.action;
    if (action !== 'create' && action !== 'revoke') {
      await json(400, { ok: false, error: 'action must be "create" or "revoke"' });
      return;
    }
    if (action === 'revoke') {
      const res = autoConsent.revokeSessionGrant(body);
      if (!res.ok) {
        await json(400, { ok: false, error: res.error || 'Invalid revoke payload' });
        return;
      }
      invalidate();
      await json(200, {
        ok: true,
        revoked: res.revoked,
        revokedCount: res.revokedCount,
        state: res.state
      });
      return;
    }

    const res = await autoConsent.createSessionGrant(body);
    if (!res.ok) {
      await json(400, { ok: false, error: res.error || 'Invalid session grant payload' });
      return;
    }
    invalidate();
    await json(200, { ok: true, grant: res.grant, state: res.state });
  });

  post('/api/auto-consent/cancel', async ({ body, json }) => {
    const res = autoConsent.cancelPending(body);
    if (!res.ok) {
      await json(400, { ok: false, error: res.error || 'Invalid cancel payload' });
      return;
    }
    invalidate();
    await json(200, { ok: true, canceledCount: res.canceledCount, state: res.state });
  });

  post('/api/auto-consent/pause-all', async ({ body, json }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      await json(400, { ok: false, error: 'pause-all payload must be a JSON object' });
      return;
    }
    const paused = body.paused === undefined ? true : body.paused;
    if (typeof paused !== 'boolean') {
      await json(400, { ok: false, error: 'paused must be a boolean' });
      return;
    }
    const res = autoConsent.pauseAll(paused);
    if (!res.ok) {
      await json(400, { ok: false, error: res.error || 'Failed to update pause state' });
      return;
    }
    invalidate();
    await json(200, {
      ok: true,
      paused: res.paused,
      canceledCount: res.canceledCount,
      state: res.state
    });
  });
}
