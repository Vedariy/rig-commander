import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShareCardModel, renderShareCardSvg } from '../openrig/assets/domain/share-card.js';
import { computeFleetFinOpsReport } from '../openrig/assets/domain/finops.js';
import { classifyModelPool, computeModelPools } from '../openrig/assets/ontology/snapshot.js';

const SAMPLE_AGENTS = [
  {
    id: 'dev-owner@secret-corp',
    shortName: 'dev-owner',
    harness: 'codex',
    model: 'gpt-6.2-sol',
    state: 'working',
    ctxPct: 48,
    usage: { totalTokens: 70_000_000, inputTokens: 69_000_000, uncachedInputTokens: 2_000_000, cachedInputTokens: 67_000_000, outputTokens: 1_000_000, estUsd: 24.5, spanDays: 1 }
  },
  {
    id: 'dev-coder4@secret-corp',
    shortName: 'dev-coder4',
    harness: 'claude-code',
    model: 'glm-5.3-flash',
    state: 'idle',
    ctxPct: 22,
    usage: { totalTokens: 5_000_000, inputTokens: 4_800_000, uncachedInputTokens: 400_000, cachedInputTokens: 4_400_000, outputTokens: 200_000, estUsd: 1.04, spanDays: 1 }
  }
];

test('buildShareCardModel & renderShareCardSvg generate valid 1200x630 SVG with ROI and Mini Gantt', () => {
  const finops = computeFleetFinOpsReport({
    agents: SAMPLE_AGENTS,
    rigFilter: 'secret-corp',
    windowKey: 'h24',
    billingPlans: { 'codex-gpt': { mode: 'sub', monthlyUsd: 200 }, 'fast-open': { mode: 'payg', monthlyUsd: 0 } },
    classifyPoolFn: classifyModelPool,
    computePoolsFn: computeModelPools
  });
  const now = Date.parse('2026-11-22T15:00:00.000Z');
  const model = buildShareCardModel({
    agents: SAMPLE_AGENTS,
    rigFilter: 'secret-corp',
    ganttItems: [
      { id: 'q1', from: 'dev-owner@secret-corp', to: 'dev-coder4@secret-corp', chain: 'slice:payments', createdAt: '2026-11-22T12:00:00.000Z', claimedAt: '2026-11-22T12:30:00.000Z', endAt: '2026-11-22T14:00:00.000Z' }
    ],
    finopsReport: finops,
    windowKey: 'h24',
    healthScore: 92,
    anonymize: false,
    lang: 'en',
    nowMs: now
  });

  assert.equal(model.rigLabel, 'secret-corp');
  assert.equal(model.savingsPositive, true);
  assert.ok(model.roiMultiplier >= 3.5);
  assert.equal(model.ganttLanes.length, 1);

  const svg = renderShareCardSvg(model);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('~$25.54'));
  assert.ok(svg.includes('SUB ROI'));
  assert.ok(svg.includes('dev-coder4'));
  assert.ok(svg.includes('Nov 21 – Nov 22, 2026'), 'date range must be explicitly visible on card');
  assert.ok(svg.includes('SAVINGS VS API · 24H'), 'KPI tile must state exact calculation window');
  assert.ok(svg.includes('/mo pace'), 'monthly savings run-rate must be shown');
});

test('anonymize mode strips private rig and seat identifiers while keeping real metrics intact', () => {
  const finops = computeFleetFinOpsReport({
    agents: SAMPLE_AGENTS,
    rigFilter: 'secret-corp',
    windowKey: 'h24',
    classifyPoolFn: classifyModelPool,
    computePoolsFn: computeModelPools
  });
  const model = buildShareCardModel({
    agents: SAMPLE_AGENTS,
    rigFilter: 'secret-corp',
    ganttItems: [
      { id: 'q1', from: 'dev-owner@secret-corp', to: 'dev-coder4@secret-corp', chain: 'slice:secret-payroll', createdAt: '2026-11-22T12:00:00.000Z', endAt: '2026-11-22T14:00:00.000Z' }
    ],
    finopsReport: finops,
    windowKey: 'h24',
    anonymize: true,
    lang: 'ru',
    nowMs: Date.parse('2026-11-22T15:00:00.000Z')
  });

  const svg = renderShareCardSvg(model);
  assert.equal(svg.includes('secret-corp'), false, 'private rig name must be scrubbed');
  assert.equal(svg.includes('dev-owner'), false, 'private seat name must be scrubbed');
  assert.equal(svg.includes('dev-coder4'), false, 'private seat name must be scrubbed');
  assert.equal(svg.includes('secret-payroll'), false, 'private slice name must be scrubbed');
  assert.ok(svg.includes('private-fleet'));
  assert.ok(svg.includes('coder-1'));
  assert.ok(svg.includes('~$25.54'));
  assert.ok(model.shareText.includes('Отчёт') || model.shareText.includes('Сводка'));
});

test('renderShareCardSvg XML-escapes special characters cleanly', () => {
  const model = buildShareCardModel({
    agents: [{ id: 'a&b<1>@rig"x', shortName: 'a&b<1>', harness: 'codex', model: 'gpt-6', state: 'idle' }],
    rigFilter: 'rig"x',
    anonymize: false,
    lang: 'en'
  });
  const svg = renderShareCardSvg(model);
  assert.ok(svg.includes('a&amp;b&lt;1&gt;'));
  assert.ok(svg.includes('rig&quot;x'));
});
