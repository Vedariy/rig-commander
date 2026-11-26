/**
 * Persistent UI Preferences for RigCommander Command Deck (Pure Domain Module).
 * Stores operator settings in localStorage under a single versioned JSON key
 * while remaining backwards-compatible with legacy openrig_* keys.
 */

import { BUDGET_WINDOWS, DEFAULT_BILLING_PLANS, sanitizeBillingPlans } from './finops.js';

export const PREFS_STORAGE_KEY = 'rigcommander_prefs_v1';

export const DEFAULT_DECK_PREFS = Object.freeze({
  rigFilter: 'all',
  calmMode: false,
  hideIdleNodes: false,
  radarFilter: 'all', // 'all' | 'blockers' | 'tasks'
  centerView: 'graph', // 'graph' | 'gantt'
  graphLayout: 'dynamic', // 'dynamic' | 'fixed'
  ganttWindowH: 6, // 0.5 | 1 | 6 | 24
  ganttMode: 'timeline', // 'timeline' | 'sequence'
  ganttGroupBy: 'agent', // 'agent' | 'chain'
  ganttHideNoise: true,
  density: 'fit', // 'fit' | 'detailed'
  sidebarLeftCollapsed: false,
  sidebarRightCollapsed: false,
  swimlanesCollapsed: false,
  autoFollow: true,
  audioRadarOn: false,
  desktopNotifications: false,
  selectedAgentId: '',
  inspectorTab: 'rules', // 'rules' | 'fallback' | 'memory'
  inspectorRefOpen: false,
  budgetWindow: 'h24', // 'h24' | 'd7' | 'session'
  billingPlans: DEFAULT_BILLING_PLANS
});

const VALID_RADAR = new Set(['all', 'blockers', 'tasks']);
const VALID_CENTER = new Set(['graph', 'gantt']);
const VALID_GRAPH_LAYOUT = new Set(['dynamic', 'fixed']);
const VALID_GANTT_H = new Set([0.5, 1, 6, 24]);
const VALID_GANTT_MODE = new Set(['timeline', 'sequence']);
const VALID_GANTT_GROUP = new Set(['agent', 'chain']);
const VALID_DENSITY = new Set(['fit', 'detailed']);
const VALID_INSP_TAB = new Set(['rules', 'fallback', 'memory']);
const VALID_BUDGET_WIN = new Set(BUDGET_WINDOWS);
const SAFE_ID_RE = /^[a-zA-Z0-9._@-]{1,96}$/;

export function sanitizeDeckPrefs(raw = {}) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const rigRaw = typeof src.rigFilter === 'string' ? src.rigFilter.trim() : '';
  const rigFilter = rigRaw === 'all' || SAFE_ID_RE.test(rigRaw) ? rigRaw : DEFAULT_DECK_PREFS.rigFilter;

  const seatRaw = typeof src.selectedAgentId === 'string' ? src.selectedAgentId.trim() : '';
  const selectedAgentId = SAFE_ID_RE.test(seatRaw) ? seatRaw : '';

  const ganttNum = Number(src.ganttWindowH);

  return {
    rigFilter,
    calmMode: typeof src.calmMode === 'boolean' ? src.calmMode : DEFAULT_DECK_PREFS.calmMode,
    hideIdleNodes: typeof src.hideIdleNodes === 'boolean' ? src.hideIdleNodes : DEFAULT_DECK_PREFS.hideIdleNodes,
    radarFilter: VALID_RADAR.has(src.radarFilter) ? src.radarFilter : DEFAULT_DECK_PREFS.radarFilter,
    centerView: VALID_CENTER.has(src.centerView) ? src.centerView : DEFAULT_DECK_PREFS.centerView,
    graphLayout: VALID_GRAPH_LAYOUT.has(src.graphLayout) ? src.graphLayout : DEFAULT_DECK_PREFS.graphLayout,
    ganttWindowH: VALID_GANTT_H.has(ganttNum) ? ganttNum : DEFAULT_DECK_PREFS.ganttWindowH,
    ganttMode: VALID_GANTT_MODE.has(src.ganttMode) ? src.ganttMode : DEFAULT_DECK_PREFS.ganttMode,
    ganttGroupBy: VALID_GANTT_GROUP.has(src.ganttGroupBy) ? src.ganttGroupBy : DEFAULT_DECK_PREFS.ganttGroupBy,
    ganttHideNoise: typeof src.ganttHideNoise === 'boolean' ? src.ganttHideNoise : DEFAULT_DECK_PREFS.ganttHideNoise,
    density: VALID_DENSITY.has(src.density) ? src.density : DEFAULT_DECK_PREFS.density,
    sidebarLeftCollapsed: typeof src.sidebarLeftCollapsed === 'boolean' ? src.sidebarLeftCollapsed : DEFAULT_DECK_PREFS.sidebarLeftCollapsed,
    sidebarRightCollapsed: typeof src.sidebarRightCollapsed === 'boolean' ? src.sidebarRightCollapsed : DEFAULT_DECK_PREFS.sidebarRightCollapsed,
    swimlanesCollapsed: typeof src.swimlanesCollapsed === 'boolean' ? src.swimlanesCollapsed : DEFAULT_DECK_PREFS.swimlanesCollapsed,
    autoFollow: typeof src.autoFollow === 'boolean' ? src.autoFollow : DEFAULT_DECK_PREFS.autoFollow,
    audioRadarOn: typeof src.audioRadarOn === 'boolean' ? src.audioRadarOn : DEFAULT_DECK_PREFS.audioRadarOn,
    desktopNotifications: typeof src.desktopNotifications === 'boolean' ? src.desktopNotifications : DEFAULT_DECK_PREFS.desktopNotifications,
    selectedAgentId,
    inspectorTab: VALID_INSP_TAB.has(src.inspectorTab) ? src.inspectorTab : DEFAULT_DECK_PREFS.inspectorTab,
    inspectorRefOpen: typeof src.inspectorRefOpen === 'boolean' ? src.inspectorRefOpen : DEFAULT_DECK_PREFS.inspectorRefOpen,
    budgetWindow: VALID_BUDGET_WIN.has(src.budgetWindow) ? src.budgetWindow : DEFAULT_DECK_PREFS.budgetWindow,
    billingPlans: sanitizeBillingPlans(src.billingPlans)
  };
}

export function loadDeckPrefs(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ...DEFAULT_DECK_PREFS };
  }
  try {
    const rawJson = storage.getItem(PREFS_STORAGE_KEY);
    if (rawJson) {
      return sanitizeDeckPrefs(JSON.parse(rawJson));
    }
  } catch {
    // fall through to legacy migration
  }

  // Graceful one-time migration from legacy individual keys
  const legacy = {};
  try {
    const cv = storage.getItem('openrig_center_view');
    if (cv) legacy.centerView = cv;
    const gw = storage.getItem('openrig_gantt_window');
    if (gw) legacy.ganttWindowH = Number(gw);
    const dm = storage.getItem('openrig_density_mode');
    if (dm) legacy.density = dm;
    const sl = storage.getItem('openrig_sidebar_left');
    if (sl === '1' || sl === '0') legacy.sidebarLeftCollapsed = sl === '1';
    const sr = storage.getItem('openrig_sidebar_right');
    if (sr === '1' || sr === '0') legacy.sidebarRightCollapsed = sr === '1';
  } catch {
    // ignore storage access errors
  }
  return sanitizeDeckPrefs(legacy);
}

export function saveDeckPrefs(storage, patch = {}) {
  const current = loadDeckPrefs(storage);
  const next = sanitizeDeckPrefs({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  if (!storage || typeof storage.setItem !== 'function') return next;
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    // Keep legacy keys in sync for compatibility
    storage.setItem('openrig_center_view', next.centerView);
    storage.setItem('openrig_gantt_window', String(next.ganttWindowH));
    storage.setItem('openrig_density_mode', next.density);
    storage.setItem('openrig_sidebar_left', next.sidebarLeftCollapsed ? '1' : '0');
    storage.setItem('openrig_sidebar_right', next.sidebarRightCollapsed ? '1' : '0');
  } catch {
    // Safari private mode / quota exceeded
  }
  return next;
}

export function resolveEffectiveRigFilter(savedRig, availableRigNames = []) {
  const clean = typeof savedRig === 'string' ? savedRig.trim() : '';
  if (!clean || clean === 'all') return 'all';
  if (!Array.isArray(availableRigNames) || availableRigNames.length === 0) return clean;
  return availableRigNames.includes(clean) ? clean : 'all';
}
