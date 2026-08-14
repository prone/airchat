import { describe, expect, it } from 'vitest';

import {
  addCounts,
  costUsd,
  effectiveRatePerMtok,
  estimateTokensFromChars,
  marginalCostUsd,
  reportDelta,
  summarizeUsage,
  totalTokens,
  ZERO_COUNTS,
  type ModelPrice,
  type TokenCounts,
  type UsageSource,
} from '../usage.js';
import { validateCard, cardFromEnv } from '../agent-card.js';

const counts = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
): TokenCounts => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: cacheRead,
  cache_creation_tokens: cacheCreation,
});

const OPUS: ModelPrice = {
  model: 'claude-opus-4-8',
  input_per_mtok: 5,
  output_per_mtok: 25,
  cache_read_per_mtok: 0.5,
  cache_write_per_mtok: 6.25,
};

const PRICES = new Map([[OPUS.model, OPUS]]);

describe('reportDelta', () => {
  it('treats the first report of a session as the whole delta', () => {
    const { delta, restarted } = reportDelta(counts(1000, 200, 50, 10), null);
    expect(delta).toEqual(counts(1000, 200, 50, 10));
    expect(restarted).toBe(false);
  });

  it('computes deltas against the cursor', () => {
    const { delta, restarted } = reportDelta(counts(1500, 350, 60, 10), counts(1000, 200, 50, 10));
    expect(delta).toEqual(counts(500, 150, 10, 0));
    expect(restarted).toBe(false);
  });

  it('is idempotent on retries (same cumulative totals → zero delta)', () => {
    const report = counts(1500, 350, 60, 10);
    const { delta } = reportDelta(report, report);
    expect(delta).toEqual(ZERO_COUNTS);
  });

  it('treats a regression on any counter as a session restart', () => {
    const { delta, restarted } = reportDelta(counts(100, 400, 60, 10), counts(1000, 200, 50, 10));
    expect(restarted).toBe(true);
    // full reported value counts — clamping to zero would drop real usage
    expect(delta).toEqual(counts(100, 400, 60, 10));
  });

  it('omitted cache counters coalesce to the cursor — no restart, no delta', () => {
    const cursor = counts(1000, 200, 500, 50);
    const { delta, restarted } = reportDelta(
      { input_tokens: 1500, output_tokens: 300 },
      cursor,
    );
    expect(restarted).toBe(false);
    expect(delta).toEqual(counts(500, 100, 0, 0));
  });

  it('never produces negative deltas', () => {
    const cases: Array<[TokenCounts, TokenCounts | null]> = [
      [counts(5, 5, 5, 5), counts(5, 5, 5, 5)],
      [counts(0, 0, 0, 0), counts(9, 9, 9, 9)],
      [counts(10, 0, 0, 0), counts(9, 1, 0, 0)],
    ];
    for (const [report, cursor] of cases) {
      const { delta } = reportDelta(report, cursor);
      for (const v of Object.values(delta)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('estimateTokensFromChars', () => {
  it('rounds up at chars/4', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
  });

  it('clamps negative input', () => {
    expect(estimateTokensFromChars(-100)).toBe(0);
  });
});

describe('cost derivation', () => {
  it('prices the 4-way split independently', () => {
    // 1M of each bucket = sum of the four rates
    const c = counts(1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(costUsd(c, OPUS)).toBeCloseTo(5 + 25 + 0.5 + 6.25);
  });

  it('marginal cost is $0 (not null) for local and subscription plans', () => {
    const c = counts(1_000_000, 0);
    expect(marginalCostUsd(c, 'llama3.1:8b', 'local', PRICES)).toBe(0);
    expect(marginalCostUsd(c, 'claude-opus-4-8', 'subscription', PRICES)).toBe(0);
  });

  it('marginal cost is null for unknown models on an api plan (unknown ≠ free)', () => {
    expect(marginalCostUsd(counts(100, 0), 'mystery-model', 'api', PRICES)).toBeNull();
    expect(marginalCostUsd(counts(100, 0), null, 'api', PRICES)).toBeNull();
  });

  it('undeclared plan behaves like api', () => {
    const c = counts(1_000_000, 0);
    expect(marginalCostUsd(c, 'claude-opus-4-8', undefined, PRICES)).toBeCloseTo(5);
  });

  it('effective rate weights input 3:1 and is 0 for non-api plans', () => {
    expect(effectiveRatePerMtok('claude-opus-4-8', 'api', PRICES)).toBeCloseTo((3 * 5 + 25) / 4);
    expect(effectiveRatePerMtok('anything', 'local', PRICES)).toBe(0);
    expect(effectiveRatePerMtok('mystery-model', 'api', PRICES)).toBeNull();
  });
});

describe('summarizeUsage', () => {
  const since = new Date('2026-08-01T00:00:00Z');
  const until = new Date('2026-08-08T00:00:00Z');
  const row = (model: string, source: UsageSource, c: TokenCounts) => ({ model, source, ...c });

  it('aggregates by model+source; served rows stay visible but do not double-count totals', () => {
    const summary = summarizeUsage(
      [
        row('claude-opus-4-8', 'native', counts(1_000_000, 100_000)),
        row('claude-opus-4-8', 'native', counts(500_000, 50_000)),
        row('unknown-model', 'served', counts(40_000, 0)),
      ],
      'macbook-airchat',
      'api',
      since,
      until,
      PRICES,
    );
    // direct (native) rows exist, so the served estimate of the same context
    // is excluded from totals — it would double-count
    expect(summary.totals).toEqual(counts(1_500_000, 150_000));
    expect(summary.breakdown).toHaveLength(2);
    const opus = summary.breakdown[0]!;
    expect(opus.events).toBe(2);
    expect(opus.est_cost_usd).toBeCloseTo(1.5 * 5 + 0.15 * 25);
    expect(summary.est_cost_usd).toBeCloseTo(opus.est_cost_usd!);
    expect(summary.breakdown[1]!.est_cost_usd).toBeNull();
    expect(summary.accuracy).toBe('estimated');
  });

  it('served rows count when they are the only measurement', () => {
    const summary = summarizeUsage(
      [row('claude-opus-4-8', 'served', counts(40_000, 0))],
      'macbook-airchat',
      'api',
      since,
      until,
      PRICES,
    );
    expect(summary.totals).toEqual(counts(40_000, 0));
    expect(summary.est_cost_usd).toBeCloseTo(0.04 * 5);
  });

  it('returns null cost when nothing can be priced, and zero totals on no rows', () => {
    const empty = summarizeUsage([], 'a', null, since, until, PRICES);
    expect(empty.totals).toEqual(ZERO_COUNTS);
    expect(empty.est_cost_usd).toBeNull();

    const unpriced = summarizeUsage(
      [row('mystery', 'self', counts(10, 10))],
      'a',
      'api',
      since,
      until,
      PRICES,
    );
    expect(unpriced.est_cost_usd).toBeNull();
  });

  it('a local-plan agent summarizes to $0, never null', () => {
    const summary = summarizeUsage(
      [row('llama3.1:8b', 'native', counts(2_000_000, 400_000))],
      'windows-gpu-models',
      'local',
      since,
      until,
      PRICES,
    );
    expect(summary.est_cost_usd).toBe(0);
    expect(summary.breakdown[0]!.est_cost_usd).toBe(0);
  });

  it('addCounts/totalTokens agree with the summary totals', () => {
    const a = counts(1, 2, 3, 4);
    const b = counts(10, 20, 30, 40);
    expect(totalTokens(addCounts(a, b))).toBe(110);
  });
});

describe('agent card plan field', () => {
  it('accepts the three plans and rejects others', () => {
    for (const plan of ['api', 'subscription', 'local']) {
      const result = validateCard({ plan });
      expect(result.ok).toBe(true);
      expect(result.card?.plan).toBe(plan);
    }
    expect(validateCard({ plan: 'free' }).ok).toBe(false);
    expect(validateCard({ model: 'x', plan: 42 }).ok).toBe(false);
  });

  it('plan alone satisfies the at-least-one-field rule', () => {
    expect(validateCard({ plan: 'local' }).ok).toBe(true);
  });

  it('cardFromEnv reads AIRCHAT_PLAN and throws on an invalid value', () => {
    expect(cardFromEnv({ AIRCHAT_PLAN: 'subscription' })?.plan).toBe('subscription');
    expect(() => cardFromEnv({ AIRCHAT_PLAN: 'gratis' })).toThrow(/plan/);
  });
});
