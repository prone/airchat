/**
 * The storage layer under a read token.
 *
 * A read token has no agent row. Two things follow: nothing may be written for
 * it (reading a channel must not try to join it), and "the DMs that are mine"
 * is the empty set, unless the token was issued with access to all of them.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';
import { DIRECT_MESSAGES_CHANNEL } from '../constants.js';
import type { AgentContext } from '../storage.js';

type Row = Record<string, unknown>;
const DM = 'chan-dm';
const GENERAL = 'chan-general';

interface Recorder { writes: string[]; rpc: Array<Record<string, unknown>>; }

function makeClient(rows: Record<string, Row[]>, rec: Recorder): SupabaseClient {
  function builder(table: string) {
    const tests: Array<(r: Row) => boolean> = [];
    let ascending: boolean | undefined;
    let limit: number | undefined;
    const result = () => {
      let out = (rows[table] ?? []).filter((r) => tests.every((t) => t(r)));
      if (ascending !== undefined) {
        out = [...out].sort((a, b) => (ascending ? 1 : -1) * String(a.created_at).localeCompare(String(b.created_at)));
      }
      return limit === undefined ? out : out.slice(0, limit);
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: () => { rec.writes.push(`insert:${table}`); return chain; },
      upsert: () => { rec.writes.push(`upsert:${table}`); return chain; },
      update: () => { rec.writes.push(`update:${table}`); return chain; },
      eq: (col: string, val: unknown) => { tests.push((r) => r[col] === val); return chain; },
      lt: (col: string, val: unknown) => { tests.push((r) => String(r[col]) < String(val)); return chain; },
      gt: (col: string, val: unknown) => { tests.push((r) => String(r[col]) > String(val)); return chain; },
      in: (col: string, vals: unknown[]) => { tests.push((r) => vals.includes(r[col])); return chain; },
      order: (_col: string, opts?: { ascending?: boolean }) => { ascending = opts?.ascending ?? true; return chain; },
      limit: (n: number) => { limit = n; return chain; },
      single: async () => ({ data: result()[0] ?? null, error: result()[0] ? null : { message: 'not found' } }),
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve(resolve({ data: result(), error: null })),
    };
    return chain;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async (_name: string, args: Record<string, unknown>) => {
      rec.rpc.push(args);
      return {
        data: (rows.messages ?? []).map((m) => ({
          id: m.id, channel_id: m.channel_id, author_agent_id: m.author_agent_id, content: m.content,
          channel_name: m.channel_id === DM ? DIRECT_MESSAGES_CHANNEL : 'general',
        })),
        error: null,
      };
    },
  } as unknown as SupabaseClient;
}

const rows = (): Record<string, Row[]> => ({
  channels: [
    { id: DM, name: DIRECT_MESSAGES_CHANNEL },
    { id: GENERAL, name: 'general' },
  ],
  messages: [
    { id: 'dm-1', channel_id: DM, author_agent_id: 'alice', content: '@bob private', quarantined: false, created_at: '2026-01-01T00:01:00Z' },
    { id: 'dm-2', channel_id: DM, author_agent_id: 'bob', content: '@alice reply', quarantined: false, created_at: '2026-01-01T00:02:00Z' },
    { id: 'dm-3', channel_id: DM, author_agent_id: 'mallory', content: '@bob held', quarantined: true, created_at: '2026-01-01T00:03:00Z' },
    { id: 'g-1', channel_id: GENERAL, author_agent_id: 'alice', content: 'hello', quarantined: false, created_at: '2026-01-01T00:04:00Z' },
  ],
  mentions: [
    { message_id: 'dm-1', mentioned_agent_id: 'bob', channel_id: DM, created_at: '2026-01-01T00:01:00Z' },
    { message_id: 'dm-2', mentioned_agent_id: 'alice', channel_id: DM, created_at: '2026-01-01T00:02:00Z' },
  ],
  channel_memberships: [],
});

const TOKEN_ID = '5b0c9b1e-0000-4000-8000-000000000001';
const reader = (extra: Partial<AgentContext> = {}): AgentContext =>
  ({ agentId: TOKEN_ID, agentName: 'read-token:test', machineId: '', readOnly: true, ...extra });

function open(ctx: AgentContext) {
  const rec: Recorder = { writes: [], rpc: [] };
  return { scoped: new SupabaseStorageAdapter(makeClient(rows(), rec)).forAgent(ctx), rec };
}
const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

describe('a read token never writes', () => {
  it('reads a channel without joining it', async () => {
    const { scoped, rec } = open(reader());
    const channel = await scoped.findChannelByName('general');
    expect(channel?.id).toBe(GENERAL);
    expect(ids(await scoped.getMessages(GENERAL, 20))).toEqual(['g-1']);
    expect(rec.writes).toEqual([]);
  });

  it('an agent reading the same channel still joins it', async () => {
    const { scoped, rec } = open({ agentId: 'alice', agentName: 'macbook-alice', machineId: 'm' });
    await scoped.findChannelByName('general');
    expect(rec.writes).toEqual(['upsert:channel_memberships']);
  });
});

describe('direct messages', () => {
  it('are invisible to a read token by default', async () => {
    const { scoped } = open(reader());
    expect(await scoped.getMessages(DM, 20)).toEqual([]);
  });

  it('are all visible to a token issued with DM access', async () => {
    const { scoped } = open(reader({ includeDirectMessages: true }));
    expect(ids(await scoped.getMessages(DM, 20))).toEqual(['dm-1', 'dm-2']);
  });

  it('still never include quarantined messages, even with DM access', async () => {
    const { scoped } = open(reader({ includeDirectMessages: true }));
    expect(ids(await scoped.getMessages(DM, 20))).not.toContain('dm-3');
  });

  it('page forward for a token with DM access like any other channel', async () => {
    const { scoped } = open(reader({ includeDirectMessages: true }));
    expect(ids(await scoped.getMessages(DM, 20, undefined, '2026-01-01T00:01:00Z'))).toEqual(['dm-2']);
  });

  it('the DM flag means nothing on an agent', async () => {
    // Nothing sets this for an agent; if something ever did, it must not work.
    const { scoped } = open({ agentId: 'carol', agentName: 'macbook-carol', machineId: 'm', includeDirectMessages: true });
    expect(await scoped.getMessages(DM, 20)).toEqual([]);
  });

  it('an agent still sees only its own', async () => {
    const { scoped } = open({ agentId: 'bob', agentName: 'macbook-bob', machineId: 'm' });
    expect(ids(await scoped.getMessages(DM, 20))).toEqual(['dm-1', 'dm-2']);
    const outsider = open({ agentId: 'carol', agentName: 'macbook-carol', machineId: 'm' });
    expect(await outsider.scoped.getMessages(DM, 20)).toEqual([]);
  });
});

describe('search', () => {
  it('hides DMs from a read token by default', async () => {
    const { scoped, rec } = open(reader());
    const results = await scoped.searchMessages('anything');
    expect(rec.rpc[0].viewer_agent_id).toBe(TOKEN_ID);
    expect(ids(results as Array<{ id: string }>).filter((id) => id.startsWith('dm-'))).toEqual([]);
  });

  it('includes DMs for a token issued with DM access', async () => {
    const { scoped, rec } = open(reader({ includeDirectMessages: true }));
    const results = await scoped.searchMessages('anything');
    expect(rec.rpc[0].viewer_agent_id).toBeNull();
    expect(ids(results as Array<{ id: string }>)).toContain('dm-1');
  });

  it('keeps applying the DM rule for an agent carrying the flag', async () => {
    const { scoped, rec } = open({ agentId: 'carol', agentName: 'macbook-carol', machineId: 'm', includeDirectMessages: true });
    const results = await scoped.searchMessages('anything');
    expect(rec.rpc[0].viewer_agent_id).toBe('carol');
    expect(ids(results as Array<{ id: string }>).filter((id) => id.startsWith('dm-'))).toEqual([]);
  });
});
