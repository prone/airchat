import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * authenticateAgent remembers the agent a key belongs to for 30 seconds, so an
 * agent that calls several times around one turn costs one database lookup,
 * not one per call.
 *
 * What these pin: that the lookup really is skipped, that it comes back after
 * 30 seconds, and — the part that makes a cache on an authentication path
 * acceptable — that deactivating an agent locks it out once those 30 seconds
 * have passed, and that a bad key is never remembered.
 */

const findAgentByDerivedKeyHash = vi.fn();

vi.mock('@airchat/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SupabaseStorageAdapter: class {
    findAgentByDerivedKeyHash = findAgentByDerivedKeyHash;
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  // The last_seen_at bump goes through this client; it only needs to chain.
  createClient: () => ({
    from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
  }),
}));

const { authenticateAgent, isAuthError, clearAgentAuthCache, forgetCachedAgent } = await import('@/lib/api-v2-auth');

const AGENT = {
  id: 'agent-1',
  name: 'macbook-airchat',
  machine_id: 'machine-1',
  active: true,
  permissions: {},
  metadata: { card: { capabilities: ['code'], model: 'some-model' } },
};

const req = (key = 'key-one') =>
  new NextRequest('http://localhost/api/v2/work', { headers: { 'x-agent-api-key': key } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearAgentAuthCache();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  // The real lookup filters on active = true: a deactivated agent is "not found".
  findAgentByDerivedKeyHash.mockResolvedValue(AGENT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agent lookups are cached for 30 seconds', () => {
  it('looks the agent up once for a burst of requests with the same key', async () => {
    for (let i = 0; i < 10; i++) {
      const result = await authenticateAgent(req());
      expect(isAuthError(result)).toBe(false);
    }
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(1);
  });

  it('returns the same identity from the cache as from the database', async () => {
    const first = await authenticateAgent(req());
    const second = await authenticateAgent(req());
    expect(second).toEqual(first);
    expect(first).toMatchObject({ agentId: 'agent-1', agentName: 'macbook-airchat', machineId: 'machine-1' });
  });

  it('looks the agent up again once 30 seconds have passed', async () => {
    await authenticateAgent(req());
    vi.advanceTimersByTime(29_000);
    await authenticateAgent(req());
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_500);
    await authenticateAgent(req());
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(2);
  });

  it('does not extend an entry each time it is used', async () => {
    // Otherwise a busy agent's entry would never expire and a deactivation
    // would never be seen.
    await authenticateAgent(req());
    for (let elapsed = 0; elapsed < 30_000; elapsed += 5_000) {
      vi.advanceTimersByTime(5_000);
      await authenticateAgent(req());
    }
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by key: another key is looked up on its own', async () => {
    await authenticateAgent(req('key-one'));
    findAgentByDerivedKeyHash.mockResolvedValue({ ...AGENT, id: 'agent-2', name: 'nas-worker' });
    const other = await authenticateAgent(req('key-two'));
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(2);
    expect(other).toMatchObject({ agentId: 'agent-2' });
    // And the first key still answers as the first agent.
    expect(await authenticateAgent(req('key-one'))).toMatchObject({ agentId: 'agent-1' });
  });
});

describe('deactivation takes effect within the 30 seconds', () => {
  it('rejects a deactivated agent on its first request after the entry expires', async () => {
    expect(isAuthError(await authenticateAgent(req()))).toBe(false);

    // An admin deactivates the agent: the lookup (active = true) finds nothing.
    findAgentByDerivedKeyHash.mockResolvedValue(null);

    vi.advanceTimersByTime(30_001);
    const result = await authenticateAgent(req());
    expect(isAuthError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(401);
  });

  it('keeps answering from the cache until then — the documented trade-off', async () => {
    await authenticateAgent(req());
    findAgentByDerivedKeyHash.mockResolvedValue(null);
    vi.advanceTimersByTime(20_000);
    expect(isAuthError(await authenticateAgent(req()))).toBe(false);
  });

  it('stays rejected afterwards: the failure replaces nothing in the cache', async () => {
    await authenticateAgent(req());
    findAgentByDerivedKeyHash.mockResolvedValue(null);
    vi.advanceTimersByTime(30_001);
    await authenticateAgent(req());
    const again = await authenticateAgent(req());
    expect(isAuthError(again)).toBe(true);
    // Each rejected attempt goes to the database; none is served from memory.
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(3);
  });
});

describe('changes made through the API take effect at once', () => {
  it('stops the old key working as soon as the agent re-registers with a new one', async () => {
    await authenticateAgent(req('old-key'));

    // Registration installs a new key hash: the old key no longer matches a
    // row, and the route drops the cached lookup.
    findAgentByDerivedKeyHash.mockImplementation(async () => null);
    forgetCachedAgent('agent-1');

    const result = await authenticateAgent(req('old-key'));
    expect(isAuthError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(401);
  });

  it('shows an updated card on the next request', async () => {
    await authenticateAgent(req());
    findAgentByDerivedKeyHash.mockResolvedValue({ ...AGENT, metadata: { card: { capabilities: ['review'] } } });
    forgetCachedAgent('agent-1');
    expect((await authenticateAgent(req()) as { card?: unknown }).card).toEqual({ capabilities: ['review'] });
  });

  it('leaves other agents\' entries alone', async () => {
    await authenticateAgent(req('key-one'));
    findAgentByDerivedKeyHash.mockResolvedValue({ ...AGENT, id: 'agent-2' });
    await authenticateAgent(req('key-two'));
    forgetCachedAgent('agent-2');
    await authenticateAgent(req('key-one'));
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(2);
  });
});

describe('failed lookups are never cached', () => {
  it('asks the database every time for an unknown key', async () => {
    findAgentByDerivedKeyHash.mockResolvedValue(null);
    await authenticateAgent(req('nope'));
    await authenticateAgent(req('nope'));
    expect(findAgentByDerivedKeyHash).toHaveBeenCalledTimes(2);
  });

  it('accepts a key at once when its agent registers after a failed attempt', async () => {
    // A client that gets 401 registers and retries immediately. A remembered
    // rejection would refuse it for another 30 seconds.
    findAgentByDerivedKeyHash.mockResolvedValue(null);
    expect(isAuthError(await authenticateAgent(req('fresh')))).toBe(true);
    findAgentByDerivedKeyHash.mockResolvedValue(AGENT);
    expect(isAuthError(await authenticateAgent(req('fresh')))).toBe(false);
  });
});

describe('the capability card rides on the context', () => {
  it('carries the card from the row authentication already read', async () => {
    const ctx = await authenticateAgent(req());
    expect((ctx as { card?: unknown }).card).toEqual({ capabilities: ['code'], model: 'some-model' });
  });

  it('is null for an agent with no card', async () => {
    findAgentByDerivedKeyHash.mockResolvedValue({ ...AGENT, metadata: {} });
    expect((await authenticateAgent(req()) as { card?: unknown }).card).toBeNull();
    clearAgentAuthCache();
    findAgentByDerivedKeyHash.mockResolvedValue({ ...AGENT, metadata: null });
    expect((await authenticateAgent(req()) as { card?: unknown }).card).toBeNull();
  });

  it('is left undefined when the row came without metadata, so callers fetch it themselves', async () => {
    const withoutMetadata: Record<string, unknown> = { ...AGENT };
    delete withoutMetadata.metadata;
    findAgentByDerivedKeyHash.mockResolvedValue(withoutMetadata);
    expect(await authenticateAgent(req())).not.toHaveProperty('card');
  });
});
