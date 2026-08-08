import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';

/**
 * The token endpoint is where an authorization code becomes an access token, so
 * it is where replay, code substitution and PKCE bypass would live. These drive
 * the real handler against a mocked database.
 */

const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const CODE_ROW = {
  id: 'code-1',
  code_hash: 'irrelevant — lookup is mocked',
  client_id: 'acl_client',
  user_id: 'user-1',
  agent_id: 'agent-1',
  redirect_uri: 'https://claude.ai/callback',
  scope: 'read',
  resource: 'https://mcp.airchat.work/api/mcp',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  consumed_at: null,
};

const state: {
  code: Record<string, unknown> | null;
  consumeSucceeds: boolean;
  inserted: Record<string, unknown>[];
} = { code: null, consumeSucceeds: true, inserted: [] };

vi.mock('@/lib/api-v2-auth', () => ({
  getSupabaseClient: () => ({
    from(table: string) {
      if (table === 'oauth_authorization_codes') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.code }) }) }),
          update: () => ({
            eq: () => ({
              is: () => ({
                select: () => ({
                  maybeSingle: async () => ({ data: state.consumeSucceeds ? { id: 'code-1' } : null }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          state.inserted.push(row);
          return { error: null };
        },
      };
    },
  }),
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

beforeEach(() => {
  vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work');
  state.code = { ...CODE_ROW };
  state.consumeSucceeds = true;
  state.inserted = [];
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
    const row = state.inserted[0];
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(access_token);
  });

  it('carries the audience through from the code', async () => {
    // RFC 8707. /api/mcp validates this on every request, which is what stops a
    // token minted for another resource being replayed against this one.
    await POST(tokenRequest());
    expect(state.inserted[0].audience).toBe('https://mcp.airchat.work/api/mcp');
  });

  it('records the consenting user and the granted scope', async () => {
    await POST(tokenRequest());
    expect(state.inserted[0].granted_by_user_id).toBe('user-1');
    expect(state.inserted[0].scope).toBe('read');
    expect(state.inserted[0].agent_id).toBe('agent-1');
  });

  it('forbids caching the response', async () => {
    const res = await POST(tokenRequest());
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('PKCE enforcement', () => {
  it('rejects a wrong verifier', async () => {
    const res = await POST(tokenRequest({ code_verifier: randomBytes(32).toString('base64url') }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(state.inserted).toHaveLength(0);
  });

  it('rejects a missing verifier', async () => {
    const res = await POST(tokenRequest({ code_verifier: '' }));
    expect(res.status).toBe(400);
    expect(state.inserted).toHaveLength(0);
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
    expect(state.inserted).toHaveLength(0);
  });

  it('refuses an unknown code', async () => {
    state.code = null;
    const res = await POST(tokenRequest());
    expect(res.status).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });

  it('gives the same answer for unknown and consumed codes', async () => {
    state.code = null;
    const unknown = await (await POST(tokenRequest())).json();
    state.code = { ...CODE_ROW };
    state.consumeSucceeds = false;
    const consumed = await (await POST(tokenRequest())).json();
    // Both invalid_grant: distinguishing them tells an attacker which guesses
    // were closer to a real code.
    expect(unknown.error).toBe(consumed.error);
  });

  it('refuses an expired code', async () => {
    state.code = { ...CODE_ROW, expires_at: new Date(Date.now() - 1000).toISOString() };
    const res = await POST(tokenRequest());
    expect(res.status).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });

  it('refuses a code issued to a different client', async () => {
    const res = await POST(tokenRequest({ client_id: 'acl_someone_else' }));
    expect(res.status).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });

  it('refuses a redirect_uri that differs from the authorization request', async () => {
    // RFC 6749 §4.1.3 — otherwise a code obtained for one destination could be
    // redeemed for another.
    const res = await POST(tokenRequest({ redirect_uri: 'https://claude.ai/other' }));
    expect(res.status).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });
});

describe('grant type', () => {
  it('supports only authorization_code', async () => {
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
    state.code = { ...CODE_ROW, scope: 'read-write' };
    const body = await (await POST(tokenRequest())).json();
    expect(body.scope).toBe('read read-write');
  });

  it('answers "read" for a read grant', async () => {
    const body = await (await POST(tokenRequest())).json();
    expect(body.scope).toBe('read');
  });

  it('stores the single collapsed scope, not the echoed list', async () => {
    // The stored value drives the tool surface and must stay one value.
    state.code = { ...CODE_ROW, scope: 'read-write' };
    await POST(tokenRequest());
    expect(state.inserted[0].scope).toBe('read-write');
  });
});

describe('audience is always set on an OAuth-issued token (RFC 8707)', () => {
  it('defaults to this server when the client omitted `resource`', async () => {
    // A null audience makes /api/mcp skip validation entirely — that carve-out
    // is for CLI tokens, whose binding is structural. An OAuth client must not
    // be able to opt out of audience binding by dropping one parameter.
    state.code = { ...CODE_ROW, resource: null };
    await POST(tokenRequest());
    expect(state.inserted[0].audience).toBe('https://mcp.airchat.work/api/mcp');
  });

  it('never stores a null audience', async () => {
    state.code = { ...CODE_ROW, resource: null };
    await POST(tokenRequest());
    expect(state.inserted[0].audience).not.toBeNull();
    expect(state.inserted[0].audience).toBeTruthy();
  });

  it('still honours an explicit resource', async () => {
    state.code = { ...CODE_ROW, resource: 'https://mcp.airchat.work/api/mcp' };
    await POST(tokenRequest());
    expect(state.inserted[0].audience).toBe('https://mcp.airchat.work/api/mcp');
  });
});
