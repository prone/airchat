/**
 * Per-agent token usage: server-side recording and querying.
 *
 * Every server consumer of the llm_usage event stream goes through this
 * module — routes, MCP tools, and workers call these functions, never the
 * table. That is deliberate: this is the single choke point where the future
 * E-B2 access controls (who may read whose usage) will land, so keep new
 * readers and writers here.
 *
 * Recording is fire-and-forget wherever a user-visible operation is in
 * flight — a usage write must never block or fail the operation it measures
 * (same contract as noteAgentActivity in api-v2-auth.ts).
 */

import {
  BILLING_PLANS,
  ZERO_COUNTS,
  addCounts,
  marginalCostUsd,
  summarizeUsage,
  totalTokens,
  type AgentUsageSummary,
  type BillingPlan,
  type ModelPrice,
  type ReportCounts,
  type ReportDelta,
  type TokenCounts,
  type UsageReport,
  type UsageSource,
} from '@airchat/shared';
import { getStorageAdapter, getSupabaseClient } from '@/lib/api-v2-auth';

/** Thrown by getUsageSummary when the named agent does not exist. */
export class UsageNotFoundError extends Error {}

// ── Validation ──────────────────────────────────────────────────────────────

/** Upper bound on any single reported counter — beyond this it's garbage. */
export const MAX_TOKEN_COUNT = 1e12;

export function isTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TOKEN_COUNT
  );
}

export interface UsagePayload extends ReportCounts {
  model: string;
}

/**
 * Validate an untrusted {model + counts} object (task completion usage,
 * self-report body). Omitted cache fields stay omitted — for cumulative
 * self-reports omission means "not tracked" (a forced 0 would regress the
 * cursor and trip the restart heuristic); event inserts coalesce them to 0.
 * Never mutates the input.
 */
export function parseUsagePayload(
  value: unknown,
): { ok: true; usage: UsagePayload } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'usage must be an object' };
  }
  const raw = value as Record<string, unknown>;

  const model = raw.model;
  if (typeof model !== 'string' || model.length < 1 || model.length > 200) {
    return { ok: false, error: 'model must be a string of 1-200 characters' };
  }

  const usage: UsagePayload = { model, input_tokens: 0, output_tokens: 0 };
  for (const field of ['input_tokens', 'output_tokens'] as const) {
    if (!isTokenCount(raw[field])) {
      return { ok: false, error: `${field} must be a non-negative integer (max 1e12)` };
    }
    usage[field] = raw[field] as number;
  }
  for (const field of ['cache_read_tokens', 'cache_creation_tokens'] as const) {
    if (raw[field] === undefined || raw[field] === null) continue;
    if (!isTokenCount(raw[field])) {
      return { ok: false, error: `${field} must be a non-negative integer (max 1e12)` };
    }
    usage[field] = raw[field] as number;
  }

  return { ok: true, usage };
}

// ── Recording ───────────────────────────────────────────────────────────────

export interface UsageEventRow extends Partial<TokenCounts> {
  agent_id: string;
  session_id?: string | null;
  model: string;
  source: UsageSource;
  purpose: string;
  channel_id?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget insert of one usage event. Callers must have validated the
 * counts already (isTokenCount / parseUsagePayload) — this never throws and
 * never blocks the caller.
 */
export function insertUsageEvent(row: UsageEventRow): void {
  try {
    void getSupabaseClient()
      .from('llm_usage')
      .insert({
        agent_id: row.agent_id,
        session_id: row.session_id ?? null,
        model: row.model,
        source: row.source,
        purpose: row.purpose,
        channel_id: row.channel_id ?? null,
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        cache_read_tokens: row.cache_read_tokens ?? 0,
        cache_creation_tokens: row.cache_creation_tokens ?? 0,
        metadata: row.metadata ?? {},
      })
      .then(({ error }) => {
        if (error) console.error(`[usage] event insert failed: ${error.message}`);
      });
  } catch (e) {
    // No Supabase env (unit tests) — skip silently, matching noteAgentActivity.
    console.error('[usage] event insert failed:', e);
  }
}

/**
 * Record a cumulative self-report (report_token_usage) through the
 * record_usage_report RPC (migration 00028): cursor advance, delta
 * computation, and the 'self' event insert happen in ONE transaction under a
 * row lock, so concurrent reports for the same (agent, session, model)
 * serialize instead of double-counting, and identical retries yield a zero
 * delta. Omitted cache counters pass as NULL ("not tracked") and coalesce to
 * the stored cursor inside the RPC.
 */
export async function recordSelfReport(
  agentId: string,
  report: UsageReport,
): Promise<ReportDelta> {
  const { data, error } = await getSupabaseClient().rpc('record_usage_report', {
    p_agent_id: agentId,
    p_session_id: report.session_id,
    p_model: report.model,
    p_input: report.input_tokens,
    p_output: report.output_tokens,
    p_cache_read: report.cache_read_tokens ?? null,
    p_cache_creation: report.cache_creation_tokens ?? null,
  });
  if (error) throw new Error(`usage report failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        delta_input: number | string;
        delta_output: number | string;
        delta_cache_read: number | string;
        delta_cache_creation: number | string;
        restarted: boolean;
      }
    | undefined;
  if (!row) throw new Error('usage report returned no row');
  // bigint columns arrive as strings through PostgREST.
  return {
    delta: {
      input_tokens: Number(row.delta_input),
      output_tokens: Number(row.delta_output),
      cache_read_tokens: Number(row.delta_cache_read),
      cache_creation_tokens: Number(row.delta_cache_creation),
    },
    restarted: row.restarted,
  };
}

/**
 * Fire-and-forget record of AirChat's own chars/4 estimate of tool-response
 * tokens served into an agent's context. Attributed to the model on the
 * agent's card ('unknown' when undeclared) so served tokens price alongside
 * the agent's other usage.
 */
export function recordServed(
  agentId: string,
  payload: { tokens: number; session_id?: string; tools?: Record<string, number> },
): void {
  void (async () => {
    try {
      const client = getSupabaseClient();
      const { data: agent } = await client
        .from('agents')
        .select('metadata')
        .eq('id', agentId)
        .maybeSingle();
      const card = ((agent?.metadata as Record<string, unknown> | null)?.card ?? null) as
        | { model?: unknown }
        | null;
      const model = typeof card?.model === 'string' && card.model ? card.model : 'unknown';
      const { error } = await client.from('llm_usage').insert({
        agent_id: agentId,
        session_id: payload.session_id ?? null,
        model,
        source: 'served',
        purpose: 'mcp-served',
        input_tokens: payload.tokens,
        metadata: { tools: payload.tools ?? {} },
      });
      if (error) console.error(`[usage] served insert failed: ${error.message}`);
    } catch (e) {
      console.error('[usage] served insert failed:', e);
    }
  })();
}

// ── Querying ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;

/**
 * Hard bound on rows fetched for one summary/fleet query. An agent can flood
 * its own events (rate-limited, but still), and unbounded fetch + in-memory
 * aggregation is a DoS lever. Beyond the cap the caller gets a 400 asking for
 * a narrower window.
 */
const MAX_USAGE_ROWS = 100_000;

/** Thrown when a usage query matches more than MAX_USAGE_ROWS events. */
export class UsageRangeTooLargeError extends Error {}

type UsageRow = TokenCounts & { model: string; source: UsageSource; agent_id: string | null };

/** Fetch event rows in [since, until), paged past PostgREST's 1000-row cap. */
async function fetchUsageRows(since: Date, until: Date, agentId?: string): Promise<UsageRow[]> {
  const client = getSupabaseClient();
  const rows: UsageRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    if (rows.length >= MAX_USAGE_ROWS) {
      throw new UsageRangeTooLargeError(
        `usage query exceeds ${MAX_USAGE_ROWS} events — narrow the time range`,
      );
    }
    let query = client
      .from('llm_usage')
      .select('agent_id, model, source, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
      .gte('created_at', since.toISOString())
      .lt('created_at', until.toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    query = agentId ? query.eq('agent_id', agentId) : query.not('agent_id', 'is', null);
    const { data, error } = await query;
    if (error) throw new Error(`usage query failed: ${error.message}`);
    rows.push(...((data ?? []) as UsageRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchPrices(): Promise<Map<string, ModelPrice>> {
  const { data, error } = await getSupabaseClient()
    .from('model_prices')
    .select('model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok');
  if (error) throw new Error(`model_prices query failed: ${error.message}`);
  return new Map(((data ?? []) as ModelPrice[]).map((p) => [p.model, p]));
}

function planFromMetadata(metadata: Record<string, unknown> | null): BillingPlan | null {
  const card = (metadata?.card ?? null) as Record<string, unknown> | null;
  const plan = card?.plan;
  return BILLING_PLANS.includes(plan as BillingPlan) ? (plan as BillingPlan) : null;
}

/**
 * One agent's usage summary over [since, until). Any authenticated agent may
 * query any agent BY DESIGN — cost-aware routing needs cross-agent visibility;
 * E-B2 ACLs will land here when that changes.
 */
export async function getUsageSummary(
  agentName: string,
  since: Date,
  until: Date,
): Promise<AgentUsageSummary> {
  const agent = await getStorageAdapter().findAgentByName(agentName);
  if (!agent) throw new UsageNotFoundError(`Agent not found: ${agentName}`);
  const [rows, prices] = await Promise.all([
    fetchUsageRows(since, until, agent.id),
    fetchPrices(),
  ]);
  return summarizeUsage(rows, agent.name, planFromMetadata(agent.metadata), since, until, prices);
}

export interface FleetUsageEntry {
  agent: string;
  plan: BillingPlan | null;
  totals: TokenCounts;
  /** Sum of priced (model, plan) groups; null when NO group could be priced. */
  est_cost_usd: number | null;
}

/**
 * Compact per-agent totals across the fleet. Rows are fetched once and
 * aggregated in TS (event volume is modest); cost is derived per
 * (model, plan) group so mixed-model agents price correctly.
 */
export async function getFleetUsage(since: Date, until: Date): Promise<FleetUsageEntry[]> {
  const rows = await fetchUsageRows(since, until);
  if (rows.length === 0) return [];
  const prices = await fetchPrices();

  const agentIds = [...new Set(rows.map((r) => r.agent_id as string))];
  const { data: agents, error } = await getSupabaseClient()
    .from('agents')
    .select('id, name, metadata')
    .in('id', agentIds);
  if (error) throw new Error(`agents query failed: ${error.message}`);
  const agentById = new Map(
    ((agents ?? []) as Array<{ id: string; name: string; metadata: Record<string, unknown> | null }>).map(
      (a) => [a.id, a],
    ),
  );

  // Same served-exclusion rule as summarizeUsage: once an agent has direct
  // ('native'/'self') rows, its 'served' estimates measure the same tokens
  // again and would double-count.
  const hasDirect = new Set<string>();
  for (const row of rows) {
    if (row.source !== 'served') hasDirect.add(row.agent_id as string);
  }

  const byAgent = new Map<string, { totals: TokenCounts; byModel: Map<string, TokenCounts> }>();
  for (const row of rows) {
    const id = row.agent_id as string;
    if (row.source === 'served' && hasDirect.has(id)) continue;
    let entry = byAgent.get(id);
    if (!entry) {
      entry = { totals: ZERO_COUNTS, byModel: new Map() };
      byAgent.set(id, entry);
    }
    entry.totals = addCounts(entry.totals, row);
    entry.byModel.set(row.model, addCounts(entry.byModel.get(row.model) ?? ZERO_COUNTS, row));
  }

  const result: FleetUsageEntry[] = [];
  for (const [id, entry] of byAgent) {
    const agent = agentById.get(id);
    if (!agent) continue; // deleted mid-query
    const plan = planFromMetadata(agent.metadata);
    let cost: number | null = null;
    for (const [model, counts] of entry.byModel) {
      const c = marginalCostUsd(counts, model, plan ?? undefined, prices);
      if (c !== null) cost = (cost ?? 0) + c;
    }
    result.push({ agent: agent.name, plan, totals: entry.totals, est_cost_usd: cost });
  }
  return result.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
}
