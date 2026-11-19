export const GANTT_LONG_WAIT_MS = 15 * 60 * 1000;

export function ganttChainColor(key) {
  let h = 2166136261;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue}, 78%, 60%)`;
}

export function ganttRoleRank(id) {
  const s = String(id || '');
  if (s.includes('owner')) return 0;
  if (s.includes('senior') || s.includes('architect')) return 1;
  if (s.includes('operator')) return 2;
  if (s.includes('coder')) return 3;
  if (s.includes('check') || s.includes('qa')) return 4;
  return 5;
}
