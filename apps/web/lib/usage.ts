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
  reportDelta,
  summarizeUsage,
  totalTokens,
  type AgentUsageSummary,
  type BillingPlan,
  type ModelPrice,
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

export interface UsagePayload extends TokenCounts {
  model: string;
}

/**
 * Validate an untrusted {model + 4-way counts} object (task completion usage,
 * self-report body). Missing cache fields default to 0; input/output are
 * required. Never mutates the input.
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

  const counts: TokenCounts = { ...ZERO_COUNTS };
  for (const field of ['input_tokens', 'output_tokens'] as const) {
    if (!isTokenCount(raw[field])) {
      return { ok: false, error: `${field} must be a non-negative integer (max 1e12)` };
    }
    counts[field] = raw[field] as number;
  }
  for (const field of ['cache_read_tokens', 'cache_creation_tokens'] as const) {
    if (raw[field] === undefined || raw[field] === null) continue;
    if (!isTokenCount(raw[field])) {
      return { ok: false, error: `${field} must be a non-negative integer (max 1e12)` };
    }
    counts[field] = raw[field] as number;
  }

  return { ok: true, usage: { model, ...counts } };
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
 * Record a cumulative self-report (report_token_usage): compute the delta
 * against the stored cursor, advance the cursor, and ledger the delta as a
 * 'self' event when it is non-zero.
 *
 * Awaited (the tool echoes the delta back), but ordered for resilience:
 * cursor first, event second. Losing the event insert undercounts one delta;
 * a cursor lagging the event stream would double-count the next retry —
 * undercounting is the recoverable failure.
 */
export async function recordSelfReport(
  agentId: string,
  report: UsageReport,
): Promise<ReportDelta> {
  const client = getSupabaseClient();

  const { data: cursor, error: readErr } = await client
    .from('usage_report_cursors')
    .select('input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
    .eq('agent_id', agentId)
    .eq('session_id', report.session_id)
    .eq('model', report.model)
    .maybeSingle();
  if (readErr) throw new Error(`usage cursor read failed: ${readErr.message}`);

  const result = reportDelta(report, (cursor as TokenCounts | null) ?? null);

  const { error: upsertErr } = await client.from('usage_report_cursors').upsert({
    agent_id: agentId,
    session_id: report.session_id,
    model: report.model,
    input_tokens: report.input_tokens,
    output_tokens: report.output_tokens,
    cache_read_tokens: report.cache_read_tokens,
    cache_creation_tokens: report.cache_creation_tokens,
    updated_at: new Date().toISOString(),
  });
  if (upsertErr) throw new Error(`usage cursor upsert failed: ${upsertErr.message}`);

  if (totalTokens(result.delta) > 0) {
    insertUsageEvent({
      agent_id: agentId,
      session_id: report.session_id,
      model: report.model,
      source: 'self',
      purpose: 'agent-report',
      ...result.delta,
    });
  }

  return result;
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

type UsageRow = TokenCounts & { model: string; source: UsageSource; agent_id: string | null };

/** Fetch event rows in [since, until), paged past PostgREST's 1000-row cap. */
async function fetchUsageRows(since: Date, until: Date, agentId?: string): Promise<UsageRow[]> {
  const client = getSupabaseClient();
  const rows: UsageRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
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

  const byAgent = new Map<string, { totals: TokenCounts; byModel: Map<string, TokenCounts> }>();
  for (const row of rows) {
    const id = row.agent_id as string;
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
