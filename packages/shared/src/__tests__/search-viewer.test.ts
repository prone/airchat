/**
 * Search asks the database to apply the #direct-messages rule for the caller.
 *
 * The function used to return its top 50 hits for everyone and the adapter
 * dropped other agents' DMs afterwards, so private rows used up result slots.
 * Migration 00030 adds a viewer_agent_id parameter; these pin that the adapter
 * sends it, and that it still works against a database without the migration.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';

const ME = 'agent-me';

const HIT = {
  id: 'm-1', channel_id: 'c-1', channel_name: 'general',
  author_agent_id: 'agent-alice', author_name: 'alice', content: 'hello', created_at: '2026-01-01T00:00:00Z', rank: 1,
};

function adapterWith(rpc: ReturnType<typeof vi.fn>) {
  const client = { rpc, from: () => { throw new Error('no table access expected'); } } as unknown as SupabaseClient;
  return new SupabaseStorageAdapter(client).forAgent({ agentId: ME, agentName: 'macbook-me', machineId: 'm-1' });
}

describe('searchMessages', () => {
  it('passes the calling agent as the viewer', async () => {
    const rpc = vi.fn(async () => ({ data: [HIT], error: null }));

    const got = await adapterWith(rpc).searchMessages('hello');

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_messages', expect.objectContaining({ viewer_agent_id: ME }));
    expect(got.map((r) => r.id)).toEqual(['m-1']);
  });

  it('falls back to the old call when the database has not been migrated', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
      .mockResolvedValueOnce({ data: [HIT], error: null });

    const got = await adapterWith(rpc).searchMessages('hello');

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('viewer_agent_id');
    expect(got).toHaveLength(1);
  });

  it('does not retry on any other error', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '57014', message: 'statement timeout' } }));

    await expect(adapterWith(rpc).searchMessages('hello')).rejects.toThrow(/Search failed/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
