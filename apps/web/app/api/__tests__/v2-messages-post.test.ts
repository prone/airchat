import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ChannelArchivedError } from '@airchat/shared';

/**
 * POST /api/v2/messages takes JSON written by an agent, so every field can
 * arrive with the wrong type, and metadata can carry keys that other code
 * reads as statements made by the server.
 */

const sendMessage = vi.fn(async (..._args: unknown[]) => ({ id: 'm-1', created_at: '2026-01-01T00:00:00Z' }));
const state = {
  archived: false as boolean | null,
  lookupFails: false,
  trustedSource: undefined as string | undefined,
};

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'macbook-test', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  resolveTrustedSource: () => state.trustedSource,
  getStorageAdapter: () => ({ forAgent: () => ({ sendMessage }) }),
  getSupabaseClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => {
        if (state.lookupFails) throw new Error('connection reset');
        return { data: state.archived === null ? null : { archived: state.archived }, error: null };
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/gossip-sync', () => ({ pushMessageToSupernodes: async () => {} }));

const { POST } = await import('@/app/api/v2/messages/route');

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost:3002/api/v2/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  state.archived = false;
  state.lookupFails = false;
  state.trustedSource = undefined;
});

describe('field types', () => {
  it('sends a well-formed message', async () => {
    const res = await post({ channel: 'general', content: ' hello ', metadata: { project: 'x' } });
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('general', 'hello', { project: 'x' }, undefined);
  });

  it('answers 400, not 500, when content is not a string', async () => {
    for (const content of [42, true, ['a'], { text: 'a' }, null]) {
      const res = await post({ channel: 'general', content });
      expect(res.status, JSON.stringify(content)).toBe(400);
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('answers 400 when metadata is not an object', async () => {
    for (const metadata of ['text', 42, ['a'], true]) {
      const res = await post({ channel: 'general', content: 'hi', metadata });
      expect(res.status, JSON.stringify(metadata)).toBe(400);
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('answers 400 when the channel or parent id has the wrong type', async () => {
    expect((await post({ channel: 42, content: 'hi' })).status).toBe(400);
    expect((await post({ channel: ['general'], content: 'hi' })).status).toBe(400);
    expect((await post({ channel: 'general', content: 'hi', parent_message_id: 42 })).status).toBe(400);
    expect((await post({ channel: 'general', content: 'hi', parent_message_id: 'not-a-uuid' })).status).toBe(400);
  });

  it('answers 400 when the body is not an object', async () => {
    expect((await post('null')).status).toBe(400);
    expect((await post('[1,2]')).status).toBe(400);
    expect((await post('"text"')).status).toBe(400);
  });

  it('treats null metadata and a null parent as absent', async () => {
    const res = await post({ channel: 'general', content: 'hi', metadata: null, parent_message_id: null });
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('general', 'hi', undefined, undefined);
  });
});

describe('metadata keys only the server may set', () => {
  it('drops `files`, so a message cannot claim to carry a stored file', async () => {
    // Access to a direct-message attachment goes to the author of a message
    // listing its path. Writing the list yourself would be writing your own
    // permission slip.
    const res = await post({
      channel: 'direct-messages',
      content: 'mine now',
      metadata: { files: [{ path: 'direct-messages/1-secret.txt' }], note: 'kept' },
    });
    expect(res.status).toBe(200);
    expect(sendMessage.mock.calls[0][2]).toEqual({ note: 'kept' });
  });

  it('drops `source` and `user_email`', async () => {
    await post({ channel: 'general', content: 'hi', metadata: { source: 'dashboard', user_email: 'a@b.c' } });
    expect(sendMessage.mock.calls[0][2]).toEqual({});
  });

  it('still stamps the source the server itself recognises', async () => {
    state.trustedSource = 'slack';
    await post({ channel: 'general', content: 'hi', metadata: { source: 'dashboard' } });
    expect(sendMessage.mock.calls[0][2]).toEqual({ source: 'slack' });
  });
});

describe('archived channels', () => {
  it('answers 409 when the adapter refuses an archived channel', async () => {
    sendMessage.mockRejectedValueOnce(new ChannelArchivedError('old-project'));
    const res = await post({ channel: 'old-project', content: 'hi' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/archived/);
  });

  it('still answers 500 for any other failure', async () => {
    sendMessage.mockRejectedValueOnce(new Error('connection reset'));
    expect((await post({ channel: 'general', content: 'hi' })).status).toBe(500);
  });
});
