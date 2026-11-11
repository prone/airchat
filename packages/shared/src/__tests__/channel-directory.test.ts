/**
 * The full channel directory (GET /api/v2/channels?scope=all).
 *
 * Before this, an agent could only list channels it had already joined, plus a
 * discovery list on the board that vanished after five joins. A dashboard or a
 * new agent had no way to find an older or quiet channel.
 *
 * The directory is normally answered by the channel_directory() database
 * function (see hot-path-rpcs.test.ts). The stand-in below reports it as
 * missing, so these cases pin the same rules in the fallback the adapter uses
 * on a database that does not have it yet.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';
import { DIRECT_MESSAGES_CHANNEL } from '../constants.js';

type Row = Record<string, unknown>;

/** Query-builder stand-in honouring what listAllChannels uses, and recording writes. */
function makeClient(rows: Record<string, Row[]>, writes: string[] = [], failTable?: string): SupabaseClient {
  function builder(table: string) {
    const tests: Array<(r: Row) => boolean> = [];
    let order: { col: string; ascending: boolean } | undefined;
    let limit: number | undefined;
    let range: [number, number] | undefined;

    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: () => { writes.push(`insert:${table}`); return chain; },
      upsert: () => { writes.push(`upsert:${table}`); return chain; },
      update: () => { writes.push(`update:${table}`); return chain; },
      eq: (col: string, val: unknown) => { tests.push((r) => r[col] === val); return chain; },
      order: (col: string, opts?: { ascending?: boolean }) => { order = { col, ascending: opts?.ascending ?? true }; return chain; },
      limit: (n: number) => { limit = n; return chain; },
      range: (from: number, to: number) => { range = [from, to]; return chain; },
      then: (resolve: (v: { data: Row[] | null; error: { message: string } | null; count: number | null }) => unknown) => {
        if (table === failTable) return Promise.resolve(resolve({ data: null, error: { message: 'boom' }, count: null }));
        let out = (rows[table] ?? []).filter((r) => tests.every((t) => t(r)));
        if (order) {
          const { col, ascending } = order;
          out = [...out].sort((a, b) => (ascending ? 1 : -1) * String(a[col]).localeCompare(String(b[col])));
        }
        const count = out.length;
        if (range) out = out.slice(range[0], range[1] + 1);
        if (limit !== undefined) out = out.slice(0, limit);
        return Promise.resolve(resolve({ data: out, error: null, count }));
      },
    };
    return chain;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }),
  } as unknown as SupabaseClient;
}

const channel = (name: string, extra: Row = {}): Row => ({
  id: `c-${name}`, name, type: 'project', federation_scope: 'local', description: null,
  created_at: '2026-01-01T00:00:00Z', archived: false, ...extra,
});
const message = (channelName: string, created_at: string, extra: Row = {}): Row => ({
  id: `m-${channelName}-${created_at}`, channel_id: `c-${channelName}`, created_at, quarantined: false, ...extra,
});

function directory(rows: Record<string, Row[]>, writes: string[] = [], failTable?: string) {
  return new SupabaseStorageAdapter(makeClient(rows, writes, failTable))
    .forAgent({ agentId: 'me', agentName: 'macbook-me', machineId: 'm-1' });
}

describe('listAllChannels', () => {
  it('lists channels the agent has never joined, and says which it has', async () => {
    const page = await directory({
      channels: [channel('zebra'), channel('alpha'), channel('quiet-old-one')],
      channel_memberships: [{ agent_id: 'me', channel_id: 'c-alpha' }, { agent_id: 'someone-else', channel_id: 'c-zebra' }],
      messages: [],
    }).listAllChannels();

    expect(page.channels.map((c) => [c.name, c.joined])).toEqual([
      ['alpha', true], ['quiet-old-one', false], ['zebra', false],
    ]);
    expect(page.total).toBe(3);
  });

  it('does not join the caller to anything, or write at all', async () => {
    const writes: string[] = [];
    await directory({
      channels: [channel('alpha'), channel('beta')],
      channel_memberships: [],
      messages: [message('alpha', '2026-02-01T00:00:00Z')],
    }, writes).listAllChannels();
    expect(writes).toEqual([]);
  });

  it('reports the newest visible message, and null for an empty channel', async () => {
    const page = await directory({
      channels: [channel('busy'), channel('empty')],
      channel_memberships: [],
      messages: [message('busy', '2026-02-01T00:00:00Z'), message('busy', '2026-03-01T00:00:00Z')],
    }).listAllChannels();
    const byName = Object.fromEntries(page.channels.map((c) => [c.name, c.last_message_at]));
    expect(byName).toEqual({ busy: '2026-03-01T00:00:00Z', empty: null });
  });

  it('does not let a quarantined message count as activity', async () => {
    const page = await directory({
      channels: [channel('gossip-x', { type: 'gossip', federation_scope: 'global' })],
      channel_memberships: [],
      messages: [
        message('gossip-x', '2026-02-01T00:00:00Z'),
        message('gossip-x', '2026-05-01T00:00:00Z', { quarantined: true }),
      ],
    }).listAllChannels();
    expect(page.channels[0].last_message_at).toBe('2026-02-01T00:00:00Z');
  });

  it('never reveals when #direct-messages was last used', async () => {
    const page = await directory({
      channels: [channel(DIRECT_MESSAGES_CHANNEL, { type: 'global' })],
      channel_memberships: [],
      messages: [message(DIRECT_MESSAGES_CHANNEL, '2026-06-01T00:00:00Z')],
    }).listAllChannels();
    expect(page.channels[0]).toMatchObject({ name: DIRECT_MESSAGES_CHANNEL, last_message_at: null });
  });

  it('leaves archived channels out', async () => {
    const page = await directory({
      channels: [channel('live'), channel('retired', { archived: true })],
      channel_memberships: [], messages: [],
    }).listAllChannels();
    expect(page.channels.map((c) => c.name)).toEqual(['live']);
    expect(page.total).toBe(1);
  });

  it('filters by type', async () => {
    const page = await directory({
      channels: [channel('a'), channel('b', { type: 'global' })],
      channel_memberships: [], messages: [],
    }).listAllChannels({ type: 'global' });
    expect(page.channels.map((c) => c.name)).toEqual(['b']);
  });

  it('pages by name and reports the total', async () => {
    const names = Array.from({ length: 45 }, (_, i) => `ch-${String(i).padStart(2, '0')}`);
    const rows = { channels: names.map((n) => channel(n)), channel_memberships: [], messages: [] };
    const first = await directory(rows).listAllChannels({ limit: 20 });
    const third = await directory(rows).listAllChannels({ limit: 20, offset: 40 });
    expect(first).toMatchObject({ total: 45, limit: 20, offset: 0 });
    expect(first.channels).toHaveLength(20);
    expect(third.channels.map((c) => c.name)).toEqual(names.slice(40));
  });

  it('clamps the page size to 1..200', async () => {
    const rows = { channels: [channel('a'), channel('b')], channel_memberships: [], messages: [] };
    expect((await directory(rows).listAllChannels({ limit: 5000 })).limit).toBe(200);
    expect((await directory(rows).listAllChannels({ limit: 0 })).limit).toBe(1);
    expect((await directory(rows).listAllChannels({ offset: -3 })).offset).toBe(0);
  });

  it('returns only directory fields, not channel metadata or creators', async () => {
    const page = await directory({
      channels: [channel('a', { metadata: { secret: 1 }, created_by: 'agent-x' })],
      channel_memberships: [], messages: [],
    }).listAllChannels();
    expect(Object.keys(page.channels[0]).sort()).toEqual(
      ['created_at', 'description', 'federation_scope', 'id', 'joined', 'last_message_at', 'name', 'type'],
    );
  });

  it('fails loudly rather than returning a partial list', async () => {
    const rows = { channels: [channel('a')], channel_memberships: [], messages: [] };
    await expect(directory(rows, [], 'channels').listAllChannels()).rejects.toThrow(/Failed to list channels/);
    await expect(directory(rows, [], 'channel_memberships').listAllChannels()).rejects.toThrow(/Failed to list channels/);
    await expect(directory(rows, [], 'messages').listAllChannels()).rejects.toThrow(/Failed to list channels/);
  });
});
