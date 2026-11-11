import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SupabaseGossipAdapter,
  remoteAgentName,
  stripReservedFederatedMetadata,
} from '../supabase-gossip-adapter.js';

/**
 * What the gossip storage layer refuses to do on another instance's word:
 * attribute a message to an agent that is not that instance's, keep metadata
 * only this server may assign, or quarantine a message written here.
 */

const ORIGIN = 'a1b2c3d4e5f60718';
const OTHER_ORIGIN = '0123456789abcdef';

// ── A small in-memory stand-in for the Supabase client ──────────────────────

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let nextId = 1;
/** When set, the next agents insert fails as if another request won the race. */
let failNextAgentInsert: Row | null = null;

function fakeClient(): SupabaseClient {
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const filters: Array<(row: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};

    const run = () => {
      if (op === 'insert') {
        if (table === 'agents' && failNextAgentInsert) {
          rows.push(failNextAgentInsert);
          failNextAgentInsert = null;
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { id: `${table}-${nextId++}`, ...payload };
        rows.push(row);
        return { data: [row], error: null };
      }
      const matched = rows.filter((row) => filters.every((f) => f(row)));
      if (op === 'update') matched.forEach((row) => Object.assign(row, payload));
      return { data: matched, error: null };
    };
    const one = () => {
      const { data, error } = run();
      return { data: data?.[0] ?? null, error };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (row: Row) => { op = 'insert'; payload = row; return builder; },
      update: (patch: Row) => { op = 'update'; payload = patch; return builder; },
      eq: (col: string, value: unknown) => { filters.push((row) => row[col] === value); return builder; },
      in: (col: string, values: unknown[]) => { filters.push((row) => values.includes(row[col])); return builder; },
      not: (col: string, operator: string, value: unknown) => {
        if (operator !== 'is' || value !== null) throw new Error('unsupported filter in fake');
        filters.push((row) => row[col] != null);
        return builder;
      },
      single: async () => one(),
      maybeSingle: async () => one(),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

let adapter: SupabaseGossipAdapter;

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  nextId = 1;
  failNextAgentInsert = null;
  adapter = new SupabaseGossipAdapter(fakeClient());
});

describe('remoteAgentName', () => {
  it('appends the origin fingerprint to the author', () => {
    expect(remoteAgentName('build-bot', ORIGIN)).toBe(`build-bot-at-${ORIGIN}`);
  });

  it('always ends in the full origin, however long the author is', () => {
    for (const author of ['a', 'a'.repeat(40), 'a'.repeat(60), `nas-agent${'-'.repeat(51)}`, 'x@y@z@w']) {
      const name = remoteAgentName(author, ORIGIN)!;
      expect(name.endsWith(`-at-${ORIGIN}`)).toBe(true);
      // Fits the agents.name rule: lowercase letters, digits, hyphens, max 100.
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,99}$/);
      expect(name.length).toBeLessThanOrEqual(60);
    }
  });

  it('can never produce a bare local-style name', () => {
    // The old scheme cut `${author}@${origin}` to 100 characters, so an author
    // padded to 100 came out as just the author.
    const padded = `nas-agent${'-'.repeat(51)}`;
    expect(remoteAgentName(padded, ORIGIN)).toBe(`nas-agent-at-${ORIGIN}`);
    expect(remoteAgentName(`nas-agent${'-'.repeat(91)}`, ORIGIN)).toBeNull();
  });

  it('gives the same author on two instances two different names', () => {
    expect(remoteAgentName('build-bot', ORIGIN)).not.toBe(remoteAgentName('build-bot', OTHER_ORIGIN));
  });

  it.each([
    ['too long', 'a'.repeat(61)],
    ['empty', ''],
    ['with a space', 'a b'],
    ['with a newline', 'a\nb'],
    ['with a slash', 'a/b'],
    ['with a non-ASCII letter', 'bót'],
    ['starting with a hyphen', '-a'],
    ['not a string', 42],
    ['null', null],
  ])('refuses an author that is %s', (_label, author) => {
    expect(remoteAgentName(author, ORIGIN)).toBeNull();
  });

  it.each([
    ['shortened', ORIGIN.slice(0, 8)],
    ['uppercase', ORIGIN.toUpperCase()],
    ['not hex', 'zzzzzzzzzzzzzzzz'],
    ['missing', null],
  ])('refuses an origin fingerprint that is %s', (_label, origin) => {
    expect(remoteAgentName('build-bot', origin)).toBeNull();
  });
});

describe('findOrCreateRemoteAgent', () => {
  const name = `nas-agent-at-${ORIGIN}`;

  it('creates a placeholder marked as remote, with its origin', async () => {
    const id = await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN);
    expect(id).toBeTruthy();
    expect(tables.agents).toHaveLength(1);
    expect(tables.agents[0]).toMatchObject({
      name,
      metadata: { remote: true, origin_instance: ORIGIN, original_name: 'nas-agent' },
    });
  });

  it('reuses its own placeholder', async () => {
    const first = await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN);
    const second = await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN);
    expect(second).toBe(first);
    expect(tables.agents).toHaveLength(1);
  });

  it('never resolves to an agent registered on this instance', async () => {
    // A local agent may be called anything, including this.
    tables.agents = [{ id: 'local-1', name, metadata: { card: { model: 'x' } } }];
    expect(await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN)).toBeNull();
    expect(tables.agents).toHaveLength(1);
  });

  it('never resolves to a local agent that has no metadata at all', async () => {
    tables.agents = [{ id: 'local-1', name, metadata: null }];
    expect(await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN)).toBeNull();
  });

  it("never resolves to another origin's placeholder", async () => {
    tables.agents = [{ id: 'remote-other', name, metadata: { remote: true, origin_instance: OTHER_ORIGIN } }];
    expect(await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN)).toBeNull();
  });

  it('does not create or look up anything for an unacceptable author', async () => {
    tables.agents = [{ id: 'local-1', name: 'nas-agent', metadata: null }];
    expect(await adapter.findOrCreateRemoteAgent(`nas-agent${'-'.repeat(91)}`, ORIGIN, ORIGIN)).toBeNull();
    expect(await adapter.findOrCreateRemoteAgent('nas agent', ORIGIN, ORIGIN)).toBeNull();
    expect(tables.agents).toHaveLength(1);
  });

  it('falls back to the delivering peer as origin when none is given', async () => {
    await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, null);
    expect(tables.agents[0].name).toBe(name);
  });

  it('applies the same checks when another request creates the row first', async () => {
    failNextAgentInsert = { id: 'raced-remote', name, metadata: { remote: true, origin_instance: ORIGIN } };
    expect(await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN)).toBe('raced-remote');

    tables.agents = [];
    failNextAgentInsert = { id: 'raced-local', name, metadata: {} };
    expect(await adapter.findOrCreateRemoteAgent('nas-agent', ORIGIN, ORIGIN)).toBeNull();
  });
});

describe('metadata on federated messages', () => {
  it('loses the keys only this server may assign', () => {
    expect(stripReservedFederatedMetadata({
      source: 'dashboard',
      user_email: 'admin@example.com',
      files: [{ path: 'x', bucket: 'y' }],
      project: 'kept',
    })).toEqual({ project: 'kept' });
  });

  it.each([null, undefined, 'text', 7, ['source']])('becomes null when it is %j', (value) => {
    expect(stripReservedFederatedMetadata(value as never)).toBeNull();
  });

  it('is stripped by insertFederatedMessage itself, whatever the caller passed', async () => {
    await adapter.insertFederatedMessage({
      id: 'm-1',
      channel_id: 'c-1',
      author_agent_id: 'a-1',
      content: 'hi',
      metadata: { source: 'dashboard', user_email: 'x@example.com', topic: 'kept' },
      safety_labels: [],
      quarantined: false,
      classification: null,
      origin_instance: ORIGIN,
      author_display: 'nas-agent',
      hop_count: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(tables.messages[0].metadata).toEqual({ topic: 'kept' });
  });
});

describe('quarantineFederatedMessage', () => {
  it('quarantines a message that arrived over federation, keeping its labels', async () => {
    tables.messages = [{ id: 'm-1', origin_instance: ORIGIN, quarantined: false, safety_labels: ['references-tools'] }];
    expect(await adapter.quarantineFederatedMessage('m-1')).toBe(true);
    expect(tables.messages[0]).toMatchObject({ quarantined: true, safety_labels: ['references-tools', 'quarantined'] });
  });

  it('leaves a message written on this instance alone', async () => {
    tables.messages = [{ id: 'm-1', origin_instance: null, quarantined: false, safety_labels: [] }];
    expect(await adapter.quarantineFederatedMessage('m-1')).toBe(false);
    expect(tables.messages[0].quarantined).toBe(false);
  });

  it('reports false for a message that does not exist', async () => {
    expect(await adapter.quarantineFederatedMessage('nope')).toBe(false);
  });
});

describe('getMessageOrigins', () => {
  it('returns the recorded origin for the ids that have one', async () => {
    tables.gossip_message_origins = [
      { message_id: 'm-1', origin_instance_fingerprint: ORIGIN, peer_id: 'p-1' },
      { message_id: 'm-2', origin_instance_fingerprint: OTHER_ORIGIN, peer_id: null },
    ];
    const origins = await adapter.getMessageOrigins(['m-1', 'm-3']);
    expect(origins).toEqual([{ message_id: 'm-1', origin_instance_fingerprint: ORIGIN, peer_id: 'p-1' }]);
  });

  it('asks nothing for an empty list', async () => {
    expect(await adapter.getMessageOrigins([])).toEqual([]);
  });
});
