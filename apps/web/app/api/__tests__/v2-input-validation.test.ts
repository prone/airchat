import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Input handling on the two routes agents use to read forward and to
 * acknowledge what they read.
 */

const getMessages = vi.fn(async () => []);
const markChannelRead = vi.fn(async () => {});

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'macbook-test', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  resolveTrustedSource: () => undefined,
  getStorageAdapter: () => ({
    forAgent: () => ({
      findChannelByName: async () => ({ id: 'c-1', name: 'general' }),
      getMessages,
      markChannelRead,
    }),
  }),
}));
vi.mock('@/lib/gossip-sync', () => ({ pushMessageToSupernodes: async () => {} }));

const messages = await import('@/app/api/v2/messages/route');
const read = await import('@/app/api/v2/channels/read/route');

const readMessages = (query: string) =>
  messages.GET(new NextRequest(`http://localhost:3002/api/v2/messages?channel=general&${query}`));
const ack = (through?: string) =>
  read.POST(new NextRequest('http://localhost:3002/api/v2/channels/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'general', through }),
  }));

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v2/messages', () => {
  it('passes `after` through to the storage layer', async () => {
    const after = '2026-01-01T00:00:00.123456+00:00';
    expect((await readMessages(`after=${encodeURIComponent(after)}`)).status).toBe(200);
    expect(getMessages).toHaveBeenCalledWith('c-1', 20, undefined, after);
  });

  it('accepts the timestamp shapes the API itself returns', async () => {
    for (const ts of ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.5Z', '2026-01-01T00:00:00.123456+00:00', '2026-01-01T00:00:00']) {
      expect((await readMessages(`after=${encodeURIComponent(ts)}`)).status).toBe(200);
    }
  });

  it('rejects a timestamp with trailing junk instead of sending it to the database', async () => {
    for (const param of ['after', 'before']) {
      const res = await readMessages(`${param}=${encodeURIComponent('2026-01-01T00:00:00junk')}`);
      expect(res.status).toBe(400);
    }
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('never asks for fewer than one or more than 200 messages', async () => {
    await readMessages('limit=-5');
    await readMessages('limit=0');
    await readMessages('limit=999');
    expect(getMessages.mock.calls.map((c: unknown[]) => c[1])).toEqual([1, 20, 200]);
  });
});

describe('POST /api/v2/channels/read', () => {
  it('keeps microseconds, so acknowledging through a message covers that message', async () => {
    // Unread means created_at > cursor. Truncating .123456 to .123 left the
    // message the agent had just acknowledged counted as unread.
    const through = '2026-01-01T00:00:00.123456+00:00';
    const res = await ack(through);
    expect(res.status).toBe(200);
    expect(markChannelRead).toHaveBeenCalledWith('c-1', through);
  });

  it('normalises looser date strings', async () => {
    await ack('2026-01-01 00:00:00Z');
    expect(markChannelRead).toHaveBeenCalledWith('c-1', '2026-01-01T00:00:00.000Z');
  });

  it('refuses a cursor in the future or one that is not a date', async () => {
    expect((await ack('2999-01-01T00:00:00Z')).status).toBe(400);
    expect((await ack('yesterday')).status).toBe(400);
    expect(markChannelRead).not.toHaveBeenCalled();
  });
});
