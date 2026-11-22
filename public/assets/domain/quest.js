/**
 * First-Contact 10-Second Interactive Mission state machine (Pure Domain Module).
 * Guides first-time /demo visitors through 3 concrete value proofs without blocking the HUD:
 *   1. hitl   — Resolve a blocked QA permission prompt and see postcondition verified in Action Audit
 *   2. gantt  — Switch to Task Gantt (key G) to expose queue wait hatching & QA rework loops
 *   3. budget — Open Fleet Advisor → Budget to inspect live token spend ($6.63) & exclusive model pools
 */

export const QUEST_STEPS = Object.freeze(['hitl', 'gantt', 'budget']);

export function createQuestState(initial = {}) {
  const srcSteps = (initial && initial.steps && typeof initial.steps === 'object') ? initial.steps : {};
  const steps = {};
  for (const id of QUEST_STEPS) {
    steps[id] = Boolean(srcSteps[id]);
  }
  return {
    steps,
    dismissed: Boolean(initial && initial.dismissed),
    minimized: Boolean(initial && initial.minimized)
  };
}

export function getQuestProgress(state) {
  const safe = createQuestState(state);
  let completed = 0;
  for (const id of QUEST_STEPS) {
    if (safe.steps[id]) completed += 1;
  }
  const total = QUEST_STEPS.length;
  return {
    completed,
    total,
    pct: Math.round((completed / total) * 100),
    allDone: completed === total
  };
}

export function getNextQuestStep(state) {
  const safe = createQuestState(state);
  for (const id of QUEST_STEPS) {
    if (!safe.steps[id]) return id;
  }
  return null;
}

export function completeQuestStep(state, stepId) {
  const safe = createQuestState(state);
  if (!QUEST_STEPS.includes(stepId)) {
    const progress = getQuestProgress(safe);
    return { state: safe, newlyCompleted: false, ...progress };
  }
  const alreadyDone = Boolean(safe.steps[stepId]);
  const nextState = {
    ...safe,
    steps: {
      ...safe.steps,
      [stepId]: true
    }
  };
  const progress = getQuestProgress(nextState);
  return {
    state: nextState,
    newlyCompleted: !alreadyDone,
    ...progress
  };
}

export function resetQuestState() {
  return createQuestState({ dismissed: false, minimized: false });
}

export function shouldAutoOpenQuest({ isLive = false, track = '', dismissed = false } = {}) {
  if (isLive) return false;
  const cleanTrack = String(track || '').toLowerCase().trim();
  if (cleanTrack === 'quest' || cleanTrack === 'mission' || cleanTrack === 'start') return true;
  if (cleanTrack) return false;
  return !dismissed;
}
