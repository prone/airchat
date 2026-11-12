import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter, isParentMessageError } from '../supabase-adapter.js';

/**
 * Edges of the private-message rules: what an agent that is not a party to a
 * direct or conversation message can still do with its id, and what the
 * people in a conversation are told about each other.
 */

type Row = Record<string, unknown>;
const ME = 'agent-me';
const ALICE = 'agent-alice';
const BOB = 'agent-bob';
const CAROL = 'agent-carol';
const DM = 'chan-dm';
const OPEN = 'chan-open';
const CONV = 'conv-1';

/** An in-memory stand-in for the Supabase client: enough of it for these paths. */
function makeClient(tables: Record<string, Row[]>) {
  const inserted: Row[] = [];
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let update: Row | null = null;
    let insert: Row | null = null;
    let limit: number | undefined;
    const rows = () => {
      if (insert) {
        const row = { id: `new-${inserted.length + 1}`, created_at: '2026-11-12T00:00:00Z', ...insert };
        inserted.push(row);
        (tables[table] ??= []).push(row);
        return [row];
      }
      let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (update) out.forEach((r) => Object.assign(r, update));
      if (limit !== undefined) out = out.slice(0, limit);
      return out.map((r) => ({ ...r, agents: { name: String(r.mentioned_agent_id ?? r.agent_id ?? r.author_agent_id ?? '') } }));
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      limit: (n: number) => { limit = n; return chain; },
      eq: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return chain; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
      not: () => chain,
      update: (vals: Row) => { update = vals; return chain; },
      insert: (row: Row) => { insert = row; return chain; },
      upsert: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve(resolve({ data: rows(), error: null })),
    };
    return chain;
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }),
  } as unknown as SupabaseClient;
  return { client, inserted };
}

const tables = (): Record<string, Row[]> => ({
  channels: [
    { id: DM, name: 'direct-messages', type: 'global', federation_scope: 'local', archived: false },
    { id: OPEN, name: 'general', type: 'global', federation_scope: 'local', archived: false },
  ],
  messages: [
    { id: 'open-1', channel_id: OPEN, author_agent_id: ALICE, conversation_id: null, quarantined: false },
    { id: 'open-hidden', channel_id: OPEN, author_agent_id: ALICE, conversation_id: null, quarantined: true },
    { id: 'dm-to-me', channel_id: DM, author_agent_id: ALICE, conversation_id: null, quarantined: false },
    { id: 'dm-others', channel_id: DM, author_agent_id: ALICE, conversation_id: null, quarantined: false },
    { id: 'dm-mine', channel_id: DM, author_agent_id: ME, conversation_id: null, quarantined: false },
    { id: 'conv-msg', channel_id: DM, author_agent_id: ALICE, conversation_id: CONV, quarantined: false },
    { id: 'conv-mine', channel_id: DM, author_agent_id: ME, conversation_id: CONV, quarantined: false },
  ],
  mentions: [
    { id: 'mn-1', message_id: 'dm-to-me', mentioned_agent_id: ME, read: false, read_at: null },
    { id: 'mn-2', message_id: 'dm-others', mentioned_agent_id: BOB, read: false, read_at: null },
    { id: 'mn-3', message_id: 'conv-msg', mentioned_agent_id: ME, read: false, read_at: null },
    // My conversation message: Alice read it, Bob has not, Carol joined later.
    { id: 'mn-4', message_id: 'conv-mine', mentioned_agent_id: ALICE, read: true, read_at: '2026-11-12T01:00:00Z' },
    { id: 'mn-5', message_id: 'conv-mine', mentioned_agent_id: BOB, read: false, read_at: null },
    { id: 'mn-6', message_id: 'conv-mine', mentioned_agent_id: CAROL, read: true, read_at: null },
    // My plain DM, read before read times were recorded.
    { id: 'mn-7', message_id: 'dm-mine', mentioned_agent_id: BOB, read: true, read_at: null },
  ],
  channel_read_cursors: [
    { channel_id: DM, agent_id: ME, read_through: 't2', updated_at: 't2' },
    { channel_id: DM, agent_id: BOB, read_through: 't1', updated_at: 't1' },
    { channel_id: OPEN, agent_id: ME, read_through: 't2', updated_at: 't2' },
    { channel_id: OPEN, agent_id: BOB, read_through: 't1', updated_at: 't1' },
  ],
});

function open(data = tables()) {
  const { client, inserted } = makeClient(data);
  const scoped = new SupabaseStorageAdapter(client).forAgent({ agentId: ME, agentName: 'mac-me', machineId: 'm-1' });
  return { scoped, inserted, data };
}

describe('replying to a message', () => {
  const refused = async (channel: string, parent: string) => {
    const { scoped, inserted } = open();
    const error = await scoped.sendMessage(channel, 'reply', undefined, parent).catch((e) => e);
    expect(inserted, `${channel} <- ${parent}`).toHaveLength(0);
    return isParentMessageError(error);
  };

  it('works in the same channel, and for a direct message the sender is party to', async () => {
    for (const [channel, parent] of [['general', 'open-1'], ['direct-messages', 'dm-to-me'], ['direct-messages', 'dm-mine']]) {
      const { scoped, inserted } = open();
      await scoped.sendMessage(channel, 'reply', undefined, parent);
      expect(inserted[0], parent).toMatchObject({ parent_message_id: parent });
    }
  });

  it.each([
    ['a message that does not exist', 'general', 'nope'],
    ['a quarantined message', 'general', 'open-hidden'],
    ['a message in another channel', 'general', 'dm-to-me'],
    ['a private message from a public channel', 'general', 'conv-msg'],
    ['someone else\'s direct message', 'direct-messages', 'dm-others'],
    ['a conversation message, from a plain direct message', 'direct-messages', 'conv-msg'],
  ])('refuses %s, with one answer for all', async (_what, channel, parent) => {
    expect(await refused(channel, parent)).toBe(true);
  });
});

describe('receipts', () => {
  it('leave out an agent that joined the conversation after the message', async () => {
    const { scoped } = open();
    const [receipt] = await scoped.getMessageReceipts(['conv-mine']);
    expect(receipt.recipients.map((r) => [r.name, r.read])).toEqual([[ALICE, true], [BOB, false]]);
  });

  it('keep a plain direct message that was read before read times existed', async () => {
    const { scoped } = open();
    const [receipt] = await scoped.getMessageReceipts(['dm-mine']);
    expect(receipt.recipients).toEqual([{ name: BOB, read: true, read_at: null }]);
  });
});

describe('marking mentions read', () => {
  it('counts only the caller\'s own, and changes no one else\'s', async () => {
    const { scoped, data } = open();
    expect(await scoped.markMentionsRead(['mn-1', 'mn-2', 'mn-5', 'nope'])).toBe(1);
    const read = (id: string) => data.mentions.find((m) => m.id === id)?.read;
    expect([read('mn-1'), read('mn-2'), read('mn-5')]).toEqual([true, false, false]);
  });
});

describe('who has read a channel', () => {
  it('is everyone in an ordinary channel', async () => {
    expect((await open().scoped.getChannelReadStatus(OPEN)).map((r) => r.agent_name)).toEqual([ME, BOB]);
  });

  it('is only the caller in #direct-messages', async () => {
    expect((await open().scoped.getChannelReadStatus(DM)).map((r) => r.agent_name)).toEqual([ME]);
  });
});
