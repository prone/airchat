import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Cross-origin approval is refused.
 *
 * Approving consent mints an authorization code, so a forged submission is a
 * grant an admin never intended. The file previously argued that being a POST
 * was the defence, which is not true — a POST is forgeable. What actually
 * protected it was `@supabase/ssr` defaulting its session cookie to
 * SameSite=Lax, a library default rather than a decision made here.
 *
 * That matters because client registration is unauthenticated by design: anyone
 * can register a client pointing at their own redirect_uri and then try to get a
 * signed-in admin's browser to approve it.
 */

const state: { user: { id: string; email: string } | null; admin: boolean } = {
  user: { id: 'u-1', email: 'duncan@example.com' },
  admin: true,
};

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock('@/lib/api-v2-auth', () => ({
  isDashboardAdmin: async () => state.admin,
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'a-1' } }) }) }),
    }),
  }),
}));

vi.mock('../route', () => ({
  validateAuthorizeRequest: async () => ({
    ok: false,
    response: Response.json({ error: 'stub' }, { status: 400 }),
  }),
}));

const { POST } = await import('@/app/api/oauth/authorize/approve/route');

function approve(origin?: string) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new NextRequest('https://mcp.airchat.work/api/oauth/authorize/approve', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ client_id: 'acl_x' }),
  });
}

beforeEach(() => {
  vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work');
  state.user = { id: 'u-1', email: 'duncan@example.com' };
  state.admin = true;
});

describe('a submission from another origin is refused', () => {
  it('rejects an attacker origin with 403', async () => {
    const res = await POST(approve('https://evil.example'));
    expect(res.status).toBe(403);
  });

  it('refuses before touching the session or the form', async () => {
    // The stubbed validateAuthorizeRequest returns 400. Seeing 403 proves the
    // origin check ran first and nothing further was evaluated.
    const res = await POST(approve('https://evil.example'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/cross-origin/i);
  });

  it('rejects a lookalike host', async () => {
    expect((await POST(approve('https://mcp.airchat.work.evil.com'))).status).toBe(403);
  });

  it('rejects a scheme downgrade', async () => {
    expect((await POST(approve('http://mcp.airchat.work'))).status).toBe(403);
  });
});

describe('the real consent flow still works', () => {
  it('allows a submission from the configured public origin', async () => {
    // Reaches the stubbed validator (400), i.e. it was NOT refused as 403.
    const res = await POST(approve('https://mcp.airchat.work'));
    expect(res.status).not.toBe(403);
  });

  it('allows a submission with no Origin header at all', async () => {
    // Some browsers omit Origin on same-origin form posts. Refusing those would
    // break the flow for a real user without stopping any attack, since a
    // cross-origin POST always carries one.
    const res = await POST(approve());
    expect(res.status).not.toBe(403);
  });
});
