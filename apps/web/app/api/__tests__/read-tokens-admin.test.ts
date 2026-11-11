import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

/**
 * Issuing, listing and revoking read tokens.
 *
 * A token can be issued with access to every direct message, so all three
 * actions belong to the instance admin, and the secret must exist in exactly
 * one place: the response to the request that created it.
 */

type Row = Record<string, unknown>;
const db = { rows: [] as Row[], fail: false };
const admin = { allowed: true };

const client = {
  from(table: string) {
    if (table !== 'read_tokens') throw new Error(`unexpected table ${table}`);
    const tests: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    let columns = '*';
    const pick = (r: Row) => (columns === '*' ? r : Object.fromEntries(columns.split(',').map((c) => [c.trim(), r[c.trim()]])));
    const run = () => {
      if (db.fail) return { data: null, error: { message: 'relation exploded at 10.0.0.5' } };
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(db.rows.length + 1).padStart(12, '0')}`, revoked_at: null, last_used_at: null, created_at: '2026-11-10T00:00:00Z', ...payload };
        db.rows.push(row);
        return { data: [pick(row)], error: null };
      }
      const matched = db.rows.filter((r) => tests.every((t) => t(r)));
      if (op === 'update') matched.forEach((r) => Object.assign(r, payload));
      return { data: matched.map(pick), error: null };
    };
    const chain: Record<string, unknown> = {
      select: (c?: string) => { if (c) columns = c; return chain; },
      insert: (p: Row) => { op = 'insert'; payload = p; return chain; },
      update: (p: Row) => { op = 'update'; payload = p; return chain; },
      eq: (col: string, val: unknown) => { tests.push((r) => r[col] === val); return chain; },
      is: (col: string, val: unknown) => { tests.push((r) => (r[col] ?? null) === val); return chain; },
      order: () => chain,
      single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(run())),
    };
    return chain;
  },
};

vi.mock('@/lib/api-v2-auth', () => ({ getSupabaseClient: () => client }));
vi.mock('@/lib/instance-admin', () => ({
  requireInstanceAdmin: async () =>
    admin.allowed ? null : NextResponse.json({ error: 'Instance admin required' }, { status: 403 }),
}));

const route = await import('@/app/api/v2/admin/read-tokens/route');

const URL_ = 'http://localhost:3002/api/v2/admin/read-tokens';
const post = async (body: unknown) => {
  const res = await route.POST(new NextRequest(URL_, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};
const list = async () => {
  const res = await route.GET(new NextRequest(URL_));
  return { status: res.status, body: await res.json() };
};
const revoke = async (id: string) => {
  const res = await route.DELETE(new NextRequest(`${URL_}?id=${id}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { db.rows = []; db.fail = false; admin.allowed = true; });

describe('only the instance admin', () => {
  it('is refused on all three actions otherwise, and nothing is created', async () => {
    admin.allowed = false;
    expect((await post({ name: 'x', include_dms: true })).status).toBe(403);
    expect((await list()).status).toBe(403);
    expect((await revoke('00000000-0000-4000-8000-000000000001')).status).toBe(403);
    expect(db.rows).toEqual([]);
  });
});

describe('issuing', () => {
  it('returns the token once and stores only its hash', async () => {
    const { status, body } = await post({ name: 'Claude Projects' });
    expect(status).toBe(201);
    const token: string = body.data.token;
    expect(token).toMatch(/^airchat_ro_[A-Za-z0-9_-]{43}$/);
    expect(body.data.header).toBe('x-airchat-read-token');

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(db.rows)).not.toContain(token);
    expect(body.data).not.toHaveProperty('token_hash');
  });

  it('gives every token a different secret', async () => {
    const a = (await post({ name: 'a' })).body.data.token;
    const b = (await post({ name: 'b' })).body.data.token;
    expect(a).not.toBe(b);
  });

  it('leaves DM access off unless it is asked for with a real true', async () => {
    await post({ name: 'default' });
    await post({ name: 'explicit', include_dms: true });
    expect(db.rows.map((r) => r.include_dms)).toEqual([false, true]);
  });

  it('rejects anything but a boolean for DM access, rather than guessing', async () => {
    for (const value of ['true', 'false', 1, 0, null, 'yes', {}]) {
      expect((await post({ name: 'x', include_dms: value })).status, JSON.stringify(value)).toBe(400);
    }
    expect(db.rows).toEqual([]);
  });

  it('requires a name of sensible length', async () => {
    for (const name of [undefined, '', '   ', 'x'.repeat(101), 42]) {
      expect((await post({ name })).status).toBe(400);
    }
    expect((await post('not json')).status).toBe(400);
    expect((await post('null')).status).toBe(400);
    expect(db.rows).toEqual([]);
  });

  it('answers 500 without database detail on failure', async () => {
    db.fail = true;
    const { status, body } = await post({ name: 'x' });
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });
});

describe('listing', () => {
  it('shows tokens without any secret or hash', async () => {
    const token = (await post({ name: 'Claude Projects', include_dms: true })).body.data.token;
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.data.tokens).toHaveLength(1);
    expect(body.data.tokens[0]).toMatchObject({ name: 'Claude Projects', include_dms: true, revoked_at: null });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain('token_hash');
  });
});

describe('revoking', () => {
  it('revokes a live token, once', async () => {
    const id = (await post({ name: 'x' })).body.data.id;
    expect((await revoke(id)).status).toBe(200);
    expect(db.rows[0].revoked_at).toBeTruthy();
    expect((await revoke(id)).status).toBe(404);
  });

  it('rejects an id that is not a token id', async () => {
    expect((await revoke('1 or 1=1')).status).toBe(400);
    expect((await revoke('')).status).toBe(400);
    expect((await revoke('00000000-0000-4000-8000-00000000ffff')).status).toBe(404);
  });
});
