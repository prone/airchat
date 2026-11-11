import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Federation administration is an operator action, not an agent action.
 *
 * Enabling gossip, adding or removing peers, and reading or releasing
 * quarantined messages used to need only an ordinary agent key. Agents read
 * untrusted text constantly, so one prompt injection could have connected the
 * instance to an attacker's server and approved its quarantined content.
 */

const state = {
  agentValid: true,
  user: null as null | { id: string },
  admin: false,
};

const gossip = {
  getInstanceConfig: vi.fn(async () => ({ gossip_enabled: false })),
  updateInstanceConfig: vi.fn(async () => {}),
  upsertPeerByEndpoint: vi.fn(async () => {}),
  listPeers: vi.fn(async () => []),
  countRecentQuarantined: vi.fn(async () => 0),
  addPeer: vi.fn(async () => ({ id: 'p-1' })),
  removePeer: vi.fn(async () => {}),
  removePeerByEndpoint: vi.fn(async () => {}),
  listQuarantinedMessages: vi.fn(async () => ({ messages: [], total: 0 })),
  approveMessages: vi.fn(async () => 1),
  deleteQuarantinedMessages: vi.fn(async () => 1),
};

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () =>
    state.agentValid
      ? { agentId: 'a-1', agentName: 'macbook-test', machineId: 'm-1' }
      : NextResponse.json({ error: 'Invalid API key' }, { status: 401 }),
  isDashboardAdmin: async () => state.admin,
  getGossipAdapter: () => gossip,
}));

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

const ipLimit = { allowed: true };
vi.mock('@/lib/rate-limit', () => ({
  checkIpRateLimit: () => (ipLimit.allowed ? { allowed: true } : { allowed: false, retryAfterMs: 30_000 }),
}));

vi.mock('@/lib/gossip-sync', () => ({
  ensureSyncWorker: async () => {},
  startSyncWorker: () => {},
}));

vi.mock('@/lib/url-validation', () => ({
  validatePeerEndpoint: async () => ({ valid: true }),
  fetchPeerUrl: async () => ({ ok: false }),
}));

const root = await import('@/app/api/v2/gossip/route');
const peers = await import('@/app/api/v2/gossip/peers/route');
const quarantine = await import('@/app/api/v2/gossip/quarantine/route');

const MSG_ID = '11111111-1111-4111-8111-111111111111';
const req = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
  new NextRequest(`http://localhost:3002${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Every operator-only action, as a function of the credentials presented. */
const adminActions: Array<[string, (h: Record<string, string>) => Promise<Response>]> = [
  ['enable gossip', (h) => root.POST(req('/api/v2/gossip', 'POST', h, { action: 'enable' }))],
  ['add a peer', (h) => peers.POST(req('/api/v2/gossip/peers', 'POST', h, { endpoint: 'https://peer.example', fingerprint: 'abcdef0123456789' }))],
  ['remove a peer', (h) => peers.DELETE(req('/api/v2/gossip/peers', 'DELETE', h, { endpoint: 'https://peer.example' }))],
  ['read quarantined messages', (h) => quarantine.GET(req('/api/v2/gossip/quarantine', 'GET', h))],
  ['approve quarantined messages', (h) => quarantine.POST(req('/api/v2/gossip/quarantine', 'POST', h, { action: 'approve', message_ids: [MSG_ID] }))],
];

const AGENT = { 'x-agent-api-key': 'a-valid-agent-key' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ADMIN_REGISTRATION_SECRET', 'operator-secret');
  state.agentValid = true;
  state.user = null;
  state.admin = false;
});

describe('a valid agent key alone', () => {
  it.each(adminActions)('cannot %s', async (_name, act) => {
    expect((await act(AGENT)).status).toBe(403);
    for (const fn of Object.values(gossip)) expect(fn).not.toHaveBeenCalled();
  });

  it('can still read status and the peer list', async () => {
    expect((await root.GET(req('/api/v2/gossip', 'GET', AGENT))).status).toBe(200);
    expect((await peers.GET(req('/api/v2/gossip/peers', 'GET', AGENT))).status).toBe(200);
  });
});

describe('no credential, a wrong secret, or a non-admin session', () => {
  it.each(adminActions)('cannot %s', async (_name, act) => {
    expect((await act({})).status).toBe(401);
    expect((await act({ ...AGENT, 'x-admin-secret': 'wrong' })).status).toBe(403);
    state.user = { id: 'u-1' };
    expect((await act({})).status).toBe(403);
    for (const fn of Object.values(gossip)) expect(fn).not.toHaveBeenCalled();
  });

  it('a secret is refused when the server has none configured', async () => {
    vi.stubEnv('ADMIN_REGISTRATION_SECRET', '');
    const res = await root.POST(req('/api/v2/gossip', 'POST', { 'x-admin-secret': '' + 'anything' }, { action: 'enable' }));
    expect(res.status).toBe(403);
  });
});

describe('an instance admin', () => {
  it.each(adminActions)('with the operator secret can %s', async (_name, act) => {
    expect((await act({ ...AGENT, 'x-admin-secret': 'operator-secret' })).status).toBeLessThan(300);
  });

  it.each(adminActions)('with a dashboard admin session can %s', async (_name, act) => {
    state.user = { id: 'u-1' };
    state.admin = true;
    expect((await act({})).status).toBeLessThan(300);
  });

  it('with a dashboard admin session can read status (the dashboard sends no agent key)', async () => {
    state.user = { id: 'u-1' };
    state.admin = true;
    expect((await root.GET(req('/api/v2/gossip', 'GET', {}))).status).toBe(200);
  });
});

describe('guessing the admin secret', () => {
  const guess = (secret: string) =>
    new NextRequest('http://localhost:3002/api/v2/gossip', {
      method: 'POST',
      headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enable' }),
    });

  beforeEach(() => {
    ipLimit.allowed = true;
    process.env.ADMIN_REGISTRATION_SECRET = 'the-real-secret-value';
  });

  it('refuses a guess of a different length', async () => {
    expect((await root.POST(guess('short'))).status).toBe(403);
    expect((await root.POST(guess('the-real-secret-value-and-more'))).status).toBe(403);
  });

  it('refuses every guess when no secret is configured', async () => {
    delete process.env.ADMIN_REGISTRATION_SECRET;
    expect((await root.POST(guess('the-real-secret-value'))).status).toBe(403);
    expect((await root.POST(guess(''))).status).not.toBe(200);
  });

  it('is throttled per address, even with the right secret', async () => {
    ipLimit.allowed = false;
    const res = await root.POST(guess('the-real-secret-value'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(gossip.updateInstanceConfig).not.toHaveBeenCalled();
  });

  it('accepts the right secret', async () => {
    expect((await root.POST(guess('the-real-secret-value'))).status).toBe(200);
  });
});
