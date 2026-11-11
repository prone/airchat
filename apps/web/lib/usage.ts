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
import { getModelPrices } from '@/lib/usage-cache';

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

// ── Served-token buffer ─────────────────────────────────────────────────────
//
// "Served" tokens are AirChat's own chars/4 estimate of the tool-response text
// it put into an agent's context. Reports arrive often and are small: the
// claude.ai connector builds a server per request, so it reported after every
// tool call, and each report was a read of the agent row plus an INSERT.
//
// Reports are now added up in memory per (agent, session) and written
// together: one read of the agents involved and one multi-row INSERT, every
// 60 seconds, or sooner once 500 (agent, session) pairs are waiting. The
// totals written are exactly the totals reported — nothing is sampled or
// dropped while the process runs, and a failed write is kept and retried with
// the next one. What is in memory when the process stops is lost: a crash or
// a restart loses at most the last 60 seconds of served estimates. One row
// now covers up to a minute of reports, so there are fewer 'served' rows (and
// a lower event count for that source) for the same token total.

const SERVED_FLUSH_MS = 60_000;
/** Flush early once this many (agent, session) pairs are waiting. */
const SERVED_FLUSH_PAIRS = 500;
/** If writes keep failing, stop holding more than this many pairs. */
const SERVED_BUFFER_MAX_PAIRS = 5000;

interface ServedEntry {
  agentId: string;
  sessionId: string | null;
  tokens: number;
  // A Map, not an object: tool names come from the caller, and a name such as
  // "__proto__" must stay an ordinary key.
  tools: Map<string, number>;
}

const servedBuffer = new Map<string, ServedEntry>();
let servedTimer: ReturnType<typeof setTimeout> | null = null;

function addServed(entry: Omit<ServedEntry, 'tools'> & { tools: Record<string, number> | Map<string, number> }): void {
  const key = `${entry.agentId}\n${entry.sessionId ?? ''}`;
  let existing = servedBuffer.get(key);
  if (!existing) {
    existing = { agentId: entry.agentId, sessionId: entry.sessionId, tokens: 0, tools: new Map() };
    servedBuffer.set(key, existing);
  }
  existing.tokens += entry.tokens;
  const counts = entry.tools instanceof Map ? entry.tools : new Map(Object.entries(entry.tools));
  for (const [tool, count] of counts) {
    existing.tools.set(tool, (existing.tools.get(tool) ?? 0) + count);
  }
}

/**
 * Record AirChat's estimate of tool-response tokens served into an agent's
 * context. Returns at once; the write happens with the next flush. Attributed
 * at flush time to the model on the agent's card ('unknown' when undeclared)
 * so served tokens price alongside the agent's other usage.
 */
export function recordServed(
  agentId: string,
  payload: { tokens: number; session_id?: string; tools?: Record<string, number> },
): void {
  addServed({
    agentId,
    sessionId: payload.session_id ?? null,
    tokens: payload.tokens,
    tools: payload.tools ?? {},
  });
  if (servedBuffer.size >= SERVED_FLUSH_PAIRS) {
    void flushServed();
  } else if (!servedTimer) {
    servedTimer = setTimeout(() => { void flushServed(); }, SERVED_FLUSH_MS);
    // Never keep the process alive just to write an estimate.
    servedTimer.unref?.();
  }
}

/**
 * Write everything buffered by recordServed. Never throws. On failure the
 * batch goes back into the buffer and is written with the next flush.
 */
export async function flushServed(): Promise<void> {
  if (servedTimer) {
    clearTimeout(servedTimer);
    servedTimer = null;
  }
  if (servedBuffer.size === 0) return;
  const batch = [...servedBuffer.values()];
  servedBuffer.clear();

  try {
    const client = getSupabaseClient();
    const agentIds = [...new Set(batch.map((e) => e.agentId))];
    const { data: agents, error: agentsError } = await client
      .from('agents')
      .select('id, metadata')
      .in('id', agentIds);
    if (agentsError) throw new Error(agentsError.message);

    const modelByAgent = new Map<string, string>();
    for (const agent of (agents ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
      const card = (agent.metadata?.card ?? null) as { model?: unknown } | null;
      modelByAgent.set(agent.id, typeof card?.model === 'string' && card.model ? card.model : 'unknown');
    }

    const rows = batch
      // An agent deleted since it reported has no row to attribute usage to,
      // and its id would fail the whole insert on the foreign key.
      .filter((e) => modelByAgent.has(e.agentId))
      .map((e) => ({
        agent_id: e.agentId,
        session_id: e.sessionId,
        model: modelByAgent.get(e.agentId)!,
        source: 'served',
        purpose: 'mcp-served',
        input_tokens: e.tokens,
        metadata: { tools: Object.fromEntries(e.tools) },
      }));
    if (rows.length === 0) return;
    const { error } = await client.from('llm_usage').insert(rows);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(`[usage] served flush failed, will retry: ${e instanceof Error ? e.message : e}`);
    if (servedBuffer.size + batch.length > SERVED_BUFFER_MAX_PAIRS) {
      console.error(`[usage] served buffer full; dropping ${batch.length} buffered estimates`);
    } else {
      for (const entry of batch) addServed(entry);
    }
    if (servedBuffer.size > 0 && !servedTimer) {
      servedTimer = setTimeout(() => { void flushServed(); }, SERVED_FLUSH_MS);
      servedTimer.unref?.();
    }
  }
}

/** Empty the served buffer without writing it. For tests. */
export function resetServedBuffer(): void {
  if (servedTimer) {
    clearTimeout(servedTimer);
    servedTimer = null;
  }
  servedBuffer.clear();
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

type UsageRow = TokenCounts & {
  model: string;
  source: UsageSource;
  agent_id: string | null;
  /** How many events this row sums; absent on a raw event row (one). */
  events?: number;
};

/**
 * Usage in [since, until), summed per (agent, model, source) by the database
 * (llm_usage_totals, migration 00039): one request and at most a few rows per
 * agent, where this used to download every event row, 1000 per request, and
 * add them up here. Every figure the summaries report is a sum or a count
 * over those groups, so the results are the same.
 *
 * On a database without the function, falls back to downloading the rows.
 */
async function fetchUsageRows(since: Date, until: Date, agentId?: string): Promise<UsageRow[]> {
  const { data, error } = await getSupabaseClient().rpc('llm_usage_totals', {
    p_since: since.toISOString(),
    p_until: until.toISOString(),
    p_agent_id: agentId ?? null,
  });
  if (!error) {
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      agent_id: (row.agent_id as string | null) ?? null,
      model: row.model as string,
      source: row.source as UsageSource,
      // Sums are bigint in the database; make sure they are numbers here.
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cache_read_tokens: Number(row.cache_read_tokens),
      cache_creation_tokens: Number(row.cache_creation_tokens),
      events: Number(row.events),
    }));
  }
  if ((error as { code?: string }).code !== 'PGRST202') {
    throw new Error(`usage query failed: ${error.message}`);
  }
  return fetchUsageEventRows(since, until, agentId);
}

/** Fetch event rows in [since, until), paged past PostgREST's 1000-row cap. */
async function fetchUsageEventRows(since: Date, until: Date, agentId?: string): Promise<UsageRow[]> {
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

/** The price table, from the 60-second cache shared with find_agents. */
function fetchPrices(): Promise<Map<string, ModelPrice>> {
  return getModelPrices(getSupabaseClient());
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
