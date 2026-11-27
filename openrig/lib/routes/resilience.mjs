import { ServerIdempotencyCache } from '../../assets/domain/action-guard.js';
import { PolicyError } from '../resilience/policy-gate.mjs';

export function registerResilienceRoutes({ get, post }, service) {
  const cache = new ServerIdempotencyCache();
  const wrap = fn => async ctx => {
    try { await fn(ctx); }
    catch (error) {
      const expected = error instanceof PolicyError;
      await ctx.json(expected ? error.status : 502, { ok: false, error: expected ? error.message : 'provider_unavailable' });
    }
  };
  get('/api/resilience/status', wrap(async ({ url, json }) =>
    json(200, await service.getStatus({ refresh: url.searchParams.get('refresh') === '1' }))));
  post('/api/resilience/plan', wrap(async ({ body, json }) => json(200, await service.gate.createPlan(body))));
  post('/api/resilience/dismiss', wrap(async ({ body, json }) => json(200, await service.dismissRig(body?.target))));

  for (const action of ['snapshot', 'resurrect']) {
    post('/api/resilience/' + action, wrap(async ({ req, body, json }) => {
      const key = req.headers['x-idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new PolicyError(400, 'invalid_idempotency_key');
      const fingerprint = JSON.stringify([action, body?.providerId, body?.scope, body?.target, body?.confirmed, body?.planHash]);
      const ticket = cache.begin({ idempotencyKey: key });
      if (ticket.action === 'reject') throw new PolicyError(409, 'in_progress');
      if (ticket.action === 'replay') {
        if (ticket.body.fingerprint !== fingerprint) throw new PolicyError(409, 'idempotency_conflict');
        return json(ticket.status, ticket.body.response);
      }
      try {
        let response, status = 200;
        if (action === 'snapshot') response = { checkpoint: await service.gate.createCheckpoint(body) };
        else {
          const receipt = await service.gate.executeRecovery(body);
          response = { receipt };
          if (receipt.status === 'failed') {
            status = 502;
            Object.assign(response, { ok: false, error: 'recovery_failed' });
          }
        }
        ticket.complete(status, { fingerprint, response });
        return json(status, response);
      } catch (error) {
        if (error instanceof PolicyError && error.status === 502) {
          ticket.complete(502, { fingerprint, response: { ok: false, error: error.message } });
        } else ticket.abort();
        throw error;
      }
    }));
  }

  post('/api/resilience/hygiene/plan', wrap(async ({ body, json }) => {
    if (!service?.hygieneGate) throw new PolicyError(502, 'hygiene_unavailable');
    return json(200, await service.hygieneGate.createPlan(body));
  }));

  post('/api/resilience/hygiene/execute', wrap(async ({ req, body, json }) => {
    if (!service?.hygieneGate) throw new PolicyError(502, 'hygiene_unavailable');
    const key = req.headers['x-idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
      throw new PolicyError(400, 'invalid_idempotency_key');
    }
    const fingerprint = JSON.stringify([
      'hygiene',
      body?.scope ?? 'fleet',
      body?.targetRig ?? body?.rigId ?? body?.target ?? null,
      body?.cutoffHours ?? 24,
      Boolean(body?.rotateDaemonLog),
      Boolean(body?.includeDetachedTargets ?? true),
      Boolean(body?.includeOldBlocked),
      body?.confirmed,
      body?.planHash
    ]);
    const ticket = cache.begin({ idempotencyKey: key });
    if (ticket.action === 'reject') throw new PolicyError(409, 'in_progress');
    if (ticket.action === 'replay') {
      if (ticket.body.fingerprint !== fingerprint) throw new PolicyError(409, 'idempotency_conflict');
      return json(ticket.status, { ...ticket.body.response, deduplicated: true });
    }
    try {
      const receipt = await service.hygieneGate.executeHygiene(body);
      const response = { receipt };
      let status = 200;
      if (receipt.status === 'failed') {
        status = 502;
        Object.assign(response, { ok: false, error: 'hygiene_failed' });
      }
      ticket.complete(status, { fingerprint, response });
      return json(status, response);
    } catch (error) {
      if (error instanceof PolicyError && error.status === 502) {
        ticket.complete(502, { fingerprint, response: { ok: false, error: error.message } });
      } else {
        ticket.abort();
      }
      throw error;
    }
  }));
}
