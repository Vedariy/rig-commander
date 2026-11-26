import assert from 'node:assert/strict';
import test from 'node:test';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import {
  renderActionAuditHtml, renderContextBadgesHtml, renderContextLineageHtml, renderCurrentTaskHtml, renderHarnessQuickKeys,
  renderInteractivePromptOptionsHtml, renderSeatDiagnosisHtml, renderSeatGitWorktreeHtml
} from '../openrig/assets/ui/inspector-view.js';

const seat = 'coder@example';
const agent = { id: seat, state: 'idle', harness: 'codex' };
const special = '<file & "branch">';
const escaped = '&lt;file &amp; &quot;branch&quot;&gt;';
const entities = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
const context = (lang = 'en') => ({
  deckLang: lang,
  td: (key, values) => tDeck(lang, key, values),
  escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]),
  shortSeat: id => id.split('@')[0],
  getControlLockAttrs: () => '',
  renderEvaluatorVerdictCardHtml: () => '',
  isEvalRunning: () => false,
  lastScreenBySeat: {},
  queueItems: [],
  openQueue: [],
  resolveSeatIdByShort: () => null,
  CMD_COPY_LABEL_HTML: 'Cmd'
});

test('empty diagnosis keeps evaluator controls and only disables the running tier', () => {
  const ctx = context();
  ctx.isEvalRunning = (scope, id, tier) => id === seat && tier === 'system2';
  const html = renderSeatDiagnosisHtml(ctx, agent);
  assert.match(html, /id="inspEvalMiniBar"/);
  assert.doesNotMatch(html, /seat-diagnosis-card/);
  assert.match(html, /is-s2" data-eval-seat="coder@example" disabled/);
});

test('urgent seat has a localized P0 and a terminal action even before findings arrive', () => {
  for (const lang of ['ru', 'en']) {
    const ctx = context(lang);
    const html = renderSeatDiagnosisHtml(ctx, { ...agent, state: 'urgent', needsInputReason: special });
    assert.match(html, /is-p0/);
    assert.match(html, /data-transport="modal_terminal"/);
    assert.ok(html.includes(ctx.td('diag.resolveHitlBtn')));
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(special));
  }
});

test('P1 shows only the affected seat’s active queue samples and brackets extra findings', () => {
  const ctx = context();
  ctx.intelligence = { allFindings: [
    { severity: 'p0_urgent', actionPlan: { seatTarget: 'other' }, title: 'Unrelated' },
    { severity: 'p1_high', detectorId: 'topology.bottleneck', metrics: { affectedSeats: [seat] }, title: 'Waiting for QA' },
    { severity: 'p2_warn', actionPlan: { seatTarget: seat }, title: 'Secondary' }
  ] };
  ctx.openQueue = [
    { destinationSession: seat, sourceSession: 'owner@example', summary: special, tags: ['slice:qa'] },
    { destinationSession: seat, sourceSession: 'change-detector', summary: 'Internal wake' }
  ];
  const html = renderSeatDiagnosisHtml(ctx, agent);
  assert.match(html, /is-p1/);
  assert.match(html, /Waiting for QA/);
  assert.match(html, /Secondary/);
  assert.match(html, /diag-queue-row/);
  assert.ok(html.includes(escaped));
  assert.doesNotMatch(html, /Unrelated|Internal wake/);
  assert.match(html, /data-transport="gantt_slice"/);
});

test('real HITL options and manual quick keys propagate the current lock and modal status target', () => {
  const ctx = context();
  let busy = true;
  ctx.getControlLockAttrs = (scope, fp) => {
    assert.equal(scope, 'seat:' + seat);
    assert.ok(fp.startsWith('send:' + seat + ':'));
    return busy ? ' disabled aria-busy="true"' : '';
  };
  const screen = ['Run this command?', '> 1. Yes, run ' + special, '  2. No, cancel', 'esc to cancel'].join('\n');
  const options = () => renderInteractivePromptOptionsHtml(ctx, seat, screen, 'modalCmdStatus');
  assert.match(options(), /data-key="1 Enter" data-status="modalCmdStatus" disabled/);
  assert.ok(options().includes(escaped));
  assert.match(renderHarnessQuickKeys(ctx, agent, 'modalCmdStatus'), /data-status="modalCmdStatus"[^>]* disabled/);
  busy = false;
  assert.doesNotMatch(options(), / disabled/);
  assert.equal(renderInteractivePromptOptionsHtml(ctx, seat, 'Notes:\n1. Read logs\n2. Review logs\nDone.\n>'), '');
});

test('terminal text and queue summaries stay escaped in current task', () => {
  const ctx = context();
  ctx.lastScreenBySeat[seat] = 'building\n' + special;
  const working = { ...agent, state: 'working' };
  for (const queueItems of [[], [{ to: seat, summary: special, state: 'pending' }]]) {
    const html = renderCurrentTaskHtml({ ...ctx, queueItems }, working);
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(special));
  }
});

test('action audit filters by seat, caps at five records, and escapes operator text', () => {
  const ctx = context();
  assert.equal(renderActionAuditHtml(ctx, seat), '');
  const records = Array.from({ length: 6 }, (_, i) => ({
    targetSeatId: seat, actionId: 'action-' + i, postconditionStatus: 'verified',
    payloadPreview: special, postconditionDetail: special
  }));
  ctx.ontologySnapshot = { actionRecords: [{ ...records[0], targetSeatId: 'other', actionId: 'elsewhere' }, ...records] };
  const html = renderActionAuditHtml(ctx, seat);
  assert.match(html, /action-4/);
  assert.doesNotMatch(html, /elsewhere|action-5/);
  assert.ok(html.includes(escaped));
  assert.ok(!html.includes(special));
});

test('lineage keeps queue IDs in data attributes and escapes body, decisions and artifacts', () => {
  const ctx = context();
  const id = "qitem-'example";
  const html = renderContextLineageHtml(ctx, {
    item: { id, from: seat, body: special, summary: special, project: special },
    lineage: { ancestors: [{ id, summary: special }] },
    artifacts: { docs: [special], adrs: [], commits: [], linkedQitems: [id] },
    relatedDecisions: [{ decision: special }]
  });
  assert.match(html, /ctx-lineage-node is-current/);
  assert.match(html, /data-qitem="qitem-&#39;example"/);
  assert.doesNotMatch(html, /onclick="[^"]*qitem-&#39;example/);
  assert.match(html, /ctx-body-pre/);
  assert.ok(html.includes(escaped));
  assert.ok(!html.includes(special));
});

test('worktree keeps conflicted files first and carries the full escaped path to the diff button', () => {
  const html = renderSeatGitWorktreeHtml(context(), { ...agent, git: {
    branch: 'main', dirtyCount: 2, conflictFilesCount: 1,
    conflictFiles: [special], files: ['ordinary', { path: special }]
  } });
  assert.match(html, /has-conflict/);
  assert.ok(html.indexOf('data-file="' + escaped + '"') < html.indexOf('data-file="ordinary"'));
  assert.match(html, /openGitDiffModal\(this.getAttribute\('data-seat'\), this.getAttribute\('data-file'\)\)/);
});

test('preview immediately precedes approval controls, with full escaped tooltip and bounded text', () => {
  for (const lang of ['en', 'ru']) {
    const ctx = context(lang);
    const command = 'echo ' + special + ' ' + 'long '.repeat(45) + 'tail';
    const html = renderInteractivePromptOptionsHtml(ctx, seat, 'Requesting permission for:\n  ' + command +
      '\nRun this command?\n> 1. Yes, run\n  2. No, cancel', 'modalCmdStatus');
    assert.ok(html.indexOf('hitl-command-preview') < html.indexOf('triggerPromptOption(this)'));
    assert.ok(html.includes('title="' + ctx.escapeHtml(command) + '"'));
    assert.ok(html.includes(ctx.td('insp.hitlCmdLabel')));
    assert.match(html, /…<\/code>/);
    assert.ok(!html.includes(special));
  }
});

test('preview-only yes/no prompts and repeated credentials in option labels have no raw credential sinks', () => {
  const ctx = context();
  const question = 'Continue with --api-key fixture-only? [Y/n]';
  const yesNo = renderInteractivePromptOptionsHtml(ctx, seat, question);
  assert.match(yesNo, /hitl-command-preview/);
  assert.doesNotMatch(yesNo, /fixture-only|triggerPromptOption/);
  const numbered = renderInteractivePromptOptionsHtml(ctx, seat,
    'Requesting permission for:\n  tool --password fixture-only\nRun this command?\n1. Yes, run with --password fixture-only\n2. No, cancel');
  assert.match(numbered, /triggerPromptOption/);
  assert.doesNotMatch(numbered, /fixture-only/);
});

test('handoff chips dispatch full queue and seat IDs in either direction', () => {
  const ctx = { ...context(), shortSeat: id => id }; // All Rigs can retain the rig suffix.
  const seatId = 'dev-check@rig-commander';
  const queueIds = ['qitem-20261125224306-8f3c8035', 'QITEM-demo@source-8f3c8035'];
  for (const [field, arrow] of [['handedOffFrom', '↖'], ['handedOffTo', '↘']]) {
    const seatChip = renderContextBadgesHtml(ctx, { [field]: seatId });
    assert.ok(seatChip.includes(`title="${field}: ${seatId}" data-seat="${seatId}"`));
    assert.ok(seatChip.includes(`selectAgent(this.dataset.seat)">${arrow} dev-check</button>`));
    for (const qitemId of queueIds) {
      const queueChip = renderContextBadgesHtml(ctx, { [field]: qitemId });
      assert.ok(queueChip.includes(`title="${field}: ${qitemId}" data-qitem="${qitemId}"`));
      assert.ok(queueChip.includes(`openQueueItemContext(this.dataset.qitem)">${arrow} 8f3c8035</button>`));
    }
  }
});

test('untyped handoff labels are trimmed, limited to 24 characters and inert', () => {
  const ref = 'First review of the 🚀 launch checklist';
  const html = renderContextBadgesHtml(context(), { handedOffFrom: '   ', handedOffTo: '  ' + ref + '  ' });
  assert.ok(html.includes(`title="handedOffTo: ${ref}">↘ First review of the 🚀 l…</span>`));
  assert.doesNotMatch(html, /handedOffFrom|onclick|<button|data-seat|data-qitem/);
  const exact = 'a'.repeat(24);
  assert.ok(renderContextBadgesHtml(context(), { handedOffFrom: exact }).includes(`↖ ${exact}</span>`));
});

test('handoff titles, labels and routing attributes escape markup in both directions', () => {
  const ctx = context();
  for (const field of ['handedOffFrom', 'handedOffTo']) {
    for (const ref of [special, special + '@rig', 'qitem-' + special]) {
      const html = renderContextBadgesHtml(ctx, { [field]: ref });
      assert.ok(html.includes(`title="${field}: ${ctx.escapeHtml(ref)}"`));
      assert.ok(!html.includes('<file'));
      if (ref.includes('@')) assert.ok(html.includes(`data-seat="${ctx.escapeHtml(ref)}"`));
      if (ref.startsWith('qitem-')) assert.ok(html.includes(`data-qitem="${ctx.escapeHtml(ref)}"`));
    }
  }
});
