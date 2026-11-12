import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/v2/work/wait holds a request open until a message names the
 * caller. It must stay cheap to hold, tell the caller nothing but "changed",
 * and never be usable by anything except an authenticated agent.
 */

// A new agent id per test, so one test's calls do not use up another's rate limit.
const state = { authFails: false, agentId: 'a-0' };
let testNumber = 0;

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () =>
    state.authFails
      ? NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
      : { agentId: state.agentId, agentName: 'macbook-test', machineId: 'm-1' },
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

const { GET } = await import('@/app/api/v2/work/wait/route');
const { announceMessage, resetWorkSignal, openWaitCount } = await import('@/lib/work-signal');

const data = async (res: Response) => (await res.json()).data;

const get = (query = '', signal?: AbortSignal) =>
  GET(new NextRequest(`http://localhost:3002/api/v2/work/wait${query}`, { signal }));

beforeEach(() => {
  vi.useFakeTimers();
  resetWorkSignal();
  state.agentId = `a-${++testNumber}`;
  state.authFails = false;
  delete process.env.AIRCHAT_WORK_WAIT;
});
afterEach(() => { resetWorkSignal(); vi.useRealTimers(); });

describe('GET /api/v2/work/wait', () => {
  it('refuses an unauthenticated caller before doing anything else', async () => {
    state.authFails = true;
    const res = await get('?after=nonsense');
    expect(res.status).toBe(401);
    expect(openWaitCount()).toBe(0);
  });

  it('answers at once with a cursor, and never with message content', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await data(res);
    expect(Object.keys(body).sort()).toEqual(['changed', 'cursor', 'dm']);
    expect(body.changed).toBe(false);
  });

  it('holds the request, then answers when a direct message arrives', async () => {
    const { cursor } = await data(await get());
    let answered = false;
    const pending = get(`?after=${cursor}&timeout=50`).then((r) => { answered = true; return r; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(answered).toBe(false);

    announceMessage({ channelName: 'direct-messages', content: '@macbook-test secret text', authorAgentName: 'nas-a' });
    const res = await pending;
    const text = await res.clone().text();
    expect(await data(res)).toMatchObject({ changed: true, dm: true });
    expect(text).not.toContain('secret');
  });

  it('answers changed false at the timeout', async () => {
    const { cursor } = await data(await get());
    const pending = get(`?after=${cursor}&timeout=2`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await data(await pending)).toEqual({ changed: false, dm: false, cursor });
  });

  it('rejects a bad cursor or timeout with 400', async () => {
    const { cursor } = await data(await get());
    for (const q of ['?after=abc', `?after=${cursor}&timeout=0`, `?after=${cursor}&timeout=51`, `?after=${cursor}&timeout=5s`, `?after=${cursor}&timeout=-1`]) {
      expect((await get(q)).status, q).toBe(400);
    }
    expect(openWaitCount()).toBe(0);
  });

  it('answers 503 when turned off', async () => {
    process.env.AIRCHAT_WORK_WAIT = 'off';
    expect((await get()).status).toBe(503);
  });

  it('limits how often one agent may call it', async () => {
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await get()).status;
    expect(last).toBe(429);
  });
});
