import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Presence filtering on /api/v2/agents.
 *
 * These exist because "who is available?" had no answer. The endpoint returned
 * every agent with active = true, and `active` only means "not deactivated" —
 * it stays true from registration until someone turns it off. On the live
 * instance that was 70 agents, of which 2 had been seen in the previous quarter
 * hour and 58 were older than a month. A picker built on that shows ghosts.
 */

const state: { rows: Array<Record<string, unknown>>; gteArg: string | null } = {
  rows: [],
  gteArg: null,
};

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'tester', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
}));

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseAdmin: () => ({
    from: () => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.gte = (_col: string, value: string) => { state.gteArg = value; return builder; };
      builder.order = async () => ({ data: state.rows, error: null });
      return builder;
    },
  }),
}));

const { GET } = await import('@/app/api/v2/agents/route');

const req = (qs = '') => new NextRequest(`http://localhost:3002/api/v2/agents${qs}`);

beforeEach(() => {
  state.rows = [
    { name: 'macbook-webapp', active: true, last_seen_at: '2026-08-08T07:30:00Z', description: null },
    { name: 'macbook-agentchat', active: true, last_seen_at: '2026-08-08T07:50:00Z', description: null },
  ];
  state.gteArg = null;
});

describe('active_within narrows the list to agents actually around', () => {
  it('applies a lower bound on last_seen_at', async () => {
    await GET(req('?active_within=1h'));
    expect(state.gteArg).not.toBeNull();
    expect(new Date(state.gteArg!).getTime()).toBeGreaterThan(Date.now() - 61 * 60_000);
  });

  it('uses a tighter bound for 15m than for 1d', async () => {
    await GET(req('?active_within=15m'));
    const tight = new Date(state.gteArg!).getTime();
    await GET(req('?active_within=1d'));
    const loose = new Date(state.gteArg!).getTime();
    expect(tight).toBeGreaterThan(loose);
  });

  it('accepts every documented window', async () => {
    for (const w of ['15m', '1h', '6h', '1d', '7d']) {
      const res = await GET(req(`?active_within=${w}`));
      expect(res.status).toBe(200);
    }
  });

  it('does not filter at all when the parameter is absent', async () => {
    // Unfiltered stays the default so existing callers are unaffected.
    await GET(req());
    expect(state.gteArg).toBeNull();
  });
});

describe('a bad window is refused rather than silently ignored', () => {
  it('rejects an unknown value', async () => {
    // Silently ignoring it would return every agent while the caller believed
    // it had asked for the live ones — the exact failure this fixes.
    const res = await GET(req('?active_within=5s'));
    expect(res.status).toBe(400);
  });

  it('names the accepted values in the error', async () => {
    const res = await GET(req('?active_within=forever'));
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('15m');
  });

  it('does not run a query for a rejected window', async () => {
    await GET(req('?active_within=nonsense'));
    expect(state.gteArg).toBeNull();
  });
});

describe('the response carries what a picker needs', () => {
  it('includes last_seen_at so callers can rank by recency', async () => {
    const res = await GET(req('?active_within=1h'));
    const body = await res.json();
    const agents = body.data.agents;
    expect(agents[0]).toHaveProperty('last_seen_at');
    expect(agents[0]).toHaveProperty('name');
  });

  it('returns an empty list rather than erroring when nobody is around', async () => {
    state.rows = [];
    const res = await GET(req('?active_within=15m'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.agents).toEqual([]);
  });
});

describe('the test suites\' agents are left out', () => {
  const names = async (qs = '') =>
    ((await (await GET(req(qs))).json()).data.agents as Array<{ name: string }>).map(a => a.name);

  beforeEach(() => {
    state.rows = [
      { name: 'macbook-agentchat', active: true, last_seen_at: '2026-08-08T07:50:00Z', permissions: {} },
      { name: 'macbook-test-alice', active: true, last_seen_at: '2026-08-08T07:49:00Z', permissions: { test_agent: true } },
      { name: 'nas-worker', active: true, last_seen_at: '2026-08-08T07:48:00Z', permissions: null },
      { name: 'nas-slack-bridge', active: true, last_seen_at: '2026-08-08T07:47:00Z', permissions: { trusted_source: 'slack' } },
    ];
  });

  it('hides an agent marked as a test agent, and nothing else', async () => {
    expect(await names()).toEqual(['macbook-agentchat', 'nas-worker', 'nas-slack-bridge']);
  });

  it('shows them when asked', async () => {
    expect(await names('?include_test=true')).toContain('macbook-test-alice');
    expect(await names('?include_test=false')).not.toContain('macbook-test-alice');
  });

  it('goes by the admin-set marker, not by the name or the card', async () => {
    state.rows = [
      { name: 'macbook-tests', active: true, last_seen_at: null, permissions: {} },
      { name: 'self-hider', active: true, last_seen_at: null, permissions: {}, metadata: { test_agent: true, card: { test_agent: true } } },
      { name: 'truthy', active: true, last_seen_at: null, permissions: { test_agent: 'true' } },
    ];
    expect(await names()).toEqual(['macbook-tests', 'self-hider', 'truthy']);
  });

  it('refuses a value that is not true or false', async () => {
    expect((await GET(req('?include_test=yes'))).status).toBe(400);
  });

  it('does not return the permissions column', async () => {
    const body = await (await GET(req('?include_test=true'))).json();
    for (const a of body.data.agents) expect(a).not.toHaveProperty('permissions');
  });
});
