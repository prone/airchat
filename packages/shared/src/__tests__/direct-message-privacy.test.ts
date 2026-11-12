/**
 * #direct-messages is a single shared channel holding every agent's private
 * conversations, and the rest of the system deliberately lets any agent read
 * any channel. These tests pin the one exception: an agent may only see DMs it
 * sent or was addressed in.
 *
 * The regression they exist for was real — a read-scoped connector token,
 * seconds old, read DMs between two unrelated agents.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';
import { DIRECT_MESSAGES_CHANNEL } from '../constants.js';

const ME = 'agent-me';
const ALICE = 'agent-alice';
const BOB = 'agent-bob';

const DM_CHANNEL_ID = 'chan-dm';
const OPEN_CHANNEL_ID = 'chan-open';

type Row = Record<string, unknown>;

interface Recorded {
  table: string;
  filters: Record<string, unknown>;
  inValues?: unknown[];
  lt?: unknown;
  gt?: unknown;
  ascending?: boolean;
  limit?: number;
}

/**
 * Minimal stand-in for the Supabase query builder: every method returns the
 * builder, and awaiting it resolves whatever `resolve` makes of the calls that
 * were recorded. Enough for the read paths under test, and nothing more.
 */
function makeClient(
  rows: Record<string, Row[]>,
  seen: Recorded[],
  rpcRows: Row[] = []
): SupabaseClient {
  function builder(table: string) {
    const record: Recorded = { table, filters: {} };
    seen.push(record);

    const result = () => {
      let out = rows[table] ?? [];
      for (const [col, val] of Object.entries(record.filters)) {
        out = out.filter((r) => r[col] === val);
      }
      if (record.inValues) {
        const allowed = new Set(record.inValues);
        // Every `.in()` in the code under test filters on a message id.
        const col = table === 'mentions' ? 'message_id' : 'id';
        out = out.filter((r) => allowed.has(r[col]));
      }
      // Window, order and limit on created_at — the read paths under test
      // depend on them, so the stand-in has to honour them.
      const at = (r: Row) => String(r.created_at ?? '');
      if (record.lt !== undefined) out = out.filter((r) => at(r) < String(record.lt));
      if (record.gt !== undefined) out = out.filter((r) => at(r) > String(record.gt));
      if (record.ascending !== undefined) {
        const dir = record.ascending ? 1 : -1;
        out = [...out].sort((a, b) => dir * at(a).localeCompare(at(b)));
      }
      if (record.limit !== undefined) out = out.slice(0, record.limit);
      return out;
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      order: (_col: string, opts?: { ascending?: boolean }) => {
        record.ascending = opts?.ascending ?? true;
        return chain;
      },
      limit: (n: number) => {
        record.limit = n;
        return chain;
      },
      lt: (_col: string, val: unknown) => {
        record.lt = val;
        return chain;
      },
      gt: (_col: string, val: unknown) => {
        record.gt = val;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        record.filters[col] = val;
        return chain;
      },
      in: (_col: string, vals: unknown[]) => {
        record.inValues = vals;
        return chain;
      },
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      single: async () => ({ data: result()[0] ?? null, error: null }),
      then: (
        resolve: (v: { data: Row[]; error: null; count: number }) => unknown
      ) => {
        const data = result();
        return Promise.resolve(resolve({ data, error: null, count: data.length }));
      },
    };
    return chain;
  }

  return {
    from: (table: string) => builder(table),
    // Only search is answered here. Every other function is reported missing,
    // so the board and friends run their query-by-query fallback, which is
    // what this stand-in models.
    rpc: async (fn: string) =>
      fn === 'search_messages'
        ? { data: rpcRows, error: null }
        : { data: null, error: { code: 'PGRST202', message: 'function not found' } },
  } as unknown as SupabaseClient;
}

function scopedAdapter(client: SupabaseClient) {
  return new SupabaseStorageAdapter(client).forAgent({
    agentId: ME,
    agentName: 'macbook-me',
    machineId: 'machine-1',
  });
}

/** Three DMs: one I sent, one sent to me, one between two other agents. */
const DM_ROWS: Row[] = [
  { id: 'dm-mine', channel_id: DM_CHANNEL_ID, author_agent_id: ME, content: '@alice mine', quarantined: false },
  { id: 'dm-to-me', channel_id: DM_CHANNEL_ID, author_agent_id: ALICE, content: '@me for me', quarantined: false },
  { id: 'dm-theirs', channel_id: DM_CHANNEL_ID, author_agent_id: ALICE, content: '@bob private', quarantined: false },
];

const CHANNELS: Row[] = [
  { id: DM_CHANNEL_ID, name: DIRECT_MESSAGES_CHANNEL },
  { id: OPEN_CHANNEL_ID, name: 'general' },
];

/** Only `dm-to-me` was addressed to this agent. */
const MENTIONS: Row[] = [
  { message_id: 'dm-to-me', mentioned_agent_id: ME, channel_id: DM_CHANNEL_ID },
  { message_id: 'dm-theirs', mentioned_agent_id: BOB, channel_id: DM_CHANNEL_ID },
];

describe('direct message privacy', () => {
  it('hides DMs between other agents from getMessages', async () => {
    const seen: Recorded[] = [];
    const adapter = scopedAdapter(
      makeClient({ messages: DM_ROWS, channels: CHANNELS, mentions: MENTIONS }, seen)
    );

    const got = await adapter.getMessages(DM_CHANNEL_ID, 50);
    const ids = got.map((m) => m.id);

    expect(ids).toContain('dm-mine');
    expect(ids).toContain('dm-to-me');
    expect(ids).not.toContain('dm-theirs');
  });

  it('leaves other channels untouched and does not query mentions for them', async () => {
    const open: Row[] = [
      { id: 'm1', channel_id: OPEN_CHANNEL_ID, author_agent_id: ALICE, content: 'hello', quarantined: false },
      { id: 'm2', channel_id: OPEN_CHANNEL_ID, author_agent_id: BOB, content: 'hi', quarantined: false },
    ];
    const seen: Recorded[] = [];
    const adapter = scopedAdapter(
      makeClient({ messages: open, channels: CHANNELS, mentions: MENTIONS }, seen)
    );

    const got = await adapter.getMessages(OPEN_CHANNEL_ID, 50);

    expect(got.map((m) => m.id)).toEqual(['m2', 'm1']);
    // The filter must cost nothing on the common path.
    expect(seen.some((s) => s.table === 'mentions')).toBe(false);
  });

  it('drops foreign DMs from search results but keeps public hits', async () => {
    const hits: Row[] = [
      {
        id: 'dm-theirs',
        channel_id: DM_CHANNEL_ID,
        channel_name: DIRECT_MESSAGES_CHANNEL,
        author_agent_id: ALICE,
        content: '@bob private',
      },
      {
        id: 'dm-to-me',
        channel_id: DM_CHANNEL_ID,
        channel_name: DIRECT_MESSAGES_CHANNEL,
        author_agent_id: ALICE,
        content: '@me for me',
      },
      {
        id: 'public',
        channel_id: OPEN_CHANNEL_ID,
        channel_name: 'general',
        author_agent_id: BOB,
        content: 'public hit',
      },
    ];
    const seen: Recorded[] = [];
    const adapter = scopedAdapter(
      makeClient({ channels: CHANNELS, mentions: MENTIONS }, seen, hits)
    );

    const ids = (await adapter.searchMessages('private')).map((r) => r.id);

    expect(ids).toEqual(['dm-to-me', 'public']);
    expect(ids).not.toContain('dm-theirs');
  });

  it('never shows a foreign DM as the board preview', async () => {
    // Newest first, as the real query orders them: the most recent DM belongs
    // to two other agents, so an unfiltered preview would show exactly it.
    const newestIsForeign: Row[] = [
      DM_ROWS.find((r) => r.id === 'dm-theirs')!,
      DM_ROWS.find((r) => r.id === 'dm-to-me')!,
    ];
    const seen: Recorded[] = [];
    const adapter = scopedAdapter(
      makeClient(
        {
          messages: newestIsForeign,
          channels: CHANNELS,
          mentions: MENTIONS,
          channel_memberships: [
            {
              agent_id: ME,
              channel_id: DM_CHANNEL_ID,
              channels: { id: DM_CHANNEL_ID, name: DIRECT_MESSAGES_CHANNEL, type: 'public' },
            },
          ],
        },
        seen
      )
    );

    const board = await adapter.getBoardSummary();
    const dm = board.find((c) => c.channel === DIRECT_MESSAGES_CHANNEL);

    expect(dm?.latest?.content).not.toBe('@bob private');
    expect(dm?.latest?.content).toBe('@me for me');
  });

  // ── Reading your own DMs on a busy board ─────────────────────────────────
  //
  // The filter used to run AFTER the limit: fetch the newest N rows of the
  // whole channel, then drop other agents'. With many agents talking, the
  // caller's own DMs were rarely among everyone's newest N, so reading
  // #direct-messages returned little or nothing.

  const stamp = (n: number) => `2026-01-01T00:${String(n).padStart(2, '0')}:00Z`;

  /** Two DMs of mine, then 40 newer ones between Alice and Bob. */
  function busyBoard() {
    const messages: Row[] = [
      { id: 'old-mine', channel_id: DM_CHANNEL_ID, author_agent_id: ME, content: '@alice q', quarantined: false, created_at: stamp(1) },
      { id: 'old-to-me', channel_id: DM_CHANNEL_ID, author_agent_id: ALICE, content: '@me a', quarantined: false, created_at: stamp(2) },
    ];
    const mentions: Row[] = [
      { message_id: 'old-to-me', mentioned_agent_id: ME, channel_id: DM_CHANNEL_ID, created_at: stamp(2) },
    ];
    for (let i = 0; i < 40; i++) {
      messages.push({
        id: `theirs-${i}`, channel_id: DM_CHANNEL_ID, author_agent_id: ALICE,
        content: '@bob chatter', quarantined: false, created_at: stamp(10 + i),
      });
      mentions.push({ message_id: `theirs-${i}`, mentioned_agent_id: BOB, channel_id: DM_CHANNEL_ID, created_at: stamp(10 + i) });
    }
    return { messages, channels: CHANNELS, mentions };
  }

  it('returns my DMs even when the newest rows all belong to other agents', async () => {
    const adapter = scopedAdapter(makeClient(busyBoard(), []));

    const got = await adapter.getMessages(DM_CHANNEL_ID, 20);

    expect(got.map((m) => m.id)).toEqual(['old-mine', 'old-to-me']);
  });

  it('pages backward through my DMs with before', async () => {
    const adapter = scopedAdapter(makeClient(busyBoard(), []));

    const got = await adapter.getMessages(DM_CHANNEL_ID, 20, stamp(2));

    expect(got.map((m) => m.id)).toEqual(['old-mine']);
  });

  it('keeps a quarantined DM out', async () => {
    const board = busyBoard();
    board.messages[1].quarantined = true;
    const adapter = scopedAdapter(makeClient(board, []));

    const got = await adapter.getMessages(DM_CHANNEL_ID, 20);

    expect(got.map((m) => m.id)).toEqual(['old-mine']);
  });

  // ── Reading forward with `after` ─────────────────────────────────────────

  const TIMELINE: Row[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `m${n}`, channel_id: OPEN_CHANNEL_ID, author_agent_id: ALICE,
    content: `message ${n}`, quarantined: false, created_at: stamp(n),
  }));

  it('without after, returns the newest messages in chronological order', async () => {
    const adapter = scopedAdapter(makeClient({ messages: TIMELINE, channels: CHANNELS }, []));

    const got = await adapter.getMessages(OPEN_CHANNEL_ID, 2);

    expect(got.map((m) => m.id)).toEqual(['m4', 'm5']);
  });

  it('with after, returns the OLDEST messages past that point, in order', async () => {
    const adapter = scopedAdapter(makeClient({ messages: TIMELINE, channels: CHANNELS }, []));

    const got = await adapter.getMessages(OPEN_CHANNEL_ID, 2, undefined, stamp(1));

    // Not m4, m5: a reader catching up must not skip m2 and m3.
    expect(got.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('reads my DMs forward with after', async () => {
    const adapter = scopedAdapter(makeClient(busyBoard(), []));

    const got = await adapter.getMessages(DM_CHANNEL_ID, 20, undefined, stamp(1));

    expect(got.map((m) => m.id)).toEqual(['old-to-me']);
  });
});
