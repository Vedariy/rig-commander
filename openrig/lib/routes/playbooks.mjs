export function registerPlaybookRoutes({ get, post }, {
  guardrailStatus, playbookEngine, sseHub, getFleetSnapshot, actionAudit, circuitBreaker
}) {
  get('/api/playbooks', guardrailStatus);

  post('/api/playbooks/config', async ({ body, json }) => {
    const state = playbookEngine.updateConfig(body);
    sseHub.notifyInvalidated('playbooks_config', '');
    await json(200, { ok: true, playbooks: state });
  });

  post('/api/playbooks/dry-run', async ({ json }) => {
    const snap = getFleetSnapshot() || {};
    const preview = playbookEngine.dryRun({
      nodes: snap.nodes || [],
      parkedSeats: snap.parkedSeats || {},
      activeQueue: snap.activeQueue || [],
      gitRadar: snap.gitRadar || null,
      actionAudit: actionAudit.list(40),
      breakerState: circuitBreaker.getState()
    });
    await json(200, { ok: true, dryRun: preview, playbooks: playbookEngine.getState() });
  });

  post('/api/playbooks/reset', async ({ body, json }) => {
    const act = String(body.action || 'pause');
    const state = act === 'reset_cooldowns'
      ? playbookEngine.resetCooldowns()
      : playbookEngine.pauseAll();
    sseHub.notifyInvalidated('playbooks_reset', '');
    await json(200, { ok: true, playbooks: state });
  });
}
