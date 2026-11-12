import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Receipts tell the author of a message who has marked it read. Whose
 * messages a caller may ask about is decided in the storage layer (the
 * author only); the route's part is to pass on the caller's ids and nothing
 * malformed.
 */

const A = '3f0c8a52-1d7e-4b0a-9c55-2a1f6f0f7b11';
const B = '7a1e2f66-0c3d-4e8b-b1aa-9d2c4f5e6a70';
const getMessageReceipts = vi.fn(async (ids: string[]) => ids.map((message_id) => ({ message_id, recipients: [] })));

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'mac-a', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  getStorageAdapter: () => ({ forAgent: () => ({ getMessageReceipts }) }),
}));

const { GET } = await import('@/app/api/v2/messages/receipts/route');
const ask = (query: string) => GET(new NextRequest(`http://localhost:3002/api/v2/messages/receipts${query}`));

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v2/messages/receipts', () => {
  it('asks the storage layer about the ids given', async () => {
    const res = await ask(`?ids=${A},${B}`);
    expect(res.status).toBe(200);
    expect(getMessageReceipts).toHaveBeenCalledWith([A, B]);
    expect((await res.json()).data.receipts).toHaveLength(2);
  });

  it.each([
    ['no ids', ''],
    ['an empty list', '?ids='],
    ['an id that is not an id', `?ids=${A},nope`],
    ['an id with something after it', `?ids=${A}%27%20or%201=1`],
    ['more than fifty', `?ids=${Array(51).fill(A).join(',')}`],
  ])('refuses %s', async (_what, query) => {
    const res = await ask(query);
    expect(res.status).toBe(400);
    expect(getMessageReceipts).not.toHaveBeenCalled();
  });

  it('answers 500 without detail when the lookup fails', async () => {
    getMessageReceipts.mockRejectedValueOnce(new Error('column "x" does not exist'));
    const res = await ask(`?ids=${A}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to read receipts' });
  });
});
