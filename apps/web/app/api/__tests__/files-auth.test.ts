import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * /api/files must not serve storage to a caller it cannot identify.
 *
 * The route uses the service role for storage, so its own check is the only
 * one. It used to accept any x-agent-api-key value: the check was "a query
 * through RLS with this key returned no error", and RLS answers an unknown key
 * with zero rows rather than an error. A logged-in non-admin passed too.
 */

const state = {
  agent: null as null | { agentId: string; agentName: string; machineId: string },
  user: null as null | { id: string },
  admin: false,
  rateLimited: false,
};

const download = vi.fn(async () => ({
  data: new Blob(['hello'], { type: 'text/plain' }),
  error: null,
}));
const list = vi.fn(async () => ({ data: [], error: null }));
const upload = vi.fn(async (_path: string, _body: Buffer, _opts: { contentType: string }) => ({ error: null }));
const sendMessage = vi.fn(async () => ({ id: 'm-1' }));

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () =>
    state.agent ?? NextResponse.json({ error: 'Invalid API key' }, { status: 401 }),
  isAuthError: (r: unknown) => r instanceof NextResponse,
  checkAgentRateLimit: () =>
    state.rateLimited ? NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }) : null,
  isDashboardAdmin: async () => state.admin,
  getStorageAdapter: () => ({ forAgent: () => ({ sendMessage }) }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock('@/lib/api-auth', () => ({
  getStorageClient: () => ({
    storage: { from: () => ({ download, list, upload, createSignedUrl: vi.fn() }) },
  }),
}));

const { GET, PUT, POST } = await import('@/app/api/files/route');

const url = 'http://localhost:3002/api/files';
const withKey = (key?: string): Record<string, string> =>
  key ? { 'x-agent-api-key': key, 'content-type': 'application/json' } : { 'content-type': 'application/json' };

const get = (key?: string) =>
  new NextRequest(`${url}?path=general/1-a.txt`, { headers: withKey(key) });
const put = (key?: string, extra: Record<string, unknown> = {}) =>
  new NextRequest(url, {
    method: 'PUT',
    headers: withKey(key),
    body: JSON.stringify({ filename: 'a.txt', content: 'hi', channel: 'general', ...extra }),
  });
const post = (key?: string) =>
  new NextRequest(url, { method: 'POST', headers: withKey(key), body: JSON.stringify({ folder: 'general' }) });

beforeEach(() => {
  vi.clearAllMocks();
  state.agent = null;
  state.user = null;
  state.admin = false;
  state.rateLimited = false;
});

describe('a made-up API key is refused on every method', () => {
  it('GET answers 401 and never touches storage', async () => {
    expect((await GET(get('not-a-real-key'))).status).toBe(401);
    expect(download).not.toHaveBeenCalled();
  });

  it('PUT answers 401 and never touches storage', async () => {
    expect((await PUT(put('not-a-real-key'))).status).toBe(401);
    expect(upload).not.toHaveBeenCalled();
  });

  it('POST answers 401 and never touches storage', async () => {
    expect((await POST(post('not-a-real-key'))).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('no credential at all', () => {
  it('is refused with 401', async () => {
    expect((await GET(get())).status).toBe(401);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('a dashboard session', () => {
  it('is refused with 403 when the user is not an admin', async () => {
    state.user = { id: 'u-1' };
    expect((await GET(get())).status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it('is served when the user is an admin', async () => {
    state.user = { id: 'u-1' };
    state.admin = true;
    expect((await GET(get())).status).toBe(200);
  });
});

describe('a registered agent', () => {
  beforeEach(() => {
    state.agent = { agentId: 'a-1', agentName: 'macbook-test', machineId: 'm-1' };
  });

  it('can download, list and upload', async () => {
    expect((await GET(get('real-key'))).status).toBe(200);
    expect((await POST(post('real-key'))).status).toBe(200);
    expect((await PUT(put('real-key'))).status).toBe(200);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('announces an upload as itself', async () => {
    await PUT(put('real-key'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('is rate limited', async () => {
    state.rateLimited = true;
    expect((await PUT(put('real-key'))).status).toBe(429);
    expect(upload).not.toHaveBeenCalled();
  });

  it('cannot store a script type by adding a charset parameter', async () => {
    await PUT(put('real-key', { content_type: 'Text/HTML; charset=utf-8' }));
    expect(upload.mock.calls[0][2]).toMatchObject({ contentType: 'application/octet-stream' });
  });
});
