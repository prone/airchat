/**
 * Two small lookups that many requests need and that change slowly, each kept
 * in process for 60 seconds: the model price table, and today's token total
 * per agent.
 *
 * find_agents attaches both to every agent it lists. It used to fetch the
 * price table and download every usage row of the UTC day on each call, one
 * request per 1000 rows, to answer "who can do X". Now the totals are one
 * aggregate query (llm_usage_tokens_by_agent, migration 00039) and both
 * results are reused for a minute.
 *
 * What a minute of staleness means: `tokens_today` in find_agents can lag an
 * agent's real total by up to 60 seconds, and a price edited in model_prices
 * takes up to 60 seconds to show in rates and cost estimates. Both figures
 * are labelled estimates. Usage *reports* (get_my_usage, get_agent_usage) are
 * not cached; only the prices they multiply by are.
 *
 * Failures are not cached: the next call tries again.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { totalTokens, type ModelPrice, type TokenCounts } from '@airchat/shared';

export const USAGE_CACHE_TTL_MS = 60_000;

/** PostgREST's code for "no such function": migration 00039 not applied yet. */
function isMissingFunction(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PGRST202';
}

interface Cached<T> {
  /** The value, or the request for it that is still in flight. */
  value: Promise<T>;
  expiresAt: number;
}

/**
 * Return the cached value while it is fresh; otherwise start `load` once and
 * let every caller that arrives meanwhile wait on the same request, so a burst
 * of calls after expiry costs one query, not one each.
 */
function cached<T>(
  slot: { current: Cached<T> | null },
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  if (slot.current && now < slot.current.expiresAt) return slot.current.value;
  const entry: Cached<T> = { value: load(), expiresAt: now + USAGE_CACHE_TTL_MS };
  slot.current = entry;
  entry.value.catch(() => {
    if (slot.current === entry) slot.current = null;
  });
  return entry.value;
}

// ── Model prices ────────────────────────────────────────────────────────────

const pricesSlot: { current: Cached<Map<string, ModelPrice>> | null } = { current: null };

/** The model price table by model name. Throws when it cannot be read. */
export function getModelPrices(client: SupabaseClient): Promise<Map<string, ModelPrice>> {
  return cached(pricesSlot, async () => {
    const { data, error } = await client
      .from('model_prices')
      .select('model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok');
    if (error) throw new Error(`model_prices query failed: ${error.message}`);
    return new Map(((data ?? []) as ModelPrice[]).map((p) => [p.model, p]));
  });
}

// ── Tokens today, per agent ─────────────────────────────────────────────────

const tokensSlot: { current: Cached<Map<string, number>> | null } = { current: null };
/** The UTC day the cached totals belong to; a new day starts from zero. */
let tokensDay = '';

const PAGE_SIZE = 1000;

/** The pre-00039 way: download the day's rows and add them up here. */
async function sumTokensByPaging(client: SupabaseClient, sinceIso: string): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('llm_usage')
      .select('agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
      .gte('created_at', sinceIso)
      .not('agent_id', 'is', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`llm_usage query failed: ${error.message}`);
    for (const u of data ?? []) {
      const row = u as TokenCounts & { agent_id: string };
      totals.set(row.agent_id, (totals.get(row.agent_id) ?? 0) + totalTokens(row));
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return totals;
}

/**
 * Tokens of every kind recorded since 00:00 UTC today, by agent id. Agents
 * with no usage today are absent. Throws when the totals cannot be read.
 */
export function getTokensTodayByAgent(
  client: SupabaseClient,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const day = now.toISOString().slice(0, 10);
  if (day !== tokensDay) {
    tokensDay = day;
    tokensSlot.current = null;
  }
  const sinceIso = `${day}T00:00:00.000Z`;
  return cached(tokensSlot, async () => {
    const { data, error } = await client.rpc('llm_usage_tokens_by_agent', { p_since: sinceIso });
    if (error) {
      if (isMissingFunction(error)) return sumTokensByPaging(client, sinceIso);
      throw new Error(`llm_usage totals failed: ${error.message}`);
    }
    const totals = new Map<string, number>();
    for (const [agentId, tokens] of Object.entries((data ?? {}) as Record<string, number | string>)) {
      totals.set(agentId, Number(tokens));
    }
    return totals;
  });
}

/** Drop both cached values. For tests. */
export function clearUsageCaches(): void {
  pricesSlot.current = null;
  tokensSlot.current = null;
  tokensDay = '';
}
