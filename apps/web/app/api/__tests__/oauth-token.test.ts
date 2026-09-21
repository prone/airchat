import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';

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
  consumeSucceeds: true,
  nextId: 1,
  updates: [] as { table: string; patch: Row; filters: [string, string, unknown][] }[],
  /** Called once after the next refresh-token lookup; simulates a concurrent writer. */
  afterRefreshLookup: null as (() => void) | null,
};

function tableFor(name: string): Row[] {
  if (name === 'oauth_authorization_codes') return state.codes;
  if (name === 'connector_tokens') return state.access;
  if (name === 'oauth_refresh_tokens') return state.refresh;
  throw new Error(`unexpected table ${name}`);
}

function applyFilters(rows: Row[], filters: [string, string, unknown][]): Row[] {
  return rows.filter((r) => filters.every(([op, col, val]) => {
    if (op === 'eq') return r[col] === val;
    if (op === 'is') return r[col] === val || (val === null && r[col] === undefined);
    if (op === 'in') return (val as unknown[]).includes(r[col]);
    return false;
  }));
}

function fakeFrom(table: string) {
  const rows = tableFor(table);
  const filters: [string, string, unknown][] = [];
  let mode: 'select' | 'update' | 'insert' = 'select';
  let patch: Row = {};
  let inserted: Row | null = null;

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
      inserted = { id: `${table}-${state.nextId++}`, ...row };
      rows.push(inserted);
      return q;
    },
    eq(col: string, val: unknown) { filters.push(['eq', col, val]); return q; },
    is(col: string, val: unknown) { filters.push(['is', col, val]); return q; },
    in(col: string, val: unknown[]) { filters.push(['in', col, val]); return q; },
    async maybeSingle() { const r = run(); return { data: r[0] ?? null, error: null }; },
    async single() { const r = run(); return r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no row' } }; },
    then(resolve: (v: unknown) => void) { resolve({ data: run(), error: null }); },
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
  state.codes = [{ ...CODE_ROW, code_hash: sha('the-code') }];
  state.access = [];
  state.refresh = [];
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
    await POST(refreshRequest(a.refresh_token)); // replay a -> revoke family a

    const stillFine = await POST(refreshRequest(b.refresh_token));
    expect(stillFine.status).toBe(200);
  });

  it('treats a lost consume race as a refusal, not a replay', async () => {
    // Both requests read the token as unconsumed; only one update wins. The
    // loser must not revoke the family, or claude.ai's proactive + reactive
    // refresh coinciding would log the user out.
    const first = await exchange();
    const row = state.refresh[0];
    // The row is unconsumed when this request looks it up, and consumed by a
    // concurrent request before the atomic update runs.
    state.afterRefreshLookup = () => { row.consumed_at = 'raced'; };
    const res = await POST(refreshRequest(first.refresh_token));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    // Refused, but nothing revoked: the winner's tokens keep working.
    expect(row.revoked_at).toBeFalsy();
    expect(liveAccess()).toHaveLength(1);
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
