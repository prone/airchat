import type { AirChatRestClient } from '@airchat/shared/rest-client';
import type { AgentUsageSummary, BillingPlan, TokenCounts, UsageWindow } from '@airchat/shared';
import { totalTokens, USAGE_WINDOWS } from '@airchat/shared';

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * null means unpriceable (unknown model on an api plan) — never $0. A real $0
 * (local/subscription plans) is rendered as such: the zero is the savings.
 */
export function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Column-aligned plain-text table. The first `leftAlignCount` columns are
 * left-aligned (names, labels); the rest right-aligned (numbers).
 */
export function renderTable(headers: string[], rows: string[][], leftAlignCount = 2): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i < leftAlignCount ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

interface UsageOpts {
  window?: string;
  since?: string;
  until?: string;
  all?: boolean;
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function resolveRange(opts: UsageOpts): { window?: UsageWindow; since?: string; until?: string } {
  const hasCustom = opts.since !== undefined || opts.until !== undefined;
  if (opts.window !== undefined && hasCustom) {
    fail('--window cannot be combined with --since/--until');
  }
  if (hasCustom) {
    for (const [flag, value] of [['--since', opts.since], ['--until', opts.until]] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        fail(`${flag} is not a valid ISO timestamp: ${value}`);
      }
    }
    return { since: opts.since, until: opts.until };
  }
  const window = opts.window ?? '7d';
  if (!(USAGE_WINDOWS as readonly string[]).includes(window)) {
    fail(`--window must be one of ${USAGE_WINDOWS.join(', ')}`);
  }
  return { window: window as UsageWindow };
}

const COUNT_HEADERS = ['input', 'output', 'cache read', 'cache write'];

export async function usage(client: AirChatRestClient, agent: string | undefined, opts: UsageOpts) {
  const range = resolveRange(opts);

  if (opts.all) {
    if (range.window === undefined) {
      fail('--since/--until are not supported with --all; use --window');
    }
    const data = await client.getFleetUsage(range.window);
    console.log(`\n📊 Fleet token usage (last ${range.window}, estimated)\n`);
    if (data.agents.length === 0) {
      console.log('  No usage recorded.\n');
      return;
    }
    const rows = data.agents.map((a: { agent: string; plan: BillingPlan | null; totals: TokenCounts; est_cost_usd: number | null }) => [
      a.agent,
      a.plan ?? '—',
      formatTokens(a.totals.input_tokens),
      formatTokens(a.totals.output_tokens),
      formatTokens(a.totals.cache_read_tokens),
      formatTokens(a.totals.cache_creation_tokens),
      formatTokens(totalTokens(a.totals)),
      formatCost(a.est_cost_usd),
    ]);
    for (const line of renderTable(['agent', 'plan', ...COUNT_HEADERS, 'total', 'est. cost'], rows)) {
      console.log(`  ${line}`);
    }
    console.log('\n  estimates — for optimization, not invoices\n');
    return;
  }

  const summary: AgentUsageSummary = await client.getUsage({
    agent,
    window: range.window,
    since: range.since,
    until: range.until,
  });

  console.log(`\n📊 Token usage — ${summary.agent} (${summary.since} → ${summary.until})\n`);
  const totalsRow = [
    summary.agent,
    summary.plan ?? '—',
    formatTokens(summary.totals.input_tokens),
    formatTokens(summary.totals.output_tokens),
    formatTokens(summary.totals.cache_read_tokens),
    formatTokens(summary.totals.cache_creation_tokens),
    formatTokens(totalTokens(summary.totals)),
    formatCost(summary.est_cost_usd),
  ];
  for (const line of renderTable(['agent', 'plan', ...COUNT_HEADERS, 'total', 'est. cost'], [totalsRow])) {
    console.log(`  ${line}`);
  }

  if (summary.breakdown.length === 0) {
    console.log('\n  No usage recorded in this window.');
  } else {
    console.log('\n  By model / source:\n');
    const rows = summary.breakdown.map((b: AgentUsageSummary['breakdown'][number]) => [
      b.model,
      b.source,
      formatTokens(b.input_tokens),
      formatTokens(b.output_tokens),
      formatTokens(b.cache_read_tokens),
      formatTokens(b.cache_creation_tokens),
      formatTokens(b.events),
      formatCost(b.est_cost_usd),
    ]);
    for (const line of renderTable(['model', 'source', ...COUNT_HEADERS, 'events', 'est. cost'], rows)) {
      console.log(`  ${line}`);
    }
  }
  console.log('\n  estimates — for optimization, not invoices\n');
}
