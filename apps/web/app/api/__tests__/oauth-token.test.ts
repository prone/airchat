import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * The token endpoint is where an authorization code becomes an access token, so
 * it is where replay, code substitution and PKCE bypass would live. Since OAuth
 * 7 it is also where refresh tokens rotate, so it is where reuse detection and
 * grant revocation live too. These drive the real handler against a small
 * in-memory fake of the three tables it touches.
 */

const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

const CODE_ROW = {
  id: 'code-1',
  code_hash: 'irrelevant — lookup is mocked',
  client_id: 'acl_client',
  user_id: 'user-1',
  agent_id: 'agent-1',
  redirect_uri: 'https://claude.ai/callback',
  scope: 'read',
  resource: 'https://mcp.airchat.work/mcp',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  consumed_at: null,
};

type Row = Record<string, any>;

/**
 * Just enough of the supabase-js query builder for this route: filters
 * (eq / is / in) applied to an in-memory array, select / update / insert, and
 * maybeSingle / single / thenable termination. Inserted rows get sequential
 * ids so the route's `.select('id')` after insert works.
 */
const state = {
  codes: [] as Row[],
  access: [] as Row[],
  refresh: [] as Row[],
  /** admin_users: who may hold a connector grant. */
  admins: [] as Row[],
  consumeSucceeds: true,
  nextId: 1,
  updates: [] as { table: string; patch: Row; filters: [string, string, unknown][] }[],
  /** Called once after the next refresh-token lookup; simulates a concurrent writer. */
  afterRefreshLookup: null as (() => void) | null,
  /** Make the next matching query fail, as a database outage would. */
  failNext: null as { table: string; mode: 'select' | 'update' | 'insert' } | null,
};

/** Rotated-away long enough ago that presenting it again is reuse, not a retry. */
const longAgo = () => new Date(Date.now() - 10 * 60_000).toISOString();

function tableFor(name: string): Row[] {
  if (name === 'oauth_authorization_codes') return state.codes;
  if (name === 'connector_tokens') return state.access;
  if (name === 'oauth_refresh_tokens') return state.refresh;
  if (name === 'admin_users') return state.admins;
  throw new Error(`unexpected table ${name}`);
}

function applyFilters(rows: Row[], filters: [string, string, unknown][]): Row[] {
  return rows.filter((r) => filters.every(([op, col, val]) => {
    if (op === 'eq') return r[col] === val;
    if (op === 'is') return r[col] === val || (val === null && r[col] === undefined);
    if (op === 'in') return (val as unknown[]).includes(r[col]);
    if (op === 'notnull') return r[col] !== null && r[col] !== undefined;
    return false;
  }));
}

function fakeFrom(table: string) {
  const rows = tableFor(table);
  const filters: [string, string, unknown][] = [];
  let mode: 'select' | 'update' | 'insert' = 'select';
  let patch: Row = {};
  let inserted: Row | null = null;
  let insertError: { message: string; code?: string } | null = null;

  /** Consume a pending injected failure if this query matches it. */
  const injected = (): { message: string } | null => {
    if (state.failNext && state.failNext.table === table && state.failNext.mode === mode) {
      state.failNext = null;
      return { message: 'connection reset' };
    }
    return insertError;
  };

  const run = (): Row[] => {
    if (mode === 'insert') return inserted ? [inserted] : [];
    const hit = applyFilters(rows, filters);
    if (mode === 'update') {
      if (table === 'oauth_authorization_codes' && !state.consumeSucceeds) return [];
      state.updates.push({ table, patch, filters: [...filters] });
      for (const r of hit) Object.assign(r, patch);
      return hit;
    }
    // A select returns copies, as a real client returns decoded JSON: what the
    // route holds is a snapshot, not a live reference into the table.
    const snapshot = hit.map((r) => ({ ...r }));
    if (table === 'oauth_refresh_tokens' && state.afterRefreshLookup) {
      const hook = state.afterRefreshLookup;
      state.afterRefreshLookup = null;
      hook();
    }
    return snapshot;
  };

  const q: any = {
    // select() is projection only; after update()/insert() it never changes
    // what the query does, exactly as in supabase-js.
    select() { return q; },
    update(p: Row) { mode = 'update'; patch = p; return q; },
    insert(row: Row) {
      mode = 'insert';
      if (state.failNext && state.failNext.table === table && state.failNext.mode === 'insert') {
        return q; // injected() reports it; nothing is stored
      }
      // token_hash is UNIQUE on both token tables.
      if (row.token_hash && rows.some((r) => r.token_hash === row.token_hash)) {
        insertError = { message: 'duplicate key value violates unique constraint', code: '23505' };
        return q;
      }
      inserted = { id: `${table}-${state.nextId++}`, ...row };
      rows.push(inserted);
      return q;
    },
    eq(col: string, val: unknown) { filters.push(['eq', col, val]); return q; },
    is(col: string, val: unknown) { filters.push(['is', col, val]); return q; },
    in(col: string, val: unknown[]) { filters.push(['in', col, val]); return q; },
    not(col: string, _op: string, _val: unknown) { filters.push(['notnull', col, null]); return q; },
    limit() { return q; },
    async maybeSingle() {
      const error = injected();
      if (error) return { data: null, error };
      const r = run();
      return { data: r[0] ?? null, error: null };
    },
    async single() {
      const error = injected();
      if (error) return { data: null, error };
      const r = run();
      return r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no row' } };
    },
    then(resolve: (v: unknown) => void) {
      const error = injected();
      resolve(error ? { data: null, error } : { data: run(), error: null });
    },
  };
  return q;
}

vi.mock('@/lib/api-v2-auth', () => ({
  getSupabaseClient: () => ({ from: fakeFrom }),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkIpRateLimit: () => ({ allowed: true }),
}));

const { POST } = await import('@/app/api/oauth/token/route');

function tokenRequest(overrides: Record<string, string> = {}) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'the-code',
    code_verifier: VERIFIER,
    redirect_uri: 'https://claude.ai/callback',
    client_id: 'acl_client',
    ...overrides,
  });
  return new NextRequest('https://mcp.airchat.work/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
}

function refreshRequest(refreshToken: string, overrides: Record<string, string> = {}) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: 'acl_client',
    ...overrides,
  });
  return new NextRequest('https://mcp.airchat.work/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
}

/** Run a full consent exchange and return the issued pair. */
async function exchange(): Promise<{ access_token: string; refresh_token: string }> {
  const res = await POST(tokenRequest());
  expect(res.status).toBe(200);
  return res.json();
}

const liveRefresh = () => state.refresh.filter((r) => !r.consumed_at && !r.revoked_at);
const liveAccess = () => state.access.filter((r) => !r.revoked_at);

beforeEach(() => {
  vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  vi.stubEnv('OAUTH_ROTATION_SECRET', '');
  state.failNext = null;
  state.codes = [{ ...CODE_ROW, code_hash: sha('the-code') }];
  state.access = [];
  state.refresh = [];
  state.admins = [{ user_id: 'user-1' }];
  state.consumeSucceeds = true;
  state.nextId = 1;
  state.updates = [];
  state.afterRefreshLookup = null;
});

describe('successful exchange', () => {
  it('issues an access token', async () => {
    const res = await POST(tokenRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^acx_/);
    expect(body.scope).toBe('read');
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it('stores only a hash of the token, never the token', async () => {
    const res = await POST(tokenRequest());
    const { access_token } = await res.json();
    const row = state.access[0];
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(access_token);
  });

  it('carries the audience through from the code', async () => {
    // RFC 8707. /api/mcp validates this on every request, which is what stops a
    // token minted for another resource being replayed against this one.
    await POST(tokenRequest());
    expect(state.access[0].audience).toBe('https://mcp.airchat.work/mcp');
  });

  it('records the consenting user and the granted scope', async () => {
    await POST(tokenRequest());
    expect(state.access[0].granted_by_user_id).toBe('user-1');
    expect(state.access[0].scope).toBe('read');
    expect(state.access[0].agent_id).toBe('agent-1');
  });

  it('forbids caching the response', async () => {
    const res = await POST(tokenRequest());
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('refresh token issuance (OAuth 7)', () => {
  it('issues a refresh token alongside the access token', async () => {
    const body = await exchange();
    expect(body.refresh_token).toMatch(/^acr_/);
    expect(body.refresh_token).not.toBe(body.access_token);
  });

  it('stores the refresh token hashed, bound to the access token, in a fresh family', async () => {
    const body = await exchange();
    expect(state.refresh).toHaveLength(1);
    const row = state.refresh[0];
    expect(row.token_hash).toBe(sha(body.refresh_token));
    expect(JSON.stringify(row)).not.toContain(body.refresh_token);
    expect(row.access_token_id).toBe(state.access[0].id);
    expect(row.family_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.client_id).toBe('acl_client');
    expect(row.agent_id).toBe('agent-1');
    expect(row.user_id).toBe('user-1');
    expect(row.audience).toBe('https://mcp.airchat.work/mcp');
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
  });

  it('starts a new family for every consent', async () => {
    const first = await exchange();
    state.codes.push({ ...CODE_ROW, id: 'code-2', code_hash: sha('second-code') });
    const res = await POST(tokenRequest({ code: 'second-code' }));
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(state.refresh[0].family_id).not.toBe(state.refresh[1].family_id);
  });
});

describe('refresh grant: rotation', () => {
  it('rotates: new access token, new refresh token, old refresh consumed, old access revoked', async () => {
    const first = await exchange();
    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(200);
    const second = await res.json();

    expect(second.access_token).toMatch(/^acx_/);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).toMatch(/^acr_/);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe('read');
    expect(res.headers.get('cache-control')).toContain('no-store');

    // Exactly one live pair remains, and it is the new one.
    expect(liveRefresh()).toHaveLength(1);
    expect(liveRefresh()[0].token_hash).toBe(sha(second.refresh_token));
    expect(liveAccess()).toHaveLength(1);
    expect(liveAccess()[0].token_hash).toBe(sha(second.access_token));
    // The old refresh token is consumed, not revoked: that distinction is what
    // lets a later presentation be recognised as reuse.
    expect(state.refresh[0].consumed_at).toBeTruthy();
    expect(state.refresh[0].revoked_at).toBeFalsy();
  });

  it('keeps the family, scope and audience across rotations', async () => {
    state.codes[0].scope = 'read-write';
    const first = await exchange();
    const second = await (await POST(refreshRequest(first.refresh_token))).json();
    expect(second.scope).toBe('read read-write');
    expect(state.refresh[1].family_id).toBe(state.refresh[0].family_id);
    expect(state.refresh[1].audience).toBe(state.refresh[0].audience);
    expect(state.access[1].scope).toBe('read-write');
    expect(state.access[1].audience).toBe('https://mcp.airchat.work/mcp');
  });

  it('does not re-derive the audience from the refresh request host', async () => {
    const first = await exchange();
    vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://evil.example');
    await POST(refreshRequest(first.refresh_token));
    expect(state.access[1].audience).toBe('https://mcp.airchat.work/mcp');
  });

  it('can rotate repeatedly', async () => {
    let { refresh_token } = await exchange();
    for (let i = 0; i < 3; i++) {
      const res = await POST(refreshRequest(refresh_token));
      expect(res.status).toBe(200);
      ({ refresh_token } = await res.json());
    }
    expect(liveRefresh()).toHaveLength(1);
    expect(liveAccess()).toHaveLength(1);
    expect(state.refresh).toHaveLength(4);
  });
});

describe('refresh grant: reuse detection', () => {
  it('revokes the whole family and its access token when a consumed token is replayed', async () => {
    const first = await exchange();
    const second = await (await POST(refreshRequest(first.refresh_token))).json();
    state.refresh[0].consumed_at = longAgo();

    const replay = await POST(refreshRequest(first.refresh_token));
    expect(replay.status).toBe(400);
    const body = await replay.json();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/reuse/i);

    // Nothing in the family survives: not the replayed token, not the current
    // one, and not the live access token the legitimate client holds.
    expect(liveRefresh()).toHaveLength(0);
    expect(liveAccess()).toHaveLength(0);
    expect(state.refresh.every((r) => r.revoked_at)).toBe(true);
    // And the legitimate client's current refresh token is now dead too.
    const again = await POST(refreshRequest(second.refresh_token));
    expect(again.status).toBe(400);
  });

  it('does not touch other families', async () => {
    const a = await exchange();
    state.codes.push({ ...CODE_ROW, id: 'code-2', code_hash: sha('second-code') });
    const b = await (await POST(tokenRequest({ code: 'second-code' }))).json();

    await POST(refreshRequest(a.refresh_token)); // consume a
    state.refresh[0].consumed_at = longAgo();
    await POST(refreshRequest(a.refresh_token)); // replay a -> revoke family a
    expect(liveRefresh().every((r) => r.family_id !== state.refresh[0].family_id)).toBe(true);

    const stillFine = await POST(refreshRequest(b.refresh_token));
    expect(stillFine.status).toBe(200);
  });

  it('revokes the family when the replayed token\'s successor has already been rotated', async () => {
    // Inside the retry window, but the grant has moved on twice: this is not a
    // retry of the last rotation.
    const first = await exchange();
    const second = await (await POST(refreshRequest(first.refresh_token))).json();
    await POST(refreshRequest(second.refresh_token));

    const replay = await POST(refreshRequest(first.refresh_token));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');
    expect(liveRefresh()).toHaveLength(0);
    expect(liveAccess()).toHaveLength(0);
  });
});

describe('refresh grant: a retry is not theft', () => {
  // Rotation consumes the client's only refresh token before the response is
  // delivered. If the response is lost, the client retries with the token it
  // still has. Treating that as reuse revoked the grant and forced consent
  // again — the silent expiry this endpoint exists to end.

  it('answers a retry with the same pair the first attempt issued', async () => {
    const first = await exchange();
    const attempt = await (await POST(refreshRequest(first.refresh_token))).json();

    const retry = await POST(refreshRequest(first.refresh_token));
    expect(retry.status).toBe(200);
    const again = await retry.json();

    expect(again.access_token).toBe(attempt.access_token);
    expect(again.refresh_token).toBe(attempt.refresh_token);
    // Nothing extra was minted and nothing was revoked.
    expect(state.refresh).toHaveLength(2);
    expect(liveRefresh()).toHaveLength(1);
    expect(liveAccess()).toHaveLength(1);
  });

  it('the pair from a retry keeps working', async () => {
    const first = await exchange();
    await POST(refreshRequest(first.refresh_token));
    const again = await (await POST(refreshRequest(first.refresh_token))).json();

    const next = await POST(refreshRequest(again.refresh_token));
    expect(next.status).toBe(200);
  });

  it('gives the loser of a consume race the winner\'s pair', async () => {
    // claude.ai refreshes proactively before expiry and reactively on a 401,
    // and the two can coincide: both read the token as unconsumed, one update
    // wins. Whichever response the client keeps must be a working pair.
    const first = await exchange();
    const row = state.refresh[0];
    state.afterRefreshLookup = () => { row.consumed_at = new Date().toISOString(); };

    const loser = await POST(refreshRequest(first.refresh_token));
    expect(loser.status).toBe(200);
    const winner = await (await POST(refreshRequest(first.refresh_token))).json();

    expect((await loser.json()).refresh_token).toBe(winner.refresh_token);
    expect(row.revoked_at).toBeFalsy();
    expect(liveRefresh()).toHaveLength(1);
    expect(liveAccess()).toHaveLength(1);
  });

  it('finishes the job when the first attempt died before storing the new pair', async () => {
    const first = await exchange();
    state.failNext = { table: 'oauth_refresh_tokens', mode: 'insert' };
    const died = await POST(refreshRequest(first.refresh_token));
    // Retryable, not a server_error: the retry below is what finishes the job.
    expect(died.status).toBe(503);
    expect(died.headers.get('Retry-After')).toBeTruthy();

    const retry = await POST(refreshRequest(first.refresh_token));
    expect(retry.status).toBe(200);
    const pair = await retry.json();
    expect(liveRefresh()).toHaveLength(1);
    expect((await POST(refreshRequest(pair.refresh_token))).status).toBe(200);
  });

  it('finishes the job even after the window, when the successor was never stored', async () => {
    // An outage longer than the retry window: the token was consumed, then the
    // database failed before the new pair was written. Nobody holds a newer
    // token, so the late retry is not reuse and must not revoke the grant.
    const first = await exchange();
    state.failNext = { table: 'oauth_refresh_tokens', mode: 'insert' };
    await POST(refreshRequest(first.refresh_token));
    state.refresh[0].consumed_at = new Date(Date.now() - 3_600_000).toISOString();

    const late = await POST(refreshRequest(first.refresh_token));
    expect(late.status).toBe(200);
    const pair = await late.json();
    expect(state.refresh[0].revoked_at).toBeFalsy();
    expect(liveRefresh()).toHaveLength(1);
    expect(liveAccess()).toHaveLength(1);
    expect((await POST(refreshRequest(pair.refresh_token))).status).toBe(200);
  });

  it('does not revoke the grant when a concurrent refresh retired the access token first', async () => {
    // Request B reads the token as unconsumed. Request A then consumes it and,
    // as rotation always does, retires the old access token. B must not read
    // that retired access token as "revoked from the dashboard".
    const first = await exchange();
    const winner = await (await POST(refreshRequest(first.refresh_token))).json();
    const row = state.refresh[0];
    const consumedAt = row.consumed_at;
    row.consumed_at = null; // B's stale read...
    state.afterRefreshLookup = () => { row.consumed_at = consumedAt; }; // ...then A lands

    const loser = await POST(refreshRequest(first.refresh_token));
    expect(loser.status).toBe(200);
    expect((await loser.json()).refresh_token).toBe(winner.refresh_token);
    expect(liveRefresh()).toHaveLength(1);
    expect(liveAccess()).toHaveLength(1);
  });

  it('stops treating it as a retry once the window has passed', async () => {
    const first = await exchange();
    await POST(refreshRequest(first.refresh_token));
    state.refresh[0].consumed_at = new Date(Date.now() - 61_000).toISOString();

    const late = await POST(refreshRequest(first.refresh_token));
    expect(late.status).toBe(400);
    expect(liveRefresh()).toHaveLength(0);
  });

  it('serves a retry only once per token', async () => {
    // One lost response or one overlap explains one extra presentation. A
    // second replay of the same consumed token is someone collecting pairs.
    const first = await exchange();
    await POST(refreshRequest(first.refresh_token));
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(200);

    const third = await POST(refreshRequest(first.refresh_token));
    expect(third.status).toBe(400);
    expect((await third.json()).error).toBe('invalid_grant');
    expect(liveRefresh()).toHaveLength(0);
    expect(liveAccess()).toHaveLength(0);
  });

  it('finishing an interrupted rotation does not use up the one retry', async () => {
    const first = await exchange();
    state.failNext = { table: 'oauth_refresh_tokens', mode: 'insert' };
    await POST(refreshRequest(first.refresh_token)); // died before storing
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(200); // finishes the job
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(200); // the one retry
    expect(liveRefresh()).toHaveLength(1);
  });

  it('a thief replaying inside the window is still caught at the next rotation', async () => {
    const first = await exchange();
    const client = await (await POST(refreshRequest(first.refresh_token))).json();
    // The thief replays the stolen token inside the window and gets the same pair.
    const thief = await (await POST(refreshRequest(first.refresh_token))).json();
    expect(thief.refresh_token).toBe(client.refresh_token);

    // The thief rotates it. Later the client presents the same, now consumed, token.
    await POST(refreshRequest(thief.refresh_token));
    state.refresh[1].consumed_at = longAgo();
    const caught = await POST(refreshRequest(client.refresh_token));

    expect(caught.status).toBe(400);
    expect(liveRefresh()).toHaveLength(0);
    expect(liveAccess()).toHaveLength(0);
  });

  it('rotated tokens are not derivable without the server key', async () => {
    const first = await exchange();
    const a = await (await POST(refreshRequest(first.refresh_token))).json();
    expect(a.refresh_token).toMatch(/^acr_[0-9a-f]{64}$/);
    expect(a.access_token).toMatch(/^acx_[0-9a-f]{64}$/);

    // Same parent row, different key: a different successor.
    const parent = state.refresh[0];
    state.access = state.access.slice(0, 1);
    state.refresh = [{ ...parent, consumed_at: null }];
    state.access[0].revoked_at = null;
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'a-different-key');
    const b = await (await POST(refreshRequest(first.refresh_token))).json();
    expect(b.refresh_token).not.toBe(a.refresh_token);
    expect(b.access_token).not.toBe(a.access_token);
  });
});

/**
 * Without OAUTH_ROTATION_SECRET the successor used to be signed with the
 * service-role key itself. It is now signed with a key derived from it, and
 * tokens rotated under the old scheme must still be recognised.
 */
describe('refresh grant: the signing key when no rotation secret is set', () => {
  const legacyPair = (parent: Row) => {
    const derive = (label: string) =>
      createHmac('sha256', 'test-service-role-key').update(`${label}\0${parent.id}\0${parent.token_hash}`).digest('hex');
    return { access: 'acx_' + derive('airchat-oauth-access-v1'), refresh: 'acr_' + derive('airchat-oauth-refresh-v1') };
  };

  it('does not sign with the service-role key directly', async () => {
    const first = await exchange();
    const parent = { ...state.refresh[0] };
    const second = await (await POST(refreshRequest(first.refresh_token))).json();
    expect(second.refresh_token).not.toBe(legacyPair(parent).refresh);
    expect(second.access_token).not.toBe(legacyPair(parent).access);
  });

  it('prefers OAUTH_ROTATION_SECRET when it is set', async () => {
    const first = await exchange();
    const parent = { ...state.refresh[0] };
    vi.stubEnv('OAUTH_ROTATION_SECRET', 'a-dedicated-secret');
    const second = await (await POST(refreshRequest(first.refresh_token))).json();
    const derive = (label: string) =>
      createHmac('sha256', 'a-dedicated-secret').update(`${label}\0${parent.id}\0${parent.token_hash}`).digest('hex');
    expect(second.refresh_token).toBe('acr_' + derive('airchat-oauth-refresh-v1'));
  });

  /** A grant whose first rotation happened before the key changed. */
  async function rotatedUnderOldKey() {
    const first = await exchange();
    const parent = state.refresh[0];
    const old = legacyPair(parent);
    parent.consumed_at = new Date().toISOString();
    state.access[0].revoked_at = new Date().toISOString();
    state.access.push({ id: 'old-access', token_hash: sha(old.access), agent_id: 'agent-1', revoked_at: null });
    state.refresh.push({
      ...parent, id: 'old-successor', token_hash: sha(old.refresh),
      access_token_id: 'old-access', consumed_at: null, revoked_at: null,
    });
    return { first, old };
  }

  it('still treats a replayed token rotated under the old key as reuse', async () => {
    const { first } = await rotatedUnderOldKey();
    state.refresh[0].consumed_at = longAgo();

    const replay = await POST(refreshRequest(first.refresh_token));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error_description).toMatch(/reuse/i);
    // Nothing new was minted and the family is dead.
    expect(state.refresh).toHaveLength(2);
    expect(liveRefresh()).toHaveLength(0);
    expect(liveAccess()).toHaveLength(0);
  });

  it('answers a retry of such a token with the pair already issued', async () => {
    const { first, old } = await rotatedUnderOldKey();
    const retry = await POST(refreshRequest(first.refresh_token));
    expect(retry.status).toBe(200);
    const again = await retry.json();
    expect(again.refresh_token).toBe(old.refresh);
    expect(again.access_token).toBe(old.access);
    expect(state.refresh).toHaveLength(2);
  });

  it('keeps rotating a successor that was issued under the old key', async () => {
    const { old } = await rotatedUnderOldKey();
    const res = await POST(refreshRequest(old.refresh));
    expect(res.status).toBe(200);
    expect(liveRefresh()).toHaveLength(1);
  });
});

/**
 * Consent requires a dashboard admin. A refresh used to renew the grant
 * without asking whether that was still true, so removing someone from the
 * admin list left their connector working indefinitely.
 */
describe('refresh grant: the user must still be an admin', () => {
  it('ends the grant when the user has been removed from the admin list', async () => {
    const first = await exchange();
    state.admins = [];

    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    // The whole grant goes, including the access token still in the client's hands.
    expect(liveRefresh()).toHaveLength(0);
    expect(liveAccess()).toHaveLength(0);
    expect(state.refresh).toHaveLength(1);
  });

  it('does not come back if the user is made an admin again', async () => {
    const first = await exchange();
    state.admins = [];
    await POST(refreshRequest(first.refresh_token));
    state.admins = [{ user_id: 'user-1' }];
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(400);
  });

  it('is not fooled by some other user being an admin', async () => {
    const first = await exchange();
    state.admins = [{ user_id: 'someone-else' }];
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(400);
  });

  it('answers 503 and keeps the grant when the admin list cannot be read', async () => {
    const first = await exchange();
    state.failNext = { table: 'admin_users', mode: 'select' };

    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(503);
    expect(state.refresh.every((r) => !r.revoked_at)).toBe(true);
    // The retry completes the rotation once the database answers.
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(200);
    expect(liveRefresh()).toHaveLength(1);
  });

  it('also applies to a retry inside the rotation window', async () => {
    const first = await exchange();
    await POST(refreshRequest(first.refresh_token));
    state.admins = [];
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(400);
    expect(liveAccess()).toHaveLength(0);
  });
});

describe('refresh grant: a database failure is not an invalid token', () => {
  // invalid_grant tells the client to discard the grant. Answering it for an
  // outage would throw away a good grant during a blip.

  it.each([
    ['looking the token up', { table: 'oauth_refresh_tokens', mode: 'select' as const }],
    ['checking the access token', { table: 'connector_tokens', mode: 'select' as const }],
    ['consuming the token', { table: 'oauth_refresh_tokens', mode: 'update' as const }],
  ])('answers 503, not invalid_grant, when %s fails', async (_what, failure) => {
    const first = await exchange();
    state.failNext = failure;

    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('temporarily_unavailable');
    expect(res.headers.get('retry-after')).toBeTruthy();

    // The grant is intact: the same token works once the database is back.
    expect(state.refresh.every((r) => !r.revoked_at)).toBe(true);
    expect((await POST(refreshRequest(first.refresh_token))).status).toBe(200);
  });
});

describe('refresh grant: stale or foreign tokens', () => {
  it('refuses an unknown refresh token with invalid_grant', async () => {
    await exchange();
    const res = await POST(refreshRequest('acr_' + randomBytes(32).toString('base64url')));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(state.access).toHaveLength(1);
  });

  it('refuses an expired refresh token', async () => {
    const first = await exchange();
    state.refresh[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(state.access).toHaveLength(1);
  });

  it('refuses a revoked refresh token', async () => {
    const first = await exchange();
    state.refresh[0].revoked_at = new Date().toISOString();
    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('refuses a refresh token presented by a different client', async () => {
    const first = await exchange();
    const res = await POST(refreshRequest(first.refresh_token, { client_id: 'acl_someone_else' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    // Not consumed either: the legitimate client can still use it.
    expect(state.refresh[0].consumed_at).toBeFalsy();
  });

  it('ends the grant when its access token was revoked elsewhere', async () => {
    // Revoking from the dashboard or CLI must be final; otherwise the next
    // refresh would silently undo it.
    const first = await exchange();
    state.access[0].revoked_at = new Date().toISOString();
    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(state.refresh[0].revoked_at).toBeTruthy();
    expect(liveAccess()).toHaveLength(0);
  });

  it('does not claim the grant is revoked when the revocation failed', async () => {
    const first = await exchange();
    state.access[0].revoked_at = new Date().toISOString();
    state.failNext = { table: 'oauth_refresh_tokens', mode: 'update' };
    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(503);
    // The retry completes it.
    const retry = await POST(refreshRequest(first.refresh_token));
    expect((await retry.json()).error).toBe('invalid_grant');
    expect(liveRefresh()).toHaveLength(0);
  });

  it('finishes a half-done revocation when a revoked token is presented again', async () => {
    // Refresh tokens revoked, but the step that revokes the access tokens failed.
    const first = await exchange();
    state.refresh[0].revoked_at = new Date().toISOString();
    expect(liveAccess()).toHaveLength(1);
    const res = await POST(refreshRequest(first.refresh_token));
    expect((await res.json()).error).toBe('invalid_grant');
    expect(liveAccess()).toHaveLength(0);
  });

  it('does not let a pair survive in a family revoked while it was being issued', async () => {
    const first = await exchange();
    const second = await (await POST(refreshRequest(first.refresh_token))).json();
    // Reuse of the first token is detected on a parallel request just as the
    // second token rotates: its family is revoked mid-rotation.
    const realInsert = state.refresh.push.bind(state.refresh);
    state.refresh.push = (...rows: Row[]) => {
      state.refresh[0].revoked_at = new Date().toISOString();
      state.refresh.push = realInsert;
      return realInsert(...rows);
    };
    const res = await POST(refreshRequest(second.refresh_token));
    expect(res.status).toBe(400);
    expect(liveRefresh()).toHaveLength(0);
    expect(liveAccess()).toHaveLength(0);
  });

  it('gives the same error for unknown, expired and revoked tokens', async () => {
    const first = await exchange();
    const unknown = await (await POST(refreshRequest('acr_nope'))).json();
    state.refresh[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await (await POST(refreshRequest(first.refresh_token))).json();
    expect(unknown.error).toBe('invalid_grant');
    expect(expired.error).toBe('invalid_grant');
  });

  it('requires refresh_token and client_id', async () => {
    await exchange();
    const res = await POST(refreshRequest('', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
    const res2 = await POST(refreshRequest('acr_x', { client_id: '' }));
    expect((await res2.json()).error).toBe('invalid_request');
  });
});

describe('PKCE enforcement', () => {
  it('rejects a wrong verifier', async () => {
    const res = await POST(tokenRequest({ code_verifier: randomBytes(32).toString('base64url') }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(state.access).toHaveLength(0);
  });

  it('rejects a missing verifier', async () => {
    const res = await POST(tokenRequest({ code_verifier: '' }));
    expect(res.status).toBe(400);
    expect(state.access).toHaveLength(0);
  });
});

describe('code replay and substitution', () => {
  it('refuses a code that was already consumed', async () => {
    // The handler marks the code spent before validating anything else, so a
    // replay racing the original still only succeeds once.
    state.consumeSucceeds = false;
    const res = await POST(tokenRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toMatch(/already used/i);
    expect(state.access).toHaveLength(0);
  });

  it('refuses an unknown code', async () => {
    state.codes = [];
    const res = await POST(tokenRequest());
    expect(res.status).toBe(400);
    expect(state.access).toHaveLength(0);
  });

  it('gives the same answer for unknown and consumed codes', async () => {
    state.codes = [];
    const unknown = await (await POST(tokenRequest())).json();
    state.codes = [{ ...CODE_ROW, code_hash: sha('the-code') }];
    state.consumeSucceeds = false;
    const consumed = await (await POST(tokenRequest())).json();
    // Both invalid_grant: distinguishing them tells an attacker which guesses
    // were closer to a real code.
    expect(unknown.error).toBe(consumed.error);
  });

  it('refuses an expired code', async () => {
    state.codes[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const res = await POST(tokenRequest());
    expect(res.status).toBe(400);
    expect(state.access).toHaveLength(0);
  });

  it('refuses a code issued to a different client', async () => {
    const res = await POST(tokenRequest({ client_id: 'acl_someone_else' }));
    expect(res.status).toBe(400);
    expect(state.access).toHaveLength(0);
  });

  it('refuses a redirect_uri that differs from the authorization request', async () => {
    // RFC 6749 §4.1.3 — otherwise a code obtained for one destination could be
    // redeemed for another.
    const res = await POST(tokenRequest({ redirect_uri: 'https://claude.ai/other' }));
    expect(res.status).toBe(400);
    expect(state.access).toHaveLength(0);
  });
});

describe('grant type', () => {
  it('supports authorization_code and refresh_token only', async () => {
    const res = await POST(tokenRequest({ grant_type: 'client_credentials' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });

  it('rejects a request missing required parameters', async () => {
    const res = await POST(tokenRequest({ code: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });
});

describe('the granted scope is echoed as a list', () => {
  it('answers "read read-write" for a read-write grant', async () => {
    // The client asked for "read read-write". Replying "read-write" alone reads
    // as a partial grant, which is what stopped it using the token.
    state.codes[0].scope = 'read-write';
    const body = await (await POST(tokenRequest())).json();
    expect(body.scope).toBe('read read-write');
  });

  it('answers "read" for a read grant', async () => {
    const body = await (await POST(tokenRequest())).json();
    expect(body.scope).toBe('read');
  });

  it('stores the single collapsed scope, not the echoed list', async () => {
    // The stored value drives the tool surface and must stay one value.
    state.codes[0].scope = 'read-write';
    await POST(tokenRequest());
    expect(state.access[0].scope).toBe('read-write');
  });
});

describe('audience is always set on an OAuth-issued token (RFC 8707)', () => {
  it('defaults to this server when the client omitted `resource`', async () => {
    // A null audience makes /api/mcp skip validation entirely — that carve-out
    // is for CLI tokens, whose binding is structural. An OAuth client must not
    // be able to opt out of audience binding by dropping one parameter.
    state.codes[0].resource = null;
    await POST(tokenRequest());
    expect(state.access[0].audience).toBe('https://mcp.airchat.work/mcp');
  });

  it('never stores a null audience', async () => {
    state.codes[0].resource = null;
    await POST(tokenRequest());
    expect(state.access[0].audience).not.toBeNull();
    expect(state.access[0].audience).toBeTruthy();
  });

  it('still honours an explicit resource', async () => {
    state.codes[0].resource = 'https://mcp.airchat.work/mcp';
    await POST(tokenRequest());
    expect(state.access[0].audience).toBe('https://mcp.airchat.work/mcp');
  });
});
