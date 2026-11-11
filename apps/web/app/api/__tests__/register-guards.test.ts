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
}));

const ip = { allowed: true };
// Every bucket the registration route counts a request against, in order.
const counted: string[] = [];
const machineBucket = { full: false };
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string) => {
    counted.push(key);
    return machineBucket.full && key.startsWith('v2-register-machine:')
      ? { allowed: false, retryAfterMs: 30_000 }
      : { allowed: true };
  },
  checkIpRateLimit: () => (ip.allowed ? { allowed: true } : { allowed: false, retryAfterMs: 20_000 }),
}));

// The signature check itself is covered by the crypto tests; here it is a
// switch, so the order of the checks around it can be observed.
const signature = { valid: false };
vi.mock('@airchat/shared/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyRegistration: () => signature.valid,
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
  counted.length = 0;
  machineBucket.full = false;
  signature.valid = false;
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

/**
 * The per-machine limit used to be counted as soon as the body parsed. A
 * machine name is not a secret, so five unsigned requests a minute naming a
 * machine kept its real owner from registering at all.
 */
describe('POST /api/v2/register: the per-machine limit', () => {
  const machineKeys = () => counted.filter((k) => k.startsWith('v2-register-machine:'));

  beforeEach(() => {
    findMachine.mockResolvedValue({ id: 'm-1', machine_name: 'macbook', public_key: 'pk', active: true });
    registerAgent.mockResolvedValue({ id: 'a-1', name: 'macbook-project' });
  });

  it('is not counted for a request whose signature does not verify', async () => {
    const res = await register.POST(post('/api/v2/register', registration('macbook-project')));
    expect(res.status).toBe(403);
    expect(machineKeys()).toEqual([]);
  });

  it('is not counted for an unknown machine or a stale timestamp', async () => {
    findMachine.mockResolvedValueOnce(null);
    expect((await register.POST(post('/api/v2/register', registration('macbook-project')))).status).toBe(403);
    const stale = { ...registration('macbook-project'), timestamp: '2020-01-01T00:00:00Z' };
    expect((await register.POST(post('/api/v2/register', stale))).status).toBe(403);
    expect(machineKeys()).toEqual([]);
  });

  it('is counted once the signature verifies', async () => {
    signature.valid = true;
    const res = await register.POST(post('/api/v2/register', registration('macbook-project')));
    expect(res.status).toBe(200);
    expect(machineKeys()).toEqual(['v2-register-machine:macbook']);
  });

  it('still limits a machine that registers too often', async () => {
    signature.valid = true;
    machineBucket.full = true;
    const res = await register.POST(post('/api/v2/register', registration('macbook-project')));
    expect(res.status).toBe(429);
    expect(registerAgent).not.toHaveBeenCalled();
  });

  it('counts the per-address limit first, for every request', async () => {
    await register.POST(post('/api/v2/register', registration('macbook-project')));
    expect(counted[0]).toMatch(/^v2-register-ip:/);
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
