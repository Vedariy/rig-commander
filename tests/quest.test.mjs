import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEST_STEPS,
  createQuestState,
  getQuestProgress,
  getNextQuestStep,
  completeQuestStep,
  resetQuestState,
  shouldAutoOpenQuest
} from '../openrig/assets/domain/quest.js';

test('Quest state machine tracks 3-step progression idempotently and computes next step', () => {
  assert.deepEqual(QUEST_STEPS, ['hitl', 'gantt', 'budget']);
  let state = createQuestState();
  assert.equal(getNextQuestStep(state), 'hitl');
  assert.deepEqual(getQuestProgress(state), { completed: 0, total: 3, pct: 0, allDone: false });

  const r1 = completeQuestStep(state, 'hitl');
  assert.equal(r1.newlyCompleted, true);
  assert.equal(r1.completed, 1);
  assert.equal(getNextQuestStep(r1.state), 'gantt');

  // Repeating same step is idempotent
  const r1Dup = completeQuestStep(r1.state, 'hitl');
  assert.equal(r1Dup.newlyCompleted, false);
  assert.equal(r1Dup.completed, 1);

  // Unknown step id is ignored safely
  const rUnknown = completeQuestStep(r1.state, 'nonexistent');
  assert.equal(rUnknown.newlyCompleted, false);
  assert.equal(rUnknown.completed, 1);

  const r2 = completeQuestStep(r1.state, 'gantt');
  assert.equal(getNextQuestStep(r2.state), 'budget');

  const r3 = completeQuestStep(r2.state, 'budget');
  assert.equal(r3.newlyCompleted, true);
  assert.equal(r3.allDone, true);
  assert.equal(r3.pct, 100);
  assert.equal(getNextQuestStep(r3.state), null);
});

test('shouldAutoOpenQuest only opens automatically for fresh offline demo or explicit ?track=quest', () => {
  assert.equal(shouldAutoOpenQuest({ isLive: false, track: '', dismissed: false }), true);
  assert.equal(shouldAutoOpenQuest({ isLive: false, track: '', dismissed: true }), false);
  assert.equal(shouldAutoOpenQuest({ isLive: true, track: '', dismissed: false }), false);
  assert.equal(shouldAutoOpenQuest({ isLive: true, track: 'quest', dismissed: false }), false);
  assert.equal(shouldAutoOpenQuest({ isLive: false, track: 'gantt', dismissed: false }), false);
  assert.equal(shouldAutoOpenQuest({ isLive: false, track: 'hitl', dismissed: false }), false);
  assert.equal(shouldAutoOpenQuest({ isLive: false, track: 'guardrails', dismissed: false }), false);
  // Explicit quest track re-opens even if previously dismissed
  assert.equal(shouldAutoOpenQuest({ isLive: false, track: 'quest', dismissed: true }), true);
  assert.equal(shouldAutoOpenQuest({ isLive: false, track: 'mission', dismissed: true }), true);
});

test('resetQuestState clears all completed steps and dismissed flag', () => {
  const done = completeQuestStep(
    completeQuestStep(createQuestState({ dismissed: true }), 'hitl').state,
    'gantt'
  ).state;
  const fresh = resetQuestState(done);
  assert.equal(fresh.dismissed, false);
  assert.deepEqual(getQuestProgress(fresh), { completed: 0, total: 3, pct: 0, allDone: false });
});
