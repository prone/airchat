import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Which agent a consenting user's connector acts as.
 *
 * The name is derived from the part of the email address before the @. Two
 * admins whose addresses share that part (alice@one.example and
 * alice@two.example) used to be given the same agent: each posted as the
 * other and could read the other's direct messages.
 */

type Row = Record<string, any>;

const state = {
  user: { id: 'user-a', email: 'alice@one.example' } as { id: string; email: string },
  agents: [] as Row[],
  tokens: [] as Row[],
  codes: [] as Row[],
  failTable: null as string | null,
  nextId: 1,
};

function fakeFrom(table: string) {
  const rows = table === 'agents' ? state.agents
    : table === 'connector_tokens' ? state.tokens
    : table === 'oauth_authorization_codes' ? state.codes
    : (() => { throw new Error(`unexpected table ${table}`); })();
  const filters: Array<(r: Row) => boolean> = [];
  let inserted: Row | null = null;
  const result = () => {
    if (state.failTable === table && !inserted) return { data: null, error: { message: 'connection reset' } };
    if (inserted) return { data: [inserted], error: null };
    return { data: rows.filter((r) => filters.every((f) => f(r))), error: null };
  };
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return q; },
    not: (col: string) => { filters.push((r) => r[col] !== null && r[col] !== undefined); return q; },
    limit: () => q,
    insert: (row: Row) => {
      inserted = { id: `${table}-${state.nextId++}`, ...row };
      rows.push(inserted);
      return q;
    },
    maybeSingle: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
    single: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock('@/lib/api-v2-auth', () => ({
  isDashboardAdmin: async () => true,
  getSupabaseClient: () => ({ from: fakeFrom }),
}));

vi.mock('@/app/api/oauth/authorize/route', () => ({
  validateAuthorizeRequest: async () => ({
    ok: true,
    request: {
      clientId: 'acl_x',
      clientName: 'Claude',
      redirectUri: 'https://claude.ai/cb',
      scope: 'read',
      state: 's',
      resource: null,
      codeChallenge: 'c',
    },
  }),
}));

const { POST } = await import('@/app/api/oauth/authorize/approve/route');

const approve = () =>
  POST(new NextRequest('https://mcp.airchat.work/api/oauth/authorize/approve', {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'acl_x' }),
  }));

/** The agent the most recent approval issued its code for. */
const grantedAgent = () => {
  const code = state.codes[state.codes.length - 1];
  return state.agents.find((a) => a.id === code.agent_id)!;
};

const signInAs = (id: string, email: string) => { state.user = { id, email }; };

beforeEach(() => {
  vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work');
  state.agents = [];
  state.tokens = [];
  state.codes = [];
  state.failTable = null;
  state.nextId = 1;
  signInAs('user-a', 'alice@one.example');
});

describe('the first user of a name', () => {
  it('gets the plain connector name', async () => {
    expect((await approve()).status).toBe(303);
    expect(grantedAgent().name).toBe('alice-claude-ai');
  });

  it('keeps the same agent on every later approval', async () => {
    await approve();
    const first = grantedAgent().id;
    state.tokens.push({ agent_id: first, granted_by_user_id: 'user-a' });
    await approve();
    expect(grantedAgent().id).toBe(first);
    expect(state.agents).toHaveLength(1);
  });
});

describe('a second user whose address has the same local part', () => {
  beforeEach(async () => {
    await approve();
    state.tokens.push({ agent_id: grantedAgent().id, granted_by_user_id: 'user-a' });
    signInAs('user-b', 'alice@two.example');
  });

  it('gets an agent of their own, not the first user\'s', async () => {
    expect((await approve()).status).toBe(303);
    const mine = grantedAgent();
    expect(mine.name).not.toBe('alice-claude-ai');
    expect(mine.name).toMatch(/^alice-[0-9a-f]{8}-claude-ai$/);
    expect(state.agents).toHaveLength(2);
  });

  it('is told apart even before the first user has exchanged their code', async () => {
    state.tokens = [];
    await approve();
    expect(grantedAgent().name).not.toBe('alice-claude-ai');
  });

  it('finds the same second agent again next time', async () => {
    await approve();
    const mine = grantedAgent().id;
    state.tokens.push({ agent_id: mine, granted_by_user_id: 'user-b' });
    await approve();
    expect(grantedAgent().id).toBe(mine);
    expect(state.agents).toHaveLength(2);
  });

  it('does not disturb the first user, who keeps the plain name', async () => {
    await approve();
    signInAs('user-a', 'alice@one.example');
    await approve();
    expect(grantedAgent().name).toBe('alice-claude-ai');
  });
});

describe('agents that already exist', () => {
  it('keeps a user on an agent two people already share, rather than renaming it', async () => {
    state.agents.push({ id: 'shared', name: 'alice-claude-ai' });
    state.tokens.push({ agent_id: 'shared', granted_by_user_id: 'user-a' });
    state.tokens.push({ agent_id: 'shared', granted_by_user_id: 'user-b' });
    signInAs('user-b', 'alice@two.example');
    await approve();
    expect(grantedAgent().id).toBe('shared');
  });

  it('uses an agent that has no recorded user, as before', async () => {
    // For example one whose tokens were all issued from the command line.
    state.agents.push({ id: 'cli-made', name: 'alice-claude-ai' });
    state.tokens.push({ agent_id: 'cli-made', granted_by_user_id: null });
    await approve();
    expect(grantedAgent().id).toBe('cli-made');
  });

  it('refuses a name held by an agent with its own credential', async () => {
    state.agents.push({ id: 'real', name: 'alice-claude-ai', derived_key_hash: 'h' });
    expect((await approve()).status).toBe(500);
    expect(state.codes).toHaveLength(0);
  });

  it('refuses rather than guess when it cannot tell whose agent it is', async () => {
    state.agents.push({ id: 'x', name: 'alice-claude-ai' });
    state.failTable = 'connector_tokens';
    expect((await approve()).status).toBe(500);
    expect(state.codes).toHaveLength(0);
  });
});
