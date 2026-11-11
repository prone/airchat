import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';
import { SupabaseGossipAdapter } from '../supabase-gossip-adapter.js';

const agent = { agentId: 'agent-me', agentName: 'macbook-me', machineId: 'm-1' };
type Row = Record<string, unknown>;

/** Messages table stand-in honouring eq / gt / order / limit on created_at. */
function messagesClient(rows: Row[]): SupabaseClient {
  return {
    from: (table: string) => {
      const f: { eq: Record<string, unknown>; gt?: string; asc?: boolean; limit?: number } = { eq: {} };
      const q: Record<string, any> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { f.eq[c] = v; return q; };
      q.gt = (_c: string, v: string) => { f.gt = v; return q; };
      q.lt = () => q;
      q.order = (_c: string, o: { ascending: boolean }) => { f.asc = o.ascending; return q; };
      q.limit = (n: number) => { f.limit = n; return q; };
      q.maybeSingle = async () => ({ data: null, error: null }); // no DM channel
      q.single = async () => ({ data: null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => {
        if (table !== 'messages') return Promise.resolve(resolve({ data: [], error: null }));
        let out = rows.filter((r) => Object.entries(f.eq).every(([c, v]) => r[c] === v));
        if (f.gt !== undefined) out = out.filter((r) => String(r.created_at) > f.gt!);
        if (f.asc !== undefined) out = [...out].sort((a, b) => (f.asc ? 1 : -1) * String(a.created_at).localeCompare(String(b.created_at)));
        if (f.limit !== undefined) out = out.slice(0, f.limit);
        return Promise.resolve(resolve({ data: out, error: null }));
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe('reading forward never skips messages that share a timestamp', () => {
  const at = (s: number) => `2026-01-01T00:00:0${s}.000000+00:00`;
  const row = (id: string, s: number): Row => ({ id, channel_id: 'c-1', quarantined: false, created_at: at(s), content: id });
  // A batch written in one transaction: b1, b2 and b3 share a timestamp.
  const rows = [row('a', 1), row('b1', 2), row('b2', 2), row('b3', 2), row('c', 3)];

  it('finishes the timestamp group a page ends in, and the next page continues after it', async () => {
    const adapter = new SupabaseStorageAdapter(messagesClient(rows)).forAgent(agent);

    const first = await adapter.getMessages('c-1', 2, undefined, '2026-01-01T00:00:00.000000+00:00');
    expect(first.map((m) => m.id).sort()).toEqual(['a', 'b1', 'b2', 'b3']);

    const next = await adapter.getMessages('c-1', 2, undefined, String(first[first.length - 1].created_at));
    expect(next.map((m) => m.id)).toEqual(['c']);
  });

  it('adds nothing when the page does not end inside a group', async () => {
    const adapter = new SupabaseStorageAdapter(messagesClient(rows)).forAgent(agent);
    const page = await adapter.getMessages('c-1', 1, undefined, '2026-01-01T00:00:00.000000+00:00');
    expect(page.map((m) => m.id)).toEqual(['a']);
  });
});

describe('gossip instance config', () => {
  const client = (result: { data: unknown; error: unknown }) => ({
    from: () => ({ select: () => ({ limit: () => ({ maybeSingle: async () => result }) }) }),
  }) as unknown as SupabaseClient;

  it('is null when the instance has no identity yet', async () => {
    expect(await new SupabaseGossipAdapter(client({ data: null, error: null })).getInstanceConfig()).toBeNull();
  });

  it('throws when the database fails, rather than reporting "not configured"', async () => {
    // Returning null here made an outage look like gossip switched off, so the
    // sync loop recorded a success and never backed off.
    const adapter = new SupabaseGossipAdapter(client({ data: null, error: { message: 'connection timeout' } }));
    await expect(adapter.getInstanceConfig()).rejects.toThrow(/connection timeout/);
  });

  it('returns the row when there is one', async () => {
    const row = { id: 'i-1', gossip_enabled: true };
    expect(await new SupabaseGossipAdapter(client({ data: row, error: null })).getInstanceConfig()).toEqual(row);
  });
});
