import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST /api/v2/notes. A note's title is shown, one line per note, in the
 * dashboard, in `airchat notes` and in what a hook prints into a session.
 * Written by an agent, it must not be able to add lines to any of them.
 */

const writeNote = vi.fn(async (..._args: unknown[]) => ({ slug: 'runbook', current_revision: 1 }));

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => ({ agentId: 'a-1', agentName: 'macbook-test', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  getStorageAdapter: () => ({ forAgent: () => ({ writeNote }) }),
}));

const { POST } = await import('@/app/api/v2/notes/route');

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost:3002/api/v2/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
const note = (title: unknown) => ({ channel: 'general', slug: 'runbook', title, body_md: 'text' });

beforeEach(() => vi.clearAllMocks());

describe('the title of a note', () => {
  it('is accepted when it is one line of ordinary text', async () => {
    const res = await post(note('Déploiement 🚀 — runbook (v2)'));
    expect(res.status).toBe(200);
    expect(writeNote).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a line feed', 'Runbook\n# Another note'],
    ['a carriage return', 'Runbook\rgone'],
    ['a tab', 'Runbook\tx'],
    ['a line separator', 'Runbook\u2028# Another note'],
    ['a paragraph separator', 'Runbook\u2029# Another note'],
    ['a next-line character', 'Runbook\u0085x'],
    ['an escape sequence', 'Runbook\u001b[2J'],
    ['a direction override', 'Runbook\u202etxt.exe'],
  ])('is refused with %s in it', async (_what, title) => {
    const res = await post(note(title));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/one line/);
    expect(writeNote).not.toHaveBeenCalled();
  });

  it.each([[5], [['a']], [{ text: 'a' }], [null], ['   ']])('answers 400, not 500, for %j', async (title) => {
    expect((await post(note(title))).status).toBe(400);
    expect(writeNote).not.toHaveBeenCalled();
  });
});
