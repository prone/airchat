/**
 * Small guarantees on the paths every agent hits constantly: reading a
 * channel, polling for mentions, and reading one's direct messages.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';
import { DIRECT_MESSAGES_CHANNEL } from '../constants.js';

const ME = 'agent-me';
const agent = { agentId: ME, agentName: 'macbook-me', machineId: 'm-1' };

/** A query builder whose every method chains, resolving to `rows` when awaited. */
function chain(rows: unknown[], calls: Array<[string, unknown[]]>) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'lt', 'gt', 'order', 'limit']) {
    q[m] = (...args: unknown[]) => { calls.push([m, args]); return q; };
  }
  q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
  q.single = async () => ({ data: rows[0] ?? null, error: null });
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows, error: null }));
  return q;
}

describe('ensureChannelMembership', () => {
  it('inserts only if missing, so reading a channel does not rewrite the membership row', async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const client = { from: () => ({ upsert }) } as unknown as SupabaseClient;

    await new SupabaseStorageAdapter(client).forAgent(agent).ensureChannelMembership('c-1');

    expect(upsert).toHaveBeenCalledWith(
      { agent_id: ME, channel_id: 'c-1' },
      { onConflict: 'agent_id,channel_id', ignoreDuplicates: true },
    );
  });
});

describe('getMentions', () => {
  const limitOf = async (limit?: number) => {
    const calls: Array<[string, unknown[]]> = [];
    const client = { from: () => chain([], calls) } as unknown as SupabaseClient;
    const scoped = new SupabaseStorageAdapter(client).forAgent(agent);
    await (limit === undefined ? scoped.getMentions(true) : scoped.getMentions(true, limit));
    return calls.find(([m]) => m === 'limit')?.[1][0];
  };

  it('fetches only as many rows as the caller will use', async () => {
    expect(await limitOf(20)).toBe(20);
  });

  it('defaults to 100 and never exceeds it', async () => {
    expect(await limitOf()).toBe(100);
    expect(await limitOf(5000)).toBe(100);
    expect(await limitOf(0)).toBe(1);
  });
});

describe('direct messages are returned in time order', () => {
  it('orders by instant even when one timestamp has no fractional seconds', async () => {
    // As text, "…:05+00:00" sorts AFTER "…:05.5+00:00" ('+' > '.' is false in
    // some collations, true in others) — compare instants, not strings.
    const whole = { id: 'whole', author_agent_id: ME, created_at: '2026-01-01T00:00:05+00:00' };
    const half = { id: 'half', author_agent_id: 'agent-alice', created_at: '2026-01-01T00:00:05.5+00:00' };
    const later = { id: 'later', author_agent_id: ME, created_at: '2026-01-01T00:00:06.000001+00:00' };

    const client = {
      from: (table: string) => {
        if (table === 'channels') return chain([{ id: 'dm', name: DIRECT_MESSAGES_CHANNEL }], []);
        if (table === 'mentions') return chain([{ message_id: 'half' }], []);
        if (table === 'messages') {
          // First messages query: authored by me. Second: the ones I am mentioned in.
          const calls: Array<[string, unknown[]]> = [];
          const q = chain([], calls) as Record<string, any>;
          q.then = (resolve: (v: unknown) => unknown) => {
            const addressed = calls.some(([m, a]) => m === 'in' && a[0] === 'id');
            return Promise.resolve(resolve({ data: addressed ? [half] : [later, whole], error: null }));
          };
          return q;
        }
        return chain([], []);
      },
    } as unknown as SupabaseClient;

    const got = await new SupabaseStorageAdapter(client).forAgent(agent).getMessages('dm', 20);
    expect(got.map((m) => m.id)).toEqual(['whole', 'half', 'later']);
  });
});
