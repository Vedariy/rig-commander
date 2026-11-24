import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_WARN_PCT,
  CONTEXT_CRIT_PCT,
  isPiHarness,
  buildNudgeQueueAction,
  getSeatContextualActions,
  getManualHarnessActions,
  resolveActionFromFinding
} from '../openrig/assets/ontology/index.js';

test('healthy idle seat with cold context exposes zero contextual write-back buttons', () => {
  const actions = getSeatContextualActions(
    { id: 'dev-coder@rig', harness: 'codex', state: 'idle', ctxPct: 22 },
    'nothing to commit, working tree clean'
  );
  assert.deepEqual(actions, []);
});

test('working seat exposes only interrupt_execution when context is cool', () => {
  const actions = getSeatContextualActions({
    id: 'dev-coder4@rig',
    harness: 'codex',
    state: 'working',
    ctxPct: 40
  });
  assert.deepEqual(actions.map(a => a.id), ['interrupt_execution']);
  assert.equal(actions[0].transport, 'tmux_key');
  assert.equal(actions[0].payload, 'C-c');
});

test('urgent seat without parsed menu exposes proceed, yes, cancel and interrupt', () => {
  const actions = getSeatContextualActions({
    id: 'dev-owner@rig',
    harness: 'codex',
    state: 'urgent',
    ctxPct: 30
  }, 'Waiting for confirmation...');
  assert.deepEqual(
    actions.map(a => a.id),
    ['proceed_prompt', 'confirm_yes', 'cancel_prompt', 'interrupt_execution']
  );
});

test('urgent seat with parsed Codex menu omits duplicate proceed/yes and keeps cancel + interrupt', () => {
  const codexMenu = [
    'Would you like to run the following command?',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again (p)',
    '  3. No, and tell Codex what to do differently (esc)'
  ].join('\n');
  const actions = getSeatContextualActions({
    id: 'dev-senior@rig',
    harness: 'codex',
    state: 'urgent',
    ctxPct: 35
  }, codexMenu);
  assert.deepEqual(actions.map(a => a.id), ['cancel_prompt', 'interrupt_execution']);
});

test('hot context >= 65% exposes compact_context on Codex/Claude and copy_restart_seat on Pi', () => {
  const warmCodex = getSeatContextualActions({
    id: 'dev-owner@rig',
    harness: 'codex',
    state: 'idle',
    ctxPct: CONTEXT_WARN_PCT
  });
  assert.deepEqual(warmCodex.map(a => a.id), ['compact_context']);
  assert.equal(warmCodex[0].tone, 'warn');

  const critCodex = getSeatContextualActions({
    id: 'dev-owner@rig',
    harness: 'codex',
    state: 'idle',
    ctxPct: CONTEXT_CRIT_PCT + 3
  });
  assert.equal(critCodex[0].id, 'compact_context');
  assert.equal(critCodex[0].tone, 'critical');

  const critPi = getSeatContextualActions({
    id: 'dev-coder3@rig',
    harness: 'pi',
    state: 'idle',
    ctxPct: 80
  });
  assert.equal(isPiHarness({ id: 'dev-coder3@rig', harness: 'pi' }), true);
  assert.deepEqual(critPi.map(a => a.id), ['copy_restart_seat']);
  assert.equal(critPi[0].transport, 'clipboard');
  assert.equal(critPi[0].payload, 'rig restart dev-coder3@rig');
});

test('parked seat exposes wake_parked_seat', () => {
  const actions = getSeatContextualActions({
    id: 'dev-owner@rig',
    harness: 'codex',
    state: 'waiting',
    ctxPct: 45,
    parkedData: { parked: true }
  });
  assert.deepEqual(actions.map(a => a.id), ['wake_parked_seat']);
  assert.equal(actions[0].payload, 'Enter');
});

test('getManualHarnessActions respects harness capabilities (Pi has no /compact)', () => {
  const piManual = getManualHarnessActions({ id: 'dev-coder3@rig', harness: 'pi' });
  assert.equal(piManual.some(a => a.payload === '/compact'), false);

  const claudeManual = getManualHarnessActions({ id: 'dev-coder@rig', harness: 'claude-code' });
  assert.deepEqual(claudeManual.map(a => a.payload), ['/compact', '/clear', '/cost', 'Enter']);
});

test('resolveActionFromFinding maps compact_seat safely and protects Pi harness', () => {
  const codexAct = resolveActionFromFinding(
    { kind: 'compact_seat', seatTarget: 'dev-owner@rig', label: '⚡ Сжать' },
    { id: 'dev-owner@rig', harness: 'codex' }
  );
  assert.equal(codexAct.id, 'compact_context');
  assert.equal(codexAct.transport, 'tmux_raw');
  assert.equal(codexAct.payload, '/compact');

  const piAct = resolveActionFromFinding(
    { kind: 'compact_seat', seatTarget: 'dev-coder3@rig', label: '⚡ Сжать' },
    { id: 'dev-coder3@rig', harness: 'pi' }
  );
  assert.equal(piAct.id, 'copy_restart_seat');
  assert.equal(piAct.transport, 'clipboard');
  assert.equal(piAct.payload, 'rig restart dev-coder3@rig');

  const fallbackAct = resolveActionFromFinding(
    { kind: 'reroute_task', commandPreview: 'rig queue handoff ...', label: 'Направить' },
    null
  );
  assert.equal(fallbackAct.id, 'copy_command');
  assert.equal(fallbackAct.payload, 'rig queue handoff ...');
});

test('resolveActionFromFinding maps open_modal, wake_seat and select_seat to live UX transports', () => {
  const modalAct = resolveActionFromFinding(
    { kind: 'open_modal', seatTarget: 'dev-check@rig', label: '📺 Открыть экран QA' },
    null
  );
  assert.equal(modalAct.id, 'open_live_terminal');
  assert.equal(modalAct.transport, 'modal_terminal');
  assert.equal(modalAct.seatId, 'dev-check@rig');

  const wakeAct = resolveActionFromFinding(
    { kind: 'wake_seat', seatTarget: 'dev-coder3@rig', label: '⚡ Разбудить' },
    null
  );
  assert.equal(wakeAct.id, 'wake_parked_seat');
  assert.equal(wakeAct.transport, 'tmux_key');
  assert.equal(wakeAct.payload, 'Enter');

  const selectAct = resolveActionFromFinding(
    { kind: 'select_seat', seatTarget: 'dev-coder3@rig', label: '🔍 Осмотреть' },
    null
  );
  assert.equal(selectAct.id, 'focus_seat');
  assert.equal(selectAct.transport, 'select_seat');

  const ganttAct = resolveActionFromFinding(
    { kind: 'open_gantt_slice', params: { slice: 'auth-flow' }, label: '📊 Разобрать на Ганте' },
    null
  );
  assert.equal(ganttAct.id, 'open_gantt_slice');
  assert.equal(ganttAct.transport, 'gantt_slice');
  assert.equal(ganttAct.payload, 'auth-flow');
});

test('parked seat whose agent exited to bare shell offers rig restart instead of wake Enter', () => {
  const shellSeat = {
    id: 'dev-operator@rig',
    harness: 'terminal',
    state: 'waiting',
    parkedData: { parked: true },
    shellExited: true
  };
  const actions = getSeatContextualActions(shellSeat);
  assert.deepEqual(actions.map(a => a.id), ['copy_restart_shell']);
  assert.equal(actions[0].transport, 'clipboard');
  assert.equal(actions[0].payload, 'rig restart dev-operator@rig');

  const resolved = resolveActionFromFinding(
    { kind: 'wake_seat', seatTarget: 'dev-operator@rig', label: '⚡ Разбудить' },
    shellSeat
  );
  assert.equal(resolved.id, 'copy_restart_shell');
  assert.equal(resolved.transport, 'clipboard');
  assert.equal(resolved.payload, 'rig restart dev-operator@rig');
});

test('buildNudgeQueueAction and resolveActionFromFinding(nudge_queue) enforce canonical prompt and shellExited guard', () => {
  const ruAct = buildNudgeQueueAction('dev-owner@rig', 'ru');
  assert.equal(ruAct.id, 'nudge_queue');
  assert.equal(ruAct.transport, 'tmux_raw');
  assert.match(ruAct.payload, /rig queue list --owned/);

  const enAct = resolveActionFromFinding(
    { kind: 'nudge_queue', seatTarget: 'dev-owner@rig', lang: 'en', label: '📨 Process queue' },
    { id: 'dev-owner@rig', harness: 'codex', shellExited: false }
  );
  assert.equal(enAct.id, 'nudge_queue');
  assert.equal(enAct.transport, 'tmux_raw');
  assert.match(enAct.payload, /Check your open queue/);

  const guarded = resolveActionFromFinding(
    { kind: 'nudge_queue', seatTarget: 'dev-operator@rig', lang: 'ru' },
    { id: 'dev-operator@rig', harness: 'terminal', shellExited: true }
  );
  assert.equal(guarded.id, 'copy_restart_shell');
  assert.equal(guarded.transport, 'clipboard');
  assert.equal(guarded.payload, 'rig restart dev-operator@rig');
});
