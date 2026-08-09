/**
 * Deactivation has to survive the agent's next request.
 *
 * It did not. `registerAgent` set `active: true` on an UPDATE matched only on
 * name and machine ownership, so switching an agent off lasted exactly until it
 * spoke again: the disabled key produced a 401, the client re-registered, and
 * the agent turned itself back on. There was no way to stop an agent whose
 * machine still held its key.
 *
 * The property was hidden for a long time because `register()` short-circuited
 * on its on-disk key cache and never reached the server, so the loop could not
 * close. Fixing that (#98) exposed this. See docs/security-review-plan.md (F4).
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../supabase-adapter.js';

const MACHINE = 'machine-1';
const OTHER_MACHINE = 'machine-2';

interface AgentRow {
  id: string;
  name: string;
  machine_id: string | null;
  derived_key_hash: string;
  active: boolean;
  metadata?: unknown;
}

/**
 * Enough of the query builder for registerAgent: a conditional UPDATE, a
 * lookup by name, and an INSERT. Filters are applied in order, which is what
 * makes `.eq('active', true)` actually mean something here.
 */
function makeClient(table: AgentRow[]): SupabaseClient {
  function builder() {
    const filters: Array<(r: AgentRow) => boolean> = [];
    let pending: 'update' | 'insert' | 'select' = 'select';
    let payload: Partial<AgentRow> = {};

    const matching = () => table.filter((r) => filters.every((f) => f(r)));

    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (values: Partial<AgentRow>) => {
        pending = 'update';
        payload = values;
        return chain;
      },
      insert: (values: Partial<AgentRow>) => {
        pending = 'insert';
        payload = values;
        return chain;
      },
      eq: (col: string, value: unknown) => {
        filters.push((r) => (r as unknown as Record<string, unknown>)[col] === value);
        return chain;
      },
      or: (expr: string) => {
        // Only shape used: machine_id.eq.X,machine_id.is.null
        const owner = /machine_id\.eq\.([^,]+)/.exec(expr)?.[1];
        filters.push((r) => r.machine_id === owner || r.machine_id === null);
        return chain;
      },
      single: async () => {
        if (pending === 'insert') {
          const row = { ...(payload as AgentRow) };
          table.push(row);
          return { data: row, error: null };
        }
        const rows = matching();
        if (pending === 'update') {
          if (rows.length !== 1) {
            return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
          }
          Object.assign(rows[0], payload);
          return { data: rows[0], error: null };
        }
        if (rows.length !== 1) {
          return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        }
        return { data: rows[0], error: null };
      },
    };
    return chain;
  }

  return { from: () => builder() } as unknown as SupabaseClient;
}

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'a-1',
    name: 'macbook-thing',
    machine_id: MACHINE,
    derived_key_hash: 'old-hash',
    active: true,
    ...overrides,
  };
}

describe('registerAgent and deactivation', () => {
  it('refuses to re-register a deactivated agent', async () => {
    const table = [agent({ active: false })];
    const adapter = new SupabaseStorageAdapter(makeClient(table));

    await expect(
      adapter.registerAgent('macbook-thing', MACHINE, 'new-hash')
    ).rejects.toThrow(/DEACTIVATED/);
  });

  it('does not let a deactivated agent install a new key', async () => {
    // Refusing the registration but writing the key anyway would hand a
    // disabled agent a working credential the moment it was re-enabled.
    const table = [agent({ active: false })];
    const adapter = new SupabaseStorageAdapter(makeClient(table));

    await expect(
      adapter.registerAgent('macbook-thing', MACHINE, 'new-hash')
    ).rejects.toThrow(/DEACTIVATED/);

    expect(table[0].derived_key_hash).toBe('old-hash');
    expect(table[0].active).toBe(false);
  });

  it('never flips active back to true', async () => {
    const table = [agent({ active: false })];
    const adapter = new SupabaseStorageAdapter(makeClient(table));

    await adapter.registerAgent('macbook-thing', MACHINE, 'new-hash').catch(() => {});

    expect(table[0].active).toBe(false);
  });

  it('still rotates the key for an agent that is active', async () => {
    // The point is to stop reactivation, not to break key rotation — which is
    // the whole reason the 401 recovery path exists.
    const table = [agent()];
    const adapter = new SupabaseStorageAdapter(makeClient(table));

    const result = await adapter.registerAgent('macbook-thing', MACHINE, 'new-hash');

    expect(result.name).toBe('macbook-thing');
    // Asserted on the row rather than the return value: `Agent` deliberately
    // does not expose the key hash, and the row is what had to change.
    expect(table[0].derived_key_hash).toBe('new-hash');
    expect(table[0].active).toBe(true);
  });

  it('still reports a name owned by another machine as a conflict', async () => {
    const table = [agent({ machine_id: OTHER_MACHINE })];
    const adapter = new SupabaseStorageAdapter(makeClient(table));

    await expect(
      adapter.registerAgent('macbook-thing', MACHINE, 'new-hash')
    ).rejects.toThrow(/CONFLICT/);
  });

  it('reports conflict, not deactivation, to a machine that does not own the name', async () => {
    // Otherwise the error tells an unrelated machine about the agent's state.
    const table = [agent({ machine_id: OTHER_MACHINE, active: false })];
    const adapter = new SupabaseStorageAdapter(makeClient(table));

    await expect(
      adapter.registerAgent('macbook-thing', MACHINE, 'new-hash')
    ).rejects.toThrow(/CONFLICT/);
  });

  it('still creates an agent that does not exist yet', async () => {
    const table: AgentRow[] = [];
    const adapter = new SupabaseStorageAdapter(makeClient(table));

    const created = await adapter.registerAgent('macbook-new', MACHINE, 'hash');

    expect(created.name).toBe('macbook-new');
    expect(table).toHaveLength(1);
    expect(table[0].active).toBe(true);
  });
});
