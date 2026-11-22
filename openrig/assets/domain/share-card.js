/**
 * Viral Daily Fleet Receipt / Share Card Generator (Pure Domain Module, 0 deps).
 * Builds a clean 1200x630 SVG trophy card (exportable to crisp PNG via Canvas)
 * highlighting Mini Task Gantt, Cache Hit %, Tokens, and SUB vs PAYG ROI.
 * Includes privacy-first Anonymize mode so engineers can share real metrics without leaking repo/rig names.
 */

function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${Math.round(num / 1_000)}K`;
  return String(Math.round(num));
}

function anonymizeSeatLabel(seatId, counters) {
  const raw = String(seatId || '').toLowerCase();
  if (/owner|lead/.test(raw)) {
    counters.owner = (counters.owner || 0) + 1;
    return counters.owner === 1 ? 'architect' : `architect-${counters.owner}`;
  }
  if (/senior|arch/.test(raw)) {
    counters.senior = (counters.senior || 0) + 1;
    return counters.senior === 1 ? 'spec-lead' : `spec-lead-${counters.senior}`;
  }
  if (/check|qa/.test(raw)) {
    counters.qa = (counters.qa || 0) + 1;
    return `qa-${counters.qa}`;
  }
  if (/operator/.test(raw)) {
    counters.ops = (counters.ops || 0) + 1;
    return counters.ops === 1 ? 'ops' : `ops-${counters.ops}`;
  }
  counters.coder = (counters.coder || 0) + 1;
  return `coder-${counters.coder}`;
}

function shortSeatClean(seatId) {
  const s = String(seatId || '');
  const idx = s.lastIndexOf('@');
  return idx > 0 ? s.slice(0, idx) : s;
}

function fmtShortDate(tsMs, isEn) {
  const d = new Date(tsMs);
  const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthsRu = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const day = d.getUTCDate();
  const m = isEn ? monthsEn[d.getUTCMonth()] : monthsRu[d.getUTCMonth()];
  return isEn ? `${m} ${day}` : `${day} ${m}`;
}

function fmtDaysCompact(days, isEn) {
  const rounded = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
  return isEn ? `${rounded}D` : `${rounded}Д`;
}

const GANTT_PALETTE = ['#00f0ff', '#00ff9d', '#a855f7', '#fbbf24', '#38bdf8', '#fb7185'];

export function buildShareCardModel({
  agents = [],
  rigFilter = 'all',
  ganttItems = [],
  finopsReport = null,
  windowKey = 'h24',
  healthScore = 85,
  anonymize = false,
  lang = 'en',
  nowMs = Date.now()
} = {}) {
  const isEn = lang !== 'ru';
  const scopedAgents = (Array.isArray(agents) ? agents : []).filter(a => {
    if (!a || !a.id) return false;
    return !rigFilter || rigFilter === 'all' || String(a.id).endsWith('@' + rigFilter);
  });

  const totals = (finopsReport && finopsReport.totals) || {
    apiEqUsd: 0,
    subShareUsd: 0,
    paygCashUsd: 0,
    actualUsd: 0,
    savingsVsApiUsd: 0,
    savingsPct: 0,
    totalTokens: 0,
    cachedPct: 0,
    spanDays: 1,
    effectiveWindowDays: 1,
    monthlySubCommitUsd: 0,
    projectedMonthlyApiUsd: 0,
    projectedMonthlySavingsUsd: 0
  };
  const pools = (finopsReport && Array.isArray(finopsReport.pools)) ? finopsReport.pools : [];

  const effectiveDays = windowKey === 'h24'
    ? 1
    : windowKey === 'd7'
      ? 7
      : Math.min(30, Math.max(1, Number(totals.spanDays) || Number(totals.effectiveWindowDays) || 1));

  const periodStartMs = nowMs - effectiveDays * 86_400_000;
  const dateRangeStr = `${fmtShortDate(periodStartMs, isEn)} – ${fmtShortDate(nowMs, isEn)}, ${new Date(nowMs).getUTCFullYear()}`;

  const winShort = windowKey === 'h24'
    ? (isEn ? '24H' : '24Ч')
    : windowKey === 'd7'
      ? (isEn ? '7D' : '7Д')
      : (isEn ? `${fmtDaysCompact(effectiveDays, true)} SESS` : `${fmtDaysCompact(effectiveDays, false)} СЕСС`);

  const winLabel = windowKey === 'h24'
    ? (isEn ? 'LAST 24H' : 'ЗА 24 ЧАСА')
    : windowKey === 'd7'
      ? (isEn ? 'LAST 7 DAYS' : 'ЗА 7 ДНЕЙ')
      : (isEn ? `SESSION (~${fmtDaysCompact(effectiveDays, true)})` : `СЕССИЯ (~${fmtDaysCompact(effectiveDays, false)})`);

  const periodBadge = isEn
    ? `${winLabel} (${dateRangeStr})`
    : `${winLabel} (${dateRangeStr})`;

  const rigLabel = anonymize
    ? (rigFilter && rigFilter !== 'all' ? 'private-fleet' : 'multi-rig-fleet')
    : (rigFilter && rigFilter !== 'all' ? rigFilter : (isEn ? 'ALL RIGS' : 'ВСЕ РИГИ'));

  const d = new Date(nowMs);
  const dateStr = d.toISOString().slice(0, 10);

  // Build anonymized seat alias map deterministically
  const aliasCounters = {};
  const seatAliasById = new Map();
  for (const a of scopedAgents) {
    seatAliasById.set(a.id, anonymize ? anonymizeSeatLabel(a.id, aliasCounters) : shortSeatClean(a.id));
  }

  // Build compact Mini Task Gantt (top 5 seats with recent items, or fallback synthetic bars from agents)
  const winHours = windowKey === 'h24' ? 24 : windowKey === 'd7' ? 168 : 24;
  const winMs = winHours * 3600_000;
  const tStart = nowMs - winMs;
  const scopedGantt = (Array.isArray(ganttItems) ? ganttItems : []).filter(it => {
    if (!it || !it.to) return false;
    if (rigFilter && rigFilter !== 'all' && !String(it.to).endsWith('@' + rigFilter)) return false;
    const end = it.endAt ? Date.parse(it.endAt) : nowMs;
    return Number.isFinite(end) && end >= tStart;
  });

  const chainColors = new Map();
  const getChainColor = (ch) => {
    if (!chainColors.has(ch)) {
      chainColors.set(ch, GANTT_PALETTE[chainColors.size % GANTT_PALETTE.length]);
    }
    return chainColors.get(ch);
  };

  // Auto-fit Mini Gantt horizontal axis to actual scoped activity span so bars fill the track cleanly
  let spanStart = tStart;
  let spanEnd = nowMs;
  if (scopedGantt.length > 0) {
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const it of scopedGantt) {
      const c = Date.parse(it.createdAt || '');
      const e = it.endAt ? Date.parse(it.endAt) : nowMs;
      if (Number.isFinite(c) && c < minTs) minTs = Math.max(tStart, c);
      if (Number.isFinite(e) && e > maxTs) maxTs = Math.min(nowMs, e);
    }
    if (Number.isFinite(minTs) && Number.isFinite(maxTs)) {
      const rawSpan = Math.max(30 * 60_000, maxTs - minTs);
      spanStart = minTs - rawSpan * 0.03;
      spanEnd = maxTs + rawSpan * 0.03;
    }
  }
  const effectiveSpanMs = Math.max(1, spanEnd - spanStart);

  const lanesMap = new Map();
  for (const it of scopedGantt) {
    const key = it.to;
    if (!lanesMap.has(key)) {
      const label = seatAliasById.get(key) || (anonymize ? anonymizeSeatLabel(key, aliasCounters) : shortSeatClean(key));
      lanesMap.set(key, { seatId: key, label, segments: [] });
    }
    const created = Date.parse(it.createdAt || '') || spanStart;
    const claimed = it.claimedAt ? Date.parse(it.claimedAt) : created;
    const end = it.endAt ? Date.parse(it.endAt) : nowMs;
    const clampFrac = (ts) => Math.max(0, Math.min(1, (ts - spanStart) / effectiveSpanMs));
    lanesMap.get(key).segments.push({
      waitStart: clampFrac(created),
      workStart: clampFrac(Math.max(created, claimed)),
      workEnd: Math.max(clampFrac(Math.max(created, claimed)) + 0.03, clampFrac(end)),
      color: getChainColor(it.chain || it.slice || it.id || 'default')
    });
  }

  let ganttLanes = Array.from(lanesMap.values())
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 5);

  if (ganttLanes.length === 0) {
    ganttLanes = scopedAgents.slice(0, 5).map((a, idx) => ({
      seatId: a.id,
      label: seatAliasById.get(a.id) || shortSeatClean(a.id),
      segments: [{
        waitStart: 0.08 + idx * 0.07,
        workStart: 0.14 + idx * 0.07,
        workEnd: Math.min(0.96, 0.45 + idx * 0.11),
        color: GANTT_PALETTE[idx % GANTT_PALETTE.length]
      }]
    }));
  }

  const maxPoolApi = Math.max(0.01, ...pools.map(p => Number(p.apiEqUsd) || 0));
  const poolRows = pools.slice(0, 4).map(p => ({
    id: p.poolId,
    name: p.poolName,
    color: p.color || '#38bdf8',
    mode: (p.plan && p.plan.mode) || 'payg',
    apiEqUsd: Number(p.apiEqUsd) || 0,
    subWindowUsd: Number(p.subWindowUsd) || 0,
    roiRatio: p.roiRatio,
    verdict: p.verdict,
    barPct: Math.max(6, Math.min(100, Math.round(((Number(p.apiEqUsd) || 0) / maxPoolApi) * 100))),
    seatCount: p.seatCount || 0
  }));

  const savingsPositive = totals.savingsVsApiUsd >= 0;
  const roiMultiplier = totals.subShareUsd > 0 && totals.apiEqUsd > 0
    ? Math.round((totals.apiEqUsd / totals.subShareUsd) * 10) / 10
    : null;

  const taskCount = scopedGantt.length || scopedAgents.reduce((s, a) => s + (a.callsIn || 0), 0);
  const workingCount = scopedAgents.filter(a => a.state === 'working').length;

  const ganttSpanHours = Math.max(0.5, Math.round((effectiveSpanMs / 3600_000) * 10) / 10);
  const ganttSpanLabel = scopedGantt.length > 0
    ? (ganttSpanHours >= 48
        ? (isEn ? `${Math.round(ganttSpanHours / 24)}D` : `${Math.round(ganttSpanHours / 24)}Д`)
        : (isEn ? `${ganttSpanHours}H` : `${ganttSpanHours}Ч`))
    : winShort;

  const headline = isEn
    ? `AI Coding Fleet Receipt • ${winLabel}`
    : `Отчёт ИИ-флота • ${winLabel}`;

  const projectedMoSav = typeof totals.projectedMonthlySavingsUsd === 'number'
    ? totals.projectedMonthlySavingsUsd
    : Math.round((totals.savingsVsApiUsd * (30 / effectiveDays)) * 100) / 100;

  const shareText = isEn
    ? [
        `💠 My ${scopedAgents.length}-agent AI coding fleet (${winLabel.toLowerCase()}, ${dateRangeStr}):`,
        `• ${fmtTokens(totals.totalTokens)} tokens (${totals.cachedPct}% prompt cache hit)`,
        `• $${totals.apiEqUsd.toFixed(2)} pure API value vs $${totals.actualUsd.toFixed(2)} actual cost (${savingsPositive ? `saved +$${totals.savingsVsApiUsd.toFixed(2)} in ${winShort.toLowerCase()}, ~$${Math.abs(projectedMoSav).toFixed(0)}/mo pace` : `overpaying -$${Math.abs(totals.savingsVsApiUsd).toFixed(2)} in ${winShort.toLowerCase()}`}${roiMultiplier && savingsPositive ? ` • ${roiMultiplier}x SUB ROI` : ''})`,
        `• Tracked locally with 0-dep RigCommander (npx rig-commander) → https://rig-commander.vercel.app/demo`
      ].join('\n')
    : [
        `💠 Сводка моего ИИ-флота из ${scopedAgents.length} агентов (${winLabel.toLowerCase()}, ${dateRangeStr}):`,
        `• ${fmtTokens(totals.totalTokens)} токенов (${totals.cachedPct}% кэш-хит)`,
        `• ~$${totals.apiEqUsd.toFixed(2)} эквивалент API против $${totals.actualUsd.toFixed(2)} факта (${savingsPositive ? `экономия +$${totals.savingsVsApiUsd.toFixed(2)} за ${winShort.toLowerCase()}, темп +$${Math.abs(projectedMoSav).toFixed(0)}/мес` : `переплата -$${Math.abs(totals.savingsVsApiUsd).toFixed(2)} за ${winShort.toLowerCase()}`}${roiMultiplier && savingsPositive ? ` • ${roiMultiplier}× ROI подписки` : ''})`,
        `• Локальный контроль флота в RigCommander (npx rig-commander) → https://rig-commander.vercel.app/demo`
      ].join('\n');

  return {
    lang: isEn ? 'en' : 'ru',
    anonymize: Boolean(anonymize),
    dateStr,
    dateRangeStr,
    effectiveDays,
    winShort,
    winLabel,
    periodBadge,
    ganttSpanLabel,
    projectedMonthlySavingsUsd: projectedMoSav,
    rigLabel,
    headline,
    seatCount: scopedAgents.length,
    workingCount,
    taskCount,
    healthScore: Math.round(Number(healthScore) || 85),
    totals,
    savingsPositive,
    roiMultiplier,
    poolRows,
    ganttLanes,
    shareText
  };
}

export function renderShareCardSvg(model) {
  const m = model || buildShareCardModel();
  const isEn = m.lang !== 'ru';
  const t = m.totals || {};
  const winShort = m.winShort || (isEn ? '24H' : '24Ч');
  const saveSign = m.savingsPositive ? '+' : '−';
  const saveColor = m.savingsPositive ? '#00ff9d' : '#fb923c';
  const saveBg = m.savingsPositive ? 'rgba(0,255,157,0.12)' : 'rgba(251,146,60,0.12)';
  const roiPill = m.roiMultiplier && m.savingsPositive
    ? `${m.roiMultiplier.toFixed(1)}× SUB ROI`
    : (m.savingsPositive ? (isEn ? 'OPTIMAL' : 'ОПТИМАЛЬНО') : (isEn ? 'REVIEW PLANS' : 'ПРОВЕРИТЬ ПЛАНЫ'));

  const moSavAbs = Math.abs(Number(m.projectedMonthlySavingsUsd) || 0).toFixed(0);
  const actualSubLine = (t.paygCashUsd || 0) <= 0 && (t.monthlySubCommitUsd || 0) > 0
    ? (isEn
        ? `SUB $${(t.subShareUsd || 0).toFixed(2)} (of $${Math.round(t.monthlySubCommitUsd)}/mo)`
        : `SUB $${(t.subShareUsd || 0).toFixed(2)} (из $${Math.round(t.monthlySubCommitUsd)}/мес)`)
    : `SUB $${(t.subShareUsd || 0).toFixed(2)} · PAYG $${(t.paygCashUsd || 0).toFixed(2)}`;

  const savingsSubLine = m.savingsPositive
    ? (isEn
        ? `${Math.abs(t.savingsPct || 0)}% saved · +$${moSavAbs}/mo pace`
        : `−${Math.abs(t.savingsPct || 0)}% от API · +$${moSavAbs}/мес`)
    : (isEn
        ? `−$${moSavAbs}/mo pace · overpaying`
        : `темп −$${moSavAbs}/мес · переплата`);

  const kpiCards = [
    {
      x: 44,
      label: isEn ? `PURE API EQUIV. · ${winShort}` : `ЭКВИВАЛЕНТ API · ${winShort}`,
      val: `~$${(t.apiEqUsd || 0).toFixed(2)}`,
      sub: isEn ? `pace ~$${(t.projectedMonthlyApiUsd || 0).toFixed(0)}/mo (30d)` : `темп ~$${(t.projectedMonthlyApiUsd || 0).toFixed(0)}/мес (30д)`,
      color: '#fde68a',
      border: 'rgba(251,191,36,0.45)'
    },
    {
      x: 326,
      label: isEn ? `ACTUAL COST · ${winShort}` : `ФАКТ. РАСХОД · ${winShort}`,
      val: `$${(t.actualUsd || 0).toFixed(2)}`,
      sub: actualSubLine,
      color: '#7dd3fc',
      border: 'rgba(56,189,248,0.45)'
    },
    {
      x: 608,
      label: isEn ? `SAVINGS VS API · ${winShort}` : `ЭКОНОМИЯ VS API · ${winShort}`,
      val: `${saveSign}$${Math.abs(t.savingsVsApiUsd || 0).toFixed(2)}`,
      sub: savingsSubLine,
      color: saveColor,
      border: m.savingsPositive ? 'rgba(0,255,157,0.5)' : 'rgba(251,146,60,0.5)'
    },
    {
      x: 890,
      label: isEn ? `TOKENS & CACHE · ${winShort}` : `ТОКЕНЫ И КЭШ · ${winShort}`,
      val: `${fmtTokens(t.totalTokens || 0)}`,
      sub: `${t.cachedPct || 0}% ${isEn ? 'cached' : 'из кэша'} · ${m.seatCount} ${isEn ? 'agents' : 'агентов'}`,
      color: '#c084fc',
      border: 'rgba(168,85,247,0.45)'
    }
  ];

  const kpiSvg = kpiCards.map(c => `
    <g transform="translate(${c.x}, 116)">
      <rect width="266" height="106" rx="14" fill="rgba(11,20,40,0.88)" stroke="${c.border}" stroke-width="1.5"/>
      <text x="18" y="28" fill="#94a3b8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" font-weight="700" letter-spacing="0.8">${escXml(c.label)}</text>
      <text x="18" y="68" fill="${c.color}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="31" font-weight="800">${escXml(c.val)}</text>
      <text x="18" y="92" fill="#cbd5e1" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${escXml(c.sub)}</text>
    </g>
  `).join('');

  // Left lower box: Mini Task Gantt
  const ganttRowsSvg = m.ganttLanes.map((lane, i) => {
    const y = 58 + i * 44;
    const trackX = 166;
    const trackW = 396;
    const cleanLabel = lane.label.length > 18 ? `${lane.label.slice(0, 17)}…` : lane.label;
    const segsSvg = lane.segments.slice(0, 12).map(seg => {
      const wx0 = trackX + seg.waitStart * trackW;
      const wx1 = trackX + seg.workStart * trackW;
      const x1 = trackX + Math.min(1, seg.workEnd) * trackW;
      const waitW = Math.max(0, wx1 - wx0);
      const workW = Math.max(8, x1 - wx1);
      return `
        ${waitW > 2 ? `<rect x="${wx0.toFixed(1)}" y="${y - 10}" width="${waitW.toFixed(1)}" height="18" rx="4" fill="url(#waitHatch)" stroke="rgba(148,163,184,0.45)" stroke-width="1"/>` : ''}
        <rect x="${wx1.toFixed(1)}" y="${y - 10}" width="${workW.toFixed(1)}" height="18" rx="4" fill="${escXml(seg.color)}" fill-opacity="0.88"/>
      `;
    }).join('');
    return `
      <line x1="16" y1="${y + 18}" x2="572" y2="${y + 18}" stroke="rgba(56,189,248,0.1)" stroke-width="1"/>
      <text x="18" y="${y + 3}" fill="#e2e8f0" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12.5" font-weight="700">${escXml(cleanLabel)}</text>
      <rect x="${trackX}" y="${y - 10}" width="${trackW}" height="18" rx="4" fill="rgba(15,23,42,0.75)"/>
      ${segsSvg}
    `;
  }).join('');

  // Right lower box: Exclusive Model Pools & SUB vs API
  const poolRowsSvg = m.poolRows.map((p, i) => {
    const y = 60 + i * 54;
    const modeColor = p.mode === 'sub' ? '#38bdf8' : '#fde68a';
    const modeLabel = p.mode === 'sub' ? 'SUB' : 'PAYG';
    const rightInfo = p.mode === 'sub' && p.roiRatio !== null
      ? `~$${p.apiEqUsd.toFixed(2)} (${p.roiRatio.toFixed(1)}×)`
      : `~$${p.apiEqUsd.toFixed(2)}`;
    const barW = Math.round((p.barPct / 100) * 456);
    return `
      <g transform="translate(18, ${y})">
        <text x="0" y="0" fill="${escXml(p.color)}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" font-weight="800">${escXml(p.name)}</text>
        <rect x="210" y="-12" width="44" height="16" rx="4" fill="rgba(2,6,23,0.8)" stroke="${modeColor}" stroke-width="1"/>
        <text x="232" y="0" text-anchor="middle" fill="${modeColor}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" font-weight="800">${modeLabel}</text>
        <text x="456" y="0" text-anchor="end" fill="#fde68a" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12.5" font-weight="700">${escXml(rightInfo)}</text>
        <rect x="0" y="10" width="456" height="10" rx="5" fill="rgba(15,23,42,0.9)"/>
        <rect x="0" y="10" width="${Math.max(12, barW)}" height="10" rx="5" fill="${escXml(p.color)}" fill-opacity="0.9"/>
      </g>
    `;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#030712"/>
      <stop offset="52%" stop-color="#081226"/>
      <stop offset="100%" stop-color="#050d1e"/>
    </linearGradient>
    <radialGradient id="glowCyan" cx="18%" cy="15%" r="48%">
      <stop offset="0%" stop-color="rgba(0,240,255,0.16)"/>
      <stop offset="100%" stop-color="rgba(0,240,255,0)"/>
    </radialGradient>
    <radialGradient id="glowEmerald" cx="85%" cy="85%" r="50%">
      <stop offset="0%" stop-color="rgba(0,255,157,0.14)"/>
      <stop offset="100%" stop-color="rgba(0,255,157,0)"/>
    </radialGradient>
    <pattern id="bgGrid" width="36" height="36" patternUnits="userSpaceOnUse">
      <path d="M 36 0 L 0 0 0 36" fill="none" stroke="rgba(56,189,248,0.05)" stroke-width="1"/>
    </pattern>
    <pattern id="waitHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="rgba(148,163,184,0.12)"/>
      <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(148,163,184,0.55)" stroke-width="2"/>
    </pattern>
  </defs>

  <rect width="1200" height="630" fill="url(#bgGrad)"/>
  <rect width="1200" height="630" fill="url(#bgGrid)"/>
  <rect width="1200" height="630" fill="url(#glowCyan)"/>
  <rect width="1200" height="630" fill="url(#glowEmerald)"/>
  <rect x="14" y="14" width="1172" height="602" rx="20" fill="none" stroke="rgba(56,189,248,0.28)" stroke-width="1.5"/>

  <!-- HEADER -->
  <text x="44" y="64" fill="#f8fafc" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="28" font-weight="800">💠 RIGCOMMANDER // ${escXml(m.headline)}</text>
  <text x="44" y="92" fill="#94a3b8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13"><tspan fill="#67e8f9" font-weight="700">📅 ${escXml(m.periodBadge || m.dateStr)}</tspan>  •  ${escXml(m.rigLabel)}  •  ${m.seatCount} ${escXml(isEn ? 'SEATS' : 'УЗЛОВ')}  •  ${m.taskCount} ${escXml(isEn ? 'HANDOFFS' : 'ПЕРЕДАЧ')}  •  HEALTH ${m.healthScore}%</text>

  <rect x="944" y="42" width="212" height="40" rx="20" fill="${saveBg}" stroke="${saveColor}" stroke-width="1.5"/>
  <text x="1050" y="67" text-anchor="middle" fill="${saveColor}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13.5" font-weight="800">${escXml(roiPill)}</text>

  <!-- 4 KPI TILES -->
  ${kpiSvg}

  <!-- LOWER LEFT: MINI TASK GANTT -->
  <g transform="translate(44, 246)">
    <rect width="590" height="296" rx="14" fill="rgba(10,18,36,0.88)" stroke="rgba(56,189,248,0.26)" stroke-width="1.5"/>
    <text x="18" y="30" fill="#67e8f9" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" font-weight="800" letter-spacing="0.5">${escXml(isEn ? `📊 MINI TASK GANTT (${m.ganttSpanLabel || winShort} • WAIT HATCHED vs WORK)` : `📊 МИНИ-ГАНТ (${m.ganttSpanLabel || winShort} • ШТРИХ = ОЖИДАНИЕ vs РАБОТА)`)}</text>
    ${ganttRowsSvg}
  </g>

  <!-- LOWER RIGHT: EXCLUSIVE POOLS & SUB VS API -->
  <g transform="translate(658, 246)">
    <rect width="498" height="296" rx="14" fill="rgba(10,18,36,0.88)" stroke="rgba(0,255,157,0.26)" stroke-width="1.5"/>
    <text x="18" y="30" fill="#6ee7b7" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" font-weight="800" letter-spacing="0.5">${escXml(isEn ? `💰 MODEL POOLS · ${winShort} (SUB vs API)` : `💰 ПУЛЫ МОДЕЛЕЙ · ${winShort} (SUB vs API)`)}</text>
    ${poolRowsSvg}
  </g>

  <!-- FOOTER -->
  <text x="44" y="586" fill="#64748b" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">0 npm deps • Local-First AI Fleet Mission Control • MIT Open Source</text>
  <text x="1156" y="586" text-anchor="end" fill="#00f0ff" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13.5" font-weight="700">npx rig-commander  •  rig-commander.vercel.app</text>
</svg>`;
}
