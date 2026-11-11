/**
 * The board, the channel directory and the work check are each answered by one
 * database function (migration 00039) instead of a query per channel or per
 * list. The rules those functions apply live in SQL and are checked against a
 * real database; what is pinned here is the adapter's side: that it makes ONE
 * request, passes the caller's identity and nothing else, and hands back
 * exactly the objects the API has always returned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter, BOARD_UNREAD_CAP, resetAdapterCaches, isChannelArchivedError } from '../supabase-adapter.js';
import { DIRECT_MESSAGES_CHANNEL } from '../constants.js';
import { STARTER_PATTERNS } from '../safety/patterns.js';

const ME = 'agent-me';
const agent = { agentId: ME, agentName: 'macbook-me', machineId: 'm-1' };

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

/** A client that answers function calls and records every request it gets. */
function rpcClient(answer: (fn: string, args: Record<string, unknown>) => RpcResult) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const tableCalls: string[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return answer(fn, args);
    },
    from: (table: string) => {
      tableCalls.push(table);
      throw new Error(`unexpected query on ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls, tableCalls };
}

const boardRow = (extra: Record<string, unknown> = {}) => ({
  ord: 1,
  channel: 'general',
  type: 'global',
  federation_scope: 'local',
  unread: 3,
  joined: true,
  latest_id: 'm-1',
  latest_content: 'hello',
  latest_content_units: 5,
  latest_created_at: '2026-01-01T00:00:00+00:00',
  latest_author_agent_id: 'agent-alice',
  latest_author_name: 'alice',
  ...extra,
});

beforeEach(() => resetAdapterCaches());

describe('getBoardSummary', () => {
  it('asks the database once, whatever the number of channels', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => boardRow({ ord: i + 1, channel: `ch-${i}` }));
    const { client, rpcCalls, tableCalls } = rpcClient(() => ({ data: rows, error: null }));

    const board = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();

    expect(board).toHaveLength(40);
    expect(rpcCalls).toEqual([{ fn: 'board_summary', args: { p_agent_id: ME, p_see_all_dms: false } }]);
    expect(tableCalls).toEqual([]);
  });

  it('returns the same object the board has always returned, field for field', async () => {
    const { client } = rpcClient(() => ({ data: [boardRow()], error: null }));
    const [row] = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();

    expect(row).toEqual({
      channel: 'general',
      type: 'global',
      federation_scope: 'local',
      unread: 3,
      joined: true,
      latest: {
        id: 'm-1',
        content: 'hello',
        created_at: '2026-01-01T00:00:00+00:00',
        author_agent_id: 'agent-alice',
        agents: { name: 'alice' },
      },
    });
    expect(Object.keys(row)).toEqual(['channel', 'type', 'federation_scope', 'unread', 'joined', 'latest']);
    expect(Object.keys(row.latest!)).toEqual(['id', 'content', 'created_at', 'author_agent_id', 'agents']);
  });

  it('reports a channel with nothing visible as latest: null', async () => {
    const { client } = rpcClient(() => ({
      data: [boardRow({
        channel: DIRECT_MESSAGES_CHANNEL, unread: 0, latest_id: null, latest_content: null,
        latest_content_units: null, latest_created_at: null, latest_author_agent_id: null, latest_author_name: null,
      })],
      error: null,
    }));
    const [row] = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();
    expect(row.latest).toBeNull();
    expect(row.unread).toBe(0);
  });

  it('writes the truncation notice from the length the database reports', async () => {
    // The database sends only the first 300 characters and the full length.
    const { client } = rpcClient(() => ({
      data: [boardRow({ latest_content: 'y'.repeat(300), latest_content_units: 2000 })],
      error: null,
    }));
    const [row] = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();
    expect(row.latest!.content.startsWith('y'.repeat(300) + '…')).toBe(true);
    expect(row.latest!.content).toContain('[TRUNCATED — 1700 more chars');
  });

  it('cuts at 300 UTF-16 units, as it did when the whole text was fetched', async () => {
    // 290 letters then emoji: the database's 300 characters are 310 units, so
    // the adapter trims to the same 300 units a JavaScript slice gave before.
    const full = 'y'.repeat(290) + '😀'.repeat(20) + 'z'.repeat(100);
    const head = 'y'.repeat(290) + '😀'.repeat(10);
    const { client } = rpcClient(() => ({
      data: [boardRow({ latest_content: head, latest_content_units: full.length })],
      error: null,
    }));
    const [row] = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();
    const before = full.slice(0, 300) + `… [TRUNCATED — ${full.length - 300} more chars. Call read_messages with full=true for complete text]`;
    expect(row.latest!.content).toBe(before);
  });

  it('leaves a message of exactly 300 units alone', async () => {
    const { client } = rpcClient(() => ({
      data: [boardRow({ latest_content: 'y'.repeat(300), latest_content_units: 300 })],
      error: null,
    }));
    const [row] = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();
    expect(row.latest!.content).toBe('y'.repeat(300));
  });

  it('keeps unread a number when the count hit the cap', async () => {
    // 100 means "100 or more"; the field's type does not change.
    const { client } = rpcClient(() => ({ data: [boardRow({ unread: BOARD_UNREAD_CAP })], error: null }));
    const [row] = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();
    expect(BOARD_UNREAD_CAP).toBe(100);
    expect(row.unread).toBe(100);
    expect(typeof row.unread).toBe('number');
  });

  it('gives an author-less message agents: null rather than a name of null', async () => {
    const { client } = rpcClient(() => ({ data: [boardRow({ latest_author_name: null })], error: null }));
    const [row] = await new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary();
    expect(row.latest!.agents).toBeNull();
  });

  it('never asks to see all direct messages on behalf of an agent', async () => {
    const { client, rpcCalls } = rpcClient(() => ({ data: [], error: null }));
    await new SupabaseStorageAdapter(client)
      .forAgent({ ...agent, includeDirectMessages: true })
      .getBoardSummary();
    expect(rpcCalls[0].args.p_see_all_dms).toBe(false);
  });

  it('asks for all direct messages only for a read token issued with that access', async () => {
    const { client, rpcCalls } = rpcClient(() => ({ data: [], error: null }));
    await new SupabaseStorageAdapter(client)
      .forAgent({ ...agent, readOnly: true, includeDirectMessages: true })
      .getBoardSummary();
    expect(rpcCalls[0].args.p_see_all_dms).toBe(true);
  });

  it('fails rather than returning an empty board when the database errors', async () => {
    const { client } = rpcClient(() => ({ data: null, error: { code: '57014', message: 'statement timeout' } }));
    await expect(new SupabaseStorageAdapter(client).forAgent(agent).getBoardSummary())
      .rejects.toThrow(/Failed to fetch board summary/);
  });
});

describe('listAllChannels', () => {
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    id: `c-${name}`, name, type: 'project', federation_scope: 'local', description: null,
    created_at: '2026-01-01T00:00:00+00:00', joined: false, last_message_at: null, ...extra,
  });

  it('asks the database once for a full page', async () => {
    const channels = Array.from({ length: 200 }, (_, i) => entry(`ch-${String(i).padStart(3, '0')}`));
    const { client, rpcCalls, tableCalls } = rpcClient(() => ({ data: { total: 450, channels }, error: null }));

    const page = await new SupabaseStorageAdapter(client).forAgent(agent).listAllChannels({ limit: 200, offset: 200 });

    expect(rpcCalls).toEqual([{
      fn: 'channel_directory',
      args: { p_agent_id: ME, p_type: null, p_limit: 200, p_offset: 200 },
    }]);
    expect(tableCalls).toEqual([]);
    expect(page).toMatchObject({ total: 450, limit: 200, offset: 200 });
    expect(page.channels).toHaveLength(200);
  });

  it('passes the type filter and clamps the page', async () => {
    const { client, rpcCalls } = rpcClient(() => ({ data: { total: 0, channels: [] }, error: null }));
    const scoped = new SupabaseStorageAdapter(client).forAgent(agent);
    await scoped.listAllChannels({ type: 'global', limit: 5000, offset: -3 });
    expect(rpcCalls[0].args).toEqual({ p_agent_id: ME, p_type: 'global', p_limit: 200, p_offset: 0 });
  });

  it('returns only directory fields, whatever the function sends', async () => {
    const { client } = rpcClient(() => ({
      data: {
        total: 1,
        channels: [entry('a', { joined: true, last_message_at: '2026-02-01T00:00:00+00:00', metadata: { secret: 1 }, created_by: 'x' })],
      },
      error: null,
    }));
    const page = await new SupabaseStorageAdapter(client).forAgent(agent).listAllChannels();
    expect(page.channels[0]).toEqual({
      id: 'c-a', name: 'a', type: 'project', federation_scope: 'local', description: null,
      created_at: '2026-01-01T00:00:00+00:00', joined: true, last_message_at: '2026-02-01T00:00:00+00:00',
    });
  });

  it('keeps the total for a page past the end', async () => {
    const { client } = rpcClient(() => ({ data: { total: 45, channels: [] }, error: null }));
    const page = await new SupabaseStorageAdapter(client).forAgent(agent).listAllChannels({ offset: 100 });
    expect(page).toEqual({ channels: [], total: 45, limit: 100, offset: 100 });
  });

  it('fails loudly when the database errors', async () => {
    const { client } = rpcClient(() => ({ data: null, error: { code: '57014', message: 'boom' } }));
    await expect(new SupabaseStorageAdapter(client).forAgent(agent).listAllChannels())
      .rejects.toThrow(/Failed to list channels/);
  });
});

describe('getWork', () => {
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, channel_id: 'c-1', title: id, body: null, capability_tags: [], status: 'open',
    created_by: 'agent-alice', claimed_by: null, result: null, result_message_id: null,
    created_at: '2026-01-01T00:00:00+00:00', claimed_at: null, completed_at: null,
    channels: { name: 'general' }, ...extra,
  });

  it('gets mentions and all three task lists in one request', async () => {
    const { client, rpcCalls, tableCalls } = rpcClient(() => ({
      data: {
        mentions: [],
        open_matching: [task('t-open')],
        mine_claimed: [task('t-claimed', { status: 'claimed', claimed_by: ME })],
        completed_for_me: [task('t-done', { status: 'done', created_by: ME, completed_at: '2026-01-02T00:00:00+00:00' })],
      },
      error: null,
    }));

    const work = await new SupabaseStorageAdapter(client).forAgent(agent)
      .getWork(['code', 'review'], '2026-01-01T00:00:00.000Z');

    expect(rpcCalls).toEqual([{
      fn: 'agent_work',
      args: {
        p_agent_id: ME,
        p_capabilities: ['code', 'review'],
        p_completed_since: '2026-01-01T00:00:00.000Z',
        p_mention_limit: 20,
        p_task_limit: 50,
      },
    }]);
    expect(tableCalls).toEqual([]);
    expect(work.open_matching.map((t) => t.id)).toEqual(['t-open']);
    expect(work.mine_claimed.map((t) => t.id)).toEqual(['t-claimed']);
    expect(work.completed_for_me.map((t) => t.id)).toEqual(['t-done']);
    // Task objects are passed through untouched, channel name included.
    expect(work.open_matching[0]).toEqual(task('t-open'));
  });

  it('shapes a mention exactly as getMentions does', async () => {
    const { client } = rpcClient(() => ({
      data: {
        mentions: [{
          id: 'mn-1', message_id: 'm-1', read: false, created_at: '2026-01-01T00:00:00+00:00',
          channel_name: 'general', author_name: 'alice', content: '@me hi',
          metadata: { project: 'airchat', source: 'claude.ai' },
        }],
        open_matching: [], mine_claimed: [], completed_for_me: [],
      },
      error: null,
    }));
    const work = await new SupabaseStorageAdapter(client).forAgent(agent).getWork([], '2026-01-01T00:00:00.000Z');
    expect(work.mentions).toEqual([{
      mention_id: 'mn-1',
      message_id: 'm-1',
      channel_name: 'general',
      author_name: 'alice',
      author_project: 'airchat',
      author_source: 'claude.ai',
      content: '@me hi',
      created_at: '2026-01-01T00:00:00+00:00',
      is_read: false,
    }]);
  });

  it('does not vouch for a source on a federated channel, and names a missing author "unknown"', async () => {
    const { client } = rpcClient(() => ({
      data: {
        mentions: [{
          id: 'mn-1', message_id: 'm-1', read: false, created_at: '2026-01-01T00:00:00+00:00',
          channel_name: 'gossip-news', author_name: null, content: null, metadata: { source: 'claude.ai' },
        }],
      },
      error: null,
    }));
    const { mentions, open_matching } = await new SupabaseStorageAdapter(client).forAgent(agent)
      .getWork([], '2026-01-01T00:00:00.000Z');
    expect(mentions[0]).toMatchObject({ author_name: 'unknown', author_source: null, author_project: null, content: '' });
    expect(open_matching).toEqual([]);
  });

  it('fails when the database errors', async () => {
    const { client } = rpcClient(() => ({ data: null, error: { code: '57014', message: 'boom' } }));
    await expect(new SupabaseStorageAdapter(client).forAgent(agent).getWork([], '2026-01-01T00:00:00.000Z'))
      .rejects.toThrow(/Failed to check work/);
  });

  it('falls back to the four queries on a database without the function, comparing instants', async () => {
    // "…T12:00:00+00:00" and "…T12:00:00.000Z" are the same instant but sort
    // differently as text; the completed filter has to compare times.
    const done = [
      task('same-instant', { status: 'done', created_by: ME, completed_at: '2026-01-01T12:00:00+00:00' }),
      task('later', { status: 'done', created_by: ME, completed_at: '2026-01-01T12:00:01+00:00' }),
      task('never', { status: 'done', created_by: ME, completed_at: null }),
    ];
    const tables: string[] = [];
    const chain = (rows: unknown[]) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'or', 'contains', 'order', 'limit']) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows, error: null }));
      return q;
    };
    const client = {
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }),
      from: (table: string) => { tables.push(table); return chain(table === 'tasks' ? done : []); },
    } as unknown as SupabaseClient;

    const work = await new SupabaseStorageAdapter(client).forAgent(agent).getWork([], '2026-01-01T12:00:00.000Z');

    expect(tables.sort()).toEqual(['mentions', 'tasks', 'tasks', 'tasks']);
    expect(work.completed_for_me.map((t) => t.id)).toEqual(['later']);
  });
});

// ── Read and send paths ──────────────────────────────────────────────────────

type Call = { table: string; op: string; args: unknown[] };

/** A recording query builder: every method chains; awaiting resolves `rows`. */
function recordingClient(rowsFor: (table: string, calls: Call[]) => unknown[]) {
  const calls: Call[] = [];
  const client = {
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }),
    from: (table: string) => {
      const mine: Call[] = [];
      const q: Record<string, unknown> = {};
      for (const op of ['select', 'insert', 'upsert', 'update', 'eq', 'neq', 'in', 'is', 'lt', 'gt', 'order', 'limit']) {
        q[op] = (...args: unknown[]) => {
          const call = { table, op, args };
          calls.push(call);
          mine.push(call);
          return q;
        };
      }
      const rows = () => rowsFor(table, mine);
      q.single = async () => ({ data: rows()[0] ?? null, error: null });
      q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows(), error: null }));
      return q;
    },
  } as unknown as SupabaseClient;
  /** How many requests reached `table` (one per select/insert/upsert/update). */
  const requests = (table: string) =>
    calls.filter((c) => c.table === table && ['select', 'insert', 'upsert', 'update'].includes(c.op)
      // insert(...).select(...) is one request, not two.
      && !(c.op === 'select' && calls[calls.indexOf(c) - 1]?.table === table && calls[calls.indexOf(c) - 1]?.op === 'insert'))
      .length;
  return { client, calls, requests };
}

describe('reading a channel', () => {
  afterEach(() => vi.useRealTimers());

  const GENERAL = { id: 'c-general', name: 'general', federation_scope: 'local' };

  it('looks the channel up and joins once, not on every read', async () => {
    const { client, requests } = recordingClient((table) => (table === 'channels' ? [GENERAL] : []));
    const adapter = new SupabaseStorageAdapter(client);

    for (let i = 0; i < 5; i++) {
      // A new scoped adapter per request, as the API builds them.
      const scoped = adapter.forAgent(agent);
      const channel = await scoped.findChannelByName('general');
      await scoped.getMessages(channel!.id, 20);
    }

    expect(requests('channels')).toBe(1);
    expect(requests('channel_memberships')).toBe(1);
    expect(requests('messages')).toBe(5);
  });

  it('looks the channel up again after 30 seconds, so a rename or archive is noticed', async () => {
    vi.useFakeTimers();
    const { client, requests } = recordingClient((table) => (table === 'channels' ? [GENERAL] : []));
    const adapter = new SupabaseStorageAdapter(client);

    await adapter.forAgent(agent).findChannelByName('general');
    vi.advanceTimersByTime(29_000);
    await adapter.forAgent(agent).findChannelByName('general');
    expect(requests('channels')).toBe(1);

    vi.advanceTimersByTime(2_000);
    await adapter.forAgent(agent).findChannelByName('general');
    expect(requests('channels')).toBe(2);
  });

  it('confirms the membership again after 10 minutes', async () => {
    vi.useFakeTimers();
    const { client, requests } = recordingClient(() => []);
    const adapter = new SupabaseStorageAdapter(client);

    await adapter.forAgent(agent).ensureChannelMembership('c-1');
    vi.advanceTimersByTime(9 * 60_000);
    await adapter.forAgent(agent).ensureChannelMembership('c-1');
    expect(requests('channel_memberships')).toBe(1);

    vi.advanceTimersByTime(61_000);
    await adapter.forAgent(agent).ensureChannelMembership('c-1');
    expect(requests('channel_memberships')).toBe(2);
  });

  it('remembers memberships per agent and per channel', async () => {
    const { client, requests } = recordingClient(() => []);
    const adapter = new SupabaseStorageAdapter(client);
    await adapter.forAgent(agent).ensureChannelMembership('c-1');
    await adapter.forAgent(agent).ensureChannelMembership('c-2');
    await adapter.forAgent({ ...agent, agentId: 'agent-other' }).ensureChannelMembership('c-1');
    expect(requests('channel_memberships')).toBe(3);
  });

  it('does not remember a membership whose write failed', async () => {
    const upsert = vi.fn()
      .mockResolvedValueOnce({ error: { message: 'boom' } })
      .mockResolvedValue({ error: null });
    const client = { from: () => ({ upsert }) } as unknown as SupabaseClient;
    const adapter = new SupabaseStorageAdapter(client);
    await expect(adapter.forAgent(agent).ensureChannelMembership('c-1')).rejects.toThrow(/membership/);
    await adapter.forAgent(agent).ensureChannelMembership('c-1');
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('does not cache a channel that does not exist, so one created a moment later is found', async () => {
    let exists = false;
    const { client } = recordingClient((table) => (table === 'channels' && exists ? [GENERAL] : []));
    const adapter = new SupabaseStorageAdapter(client);
    expect(await adapter.forAgent(agent).findChannelByName('general')).toBeNull();
    exists = true;
    expect((await adapter.forAgent(agent).findChannelByName('general'))?.id).toBe('c-general');
  });

  it('applies the direct-message rule from the name it already resolved, without another lookup', async () => {
    const DM = { id: 'c-dm', name: DIRECT_MESSAGES_CHANNEL, federation_scope: 'local' };
    const { client, calls, requests } = recordingClient((table) => (table === 'channels' ? [DM] : []));
    const scoped = new SupabaseStorageAdapter(client).forAgent(agent);

    const channel = await scoped.findChannelByName(DIRECT_MESSAGES_CHANNEL);
    await scoped.getMessages(channel!.id, 20);

    // One lookup (by name); the read itself asks only for this agent's DMs.
    expect(requests('channels')).toBe(1);
    const authorFilters = calls.filter((c) => c.table === 'messages' && c.op === 'eq' && c.args[0] === 'author_agent_id');
    expect(authorFilters.map((c) => c.args[1])).toEqual([ME]);
    expect(calls.some((c) => c.table === 'mentions' && c.op === 'eq' && c.args[0] === 'mentioned_agent_id' && c.args[1] === ME)).toBe(true);
  });

  it('still recognises #direct-messages by id when the channel was not resolved by name', async () => {
    const DM = { id: 'c-dm', name: DIRECT_MESSAGES_CHANNEL };
    const { client, calls } = recordingClient((table) => (table === 'channels' ? [DM] : []));
    await new SupabaseStorageAdapter(client).forAgent(agent).getMessages('c-dm', 20);
    expect(calls.some((c) => c.table === 'messages' && c.op === 'eq' && c.args[0] === 'author_agent_id')).toBe(true);
  });
});

describe('sending a message', () => {
  const SENT = { id: 'm-1', channel_id: 'c-general', author_agent_id: ME, content: 'hi', created_at: '2026-01-01T00:00:00+00:00' };

  it('takes three requests: find the channel, insert, mark the membership', async () => {
    const { client, calls, requests } = recordingClient((table) =>
      table === 'channels' ? [{ id: 'c-general', federation_scope: 'local' }] : table === 'messages' ? [SENT] : []);

    const message = await new SupabaseStorageAdapter(client).forAgent(agent).sendMessage('general', 'hi');

    expect(message.id).toBe('m-1');
    expect(requests('channels')).toBe(1);
    expect(requests('messages')).toBe(1);
    expect(requests('channel_memberships')).toBe(1);
    expect(calls.filter((c) => ['select', 'insert', 'upsert', 'update'].includes(c.op)
      && !(c.op === 'select' && c.table === 'messages')).length).toBe(3);
  });

  it('reads the federation scope in the first lookup', async () => {
    const { client, calls } = recordingClient((table) =>
      table === 'channels' ? [{ id: 'c-general', federation_scope: 'local' }] : table === 'messages' ? [SENT] : []);
    await new SupabaseStorageAdapter(client).forAgent(agent).sendMessage('general', 'hi');
    const lookup = calls.find((c) => c.table === 'channels' && c.op === 'select');
    expect(lookup?.args[0]).toBe('id, federation_scope, archived');
  });

  it('refuses an archived channel in that same lookup, before writing anything', async () => {
    const { client, calls } = recordingClient((table) =>
      table === 'channels' ? [{ id: 'c-old', federation_scope: 'local', archived: true }] : []);
    const scoped = new SupabaseStorageAdapter(client).forAgent(agent);
    await expect(scoped.sendMessage('old-project', 'hi')).rejects.toSatisfy(isChannelArchivedError);
    await expect(scoped.resolveOrCreateChannel('old-project')).rejects.toSatisfy(isChannelArchivedError);
    expect(calls.some((c) => ['insert', 'upsert', 'update'].includes(c.op))).toBe(false);
  });

  it('does not return the search vector, classification or safety labels', async () => {
    const { client, calls } = recordingClient((table) =>
      table === 'channels' ? [{ id: 'c-general', federation_scope: 'local' }] : table === 'messages' ? [SENT] : []);
    await new SupabaseStorageAdapter(client).forAgent(agent).sendMessage('general', 'hi');

    const returning = String(calls.find((c) => c.table === 'messages' && c.op === 'select')?.args[0]);
    expect(returning).not.toBe('*');
    for (const column of ['content_tsv', 'classification', 'safety_labels']) {
      expect(returning).not.toContain(column);
    }
    for (const column of ['id', 'channel_id', 'author_agent_id', 'content', 'metadata', 'parent_message_id', 'created_at']) {
      expect(returning).toContain(column);
    }
  });

  it('creates the membership if missing and moves last_read_at in one write', async () => {
    const { client, calls } = recordingClient((table) =>
      table === 'channels' ? [{ id: 'c-general', federation_scope: 'local' }] : table === 'messages' ? [SENT] : []);
    await new SupabaseStorageAdapter(client).forAgent(agent).sendMessage('general', 'hi');

    const write = calls.find((c) => c.table === 'channel_memberships' && c.op === 'upsert')!;
    expect(write.args[0]).toMatchObject({ agent_id: ME, channel_id: 'c-general' });
    expect(typeof (write.args[0] as { last_read_at: unknown }).last_read_at).toBe('string');
    // No ignoreDuplicates: an existing row must be updated, not skipped.
    expect(write.args[1]).toEqual({ onConflict: 'agent_id,channel_id' });
  });

  it('classifies a federated channel using the scope from that first lookup', async () => {
    const { client, calls, requests } = recordingClient((table) =>
      table === 'channels' ? [{ id: 'c-gossip', federation_scope: 'global' }] : table === 'messages' ? [SENT] : []);
    const adapter = new SupabaseStorageAdapter(client);
    adapter.setPatternSet(STARTER_PATTERNS);

    await adapter.forAgent(agent).sendMessage('gossip-news', 'hello');

    expect(requests('channels')).toBe(1);
    const inserted = calls.find((c) => c.table === 'messages' && c.op === 'insert')!.args[0] as Record<string, unknown>;
    // A classification object is only built for a federated channel.
    expect(inserted.classification).not.toBeNull();
  });

  it('does not classify a local channel', async () => {
    const { client, calls } = recordingClient((table) =>
      table === 'channels' ? [{ id: 'c-general', federation_scope: 'local' }] : table === 'messages' ? [SENT] : []);
    const adapter = new SupabaseStorageAdapter(client);
    adapter.setPatternSet(STARTER_PATTERNS);
    await adapter.forAgent(agent).sendMessage('general', 'hello');
    const inserted = calls.find((c) => c.table === 'messages' && c.op === 'insert')!.args[0] as Record<string, unknown>;
    expect(inserted.classification).toBeNull();
  });
});
