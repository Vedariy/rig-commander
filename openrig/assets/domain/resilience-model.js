/** Pure, advisory resilience models. These functions never execute recovery. */
export const OUTAGE_TIERS = Object.freeze({ HEALTHY: 'healthy', SEAT_EXITED: 'seat_exited', RIG_DOWN: 'rig_down', DAEMON_DOWN: 'daemon_down' });
export const STATE_BUNDLE_SCHEMA_VERSION = 1;
export const SAFE_RIG_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const SAFE_SEAT_ID_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
export const SAFE_ATTEMPT_ID_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const SAFE_PROVIDER_ID_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const rigId = value => typeof value === 'string' ? value : text(value?.rigName || value?.rigId || value?.name || value?.id);
const seatId = value => typeof value === 'string' ? value : text(value?.canonicalSessionName || value?.seatId || value?.id);
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;

/** Boolean validator; fleet uses no target (null/undefined/empty/'all'). */
export function validateResilienceTarget({ providerId, scope, target } = {}) {
  if (typeof providerId !== 'string' || !SAFE_PROVIDER_ID_RE.test(providerId)) return false;
  if (scope === 'fleet') return target == null || target === '' || target === 'all';
  return typeof target === 'string' && (scope === 'rig' ? SAFE_RIG_NAME_RE : scope === 'seat' ? SAFE_SEAT_ID_RE : /$a/).test(target);
}

export function parseSnapshotTable(stdout) {
  if (typeof stdout !== 'string' || stdout.length > 1024 * 1024) return [];
  let rows;
  try { rows = JSON.parse(stdout); } catch { /* Native CLI is a padded table. */ }
  if (!Array.isArray(rows)) rows = stdout.split(/\r?\n/).map(line => {
    const cells = line.trim().split(/\s{2,}/);
    return cells.length === 4 ? { id: cells[0], kind: cells[1], status: cells[2], createdAt: cells[3] } : null;
  });
  return rows.filter(row => row && SAFE_ATTEMPT_ID_RE.test(text(row.id)) &&
    /^[a-z][a-z0-9-]{0,63}$/i.test(text(row.kind)) && /^[a-z][a-z0-9_-]{0,31}$/i.test(text(row.status)) &&
    Number.isFinite(dateMs(row.createdAt)))
    .map(({ id, kind, status, createdAt }) => ({ id, kind, status, createdAt: new Date(createdAt).toISOString(), restoreUsable: status === 'complete' }))
    .sort((a, b) => dateMs(b.createdAt) - dateMs(a.createdAt) || cmp(a.id, b.id));
}

export function detectSleepWakeJump(prevWallMs, nowWallMs, thresholdMs = 90_000) {
  const valid = Number.isFinite(prevWallMs) && Number.isFinite(nowWallMs) && prevWallMs >= 0 && nowWallMs >= prevWallMs;
  const deltaMs = valid ? nowWallMs - prevWallMs : 0;
  return { jumped: valid && deltaMs > (Number.isFinite(thresholdMs) && thresholdMs >= 0 ? thresholdMs : 90_000), deltaMs };
}

export function classifyFleetResilience({ daemonUp, crashCart, liveRigs = [], liveNodes = [], manifestRigs = [], snapshotsByRig = {}, nowMs = Date.now() } = {}) {
  const known = new Map();
  for (const rig of [...list(manifestRigs), ...list(liveRigs)]) {
    const id = rigId(rig);
    if (SAFE_RIG_NAME_RE.test(id)) known.set(id, { ...known.get(id), ...(typeof rig === 'object' ? rig : {}), rigId: id,
      intentionallyStopped: known.get(id)?.intentionallyStopped === true || rig?.intentionallyStopped === true });
  }
  const downStates = new Set(['down', 'stopped', 'exited', 'dead', 'failed', 'offline']);
  const live = new Set(list(liveRigs).filter(r => r?.running !== false && r?.isRunning !== false && !downStates.has(r?.status || r?.state)).map(rigId));
  const daemonDown = daemonUp === false || (daemonUp !== true && ['down', 'daemon_down'].includes(crashCart?.state));
  const rigReports = [...known.values()].sort((a, b) => cmp(a.rigId, b.rigId)).map(rig => {
    const online = !daemonDown && live.has(rig.rigId);
    const intentionallyStopped = rig.intentionallyStopped === true;
    const nodes = list(liveNodes).filter(n => (rigId({ rigId: n.rigName || n.rigId }) || seatId(n).split('@')[1]) === rig.rigId);
    const present = new Set(nodes.map(seatId));
    const absentSeats = online ? list(rig.seats).filter(s => s?.intentionallyStopped !== true && !present.has(seatId(s))).map(seatId) : [];
    const exitedSeats = [...new Set([...absentSeats, ...nodes.filter(n => n.intentionallyStopped !== true &&
      (n.shellExited === true || downStates.has(n.state || n.status))).map(seatId)])].filter(id => SAFE_SEAT_ID_RE.test(id)).sort(cmp);
    const usable = list(snapshotsByRig[rig.rigId]).filter(s => s && s.restoreUsable !== false && s.status === 'complete' && Number.isFinite(dateMs(s.createdAt)))
      .sort((a, b) => dateMs(b.createdAt) - dateMs(a.createdAt) || cmp(text(a.id), text(b.id)))[0];
    const ageMs = usable && Number.isFinite(nowMs) ? Math.max(0, nowMs - dateMs(usable.createdAt)) : null;
    const snapshot = { id: usable?.id || null, createdAt: usable?.createdAt || null, ageMs,
      freshness: ageMs == null ? 'missing' : ageMs <= 15 * 60_000 ? 'fresh' : ageMs <= 2 * 3600_000 ? 'aging' : 'stale' };
    return { rigId: rig.rigId, online, intentionallyStopped, recoverable: !online && !intentionallyStopped,
      tier: intentionallyStopped ? OUTAGE_TIERS.HEALTHY : daemonDown ? OUTAGE_TIERS.DAEMON_DOWN : !online ? OUTAGE_TIERS.RIG_DOWN : exitedSeats.length ? OUTAGE_TIERS.SEAT_EXITED : OUTAGE_TIERS.HEALTHY,
      exitedSeats: intentionallyStopped ? [] : exitedSeats, snapshot };
  });
  const offlineRigs = rigReports.filter(r => r.recoverable).map(r => r.rigId);
  const exitedSeats = rigReports.flatMap(r => r.exitedSeats);
  return { tier: daemonDown ? OUTAGE_TIERS.DAEMON_DOWN : offlineRigs.length ? OUTAGE_TIERS.RIG_DOWN : exitedSeats.length ? OUTAGE_TIERS.SEAT_EXITED : OUTAGE_TIERS.HEALTHY,
    rigReports, offlineRigs, summary: { totalRigs: rigReports.length, onlineRigs: rigReports.filter(r => r.online).length,
      offlineRigs: offlineRigs.length, intentionallyStoppedRigs: rigReports.filter(r => r.intentionallyStopped).length, exitedSeats: exitedSeats.length } };
}

/** Structural v1 check only. Local store additionally verifies the payload SHA-256. */
export function isStateBundleEnvelope(value) {
  return value?.schemaVersion === STATE_BUNDLE_SCHEMA_VERSION && value.bundleType === 'fleet-manifest' &&
    SAFE_RIG_NAME_RE.test(text(value.hostId)) && Number.isSafeInteger(value.lamportClock) && value.lamportClock >= 0 &&
    Number.isFinite(dateMs(value.updatedAt)) && /^[a-f0-9]{64}$/.test(text(value.contentSha256)) &&
    value.encryption?.mode === 'none' && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload);
}

export function mergeHostManifestEnvelopes(envelopes = []) {
  const hosts = new Map();
  for (const envelope of list(envelopes).filter(isStateBundleEnvelope)) {
    const prior = hosts.get(envelope.hostId);
    // Payload hash breaks equal-clock/time ties deterministically, independent of arrival order.
    if (!prior || envelope.lamportClock > prior.lamportClock || (envelope.lamportClock === prior.lamportClock &&
      (dateMs(envelope.updatedAt) > dateMs(prior.updatedAt) || (dateMs(envelope.updatedAt) === dateMs(prior.updatedAt) &&
        (cmp(envelope.contentSha256, prior.contentSha256) || cmp(JSON.stringify(envelope), JSON.stringify(prior))) > 0)))) hosts.set(envelope.hostId, envelope);
  }
  const partitions = [...hosts.values()].sort((a, b) => cmp(a.hostId, b.hostId));
  const rigs = partitions.flatMap(e => list(e.payload.rigs).map(r => ({ ...r, provenance: { hostId: e.hostId, hostLabel: e.hostLabel || '', lamportClock: e.lamportClock, updatedAt: e.updatedAt } })));
  return { hosts: partitions, rigs };
}

export function buildResurrectPlanPreview({ providerId = 'openrig', scope = 'fleet', target = null, report = {}, capabilities = {}, commandPreview = '', warnings = [] } = {}) {
  if (!validateResilienceTarget({ providerId, scope, target })) throw new TypeError('Invalid resilience target');
  const required = scope === 'fleet' ? 'fleetRecover' : 'unitRecover';
  const skippedRigs = list(report.rigReports).filter(r => r.intentionallyStopped).map(r => r.rigId);
  const targetRigs = scope === 'fleet' ? list(report.offlineRigs).filter(id => !skippedRigs.includes(id)) : scope === 'rig' ? [target] : [];
  return { providerId, scope, target, commandPreview: text(commandPreview).slice(0, 2048), targetRigs, targetSeats: scope === 'seat' ? [target] : [],
    skippedRigs, warnings: list(warnings).filter(w => typeof w === 'string').slice(0, 32).map(w => w.slice(0, 512)),
    supported: capabilities.planPreview === true && capabilities[required] === true, requiresConfirmation: true };
}

export function normalizeRestoreReceipt(raw) {
  const statuses = ['restored', 'partial', 'failed', 'unknown'];
  const nativeStatus = value => value === 'fully_restored' ? 'restored' : value === 'partially_restored' ? 'partial' : value === 'failed' ? 'failed' : 'unknown';
  const normalize = item => ({ target: text(item?.target || item?.rigId || item?.seatId).slice(0, 128), status: statuses.includes(item?.status) ? item.status : 'unknown' });
  const rigs = list(raw?.rigs).slice(0, 64).map(normalize);
  const seats = Array.isArray(raw?.seats) ? raw.seats.slice(0, 4096).map(normalize) : list(raw?.currentNodes).slice(0, 4096).map(node => ({
    target: text(node?.logicalId || node?.nodeId).slice(0, 128),
    status: list(node?.guidanceGaps).length ? 'partial' : ['resumed', 'rebuilt', 'operator_recovered'].includes(node?.status) ? 'restored' :
      node?.status === 'failed' ? 'failed' : ['fresh', 'fresh-primed'].includes(node?.status) ? node.noConversation === true ? 'restored' : 'partial' : 'unknown'
  }));
  let status = statuses.includes(raw?.status) ? raw.status : nativeStatus(raw?.currentIntendedSetVerdict || raw?.rigResult);
  const children = [...rigs, ...seats];
  if (status === 'restored' && children.some(c => c.status !== 'restored')) status = 'partial';
  const attemptId = Number.isSafeInteger(raw?.attemptId) && raw.attemptId >= 0 ? String(raw.attemptId) : text(raw?.attemptId);
  return { attemptId: SAFE_ATTEMPT_ID_RE.test(attemptId) ? attemptId : null, status, rigs, seats };
}

export function buildDemoResilienceScenario(step = 'blackout') {
  const selected = ['blackout', 'preview', 'recovered'].includes(step) ? step : 'blackout';
  const capabilities = { daemonProbe: true, checkpoints: true, fleetRecover: true, unitRecover: true, planPreview: true, receiptPolling: true };
  const report = classifyFleetResilience({ daemonUp: selected === 'recovered', manifestRigs: [{ rigId: 'demo-fleet' }],
    liveRigs: selected === 'recovered' ? ['demo-fleet'] : [], nowMs: 1_800_000_000_000,
    snapshotsByRig: { 'demo-fleet': [{ id: 'demo-checkpoint', status: 'complete', createdAt: new Date(1_800_000_000_000 - 240_000).toISOString() }] } });
  return { step: selected, providers: [{ id: 'openrig', capabilities }], vault: { adapterId: 'local-fs', encrypted: false, hostId: 'demo-host', lamportClock: 1 }, report,
    activeRecoveries: [], history: [], plan: selected === 'blackout' ? null : buildResurrectPlanPreview({ report, capabilities, commandPreview: 'rig start --last --json' }),
    receipt: selected === 'recovered' ? normalizeRestoreReceipt({ attemptId: 'demo-attempt', status: 'restored', rigs: [{ target: 'demo-fleet', status: 'restored' }] }) : null };
}
