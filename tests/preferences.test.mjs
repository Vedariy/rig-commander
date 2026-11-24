import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFS_STORAGE_KEY,
  DEFAULT_DECK_PREFS,
  sanitizeDeckPrefs,
  loadDeckPrefs,
  saveDeckPrefs,
  resolveEffectiveRigFilter
} from '../openrig/assets/domain/preferences.js';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

test('sanitizeDeckPrefs validates enums, booleans, numbers and rejects unsafe identifiers', () => {
  const clean = sanitizeDeckPrefs({
    rigFilter: 'core-platform',
    calmMode: true,
    hideIdleNodes: true,
    radarFilter: 'blockers',
    centerView: 'gantt',
    graphLayout: 'fixed',
    ganttWindowH: 24,
    ganttMode: 'sequence',
    ganttGroupBy: 'chain',
    ganttHideNoise: false,
    density: 'detailed',
    sidebarLeftCollapsed: true,
    sidebarRightCollapsed: false,
    autoFollow: false,
    audioRadarOn: true,
    selectedAgentId: 'dev-owner@core-platform',
    inspectorTab: 'memory',
    inspectorRefOpen: true
  });
  assert.equal(clean.rigFilter, 'core-platform');
  assert.equal(clean.calmMode, true);
  assert.equal(clean.hideIdleNodes, true);
  assert.equal(clean.radarFilter, 'blockers');
  assert.equal(clean.centerView, 'gantt');
  assert.equal(clean.graphLayout, 'fixed');
  assert.equal(clean.ganttWindowH, 24);
  assert.equal(clean.ganttMode, 'sequence');
  assert.equal(clean.ganttGroupBy, 'chain');
  assert.equal(clean.ganttHideNoise, false);
  assert.equal(clean.density, 'detailed');
  assert.equal(clean.sidebarLeftCollapsed, true);
  assert.equal(clean.autoFollow, false);
  assert.equal(clean.audioRadarOn, true);
  assert.equal(clean.selectedAgentId, 'dev-owner@core-platform');
  assert.equal(clean.inspectorTab, 'memory');
  assert.equal(clean.inspectorRefOpen, true);

  const dirty = sanitizeDeckPrefs({
    rigFilter: '<script>alert(1)</script>',
    radarFilter: 'unknown',
    centerView: 'table',
    graphLayout: 'chaotic',
    ganttWindowH: 999,
    ganttMode: 'uml',
    ganttGroupBy: 'random',
    density: 'huge',
    selectedAgentId: 'bad;rm -rf /',
    inspectorTab: 'evil'
  });
  assert.deepEqual(dirty, DEFAULT_DECK_PREFS);
});

test('loadDeckPrefs migrates legacy openrig_* keys and saveDeckPrefs merges idempotently', () => {
  const storage = createMemoryStorage({
    openrig_center_view: 'gantt',
    openrig_gantt_window: '1',
    openrig_density_mode: 'detailed',
    openrig_sidebar_left: '1',
    openrig_sidebar_right: '0'
  });

  const migrated = loadDeckPrefs(storage);
  assert.equal(migrated.centerView, 'gantt');
  assert.equal(migrated.ganttWindowH, 1);
  assert.equal(migrated.density, 'detailed');
  assert.equal(migrated.sidebarLeftCollapsed, true);
  assert.equal(migrated.sidebarRightCollapsed, false);

  const saved = saveDeckPrefs(storage, { rigFilter: 'core-platform', calmMode: true, hideIdleNodes: true });
  assert.equal(saved.rigFilter, 'core-platform');
  assert.equal(saved.calmMode, true);
  assert.equal(saved.centerView, 'gantt');
  assert.ok(storage.getItem(PREFS_STORAGE_KEY));

  // Reloading preserves both migrated and newly saved fields
  const reloaded = loadDeckPrefs(storage);
  assert.deepEqual(reloaded, saved);

  // Corrupt JSON falls back cleanly without throwing
  storage.setItem(PREFS_STORAGE_KEY, '{broken');
  assert.equal(loadDeckPrefs(storage).rigFilter, 'all');
});

test('resolveEffectiveRigFilter keeps valid rig and safely falls back to all when rig disappears', () => {
  assert.equal(resolveEffectiveRigFilter('all', ['a', 'b']), 'all');
  assert.equal(resolveEffectiveRigFilter('a', ['a', 'b']), 'a');
  assert.equal(resolveEffectiveRigFilter('gone-rig', ['a', 'b']), 'all');
  assert.equal(resolveEffectiveRigFilter('pending-rig', []), 'pending-rig');
});
