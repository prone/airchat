import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * GET /api/v2/work is the "anything for me?" check a hook runs around every
 * agent turn. It used to cost six database requests: authenticate, read the
 * agent's card, then four lists. The card now arrives with the authenticated
 * identity and the four lists come from one call, and the response the hook
 * and the check_work tool read is unchanged.
 */

const getWork = vi.fn();
const getOwnCard = vi.fn();
const getMentions = vi.fn();
const listTasks = vi.fn();
let auth: Record<string, unknown>;

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => auth,
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  getStorageAdapter: () => ({
    forAgent: () => ({ getWork, getOwnCard, getMentions, listTasks }),
  }),
}));

const { GET } = await import('@/app/api/v2/work/route');

const req = (qs = '') => new NextRequest(`http://localhost:3002/api/v2/work${qs}`);
const body = async (res: Response) => (await res.json()).data;

const mention = (extra: Record<string, unknown> = {}) => ({
  mention_id: 'mn-1',
  message_id: 'm-1',
  channel_name: 'direct-messages',
  author_name: 'alice',
  author_project: 'airchat',
  author_source: null,
  content: '@me hello',
  created_at: '2026-11-10T12:00:00+00:00',
  is_read: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth = { agentId: 'a-1', agentName: 'tester', machineId: 'm-1', card: { capabilities: ['code', 'review'] } };
  getWork.mockResolvedValue({ mentions: [], open_matching: [], mine_claimed: [], completed_for_me: [] });
  getOwnCard.mockResolvedValue({ capabilities: ['from-database'] });
});

describe('one storage call per work check', () => {
  it('uses the card that came with authentication instead of reading the agent again', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(getOwnCard).not.toHaveBeenCalled();
    expect(getWork).toHaveBeenCalledTimes(1);
    expect(getWork.mock.calls[0][0]).toEqual(['code', 'review']);
    expect(getMentions).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('matches only untagged tasks for an agent with no card', async () => {
    auth = { ...auth, card: null };
    await GET(req());
    expect(getOwnCard).not.toHaveBeenCalled();
    expect(getWork.mock.calls[0][0]).toEqual([]);
  });

  it('reads the card itself only when the identity came without one', async () => {
    const withoutCard = { ...auth };
    delete withoutCard.card;
    auth = withoutCard;
    await GET(req());
    expect(getOwnCard).toHaveBeenCalledTimes(1);
    expect(getWork.mock.calls[0][0]).toEqual(['from-database']);
  });

  it('ignores capabilities that are not text', async () => {
    auth = { ...auth, card: { capabilities: ['code', 7, null, { a: 1 }] } };
    await GET(req());
    expect(getWork.mock.calls[0][0]).toEqual(['code']);
  });
});

describe('the completed-since window', () => {
  it('defaults to the last 24 hours', async () => {
    const before = Date.now();
    await GET(req());
    const since = Date.parse(getWork.mock.calls[0][1]);
    expect(since).toBeGreaterThanOrEqual(before - 24 * 3600_000 - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - 24 * 3600_000 + 1000);
  });

  it('passes ?since= to the database as an exact instant', async () => {
    await GET(req('?since=2026-11-10T08:00:00%2B02:00'));
    expect(getWork.mock.calls[0][1]).toBe('2026-11-10T06:00:00.000Z');
  });

  it('rejects a value that is not a timestamp before asking the database anything', async () => {
    for (const bad of ['yesterday', '2026-11-10', '2026-11-10T08:00:00junk']) {
      const res = await GET(req(`?since=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
    }
    expect(getWork).not.toHaveBeenCalled();
  });
});

describe('the response is what the hook and check_work read', () => {
  it('returns the four lists under their established names', async () => {
    getWork.mockResolvedValue({
      mentions: [mention()],
      open_matching: [{ id: 't-open' }],
      mine_claimed: [{ id: 't-claimed' }],
      completed_for_me: [{ id: 't-done' }],
    });
    const data = await body(await GET(req()));

    expect(Object.keys(data)).toEqual(['mentions', 'open_matching', 'mine_claimed', 'completed_for_me']);
    expect(data.open_matching).toEqual([{ id: 't-open' }]);
    expect(data.mine_claimed).toEqual([{ id: 't-claimed' }]);
    expect(data.completed_for_me).toEqual([{ id: 't-done' }]);
  });

  it('names mention fields as before', async () => {
    getWork.mockResolvedValue({ mentions: [mention()], open_matching: [], mine_claimed: [], completed_for_me: [] });
    const data = await body(await GET(req()));
    expect(data.mentions).toEqual([{
      mention_id: 'mn-1',
      message_id: 'm-1',
      channel: 'direct-messages',
      from: 'alice',
      from_project: 'airchat',
      content: '@me hello',
      timestamp: '2026-11-10T12:00:00+00:00',
      read: false,
    }]);
  });

  it('includes source only when the server vouches for one', async () => {
    getWork.mockResolvedValue({
      mentions: [mention({ author_source: 'claude.ai' }), mention({ mention_id: 'mn-2' })],
      open_matching: [], mine_claimed: [], completed_for_me: [],
    });
    const { mentions } = await body(await GET(req()));
    expect(mentions[0].source).toBe('claude.ai');
    expect(mentions[1]).not.toHaveProperty('source');
  });

  it('never returns more than 20 mentions', async () => {
    getWork.mockResolvedValue({
      mentions: Array.from({ length: 35 }, (_, i) => mention({ mention_id: `mn-${i}` })),
      open_matching: [], mine_claimed: [], completed_for_me: [],
    });
    expect((await body(await GET(req()))).mentions).toHaveLength(20);
  });

  it('answers 500 without detail when storage fails', async () => {
    getWork.mockRejectedValue(new Error('Failed to check work: connection refused to 10.0.0.5'));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.5');
  });
});
