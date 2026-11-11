import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

/**
 * A read token is accepted for GET on four routes and for nothing else.
 *
 * It is a weaker credential than an agent key on purpose (it may be pasted
 * into a dashboard's config), and it can carry access to every direct message.
 * So what matters most here is what it is refused for.
 */

const TOKEN = 'airchat_ro_' + 'A'.repeat(43);
const OTHER = 'airchat_ro_' + 'B'.repeat(43);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

type Row = Record<string, unknown>;
const db = { rows: [] as Row[], lookups: 0, fail: false };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const tests: Array<(r: Row) => boolean> = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: () => chain,
        eq: (col: string, val: unknown) => { tests.push((r) => r[col] === val); return chain; },
        is: (col: string, val: unknown) => { tests.push((r) => (r[col] ?? null) === val); return chain; },
        maybeSingle: async () => {
          if (table !== 'read_tokens') return { data: null, error: null };
          db.lookups++;
          if (db.fail) return { data: null, error: { message: 'connection reset' } };
          return { data: db.rows.find((r) => tests.every((t) => t(r))) ?? null, error: null };
        },
        then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })),
      };
      return chain;
    },
  }),
}));

const findAgentByDerivedKeyHash = vi.fn(async (hash: string) =>
  hash === sha('a-real-agent-key') ? { id: 'agent-1', name: 'macbook-test', machine_id: 'm-1', permissions: {} } : null);

vi.mock('@airchat/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SupabaseStorageAdapter: class { findAgentByDerivedKeyHash = findAgentByDerivedKeyHash; },
}));

vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');

const { authenticateAgent, READ_TOKEN_ROUTES } = await import('@/lib/api-v2-auth');

const request = (path: string, headers: Record<string, string>, method = 'GET') =>
  new NextRequest(`http://localhost:3002${path}`, { method, headers });
const withToken = (path: string, method = 'GET', token = TOKEN) =>
  authenticateAgent(request(path, { 'x-airchat-read-token': token }, method));
const status = (r: unknown) => (r instanceof NextResponse ? r.status : 200);

beforeEach(() => {
  vi.clearAllMocks();
  db.lookups = 0;
  db.fail = false;
  db.rows = [
    { id: 'tok-1', name: 'Claude Projects', token_hash: sha(TOKEN), include_dms: false, revoked_at: null },
    { id: 'tok-2', name: 'Owner', token_hash: sha(OTHER), include_dms: true, revoked_at: null },
  ];
});

describe('what a read token is accepted for', () => {
  it('reads the four listed routes', async () => {
    for (const path of ['/api/v2/agents', '/api/v2/channels?scope=all', '/api/v2/messages?channel=general', '/api/v2/search?q=x']) {
      const ctx = await withToken(path);
      expect(ctx, path).toMatchObject({ agentId: 'tok-1', readOnly: true, includeDirectMessages: false });
    }
  });

  it('pins the list, so widening it is a deliberate change to this test', () => {
    expect([...READ_TOKEN_ROUTES].sort()).toEqual([
      '/api/v2/agents', '/api/v2/channels', '/api/v2/messages', '/api/v2/search',
    ]);
  });

  it('is not an agent: its id is the token id and it has no machine', async () => {
    const ctx = await withToken('/api/v2/agents');
    expect(ctx).toMatchObject({ agentId: 'tok-1', agentName: 'read-token:Claude Projects', machineId: '' });
    expect(findAgentByDerivedKeyHash).not.toHaveBeenCalled();
  });

  it('carries DM access only when the token was issued with it', async () => {
    expect(await withToken('/api/v2/messages?channel=direct-messages')).toMatchObject({ includeDirectMessages: false });
    expect(await withToken('/api/v2/messages?channel=direct-messages', 'GET', OTHER)).toMatchObject({
      agentId: 'tok-2', readOnly: true, includeDirectMessages: true,
    });
  });
});

describe('what it is refused for', () => {
  it('refuses every write, without even looking the token up', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/v2/messages', '/api/v2/channels', '/api/v2/dm', '/api/v2/notes']) {
        expect(status(await withToken(path, method)), `${method} ${path}`).toBe(403);
      }
    }
    expect(db.lookups).toBe(0);
  });

  it('refuses GET on every route that is not listed', async () => {
    const closed = [
      '/api/v2/board', '/api/v2/work', '/api/v2/mentions', '/api/v2/notes', '/api/v2/notes/backlinks',
      '/api/v2/tasks', '/api/v2/usage', '/api/v2/dm', '/api/v2/gossip', '/api/v2/gossip/peers',
      '/api/v2/channels/read', '/api/v2/admin/read-tokens', '/api/files?path=general/x.txt',
      '/api/v2/messagesx', '/api/v2/messages/extra', '/api/v2', '/api/mcp',
    ];
    for (const path of closed) expect(status(await withToken(path)), path).toBe(403);
    expect(db.lookups).toBe(0);
  });

  it('refuses a revoked token', async () => {
    db.rows[0].revoked_at = '2026-11-10T00:00:00Z';
    expect(status(await withToken('/api/v2/agents'))).toBe(401);
  });

  it('refuses an unknown or malformed token', async () => {
    expect(status(await withToken('/api/v2/agents', 'GET', 'airchat_ro_' + 'C'.repeat(43)))).toBe(401);
    for (const bad of ['', 'airchat_ro_short', 'a-real-agent-key', 'airchat_ro_' + 'A'.repeat(44), TOKEN + '.x']) {
      expect(status(await withToken('/api/v2/agents', 'GET', bad)), JSON.stringify(bad)).toBe(401);
    }
  });

  it('says "unavailable", not "invalid", when the database fails', async () => {
    db.fail = true;
    expect(status(await withToken('/api/v2/agents'))).toBe(503);
  });

  it('does not fall back to an agent key sent alongside a bad token', async () => {
    const res = await authenticateAgent(request('/api/v2/messages?channel=general', {
      'x-airchat-read-token': 'airchat_ro_' + 'C'.repeat(43),
      'x-agent-api-key': 'a-real-agent-key',
    }));
    expect(status(res)).toBe(401);
    expect(findAgentByDerivedKeyHash).not.toHaveBeenCalled();
  });

  it('does not let the token header turn an agent key into a writer either', async () => {
    const res = await authenticateAgent(request('/api/v2/messages', {
      'x-airchat-read-token': TOKEN,
      'x-agent-api-key': 'a-real-agent-key',
    }, 'POST'));
    expect(status(res)).toBe(403);
  });

  it('is not accepted in the agent-key header', async () => {
    const res = await authenticateAgent(request('/api/v2/agents', { 'x-agent-api-key': TOKEN }));
    expect(status(res)).toBe(401);
  });
});

describe('agent keys are unaffected', () => {
  it('authenticates as before, with no read-only flags', async () => {
    const ctx = await authenticateAgent(request('/api/v2/messages', { 'x-agent-api-key': 'a-real-agent-key' }, 'POST'));
    expect(ctx).toMatchObject({ agentId: 'agent-1', agentName: 'macbook-test' });
    expect(ctx).not.toHaveProperty('readOnly');
    expect(ctx).not.toHaveProperty('includeDirectMessages');
    expect(db.lookups).toBe(0);
  });
});
