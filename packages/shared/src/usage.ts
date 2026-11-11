/**
 * Per-agent token usage: shared types and pure logic.
 *
 * Events live in the llm_usage table (extended in migration 00028) with a
 * 4-way token split and a source tag:
 *
 *   native — exact counts from a provider response (Anthropic usage object,
 *            Ollama prompt_eval_count/eval_count, OpenAI-compat usage)
 *   self   — agent self-reports (report_token_usage): cumulative per-session
 *            counters, server stores computed deltas
 *   served — AirChat's chars/4 estimate of tool-response text it fed into an
 *            agent's context; zero agent cooperation required
 *
 * Dollars are DERIVED at read time from model_prices — never stored on
 * events, so price changes don't rot history. An agent's billing plan (from
 * its capability card) decides whether rates apply at all: 'local' and
 * 'subscription' agents have $0 marginal token cost, and that $0 is displayed
 * rather than omitted — it is the "tokens diverted to owned hardware" savings
 * metric.
 */

export type UsageSource = 'native' | 'self' | 'served';

/** How an agent's tokens are billed. Declared on the capability card. */
export type BillingPlan = 'api' | 'subscription' | 'local';

export const BILLING_PLANS: readonly BillingPlan[] = ['api', 'subscription', 'local'];

/** The 4-way split. Cache reads are ~10x cheaper than input; one number lies. */
export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export const ZERO_COUNTS: TokenCounts = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

/** USD per million tokens, matching a model_prices row. */
export interface ModelPrice {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
}

/**
 * Counters as a reporter sends them: cache fields may be omitted entirely
 * when the harness doesn't track them — omission means "unknown", not zero
 * (a zero would regress the cursor and trip the restart heuristic).
 */
export interface ReportCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

/** Cumulative per-session counters sent by report_token_usage. */
export interface UsageReport extends ReportCounts {
  session_id: string;
  model: string;
}

export function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_creation_tokens: a.cache_creation_tokens + b.cache_creation_tokens,
  };
}

export function totalTokens(c: TokenCounts): number {
  return c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_creation_tokens;
}

export interface ReportDelta {
  /** Event row to insert (never negative). */
  delta: TokenCounts;
  /**
   * True when any reported counter fell below the stored cursor — the session
   * restarted its counting (harness restart, context reset). The full
   * reported value is then taken as the delta rather than clamping to zero,
   * which would silently drop real usage.
   */
  restarted: boolean;
}

/**
 * Delta between a new cumulative report and the stored cursor.
 *
 * Counters are monotonic within a session (OTel convention), which makes
 * retries idempotent: re-sending the same cumulative totals yields a zero
 * delta. A regression on ANY counter means the counting restarted, so the
 * whole report is treated as fresh usage.
 */
export function reportDelta(report: ReportCounts, cursor: TokenCounts | null): ReportDelta {
  const prior = cursor ?? ZERO_COUNTS;
  // Omitted cache counters coalesce to the cursor: they can neither trip the
  // restart heuristic nor produce a delta.
  const full: TokenCounts = {
    input_tokens: report.input_tokens,
    output_tokens: report.output_tokens,
    cache_read_tokens: report.cache_read_tokens ?? prior.cache_read_tokens,
    cache_creation_tokens: report.cache_creation_tokens ?? prior.cache_creation_tokens,
  };
  const restarted =
    full.input_tokens < prior.input_tokens ||
    full.output_tokens < prior.output_tokens ||
    full.cache_read_tokens < prior.cache_read_tokens ||
    full.cache_creation_tokens < prior.cache_creation_tokens;
  const base = restarted ? ZERO_COUNTS : prior;
  return {
    delta: {
      input_tokens: full.input_tokens - base.input_tokens,
      output_tokens: full.output_tokens - base.output_tokens,
      cache_read_tokens: full.cache_read_tokens - base.cache_read_tokens,
      cache_creation_tokens: full.cache_creation_tokens - base.cache_creation_tokens,
    },
    restarted,
  };
}

/**
 * chars/4 estimate for served-token measurement. Matches the estimator the
 * dashboard already uses (viz.ts); good enough for a number that is always
 * labeled estimated.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/** Exact dollars for a count at a price. Caller decides whether rates apply. */
export function costUsd(counts: TokenCounts, price: ModelPrice): number {
  return (
    (counts.input_tokens * price.input_per_mtok +
      counts.output_tokens * price.output_per_mtok +
      counts.cache_read_tokens * price.cache_read_per_mtok +
      counts.cache_creation_tokens * price.cache_write_per_mtok) /
    1_000_000
  );
}

/**
 * Marginal cost of a count for an agent, honoring its billing plan.
 *
 * - 'local' and 'subscription': $0 — flat-rate or owned hardware. Zero, not
 *   null: the zero is the story.
 * - 'api' (or undeclared): price-table lookup; null when the model has no
 *   price row (unknown ≠ free).
 */
export function marginalCostUsd(
  counts: TokenCounts,
  model: string | null,
  plan: BillingPlan | undefined,
  prices: Map<string, ModelPrice>,
): number | null {
  if (plan === 'local' || plan === 'subscription') return 0;
  if (!model) return null;
  const price = prices.get(model);
  if (!price) return null;
  return costUsd(counts, price);
}

/**
 * Effective blended rate for ranking agents by cost (USD per Mtok, weighting
 * input:output 3:1 — tool-using agents read far more than they write). Used
 * by find_agents sort="cheapest"; display-only precision.
 */
export function effectiveRatePerMtok(
  model: string | undefined,
  plan: BillingPlan | undefined,
  prices: Map<string, ModelPrice>,
): number | null {
  if (plan === 'local' || plan === 'subscription') return 0;
  if (!model) return null;
  const price = prices.get(model);
  if (!price) return null;
  return (3 * price.input_per_mtok + price.output_per_mtok) / 4;
}

// ── Query-surface contract ──────────────────────────────────────────────────

export const USAGE_WINDOWS = ['24h', '7d', '30d'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export const USAGE_WINDOW_MS: Record<UsageWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface UsageBreakdownRow extends TokenCounts {
  model: string;
  source: UsageSource;
  events: number;
  /** Derived at read time; null = unknown model on an api plan. */
  est_cost_usd: number | null;
}

/** Response shape of GET /api/v2/usage and the get_agent_usage MCP tool. */
export interface AgentUsageSummary {
  agent: string;
  plan: BillingPlan | null;
  since: string;
  until: string;
  totals: TokenCounts;
  /** Sum of priced rows; null when NO row could be priced. */
  est_cost_usd: number | null;
  breakdown: UsageBreakdownRow[];
  /**
   * Always set: these numbers mix exact provider counts with estimates and
   * self-reports — they are for optimization, not invoices.
   */
  accuracy: 'estimated';
}

/** One agent's compact totals in the fleet view. */
export interface FleetUsageAgent {
  agent: string;
  plan: BillingPlan | null;
  totals: TokenCounts;
  est_cost_usd: number | null;
}

/** Response shape of GET /api/v2/usage?all=true (the `usage` key). */
export interface FleetUsage {
  since: string;
  until: string;
  agents: FleetUsageAgent[];
  accuracy: 'estimated';
}

/**
 * Aggregate raw event rows into the summary shape. Pure — callers fetch
 * events and prices however they like (service-role query, RLS query).
 */
export function summarizeUsage(
  // `events` is set when a row is already a sum of that many events (the
  // database aggregates before sending); a row without it is one event.
  rows: Array<TokenCounts & { model: string; source: UsageSource; events?: number }>,
  agent: string,
  plan: BillingPlan | null,
  since: Date,
  until: Date,
  prices: Map<string, ModelPrice>,
): AgentUsageSummary {
  // 'served' is the fallback measurement of what AirChat fed into the
  // context. When the window also has exact ('native') or self-reported rows,
  // adding served on top double-counts the same tokens — so served stays
  // visible in the breakdown but is excluded from totals and cost.
  const hasDirect = rows.some((r) => r.source !== 'served');
  const byKey = new Map<string, UsageBreakdownRow>();
  let totals = ZERO_COUNTS;
  for (const row of rows) {
    if (!(hasDirect && row.source === 'served')) totals = addCounts(totals, row);
    const key = `${row.model}::${row.source}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.output_tokens += row.output_tokens;
      existing.cache_read_tokens += row.cache_read_tokens;
      existing.cache_creation_tokens += row.cache_creation_tokens;
      existing.events += row.events ?? 1;
    } else {
      byKey.set(key, {
        model: row.model,
        source: row.source,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_creation_tokens: row.cache_creation_tokens,
        events: row.events ?? 1,
        est_cost_usd: null,
      });
    }
  }
  let cost: number | null = null;
  const breakdown = [...byKey.values()].sort((a, b) => totalTokens(b) - totalTokens(a));
  for (const row of breakdown) {
    row.est_cost_usd = marginalCostUsd(row, row.model, plan ?? undefined, prices);
    if (hasDirect && row.source === 'served') continue; // priced for display, not summed
    if (row.est_cost_usd !== null) cost = (cost ?? 0) + row.est_cost_usd;
  }
  return {
    agent,
    plan,
    since: since.toISOString(),
    until: until.toISOString(),
    totals,
    est_cost_usd: cost,
    breakdown,
    accuracy: 'estimated',
  };
}
