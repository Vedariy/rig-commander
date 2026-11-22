export function getContextThermal(ctxPct, ctxWindowSize) {
  if (ctxPct === null || ctxPct === undefined) {
    return { color: '#475569', glow: 'rgba(71, 85, 105, 0.18)', pct: 6, label: '— (no reader)', tempTag: '❄️ CTX: —' };
  }
  const pct = Math.min(100, Math.max(4, Math.round(ctxPct)));
  const winK = ctxWindowSize ? `${Math.round(ctxWindowSize / 1000)}K` : '';
  const usedK = ctxWindowSize ? `${Math.round((ctxPct / 100) * (ctxWindowSize / 1000))}K / ${winK}` : `${pct}%`;

  if (pct <= 20) return { color: '#00f0ff', glow: 'rgba(0, 240, 255, 0.25)', pct, label: `${pct}% (${usedK})`, tempTag: `❄️ CTX ${pct}%` };
  if (pct <= 45) return { color: '#3b82f6', glow: 'rgba(59, 130, 246, 0.32)', pct, label: `${pct}% (${usedK})`, tempTag: `💧 CTX ${pct}%` };
  if (pct <= 70) return { color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.45)', pct, label: `${pct}% (${usedK})`, tempTag: `🌡️ CTX ${pct}%` };
  return { color: '#ff0055', glow: 'rgba(255, 0, 85, 0.65)', pct, label: `${pct}% (${usedK})`, tempTag: `🔥 CTX ${pct}%` };
}

export function formatTokensShort(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

export function computeBurn(a, lang = 'ru') {
  const en = lang === 'en';
  const h = Array.isArray(a && a.ctxHistory) ? a.ctxHistory : [];
  if (h.length < 2) return { perHour: null, label: en ? 'Pace: sampling…' : 'Темп: копим замеры…' };
  const first = h[0];
  const last = h[h.length - 1];
  const hours = (last.t - first.t) / 3600000;
  if (hours < 0.02) return { perHour: null, label: en ? 'Pace: sampling…' : 'Темп: копим замеры…' };
  const perHour = (last.pct - first.pct) / hours;
  if (perHour <= 0.1) return { perHour: 0, label: en ? 'Pace: ~0%/h (stable).' : 'Темп: ~0%/ч (стабильно).' };
  const left = 75 - last.pct;
  const eta = left > 0
    ? (en ? ` • to 75%: ~${Math.round((left / perHour) * 60)}m` : ` • до 75%: ~${Math.round((left / perHour) * 60)} мин`)
    : (en ? ' • 75% threshold passed' : ' • порог 75% пройден');
  return { perHour, label: en ? `Pace: +${perHour.toFixed(1)}%/h${eta}.` : `Темп: +${perHour.toFixed(1)}%/ч${eta}.` };
}
