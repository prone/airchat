import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * find_agents (GET /api/v2/agents) reports each agent's tokens today and a
 * price-derived rate. It used to download every usage row of the day on each
 * call to add them up. It now makes one aggregate call and one price read,
 * and reuses both for a minute.
 */

const rpc = vi.fn();
const tables: string[] = [];
let rows: Array<Record<string, unknown>> = [];

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'tester', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
}));

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseAdmin: () => ({
    rpc,
    from: (table: string) => {
      tables.push(table);
      const builder: Record<string, unknown> = {};
      builder.select = () => (table === 'model_prices'
        ? Promise.resolve({
            data: [{ model: 'model-a', input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75 }],
            error: null,
          })
        : builder);
      builder.eq = () => builder;
      builder.gte = () => builder;
      builder.contains = () => builder;
      builder.order = async () => ({ data: rows, error: null });
      return builder;
    },
  }),
}));

const { GET } = await import('@/app/api/v2/agents/route');
const { clearUsageCaches } = await import('@/lib/usage-cache');

const req = (qs = '') => new NextRequest(`http://localhost:3002/api/v2/agents${qs}`);
const agents = async (res: Response) => (await res.json()).data.agents as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  clearUsageCaches();
  tables.length = 0;
  rows = [
    { id: 'id-a', name: 'macbook-airchat', active: true, last_seen_at: '2026-11-10T07:50:00Z', description: null, metadata: { card: { model: 'model-a', plan: 'api' } }, permissions: {} },
    { id: 'id-b', name: 'nas-worker', active: true, last_seen_at: '2026-11-10T07:30:00Z', description: null, metadata: {}, permissions: null },
  ];
  rpc.mockResolvedValue({ data: { 'id-a': 4200 }, error: null });
});

describe('tokens_today comes from one aggregate', () => {
  it('reports each agent\'s total, and 0 for an agent with no usage today', async () => {
    const list = await agents(await GET(req()));
    expect(list.map((a) => [a.name, a.tokens_today])).toEqual([
      ['macbook-airchat', 4200],
      ['nas-worker', 0],
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('llm_usage_tokens_by_agent');
    expect(String(rpc.mock.calls[0][1].p_since)).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  it('never reads usage rows', async () => {
    await GET(req());
    expect(tables).not.toContain('llm_usage');
  });

  it('reuses the totals and the prices across calls', async () => {
    await GET(req());
    await GET(req('?active_within=1h'));
    await GET(req('?sort=cheapest'));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(tables.filter((t) => t === 'model_prices')).toHaveLength(1);
    // The agent list itself is read every time: presence must be current.
    expect(tables.filter((t) => t === 'agents')).toHaveLength(3);
  });

  it('still prices agents from the cached table', async () => {
    const [first, second] = await agents(await GET(req()));
    expect(typeof first.effective_rate_per_mtok).toBe('number');
    expect(second.effective_rate_per_mtok).toBeNull();
  });

  it('keeps every field of the response', async () => {
    const [first] = await agents(await GET(req()));
    expect(Object.keys(first)).toEqual([
      'name', 'active', 'last_seen_at', 'description', 'machine', 'card', 'plan',
      'effective_rate_per_mtok', 'tokens_today',
    ]);
  });

  it('answers with zero totals rather than failing when usage cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'statement timeout' } });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await agents(res)).map((a) => a.tokens_today)).toEqual([0, 0]);
    vi.restoreAllMocks();
  });
});
