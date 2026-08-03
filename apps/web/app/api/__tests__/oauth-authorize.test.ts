import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The authorize endpoint.
 *
 * The redirect tests exist because of a bug that unit tests could not have
 * caught as written: both browser-facing redirects used
 * `request.nextUrl.origin`, which inside the container is the bind address
 * `http://0.0.0.0:3002`. Every test constructs a NextRequest with a sensible
 * URL, so it looked correct; only driving the deployed instance showed a login
 * redirect a browser could not follow. These now assert the origin explicitly,
 * with the request deliberately carrying a different one.
 */

const client = {
  client_id: 'acl_test',
  client_name: 'Test Client',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
};

const state: { client: typeof client | null; user: { id: string } | null; admin: boolean } = {
  client, user: null, admin: false,
};

vi.mock('@/lib/api-v2-auth', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.client }) }) }),
    }),
  }),
  isDashboardAdmin: async () => state.admin,
}));

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

const { GET } = await import('@/app/api/oauth/authorize/route');

const VALID = {
  client_id: 'acl_test',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  response_type: 'code',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  scope: 'read',
};

/** Built with the container's own bind address, as a real request arrives. */
function authorizeRequest(overrides: Record<string, string> = {}, origin = 'http://0.0.0.0:3002') {
  const params = new URLSearchParams({ ...VALID, ...overrides });
  for (const [k, v] of Object.entries(overrides)) if (v === '') params.delete(k);
  return new NextRequest(`${origin}/api/oauth/authorize?${params}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work');
  state.client = client;
  state.user = null;
  state.admin = false;
});

describe('redirects name an address a browser can reach', () => {
  it('sends an unauthenticated user to login on the public origin', async () => {
    const res = await GET(authorizeRequest());
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location.startsWith('https://mcp.airchat.work/login')).toBe(true);
    // The bug: this was http://0.0.0.0:3002/login, which no browser resolves.
    expect(location).not.toContain('0.0.0.0');
  });

  it('preserves the original request in ?next so login can return to it', async () => {
    const res = await GET(authorizeRequest());
    const next = new URL(res.headers.get('location')!).searchParams.get('next');
    expect(next).toContain('/api/oauth/authorize');
    expect(next).toContain('code_challenge');
  });

  it('sends an approved admin to consent on the public origin', async () => {
    state.user = { id: 'user-1' };
    state.admin = true;
    const res = await GET(authorizeRequest());
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location.startsWith('https://mcp.airchat.work/oauth/consent')).toBe(true);
    expect(location).not.toContain('0.0.0.0');
  });

  it('carries the authorization parameters through to consent', async () => {
    state.user = { id: 'user-1' };
    state.admin = true;
    const res = await GET(authorizeRequest());
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('client_id')).toBe('acl_test');
    expect(url.searchParams.get('code_challenge')).toBe(VALID.code_challenge);
  });
});

describe('access control', () => {
  it('refuses a signed-in non-admin', async () => {
    // Decided 2026-08-02: admins only.
    state.user = { id: 'user-1' };
    state.admin = false;
    const res = await GET(authorizeRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('access_denied');
  });
});

describe('request validation', () => {
  it('rejects an unknown client', async () => {
    state.client = null;
    const res = await GET(authorizeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client');
  });

  it('rejects a redirect_uri that is not registered', async () => {
    const res = await GET(authorizeRequest({ redirect_uri: 'https://evil.example/cb' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  it('never redirects to an unverified redirect_uri', async () => {
    // Redirecting to an unverified URI is the open-redirect bug itself.
    const res = await GET(authorizeRequest({ redirect_uri: 'https://evil.example/cb' }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('requires PKCE', async () => {
    const res = await GET(authorizeRequest({ code_challenge: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toMatch(/code_challenge/);
  });

  it('requires S256 and refuses plain', async () => {
    const res = await GET(authorizeRequest({ code_challenge_method: 'plain' }));
    expect(res.status).toBe(400);
  });

  it('supports only response_type=code', async () => {
    const res = await GET(authorizeRequest({ response_type: 'token' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_response_type');
  });

  it('rejects an unknown scope', async () => {
    const res = await GET(authorizeRequest({ scope: 'admin' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_scope');
  });

  it('validates before checking the session, so an invalid request never prompts a login', async () => {
    state.client = null;
    const res = await GET(authorizeRequest());
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});
