export const THERMAL_CURVE_OPTIMAL_PCT = 35;
export const THERMAL_CURVE_BASE_H = 6;
export const THERMAL_CURVE_MAX_H = 96;
export const THERMAL_CURVE_EXP_K = 1.3;

/**
 * Computes the height (% of card height from bottom edge) of the non-linear thermal wedge:
 * flat baseline (6% ≈ 3px) across optimal context (0..35%), then exponential flare upward to 96%.
 */
export function evalThermalCurveHeightPct(pct) {
  const x = Math.min(100, Math.max(0, Number(pct) || 0));
  if (x <= THERMAL_CURVE_OPTIMAL_PCT) return THERMAL_CURVE_BASE_H;
  const t = (x - THERMAL_CURVE_OPTIMAL_PCT) / (100 - THERMAL_CURVE_OPTIMAL_PCT);
  const expNorm = (Math.exp(THERMAL_CURVE_EXP_K * t) - 1) / (Math.exp(THERMAL_CURVE_EXP_K) - 1);
  return +(THERMAL_CURVE_BASE_H + (THERMAL_CURVE_MAX_H - THERMAL_CURVE_BASE_H) * expNorm).toFixed(2);
}

/**
 * Generates SVG path commands (in a 0..100 x 0..100 coordinate box with bottom edge y=100)
 * for the exponential thermal wedge area and its luminous top ridge curve.
 */
export function buildThermalCurvePaths(step = 2.5) {
  const safeStep = Math.max(0.5, Math.min(10, Number(step) || 2.5));
  const points = [];
  for (let x = 0; x <= 100 + 1e-6; x += safeStep) {
    const cx = Math.min(100, +x.toFixed(2));
    const y = +(100 - evalThermalCurveHeightPct(cx)).toFixed(2);
    points.push([cx, y]);
  }
  const last = points[points.length - 1];
  if (!last || last[0] < 100) {
    points.push([100, +(100 - evalThermalCurveHeightPct(100)).toFixed(2)]);
  }
  const ridgePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
  const areaPath = `${ridgePath} L 100 100 L 0 100 Z`;
  return { areaPath, ridgePath, points };
}

export function buildThermalCurveSvgHtml() {
  const { areaPath, ridgePath } = buildThermalCurvePaths(2.5);
  return `<svg class="node-thermal-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${areaPath}" fill="url(#rigThermalWedgeGrad)"/><rect x="0" y="94.5" width="100" height="5.5" fill="url(#rigThermalRidgeGrad)" opacity="0.9"/><path d="${ridgePath}" fill="none" stroke="url(#rigThermalRidgeGrad)" stroke-width="1.8" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

export function getContextThermal(ctxPct, ctxWindowSize) {
  if (ctxPct === null || ctxPct === undefined || !Number.isFinite(Number(ctxPct))) {
    return {
      color: '#64748b',
      glow: 'rgba(71, 85, 105, 0.12)',
      pct: 0,
      tier: 'none',
      band: 'none',
      tokensShort: '',
      label: '— (no reader)',
      tempTag: 'CTX: —'
    };
  }
  const rawPct = Math.min(100, Math.max(0, Math.round(Number(ctxPct))));
  const pct = Math.max(4, rawPct);
  const winK = ctxWindowSize ? `${Math.round(ctxWindowSize / 1000)}K` : '';
  const usedNumK = ctxWindowSize ? Math.round((rawPct / 100) * (ctxWindowSize / 1000)) : null;
  const usedK = ctxWindowSize ? `${usedNumK}K / ${winK}` : `${rawPct}%`;
  const tokensShort = ctxWindowSize ? `${usedNumK}K/${winK}` : '';
  const label = `${rawPct}% (${usedK})`;

  // 6-Band Thermal Spectrum (Inferno/Plasma — zero green conflict with WORKING emerald #00ff9d):
  // violet (0-19%) -> blue (20-39%) -> sky (40-54%) -> yellow (55-64%) -> orange (65-74% warn) -> red (>=75% crit)
  if (rawPct < 20) {
    return { color: '#a78bfa', glow: 'rgba(167, 139, 250, 0.18)', pct, tier: 'cool', band: 'violet', tokensShort, label, tempTag: `❄️ CTX ${rawPct}%` };
  }
  if (rawPct < 40) {
    return { color: '#60a5fa', glow: 'rgba(96, 165, 250, 0.20)', pct, tier: 'cool', band: 'blue', tokensShort, label, tempTag: `💧 CTX ${rawPct}%` };
  }
  if (rawPct < 55) {
    return { color: '#38bdf8', glow: 'rgba(56, 189, 248, 0.22)', pct, tier: 'cool', band: 'sky', tokensShort, label, tempTag: `💧 CTX ${rawPct}%` };
  }
  if (rawPct < 65) {
    return { color: '#facc15', glow: 'rgba(250, 204, 21, 0.28)', pct, tier: 'warm', band: 'yellow', tokensShort, label, tempTag: `🌡️ CTX ${rawPct}%` };
  }
  if (rawPct < 75) {
    return { color: '#fb923c', glow: 'rgba(251, 146, 60, 0.38)', pct, tier: 'warn', band: 'orange', tokensShort, label, tempTag: `🌡️ CTX ${rawPct}%` };
  }
  return { color: '#ff0055', glow: 'rgba(255, 0, 85, 0.60)', pct, tier: 'crit', band: 'red', tokensShort, label, tempTag: `🔥 CTX ${rawPct}%` };
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
