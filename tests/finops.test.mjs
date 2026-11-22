import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BILLING_PLANS,
  sanitizeBillingPlans,
  getUsageForWindow,
  getWindowAmortizedPlanUsd,
  computeFleetFinOpsReport
} from '../openrig/assets/domain/finops.js';
import { classifyModelPool, computeModelPools } from '../openrig/assets/ontology/snapshot.js';
import { readTranscriptTokenUsage } from '../openrig/server.mjs';

test('getWindowAmortizedPlanUsd prorates monthly subscription cleanly across 24h, 7d and session windows', () => {
  assert.equal(getWindowAmortizedPlanUsd(300, 'h24'), 10);
  assert.equal(getWindowAmortizedPlanUsd(300, 'd7'), 70);
  assert.equal(getWindowAmortizedPlanUsd(300, 'session', 3), 30);
  assert.equal(getWindowAmortizedPlanUsd(300, 'session', 60), 300); // capped at 30d
  assert.equal(getWindowAmortizedPlanUsd(0, 'h24'), 0);
});

test('computeFleetFinOpsReport compares SUB vs PAYG accurately and produces mode verdicts', () => {
  const agents = [
    {
      id: 'dev-owner@rig',
      shortName: 'dev-owner',
      harness: 'codex',
      model: 'gpt-6.2-sol',
      state: 'working',
      ctxPct: 48,
      usage: {
        totalTokens: 50_000_000,
        inputTokens: 49_000_000,
        uncachedInputTokens: 2_000_000,
        cachedInputTokens: 47_000_000,
        outputTokens: 1_000_000,
        estUsd: 31.75,
        spanDays: 2,
        windows: {
          h24: { totalTokens: 25_000_000, inputTokens: 24_500_000, cachedInputTokens: 23_500_000, uncachedInputTokens: 1_000_000, outputTokens: 500_000, estUsd: 18.0 },
          d7: { totalTokens: 50_000_000, inputTokens: 49_000_000, cachedInputTokens: 47_000_000, uncachedInputTokens: 2_000_000, outputTokens: 1_000_000, estUsd: 31.75 },
          session: { totalTokens: 50_000_000, inputTokens: 49_000_000, cachedInputTokens: 47_000_000, uncachedInputTokens: 2_000_000, outputTokens: 1_000_000, estUsd: 31.75 }
        }
      }
    },
    {
      id: 'dev-arch@rig',
      shortName: 'dev-arch',
      harness: 'claude-code',
      model: 'claude-sonnet-4',
      state: 'idle',
      ctxPct: 20,
      usage: {
        totalTokens: 500_000,
        inputTokens: 480_000,
        uncachedInputTokens: 100_000,
        cachedInputTokens: 380_000,
        outputTokens: 20_000,
        estUsd: 0.71,
        spanDays: 1,
        windows: {
          h24: { totalTokens: 500_000, inputTokens: 480_000, cachedInputTokens: 380_000, uncachedInputTokens: 100_000, outputTokens: 20_000, estUsd: 0.71 },
          d7: { totalTokens: 500_000, inputTokens: 480_000, cachedInputTokens: 380_000, uncachedInputTokens: 100_000, outputTokens: 20_000, estUsd: 0.71 },
          session: { totalTokens: 500_000, inputTokens: 480_000, cachedInputTokens: 380_000, uncachedInputTokens: 100_000, outputTokens: 20_000, estUsd: 0.71 }
        }
      }
    },
    {
      id: 'dev-qa@rig',
      shortName: 'dev-qa',
      harness: 'claude-code',
      model: 'glm-5.3-flash',
      state: 'idle',
      ctxPct: 12,
      usage: {
        totalTokens: 4_000_000,
        inputTokens: 3_900_000,
        uncachedInputTokens: 1_500_000,
        cachedInputTokens: 2_400_000,
        outputTokens: 100_000,
        estUsd: 1.5,
        spanDays: 1,
        windows: {
          h24: { totalTokens: 4_000_000, inputTokens: 3_900_000, cachedInputTokens: 2_400_000, uncachedInputTokens: 1_500_000, outputTokens: 100_000, estUsd: 1.5 },
          d7: { totalTokens: 4_000_000, inputTokens: 3_900_000, cachedInputTokens: 2_400_000, uncachedInputTokens: 1_500_000, outputTokens: 100_000, estUsd: 1.5 },
          session: { totalTokens: 4_000_000, inputTokens: 3_900_000, cachedInputTokens: 2_400_000, uncachedInputTokens: 1_500_000, outputTokens: 100_000, estUsd: 1.5 }
        }
      }
    }
  ];

  const report = computeFleetFinOpsReport({
    agents,
    rigFilter: 'all',
    windowKey: 'h24',
    billingPlans: {
      'codex-gpt': { mode: 'sub', monthlyUsd: 200 },   // $6.67/24h vs $18 API -> sub_wins
      'claude': { mode: 'sub', monthlyUsd: 100 },      // $3.33/24h vs $0.71 API -> sub_underused
      'fast-open': { mode: 'payg', monthlyUsd: 20 }    // $0.67/24h vs $1.50 API -> switch_to_sub
    },
    classifyPoolFn: classifyModelPool,
    computePoolsFn: computeModelPools
  });

  const byId = Object.fromEntries(report.pools.map(p => [p.poolId, p]));
  assert.equal(byId['codex-gpt'].verdict, 'sub_wins');
  assert.equal(byId['codex-gpt'].subWindowUsd, 6.67);
  assert.equal(byId['codex-gpt'].paygCashUsd, 0);
  assert.equal(byId['codex-gpt'].roiRatio, 2.7);

  assert.equal(byId['claude'].verdict, 'sub_underused');
  assert.ok(byId['claude'].savingsVsApiUsd < 0);

  assert.equal(byId['fast-open'].verdict, 'switch_to_sub');
  assert.equal(byId['fast-open'].paygCashUsd, 1.5);

  assert.equal(report.totals.apiEqUsd, 20.21);
  assert.equal(report.totals.paygCashUsd, 1.5);
  assert.equal(report.totals.subShareUsd, 10);
  assert.equal(report.totals.actualUsd, 11.5);
  assert.equal(report.totals.savingsVsApiUsd, 8.71);

  // Sanitization rejects negative prices and unknown modes
  const cleanPlans = sanitizeBillingPlans({ 'codex-gpt': { mode: 'free', monthlyUsd: -99 } });
  assert.equal(cleanPlans['codex-gpt'].mode, DEFAULT_BILLING_PLANS['codex-gpt'].mode);
  assert.equal(cleanPlans['codex-gpt'].monthlyUsd, DEFAULT_BILLING_PLANS['codex-gpt'].monthlyUsd);
  assert.equal(getUsageForWindow(null, 'h24').totalTokens, 0);
});

test('readTranscriptTokenUsage computes exact 24h vs 7d vs session windows from JSONL timestamps', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rig-finops-win-'));
  const nowMs = Date.parse('2026-11-22T12:00:00.000Z');
  try {
    // Codex cumulative token_count across 3 days: 3d ago -> 100k, 2h ago -> 350k (24h delta = 250k!)
    const codexFile = path.join(tmpDir, 'codex-win.jsonl');
    await fs.writeFile(codexFile, [
      JSON.stringify({
        timestamp: '2026-11-19T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 5_000 } } }
      }),
      JSON.stringify({
        timestamp: '2026-11-22T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 350_000, cached_input_tokens: 300_000, output_tokens: 15_000 } } }
      })
    ].join('\n') + '\n');

    const cRes = await readTranscriptTokenUsage(codexFile, nowMs);
    assert.equal(cRes.windows.session.inputTokens, 350_000);
    assert.equal(cRes.windows.h24.inputTokens, 250_000);
    assert.equal(cRes.windows.h24.cachedInputTokens, 220_000);
    assert.equal(cRes.windows.h24.uncachedInputTokens, 30_000);
    assert.equal(cRes.windows.h24.outputTokens, 10_000);
    assert.equal(cRes.windows.d7.inputTokens, 350_000);
    assert.equal(cRes.spanDays, 3);

    // Claude per-message timestamps: 10d ago (outside 7d) + 3h ago (inside 24h)
    const claudeFile = path.join(tmpDir, 'claude-win.jsonl');
    await fs.writeFile(claudeFile, [
      JSON.stringify({
        timestamp: '2026-11-12T09:00:00.000Z',
        message: { id: 'old_1', model: 'glm-5.3-flash', usage: { input_tokens: 10_000, cache_read_input_tokens: 90_000, output_tokens: 1_000 } }
      }),
      JSON.stringify({
        timestamp: '2026-11-22T09:00:00.000Z',
        message: { id: 'new_1', model: 'glm-5.3-flash', usage: { input_tokens: 5_000, cache_read_input_tokens: 45_000, output_tokens: 500 } }
      })
    ].join('\n') + '\n');

    const clRes = await readTranscriptTokenUsage(claudeFile, nowMs);
    assert.equal(clRes.windows.session.inputTokens, 150_000);
    assert.equal(clRes.windows.d7.inputTokens, 50_000);
    assert.equal(clRes.windows.h24.inputTokens, 50_000);
    assert.equal(clRes.windows.h24.outputTokens, 500);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
