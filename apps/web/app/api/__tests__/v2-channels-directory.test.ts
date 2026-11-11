import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * GET /api/v2/channels: the default (joined channels) must stay exactly as it
 * was, and ?scope=all must validate its paging before touching the database.
 */

const getChannels = vi.fn(async () => [{ id: 'c-1', name: 'general' }]);
const listAllChannels = vi.fn(async (opts: { limit?: number; offset?: number }) => ({
  channels: [{ id: 'c-2', name: 'quiet', joined: false, last_message_at: null }],
  total: 1, limit: opts.limit ?? 100, offset: opts.offset ?? 0,
}));

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'macbook-test', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  getStorageAdapter: () => ({ forAgent: () => ({ getChannels, listAllChannels }) }),
}));

const { GET } = await import('@/app/api/v2/channels/route');
const call = async (query = '') => {
  const res = await GET(new NextRequest(`http://localhost:3002/api/v2/channels${query}`));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => vi.clearAllMocks());

describe('default scope', () => {
  it('still returns only joined channels', async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.data.channels).toEqual([{ id: 'c-1', name: 'general' }]);
    expect(getChannels).toHaveBeenCalledWith(undefined);
    expect(listAllChannels).not.toHaveBeenCalled();
  });

  it('ignores paging parameters rather than rejecting old callers', async () => {
    expect((await call('?limit=200')).status).toBe(200);
    expect((await call('?scope=joined&limit=abc')).status).toBe(200);
    expect(listAllChannels).not.toHaveBeenCalled();
  });

  it('accepts shared and gossip as types, which the MCP tool has always offered', async () => {
    for (const type of ['shared', 'gossip', 'project']) expect((await call(`?type=${type}`)).status).toBe(200);
    expect((await call('?type=nonsense')).status).toBe(400);
  });
});

describe('scope=all', () => {
  it('returns the directory page with its paging fields', async () => {
    const { status, body } = await call('?scope=all');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ total: 1, limit: 100, offset: 0 });
    expect(body.data.channels[0]).toMatchObject({ name: 'quiet', joined: false });
    expect(listAllChannels).toHaveBeenCalledWith({ type: undefined, limit: 100, offset: 0 });
    expect(getChannels).not.toHaveBeenCalled();
  });

  it('passes type, limit and offset through', async () => {
    await call('?scope=all&type=project&limit=25&offset=50');
    expect(listAllChannels).toHaveBeenCalledWith({ type: 'project', limit: 25, offset: 50 });
  });

  it('rejects bad paging without querying', async () => {
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=-1', 'limit=', 'offset=-1', 'offset=x', 'offset=1e3']) {
      expect((await call(`?scope=all&${q}`)).status, q).toBe(400);
    }
    expect(listAllChannels).not.toHaveBeenCalled();
  });

  it('rejects an unknown scope', async () => {
    expect((await call('?scope=everything')).status).toBe(400);
  });

  it('answers 500 without detail when the database fails', async () => {
    listAllChannels.mockRejectedValueOnce(new Error('relation "channels" exploded at 10.0.0.5'));
    const { status, body } = await call('?scope=all');
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });
});
