import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Two guards in front of registration:
 *
 * - the server's own agent names cannot be registered by a machine, and
 * - guesses at the operator secret on /admin/register-machine are throttled,
 *   as they already were everywhere else that secret is accepted.
 */

const registerAgent = vi.fn();
const findMachine = vi.fn();
const upsert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'm-1' }, error: null }) }) }));

vi.mock('@/lib/api-v2-auth', () => ({
  getStorageAdapter: () => ({
    registerAgent,
    findMachineByName: findMachine,
    findMachineByPublicKey: findMachine,
    findAgentByName: async () => null,
    countAgentsByMachine: async () => 0,
  }),
  getSupabaseClient: () => ({ from: () => ({ upsert }) }),
  forgetCachedAgent: () => {},
}));

const ip = { allowed: true };
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true }),
  checkIpRateLimit: () => (ip.allowed ? { allowed: true } : { allowed: false, retryAfterMs: 20_000 }),
}));

const register = await import('@/app/api/v2/register/route');
const registerMachine = await import('@/app/api/v2/admin/register-machine/route');

const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost:3002${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const registration = (agent_name: string) => ({
  machine_name: 'macbook',
  agent_name,
  derived_key_hash: 'a'.repeat(64),
  timestamp: new Date().toISOString(),
  nonce: 'n-' + Math.random(),
  signature: 'sig',
});

beforeEach(() => {
  vi.clearAllMocks();
  ip.allowed = true;
  vi.stubEnv('ADMIN_REGISTRATION_SECRET', 'the-operator-secret');
});

describe('POST /api/v2/register', () => {
  it.each(['dashboard-admin', 'janitor', 'summarizer', 'slack-bridge', 'Dashboard-Admin'])(
    'refuses the reserved name %s before looking anything up',
    async (name) => {
      const res = await register.POST(post('/api/v2/register', registration(name)));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('Agent name is reserved');
      expect(findMachine).not.toHaveBeenCalled();
      expect(registerAgent).not.toHaveBeenCalled();
    },
  );

  it('does not refuse an ordinary name that merely contains one', async () => {
    const res = await register.POST(post('/api/v2/register', registration('macbook-janitor')));
    expect(res.status).not.toBe(409);
  });
});

describe('POST /api/v2/admin/register-machine', () => {
  const body = (admin_secret: string) => ({
    machine_name: 'macbook',
    public_key: 'k'.repeat(44),
    admin_secret,
  });

  it('throttles per address before comparing the secret', async () => {
    ip.allowed = false;
    const res = await registerMachine.POST(post('/api/v2/admin/register-machine', body('the-operator-secret')));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('20');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret of any length', async () => {
    for (const guess of ['x', 'the-operator-secreT', 'the-operator-secret-and-more']) {
      const res = await registerMachine.POST(post('/api/v2/admin/register-machine', body(guess)));
      expect(res.status, guess).toBe(403);
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it('gets past the secret check with the right one', async () => {
    const res = await registerMachine.POST(post('/api/v2/admin/register-machine', body('the-operator-secret')));
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(429);
  });
});
