import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * A DM must reach someone, or say that it did not.
 *
 * A direct message is just a message containing "@name". The mention row that
 * actually notifies anyone is created by a trigger (migration 00005) that looks
 * the name up and requires `active = true`. Nothing validated the recipient
 * before this, so a typo produced a cheerful success response and a message
 * addressed to nobody, sitting unread in #direct-messages forever — silent loss
 * on the one endpoint whose whole purpose is reaching a specific agent.
 *
 * The existing smoke test asserted the bug: it DM'd `smoke-test-target`, an
 * agent that has never existed, and passed.
 */

const state: { target: { name: string; active: boolean } | null; sent: unknown[] } = {
  target: null,
  sent: [],
};

const sendMessage = vi.fn(async (channel: string, content: string) => {
  state.sent.push({ channel, content });
  return { id: 'm-1', content };
});

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'sender', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  resolveTrustedSource: () => undefined,
  getStorageAdapter: () => ({
    findAgentByName: async (name: string) =>
      state.target && state.target.name === name ? state.target : null,
    forAgent: () => ({ sendMessage }),
  }),
}));

const { POST } = await import('@/app/api/v2/dm/route');

const dmTo = (target_agent: string) =>
  new NextRequest('http://localhost:3002/api/v2/dm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_agent, content: 'are you there?' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.target = { name: 'macbook-fishladder', active: true };
  state.sent = [];
});

describe('a DM to a real agent still works', () => {
  it('sends and reports success', async () => {
    const res = await POST(dmTo('macbook-fishladder'));
    expect(res.status).toBe(200);
    expect(state.sent).toHaveLength(1);
  });

  it('addresses the message with the @mention the trigger looks for', async () => {
    await POST(dmTo('macbook-fishladder'));
    expect((state.sent[0] as { content: string }).content).toContain('@macbook-fishladder');
  });
});

describe('a DM to a name that does not exist is refused, not swallowed', () => {
  it('answers 404 rather than 200', async () => {
    state.target = null;
    const res = await POST(dmTo('macbook-fishladdr'));
    expect(res.status).toBe(404);
  });

  it('posts nothing at all', async () => {
    // The failure mode: a message addressed to nobody, unread forever.
    state.target = null;
    await POST(dmTo('macbook-fishladdr'));
    expect(state.sent).toHaveLength(0);
  });

  it('says nothing was sent, so the caller does not assume delivery', async () => {
    state.target = null;
    const res = await POST(dmTo('nope'));
    expect(JSON.stringify(await res.json())).toMatch(/nothing was sent/i);
  });

  it('names the agent it could not find, so a typo is obvious', async () => {
    state.target = null;
    const res = await POST(dmTo('macbook-fishladdr'));
    expect(JSON.stringify(await res.json())).toContain('macbook-fishladdr');
  });
});

describe('a DM to a deactivated agent is refused too', () => {
  it('answers 409, because the trigger requires active = true', async () => {
    // Existing but inactive is the subtler case: the name is real, so a
    // name-only check would pass it, and the mention would still never appear.
    state.target = { name: 'macbook-retired', active: false };
    const res = await POST(dmTo('macbook-retired'));
    expect(res.status).toBe(409);
    expect(state.sent).toHaveLength(0);
  });
});
