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

// What the service-role client sees when the route checks who a DM attachment
// belongs to: the messages carrying the requested path, and the mentions of
// the caller among them.
const dm = {
  carriers: [] as Array<{ id: string; author_agent_id: string }>,
  mentioned: [] as Array<{ id: string }>,
  fail: false,
};
const db = {
  from: (table: string) => {
    const result = () => {
      if (dm.fail) return { data: null, error: { message: 'boom' } };
      if (table === 'channels') return { data: { id: 'dm-channel' }, error: null };
      if (table === 'messages') return { data: dm.carriers, error: null };
      return { data: dm.mentioned, error: null };
    };
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'contains']) q[m] = () => q;
    q.limit = async () => result();
    q.maybeSingle = async () => result();
    return q;
  },
};

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () =>
    state.agent ?? NextResponse.json({ error: 'Invalid API key' }, { status: 401 }),
  isAuthError: (r: unknown) => r instanceof NextResponse,
  checkAgentRateLimit: () =>
    state.rateLimited ? NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }) : null,
  isDashboardAdmin: async () => state.admin,
  getStorageAdapter: () => ({ forAgent: () => ({ sendMessage }) }),
  getSupabaseClient: () => db,
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
  dm.carriers = [];
  dm.mentioned = [];
  dm.fail = false;
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

describe('files attached to direct messages are as private as the messages', () => {
  const ME = { agentId: 'a-me', agentName: 'macbook-me', machineId: 'm-1' };
  const dmGet = (path = 'direct-messages/1-secret.txt') =>
    new NextRequest(`${url}?path=${encodeURIComponent(path)}`, { headers: withKey('k') });
  const dmList = (folder: unknown) =>
    new NextRequest(url, { method: 'POST', headers: withKey('k'), body: JSON.stringify({ folder }) });

  beforeEach(() => { state.agent = ME; });

  it('hides a DM attachment from an agent who is not a party to it', async () => {
    dm.carriers = [{ id: 'm-1', author_agent_id: 'a-alice' }];
    const res = await GET(dmGet());
    expect(res.status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it('hides a DM-folder file that no message carries', async () => {
    expect((await GET(dmGet())).status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it('serves it to the agent who sent it', async () => {
    dm.carriers = [{ id: 'm-1', author_agent_id: ME.agentId }];
    expect((await GET(dmGet())).status).toBe(200);
  });

  it('serves it to an agent mentioned in the message', async () => {
    dm.carriers = [{ id: 'm-1', author_agent_id: 'a-alice' }];
    dm.mentioned = [{ id: 'mention-1' }];
    expect((await GET(dmGet())).status).toBe(200);
  });

  it('refuses when the ownership lookup fails', async () => {
    dm.fail = true;
    expect((await GET(dmGet())).status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it('is not fooled by path spellings of the DM folder', async () => {
    for (const path of ['./direct-messages/1-secret.txt', 'direct-messages//1-secret.txt']) {
      expect((await GET(dmGet(path))).status).toBe(404);
    }
    expect(download).not.toHaveBeenCalled();
  });

  it('does not let an agent list the DM folder', async () => {
    for (const folder of ['direct-messages', 'direct-messages/', './direct-messages']) {
      expect((await POST(dmList(folder))).status).toBe(403);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a folder that is not a string', async () => {
    expect((await POST(dmList(42))).status).toBe(400);
  });

  it('leaves other channels\' files alone', async () => {
    expect((await GET(get('k'))).status).toBe(200);
    expect((await POST(post('k'))).status).toBe(200);
  });

  it('does not restrict a dashboard admin', async () => {
    state.agent = null;
    state.user = { id: 'u-1' };
    state.admin = true;
    const res = await GET(new NextRequest(`${url}?path=direct-messages/1-secret.txt`));
    expect(res.status).toBe(200);
  });
});

describe('uploads', () => {
  beforeEach(() => {
    state.agent = { agentId: 'a-1', agentName: 'macbook-test', machineId: 'm-1' };
  });

  it('stores each file under a path nobody can guess from the time and name', async () => {
    await PUT(put('k'));
    await PUT(put('k'));
    const [first, second] = upload.mock.calls.map((c) => c[0]);
    expect(first).toMatch(/^general\/\d+-[0-9a-f]{16}-a\.txt$/);
    expect(second).not.toBe(first);
    expect(first.split('-')[1]).not.toBe(second.split('-')[1]);
  });

  it('refuses an oversized request by its declared length, before reading it', async () => {
    const req = put('k');
    const json = vi.spyOn(req, 'json');
    req.headers.set('content-length', String(50 * 1024 * 1024));
    const res = await PUT(req);
    expect(res.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses content too long to fit the limit without decoding it', async () => {
    const decode = vi.spyOn(Buffer, 'from');
    const res = await PUT(put('k', { content: 'A'.repeat(14 * 1024 * 1024 + 8), encoding: 'base64' }));
    expect(res.status).toBe(400);
    expect(decode.mock.calls.some((c) => (c as unknown[])[1] === 'base64')).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  it('accepts ordinary media types', async () => {
    for (const content_type of ['image/png', 'text/plain; charset=utf-8', 'application/vnd.api+json', 'application/octet-stream']) {
      expect((await PUT(put('k', { content_type }))).status, content_type).toBe(200);
    }
  });

  it('rejects a content type that is not a plain media type', async () => {
    for (const content_type of [
      'text/plain\r\nX-Injected: 1',
      'image/png; foo=bar',
      'text/html, text/plain',
      'not a type',
      'a/' + 'b'.repeat(300),
      42,
      { type: 'image/png' },
    ]) {
      expect((await PUT(put('k', { content_type }))).status, String(content_type)).toBe(400);
    }
    expect(upload).not.toHaveBeenCalled();
  });

  it('answers 400, not 500, when a field has the wrong type', async () => {
    for (const extra of [{ content: 42 }, { content: ['a'] }, { filename: {} }, { channel: 7 }]) {
      expect((await PUT(put('k', extra))).status).toBe(400);
    }
    expect(upload).not.toHaveBeenCalled();
  });
});
