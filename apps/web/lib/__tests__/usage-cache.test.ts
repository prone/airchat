import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getModelPrices, getTokensTodayByAgent, clearUsageCaches, USAGE_CACHE_TTL_MS } from '@/lib/usage-cache';

/**
 * find_agents attaches a price-derived rate and today's token total to every
 * agent. Both used to be fetched on each call — the totals by downloading the
 * whole day's usage rows. They are now one aggregate query and one small
 * select, each reused for 60 seconds.
 */

type Result = { data: unknown; error: { code?: string; message: string } | null };

function client(opts: {
  rpc?: (fn: string, args: Record<string, unknown>) => Result;
  prices?: () => Result;
  usagePages?: unknown[][];
}) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) =>
    (opts.rpc ?? (() => ({ data: {}, error: null })))(fn, args));
  const priceSelect = vi.fn(async () => (opts.prices ?? (() => ({ data: [], error: null })))());
  const ranges: Array<[number, number]> = [];
  const from = vi.fn((table: string) => {
    if (table === 'model_prices') return { select: priceSelect };
    // llm_usage, paged: the fallback on a database without the function.
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'gte', 'not', 'order']) q[m] = () => q;
    q.range = async (start: number, end: number) => {
      ranges.push([start, end]);
      return { data: (opts.usagePages ?? [])[ranges.length - 1] ?? [], error: null };
    };
    return q;
  });
  return { supabase: { rpc, from } as unknown as SupabaseClient, rpc, priceSelect, ranges };
}

const NOON = new Date('2026-11-10T12:00:00Z');

beforeEach(() => {
  clearUsageCaches();
  vi.useFakeTimers();
  vi.setSystemTime(NOON);
});

afterEach(() => vi.useRealTimers());

describe('getTokensTodayByAgent', () => {
  it('asks for one aggregate since 00:00 UTC, not for the rows', async () => {
    const c = client({ rpc: () => ({ data: { 'agent-a': 338, 'agent-b': 7 }, error: null }) });
    const totals = await getTokensTodayByAgent(c.supabase);

    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith('llm_usage_tokens_by_agent', { p_since: '2026-11-10T00:00:00.000Z' });
    expect(c.ranges).toEqual([]);
    expect(Object.fromEntries(totals)).toEqual({ 'agent-a': 338, 'agent-b': 7 });
  });

  it('answers from memory for 60 seconds', async () => {
    const c = client({ rpc: () => ({ data: { 'agent-a': 1 }, error: null }) });
    for (let i = 0; i < 25; i++) await getTokensTodayByAgent(c.supabase);
    vi.setSystemTime(NOON.getTime() + USAGE_CACHE_TTL_MS - 1);
    await getTokensTodayByAgent(c.supabase);
    expect(c.rpc).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOON.getTime() + USAGE_CACHE_TTL_MS + 1);
    await getTokensTodayByAgent(c.supabase);
    expect(c.rpc).toHaveBeenCalledTimes(2);
    expect(USAGE_CACHE_TTL_MS).toBe(60_000);
  });

  it('makes one request for callers that arrive together', async () => {
    const c = client({ rpc: () => ({ data: { 'agent-a': 1 }, error: null }) });
    await Promise.all(Array.from({ length: 8 }, () => getTokensTodayByAgent(c.supabase)));
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });

  it('starts from zero at midnight UTC instead of serving yesterday\'s totals', async () => {
    const c = client({ rpc: () => ({ data: { 'agent-a': 999 }, error: null }) });
    vi.setSystemTime(new Date('2026-11-10T23:59:50Z'));
    await getTokensTodayByAgent(c.supabase);
    vi.setSystemTime(new Date('2026-11-11T00:00:05Z'));
    await getTokensTodayByAgent(c.supabase);
    expect(c.rpc).toHaveBeenCalledTimes(2);
    expect(c.rpc).toHaveBeenLastCalledWith('llm_usage_tokens_by_agent', { p_since: '2026-11-11T00:00:00.000Z' });
  });

  it('turns totals that arrive as text into numbers', async () => {
    const c = client({ rpc: () => ({ data: { 'agent-a': '9000000000' }, error: null }) });
    expect((await getTokensTodayByAgent(c.supabase)).get('agent-a')).toBe(9_000_000_000);
  });

  it('does not remember a failure', async () => {
    let fail = true;
    const c = client({
      rpc: () => (fail ? { data: null, error: { message: 'timeout' } } : { data: { 'agent-a': 5 }, error: null }),
    });
    await expect(getTokensTodayByAgent(c.supabase)).rejects.toThrow(/timeout/);
    fail = false;
    expect((await getTokensTodayByAgent(c.supabase)).get('agent-a')).toBe(5);
  });

  it('adds the rows up itself on a database without the function, and caches that too', async () => {
    const row = (agent_id: string, n: number) => ({
      agent_id, input_tokens: n, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0,
    });
    const fullPage = Array.from({ length: 1000 }, () => row('agent-a', 1));
    const c = client({
      rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }),
      usagePages: [fullPage, [row('agent-a', 10), row('agent-b', 3)]],
    });

    const totals = await getTokensTodayByAgent(c.supabase);
    expect(c.ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(Object.fromEntries(totals)).toEqual({ 'agent-a': 2011, 'agent-b': 4 });

    await getTokensTodayByAgent(c.supabase);
    expect(c.ranges).toHaveLength(2);
  });
});

describe('getModelPrices', () => {
  const PRICE = { model: 'some-model', input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75 };

  it('reads the price table once per 60 seconds', async () => {
    const c = client({ prices: () => ({ data: [PRICE], error: null }) });
    const first = await getModelPrices(c.supabase);
    await getModelPrices(c.supabase);
    expect(first.get('some-model')).toEqual(PRICE);
    expect(c.priceSelect).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOON.getTime() + USAGE_CACHE_TTL_MS + 1);
    await getModelPrices(c.supabase);
    expect(c.priceSelect).toHaveBeenCalledTimes(2);
  });

  it('throws on failure and tries again next time', async () => {
    let fail = true;
    const c = client({ prices: () => (fail ? { data: null, error: { message: 'down' } } : { data: [PRICE], error: null }) });
    await expect(getModelPrices(c.supabase)).rejects.toThrow(/model_prices query failed: down/);
    fail = false;
    expect((await getModelPrices(c.supabase)).size).toBe(1);
  });

  it('is cached separately from the token totals', async () => {
    const c = client({});
    await getModelPrices(c.supabase);
    await getTokensTodayByAgent(c.supabase);
    expect(c.priceSelect).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });
});
