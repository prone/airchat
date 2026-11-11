import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Two things in lib/usage:
 *
 *  - Served-token estimates are added up in memory and written together once
 *    a minute, instead of a read and an INSERT per report. The connector
 *    reports after every tool call, so that was two database requests per
 *    call. Nothing reported may go missing on the way.
 *
 *  - Usage summaries ask the database for sums per (agent, model, source)
 *    instead of downloading every event row.
 */

type Result = { data: unknown; error: { code?: string; message: string } | null };

const state: {
  agents: Array<{ id: string; metadata: Record<string, unknown> | null }>;
  inserts: unknown[][];
  insertResult: () => Result;
  agentsResult: (() => Result) | null;
  rpc: (fn: string, args: Record<string, unknown>) => Result;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  pages: unknown[][];
  ranges: number;
} = {
  agents: [], inserts: [], insertResult: () => ({ data: null, error: null }), agentsResult: null,
  rpc: () => ({ data: [], error: null }), rpcCalls: [], pages: [], ranges: 0,
};

const agentSelects = vi.fn();

vi.mock('@/lib/api-v2-auth', () => ({
  getStorageAdapter: () => ({
    findAgentByName: async (name: string) => ({ id: 'agent-a', name, metadata: { card: { plan: 'api' } } }),
  }),
  getSupabaseClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc(fn, args);
    },
    from: (table: string) => {
      if (table === 'agents') {
        return {
          select: (columns: string) => ({
            in: async (_col: string, ids: string[]) => {
              agentSelects(columns, ids);
              return state.agentsResult
                ? state.agentsResult()
                : { data: state.agents.filter((a) => ids.includes(a.id)), error: null };
            },
          }),
        };
      }
      if (table === 'model_prices') return { select: async () => ({ data: [], error: null }) };
      // llm_usage
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'lt', 'eq', 'not', 'order', 'range']) q[m] = () => q;
      // Awaiting the built query returns the next page of event rows.
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: state.pages[state.ranges++] ?? [], error: null }));
      q.insert = async (rows: unknown[]) => {
        state.inserts.push(rows);
        return state.insertResult();
      };
      return q;
    },
  }),
}));

const { recordServed, flushServed, resetServedBuffer, getUsageSummary, getFleetUsage } = await import('@/lib/usage');
const { clearUsageCaches } = await import('@/lib/usage-cache');

beforeEach(() => {
  vi.clearAllMocks();
  resetServedBuffer();
  clearUsageCaches();
  state.agents = [
    { id: 'agent-a', metadata: { card: { model: 'model-a' } } },
    { id: 'agent-b', metadata: {} },
  ];
  state.inserts = [];
  state.insertResult = () => ({ data: null, error: null });
  state.agentsResult = null;
  state.rpc = () => ({ data: [], error: null });
  state.rpcCalls = [];
  state.pages = [];
  state.ranges = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('served-token estimates are buffered', () => {
  it('writes nothing when a report arrives', async () => {
    recordServed('agent-a', { tokens: 120, session_id: 's-1', tools: { check_work: 120 } });
    await Promise.resolve();
    expect(state.inserts).toEqual([]);
    expect(agentSelects).not.toHaveBeenCalled();
  });

  it('writes one row per agent and session with the reports added up', async () => {
    recordServed('agent-a', { tokens: 120, session_id: 's-1', tools: { check_work: 120 } });
    recordServed('agent-a', { tokens: 30, session_id: 's-1', tools: { check_work: 10, read_messages: 20 } });
    recordServed('agent-a', { tokens: 5, session_id: 's-2' });
    recordServed('agent-b', { tokens: 7 });

    await flushServed();

    // One read of the agents involved, one INSERT for everything.
    expect(agentSelects).toHaveBeenCalledTimes(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toEqual([
      { agent_id: 'agent-a', session_id: 's-1', model: 'model-a', source: 'served', purpose: 'mcp-served', input_tokens: 150, metadata: { tools: { check_work: 130, read_messages: 20 } } },
      { agent_id: 'agent-a', session_id: 's-2', model: 'model-a', source: 'served', purpose: 'mcp-served', input_tokens: 5, metadata: { tools: {} } },
      { agent_id: 'agent-b', session_id: null, model: 'unknown', source: 'served', purpose: 'mcp-served', input_tokens: 7, metadata: { tools: {} } },
    ]);
  });

  it('loses no tokens across many small reports', async () => {
    let reported = 0;
    for (let i = 1; i <= 200; i++) {
      recordServed(i % 2 ? 'agent-a' : 'agent-b', { tokens: i, session_id: 's', tools: { t: i } });
      reported += i;
    }
    await flushServed();
    const rows = state.inserts.flat() as Array<{ input_tokens: number }>;
    expect(rows.reduce((sum, r) => sum + r.input_tokens, 0)).toBe(reported);
    expect(state.inserts).toHaveLength(1);
  });

  it('flushes by itself 60 seconds after the first report', async () => {
    vi.useFakeTimers();
    recordServed('agent-a', { tokens: 10 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(state.inserts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state.inserts).toHaveLength(1);
  });

  it('flushes early once 500 agent-session pairs are waiting', async () => {
    state.agents = [{ id: 'agent-a', metadata: {} }];
    for (let i = 0; i < 499; i++) recordServed('agent-a', { tokens: 1, session_id: `s-${i}` });
    await Promise.resolve();
    expect(state.inserts).toEqual([]);

    recordServed('agent-a', { tokens: 1, session_id: 's-499' });
    await vi.waitFor(() => expect(state.inserts).toHaveLength(1));
    expect(state.inserts[0]).toHaveLength(500);
  });

  it('starts empty after a flush: nothing is written twice', async () => {
    recordServed('agent-a', { tokens: 10 });
    await flushServed();
    await flushServed();
    expect(state.inserts).toHaveLength(1);
  });

  it('keeps a batch whose write failed and writes it with the next one', async () => {
    recordServed('agent-a', { tokens: 100, session_id: 's-1', tools: { a: 100 } });
    state.insertResult = () => ({ data: null, error: { message: 'timeout' } });
    await flushServed();

    recordServed('agent-a', { tokens: 50, session_id: 's-1', tools: { a: 50 } });
    state.insertResult = () => ({ data: null, error: null });
    await flushServed();

    const last = state.inserts[state.inserts.length - 1] as Array<{ input_tokens: number; metadata: unknown }>;
    expect(last).toHaveLength(1);
    expect(last[0].input_tokens).toBe(150);
    expect(last[0].metadata).toEqual({ tools: { a: 150 } });
  });

  it('retries on its own after a failed write', async () => {
    vi.useFakeTimers();
    recordServed('agent-a', { tokens: 100 });
    state.agentsResult = () => ({ data: null, error: { message: 'down' } });
    await flushServed();
    expect(state.inserts).toEqual([]);

    state.agentsResult = null;
    await vi.advanceTimersByTimeAsync(60_500);
    expect((state.inserts.flat() as Array<{ input_tokens: number }>)[0].input_tokens).toBe(100);
  });

  it('never throws, whatever the database does', async () => {
    recordServed('agent-a', { tokens: 1 });
    state.agentsResult = () => { throw new Error('socket hang up'); };
    await expect(flushServed()).resolves.toBeUndefined();
  });

  it('skips an agent that no longer exists rather than failing the whole write', async () => {
    recordServed('agent-a', { tokens: 10 });
    recordServed('agent-deleted', { tokens: 99 });
    await flushServed();
    expect((state.inserts[0] as Array<{ agent_id: string }>).map((r) => r.agent_id)).toEqual(['agent-a']);
  });
});

describe('usage summaries use database sums', () => {
  const since = new Date('2026-11-01T00:00:00Z');
  const until = new Date('2026-11-08T00:00:00Z');
  const group = (extra: Record<string, unknown>) => ({
    agent_id: 'agent-a', model: 'model-a', source: 'self',
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, events: 1, ...extra,
  });

  it('asks for one agent\'s totals in one request and reports them unchanged', async () => {
    state.rpc = () => ({
      data: [
        group({ input_tokens: 300, output_tokens: 30, cache_read_tokens: 1, cache_creation_tokens: 2, events: 2 }),
        group({ source: 'served', input_tokens: 5, events: 4 }),
      ],
      error: null,
    });

    const summary = await getUsageSummary('macbook-airchat', since, until);

    expect(state.rpcCalls).toEqual([{
      fn: 'llm_usage_totals',
      args: { p_since: '2026-11-01T00:00:00.000Z', p_until: '2026-11-08T00:00:00.000Z', p_agent_id: 'agent-a' },
    }]);
    expect(state.ranges).toBe(0);
    // Served is shown but, with direct rows present, left out of the totals.
    expect(summary.totals).toEqual({ input_tokens: 300, output_tokens: 30, cache_read_tokens: 1, cache_creation_tokens: 2 });
    const bySource = Object.fromEntries(summary.breakdown.map((b) => [b.source, b]));
    expect(bySource.self).toMatchObject({ input_tokens: 300, events: 2 });
    expect(bySource.served).toMatchObject({ input_tokens: 5, events: 4 });
  });

  it('gives the same summary from sums as from the individual rows', async () => {
    const events = [
      { agent_id: 'agent-a', model: 'model-a', source: 'self', input_tokens: 100, output_tokens: 10, cache_read_tokens: 1, cache_creation_tokens: 2 },
      { agent_id: 'agent-a', model: 'model-a', source: 'self', input_tokens: 200, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
      { agent_id: 'agent-a', model: 'model-b', source: 'native', input_tokens: 7, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      { agent_id: 'agent-a', model: 'model-a', source: 'served', input_tokens: 5, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    ];
    // Old path: the function is missing, so the rows are downloaded.
    state.rpc = () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
    state.pages = [events];
    const fromRows = await getUsageSummary('macbook-airchat', since, until);

    state.rpc = () => ({
      data: [
        group({ input_tokens: 300, output_tokens: 30, cache_read_tokens: 1, cache_creation_tokens: 2, events: 2 }),
        group({ model: 'model-b', source: 'native', input_tokens: 7, output_tokens: 1, events: 1 }),
        group({ source: 'served', input_tokens: 5, events: 1 }),
      ],
      error: null,
    });
    const fromSums = await getUsageSummary('macbook-airchat', since, until);

    expect(fromSums).toEqual(fromRows);
  });

  it('sums the whole fleet in one request, leaving served out where direct counts exist', async () => {
    state.rpc = () => ({
      data: [
        group({ agent_id: 'agent-a', input_tokens: 300, events: 2 }),
        group({ agent_id: 'agent-a', source: 'served', input_tokens: 50, events: 9 }),
        group({ agent_id: 'agent-b', source: 'served', input_tokens: 7, events: 1 }),
      ],
      error: null,
    });
    state.agentsResult = () => ({
      data: [
        { id: 'agent-a', name: 'macbook-airchat', metadata: {} },
        { id: 'agent-b', name: 'nas-worker', metadata: {} },
      ],
      error: null,
    });

    const fleet = await getFleetUsage(since, until);

    expect(state.rpcCalls[0].args).toMatchObject({ p_agent_id: null });
    expect(fleet.map((f) => [f.agent, f.totals.input_tokens])).toEqual([
      ['macbook-airchat', 300],
      ['nas-worker', 7],
    ]);
  });

  it('fails on a database error other than a missing function', async () => {
    state.rpc = () => ({ data: null, error: { code: '57014', message: 'statement timeout' } });
    await expect(getUsageSummary('macbook-airchat', since, until)).rejects.toThrow(/usage query failed/);
  });
});
