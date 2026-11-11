/**
 * Rules the storage adapter applies to notes, and the machine check on agent
 * authentication. Driven against a small in-memory stand-in for the database
 * client, so they run without one.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';
import { DIRECT_MESSAGES_CHANNEL } from '../constants.js';
import { MAX_LINKS_PER_NOTE_WRITE, modelInventoryOwner } from '../notes.js';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

/**
 * Enough of the query builder for the notes paths: filters (eq / is / in /
 * contains) over in-memory rows, and insert / update / delete / upsert that
 * really change them. Joined columns are not computed; a test that needs one
 * puts it on the seeded row.
 */
function makeClient(tables: Tables): SupabaseClient {
  let nextId = 1;
  function builder(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let patch: Row = {};
    let inserted: Row[] = [];
    let max: number | undefined;

    const run = (): Row[] => {
      if (mode === 'insert') return inserted;
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === 'update') {
        for (const r of hit) Object.assign(r, patch);
        return hit;
      }
      if (mode === 'delete') {
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return hit;
      }
      return (max === undefined ? hit : hit.slice(0, max)).map((r) => ({ ...r }));
    };
    const add = (input: Row | Row[]) => {
      mode = 'insert';
      inserted = (Array.isArray(input) ? input : [input]).map((r) => ({
        id: `${table}-${nextId++}`,
        ...(table === 'notes' ? { current_revision: 1, protected: false, properties: {} } : {}),
        ...r,
      }));
      rows.push(...inserted);
      return chain;
    };

    const chain: Record<string, any> = {
      select: () => chain,
      order: () => chain,
      or: () => chain,
      gte: () => chain,
      limit: (n: number) => { max = n; return chain; },
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
      is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return chain; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
      contains: (col: string, want: Row) => {
        filters.push((r) => Object.entries(want).every(([k, v]) => r[col]?.[k] === v));
        return chain;
      },
      insert: add,
      upsert: add,
      update: (p: Row) => { mode = 'update'; patch = p; return chain; },
      delete: () => { mode = 'delete'; return chain; },
      single: async () => {
        const data = run()[0] ?? null;
        return { data, error: data ? null : { message: 'no rows' } };
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: run(), error: null })),
    };
    return chain;
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient;
}

const ME = 'agent-me';
const LINKER = 'agent-linker';

function adapterFor(tables: Tables, agentId = ME, agentName = 'macbook-me') {
  return new SupabaseStorageAdapter(makeClient(tables)).forAgent({ agentId, agentName, machineId: 'machine-1' });
}

const write = (adapter: ReturnType<typeof adapterFor>, over: Row = {}) =>
  adapter.writeNote({ channelName: null, slug: 'runbook', title: 'Runbook', bodyMd: 'steps', ...over } as never);

describe('who is the creator of a note that began as a stub', () => {
  // A stub is made when someone links to a note that does not exist. The
  // linker used to stay "creator" for good, and the creator is the one who
  // may protect a note and write to it once protected.
  const stub = (): Row => ({
    id: 'n-1', slug: 'runbook', channel_id: null, title: 'runbook', body_md: '',
    created_by: LINKER, updated_by: LINKER, is_stub: true, protected: false, current_revision: 1, properties: {},
  });

  it('becomes whoever first writes the real note', async () => {
    const tables: Tables = { notes: [stub()] };
    const saved = await write(adapterFor(tables));
    expect(saved.created_by).toBe(ME);
    expect(saved.is_stub).toBe(false);
  });

  it('lets that writer protect it, and keeps the linker out afterwards', async () => {
    const tables: Tables = { notes: [stub()] };
    const saved = await write(adapterFor(tables), { protect: true });
    expect(saved.protected).toBe(true);
    await expect(write(adapterFor(tables, LINKER, 'macbook-linker'), { bodyMd: 'mine now' }))
      .rejects.toThrow(/^PROTECTED/);
  });

  it('does not move ownership of a note that is already written', async () => {
    const tables: Tables = { notes: [{ ...stub(), is_stub: false, body_md: 'real' }] };
    const saved = await write(adapterFor(tables), { protect: true });
    expect(saved.created_by).toBe(LINKER);
    // And someone who is not the creator still cannot switch protection on.
    expect(saved.protected).toBe(false);
  });
});

describe('links recorded per write', () => {
  it('stops at the cap, for link rows and for stubs', async () => {
    const tables: Tables = { notes: [] };
    const bodyMd = Array.from({ length: MAX_LINKS_PER_NOTE_WRITE + 30 }, (_, i) => `[[target-${i}]]`).join(' ');
    await write(adapterFor(tables), { bodyMd });
    expect(tables.note_links).toHaveLength(MAX_LINKS_PER_NOTE_WRITE);
    expect(tables.notes.filter((n) => n.is_stub)).toHaveLength(MAX_LINKS_PER_NOTE_WRITE);
  });

  it('records every link when there are fewer than the cap', async () => {
    const tables: Tables = { notes: [] };
    await write(adapterFor(tables), { bodyMd: '[[a]] and [[b]]' });
    expect(tables.note_links.map((l) => l.target_slug).sort()).toEqual(['a', 'b']);
  });
});

describe('backlinks', () => {
  it('leaves out a quarantined message', async () => {
    const tables: Tables = {
      note_links: [
        { source_type: 'message', source_id: 'm-ok', target_slug: 'runbook', target_channel_id: null, created_at: '2026-01-02' },
        { source_type: 'message', source_id: 'm-held', target_slug: 'runbook', target_channel_id: null, created_at: '2026-01-01' },
      ],
      messages: [
        { id: 'm-ok', content: 'see [[runbook]]', created_at: '2026-01-02', author_agent_id: LINKER, quarantined: false, channels: { name: 'general' } },
        { id: 'm-held', content: 'held back: secret [[runbook]]', created_at: '2026-01-01', author_agent_id: LINKER, quarantined: true, channels: { name: 'general' } },
      ],
    };
    const backlinks = await adapterFor(tables).getNoteBacklinks(null, 'runbook');
    expect(backlinks.map((b) => b.source_id)).toEqual(['m-ok']);
    expect(JSON.stringify(backlinks)).not.toContain('secret');
  });
});

describe('notes and the direct-messages channel', () => {
  // Every agent can read every note; direct messages are private. A note in
  // that scope would look private and be public.
  const tables = (): Tables => ({
    channels: [{ id: 'chan-dm', name: DIRECT_MESSAGES_CHANNEL }],
    notes: [{ id: 'n-old', slug: 'runbook', channel_id: 'chan-dm', title: 't', body_md: 'old', created_by: LINKER, is_stub: false, current_revision: 1 }],
    channel_memberships: [],
  });

  it('refuses to write one, and writes nothing', async () => {
    const t = tables();
    await expect(write(adapterFor(t), { channelName: DIRECT_MESSAGES_CHANNEL })).rejects.toThrow(/direct-messages/);
    expect(t.notes).toHaveLength(1);
    expect(t.channel_memberships).toHaveLength(0);
  });

  it('does not serve one that already exists', async () => {
    const adapter = adapterFor(tables());
    expect(await adapter.getNote(DIRECT_MESSAGES_CHANNEL, 'runbook')).toBeNull();
    expect(await adapter.getNoteBacklinks(DIRECT_MESSAGES_CHANNEL, 'runbook')).toEqual([]);
    expect(await adapter.listNotes({ channelName: DIRECT_MESSAGES_CHANNEL })).toEqual([]);
  });

  it('does not create a stub there from a link', async () => {
    const t = tables();
    await write(adapterFor(t), { bodyMd: `[[${DIRECT_MESSAGES_CHANNEL}/secret-plan]] [[ok]]` });
    expect(t.notes.some((n) => n.slug === 'secret-plan')).toBe(false);
    expect(t.note_links.map((l) => l.target_slug)).toEqual(['ok']);
  });
});

describe('model inventory notes', () => {
  // The inventory tells other agents where to send prompts. Any agent used to
  // be able to publish one, and so advertise a model at its own address.
  const inventory = { type: 'model-inventory', machine: 'nas', models: [] };
  const worker = (t: Tables) => adapterFor(t, 'agent-worker', 'nas-models');

  it('names the one agent that may publish each inventory', () => {
    expect(modelInventoryOwner('models-nas')).toBe('nas-models');
    expect(modelInventoryOwner('models-mac-mini')).toBe('mac-mini-models');
    expect(modelInventoryOwner('deploy-runbook')).toBeNull();
    expect(modelInventoryOwner('models-')).toBeNull();
  });

  it('accepts models-<machine> from <machine>-models', async () => {
    const t: Tables = { notes: [] };
    const saved = await write(worker(t), { slug: 'models-nas', properties: inventory });
    expect(saved.created_by).toBe('agent-worker');
  });

  it('refuses an inventory from any other agent, under any slug', async () => {
    const t: Tables = { notes: [] };
    await expect(write(adapterFor(t), { slug: 'models-nas', properties: inventory })).rejects.toThrow(/^PROTECTED/);
    await expect(write(adapterFor(t), { slug: 'my-models', properties: inventory })).rejects.toThrow(/^PROTECTED/);
    await expect(write(worker(t), { slug: 'models-workstation', properties: inventory })).rejects.toThrow(/^PROTECTED/);
    expect(t.notes).toHaveLength(0);
  });

  it('refuses an inventory filed in a channel instead of the global scope', async () => {
    const t: Tables = { notes: [], channels: [{ id: 'chan-1', name: 'general' }], channel_memberships: [] };
    await expect(write(worker(t), { channelName: 'general', slug: 'models-nas', properties: inventory }))
      .rejects.toThrow(/^PROTECTED/);
  });

  it('does not let another agent edit a published inventory', async () => {
    const t: Tables = { notes: [] };
    await write(worker(t), { slug: 'models-nas', properties: inventory });
    await expect(write(adapterFor(t), { slug: 'models-nas', bodyMd: 'edited' })).rejects.toThrow(/^PROTECTED/);
    await expect(write(adapterFor(t), { slug: 'models-nas', properties: { type: 'other' } })).rejects.toThrow(/^PROTECTED/);
  });

  it('lets the worker take the note back from someone who claimed the name first', async () => {
    const t: Tables = { notes: [{
      id: 'n-squat', slug: 'models-nas', channel_id: null, title: 'squat', body_md: 'x',
      created_by: LINKER, updated_by: LINKER, is_stub: false, protected: true, current_revision: 3, properties: {},
    }] };
    const saved = await write(worker(t), { slug: 'models-nas', properties: inventory });
    expect(saved.created_by).toBe('agent-worker');
    expect(saved.properties).toEqual(inventory);
  });

  it('still lets anyone write an ordinary note whose slug starts with models-', async () => {
    const t: Tables = { notes: [] };
    const saved = await write(adapterFor(t), { slug: 'models-comparison', properties: { status: 'draft' } });
    expect(saved.slug).toBe('models-comparison');
  });

  it('reports who created and last wrote a note when querying by properties', async () => {
    const t: Tables = {
      channel_memberships: [],
      notes: [{
        slug: 'models-nas', channel_id: null, title: 't', is_stub: false, protected: false, current_revision: 2,
        updated_at: '2026-01-01', properties: inventory, creator: { name: 'nas-models' }, updater: { name: 'laptop-other' },
      }],
    };
    const [note] = await adapterFor(t).queryNotes({ properties: { type: 'model-inventory' } });
    expect(note.created_by_name).toBe('nas-models');
    expect(note.updated_by_name).toBe('laptop-other');
  });
});

describe('an agent whose machine has been switched off', () => {
  const agent = (machine: Row | null): Row => ({
    id: 'a-1', name: 'nas-project', derived_key_hash: 'hash', active: true,
    machine_id: machine ? 'm-1' : null, machine_keys: machine,
  });
  const find = (row: Row) => new SupabaseStorageAdapter(makeClient({ agents: [row] })).findAgentByDerivedKeyHash('hash');

  it('no longer authenticates', async () => {
    expect(await find(agent({ active: false }))).toBeNull();
  });

  it('authenticates while its machine is active', async () => {
    const found = await find(agent({ active: true }));
    expect(found?.id).toBe('a-1');
    // The joined machine row is not part of the agent.
    expect(found).not.toHaveProperty('machine_keys');
  });

  it('is unaffected when it has no machine', async () => {
    expect((await find(agent(null)))?.id).toBe('a-1');
  });

  it('is still refused when the agent itself is inactive', async () => {
    expect(await find({ ...agent({ active: true }), active: false })).toBeNull();
  });
});
