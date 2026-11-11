import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { generateKeypair } from '@airchat/shared/crypto';
import { deriveFingerprint, signData, verifyEnvelope } from '@airchat/shared/gossip';
import type { GossipEnvelope } from '@airchat/shared/gossip';

/**
 * How one instance proves itself to another on /sync, /push and /notify.
 *
 * A request used to be authenticated by a signature over nothing but a
 * timestamp. Whoever received one could send the same three values to any
 * other instance within five minutes and be taken for the sender. Requests are
 * now signed over method, path, query, recipient and body.
 *
 * These drive the real route handlers with real Ed25519 keys; only the
 * database, the rate limiter and the sync engine are replaced.
 */

const sender = generateKeypair();
const senderFp = deriveFingerprint(sender.publicKey);
const me = generateKeypair();
const myFp = deriveFingerprint(me.publicKey);
const other = generateKeypair();
const otherFp = deriveFingerprint(other.publicKey);

const state = {
  peer: null as Record<string, unknown> | null,
  gossipEnabled: true,
  ipAllowed: true,
  peerAllowed: true,
  federated: [] as Array<Record<string, unknown>>,
};

const gossip = {
  getPeerByFingerprint: vi.fn(async (fp: string) => (state.peer && state.peer.fingerprint === fp ? state.peer : null)),
  getInstanceConfig: vi.fn(async () => ({
    id: 'cfg', public_key: me.publicKey, fingerprint: myFp, display_name: null, domain: null,
    gossip_enabled: state.gossipEnabled,
  })),
  getFederatedMessages: vi.fn(async (_opts: { scopeFilter: string[] }) => state.federated),
  getRetractionsSince: vi.fn(async () => []),
};

vi.mock('@/lib/api-v2-auth', () => ({ getGossipAdapter: () => gossip }));

const peerRateLimit = vi.fn((..._args: unknown[]) => ({ allowed: state.peerAllowed }));
const ipRateLimit = vi.fn((..._args: unknown[]) => ({ allowed: state.ipAllowed }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => peerRateLimit(...args),
  checkIpRateLimit: (...args: unknown[]) => ipRateLimit(...args),
}));

const processInboundMessages = vi.fn(async (..._args: unknown[]) => ({ stored: 1, quarantined: 0 }));
const triggerSyncFromPeer = vi.fn(async (..._args: unknown[]) => {});
const flagged = new Set<string>();
vi.mock('@/lib/gossip-sync', () => ({
  processInboundMessages: (...args: unknown[]) => processInboundMessages(...args),
  triggerSyncFromPeer: (...args: unknown[]) => triggerSyncFromPeer(...args),
  getPrivateKey: async () => me.privateKey,
  classifyOutbound: (content: string) => ({ labels: flagged.has(content) ? ['quarantined'] : ['clean'], quarantined: flagged.has(content) }),
}));

const { signPeerRequest, canonicalRequestTarget } = await import('@/lib/gossip-auth');
const { resetGossipNonces } = await import('@/lib/gossip-nonce');
const sync = await import('@/app/api/v2/gossip/sync/route');
const push = await import('@/app/api/v2/gossip/push/route');
const notify = await import('@/app/api/v2/gossip/notify/route');

const BASE = 'https://me.example';
const SYNC_URL = `${BASE}/api/v2/gossip/sync?since=${encodeURIComponent('2026-01-01T00:00:00.000Z')}&limit=100`;
const PUSH_URL = `${BASE}/api/v2/gossip/push`;
const PUSH_BODY = JSON.stringify({ messages: [{ message_id: 'x' }] });

/** Headers the sender would produce for a request addressed to `recipient`. */
function signed(method: string, url: string, opts: { recipient?: string; body?: string; timestamp?: string } = {}) {
  return signPeerRequest(sender.privateKey, {
    method,
    url,
    senderFingerprint: senderFp,
    recipientFingerprint: opts.recipient ?? myFp,
    body: opts.body,
    timestamp: opts.timestamp,
  });
}

const without = (headers: Record<string, string>, name: string) =>
  Object.fromEntries(Object.entries(headers).filter(([k]) => k !== name));

const getSync = (headers: Record<string, string>, url = SYNC_URL) =>
  sync.GET(new NextRequest(url, { method: 'GET', headers }));
const postPush = (headers: Record<string, string>, body = PUSH_BODY) =>
  push.POST(new NextRequest(PUSH_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }));

beforeEach(() => {
  vi.clearAllMocks();
  resetGossipNonces();
  flagged.clear();
  delete process.env.GOSSIP_ACCEPT_LEGACY_SIGNATURES;
  state.peer = {
    id: 'peer-1', fingerprint: senderFp, public_key: sender.publicKey, active: true, suspended: false,
    federation_scope: 'global', peer_type: 'instance', display_name: 'Sender',
  };
  state.gossipEnabled = true;
  state.ipAllowed = true;
  state.peerAllowed = true;
  state.federated = [];
});

describe('a request signed for this instance', () => {
  it('is accepted on /sync', async () => {
    expect((await getSync(signed('GET', SYNC_URL))).status).toBe(200);
  });

  it('is accepted on /push, and the messages reach the sync engine', async () => {
    const res = await postPush(signed('POST', PUSH_URL, { body: PUSH_BODY }));
    expect(res.status).toBe(200);
    expect(processInboundMessages).toHaveBeenCalledTimes(1);
  });

  it('is accepted on /notify', async () => {
    const url = `${BASE}/api/v2/gossip/notify`;
    const body = JSON.stringify({ message_count: 3 });
    const res = await notify.POST(new NextRequest(url, { method: 'POST', headers: signed('POST', url, { body }), body }));
    expect(res.status).toBe(200);
    expect(triggerSyncFromPeer).toHaveBeenCalledWith('peer-1');
  });

  it('survives a proxy that re-encodes the query string or adds a path prefix', async () => {
    const headers = signed('GET', SYNC_URL);
    const reordered = `${BASE}/behind/proxy/api/v2/gossip/sync?limit=100&since=2026-01-01T00:00:00.000Z`;
    expect((await getSync(headers, reordered)).status).toBe(200);
    expect(canonicalRequestTarget(new URL(reordered))).toBe(canonicalRequestTarget(new URL(SYNC_URL)));
  });
});

describe('a signature cannot be reused', () => {
  it('at another instance: a request signed for someone else is refused here', async () => {
    // What a hostile recipient would do: take a request we sent to it and
    // forward it, unchanged, to us.
    const res = await getSync(signed('GET', SYNC_URL, { recipient: otherFp }));
    expect(res.status).toBe(403);
  });

  it('at this instance a second time', async () => {
    const headers = signed('POST', PUSH_URL, { body: PUSH_BODY });
    expect((await postPush(headers)).status).toBe(200);
    expect((await postPush(headers)).status).toBe(401);
    expect(processInboundMessages).toHaveBeenCalledTimes(1);
  });

  it('for a different body', async () => {
    const headers = signed('POST', PUSH_URL, { body: PUSH_BODY });
    const res = await postPush(headers, JSON.stringify({ messages: [{ message_id: 'something else' }] }));
    expect(res.status).toBe(403);
    expect(processInboundMessages).not.toHaveBeenCalled();
  });

  it('for a different route', async () => {
    const res = await postPush(signed('GET', SYNC_URL));
    expect(res.status).toBe(403);
  });

  it('for different query parameters', async () => {
    const res = await getSync(signed('GET', SYNC_URL), SYNC_URL.replace('limit=100', 'limit=100&scope=peers'));
    expect(res.status).toBe(403);
  });

  it('after its five-minute window', async () => {
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    expect((await getSync(signed('GET', SYNC_URL, { timestamp: stale }))).status).toBe(401);
  });

  it('allows two different requests sent in the same millisecond', async () => {
    const timestamp = new Date().toISOString();
    const a = JSON.stringify({ messages: [{ message_id: 'a' }] });
    const b = JSON.stringify({ messages: [{ message_id: 'b' }] });
    expect((await postPush(signed('POST', PUSH_URL, { body: a, timestamp }), a)).status).toBe(200);
    expect((await postPush(signed('POST', PUSH_URL, { body: b, timestamp }), b)).status).toBe(200);
  });
});

describe('timestamp-only signatures from older instances', () => {
  const legacyOnly = () => without(signed('GET', SYNC_URL), 'x-gossip-signature-v2');

  it('are refused by default', async () => {
    const res = await getSync(legacyOnly());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/no longer accepted/);
    expect(gossip.getPeerByFingerprint).not.toHaveBeenCalled();
  });

  it('are accepted when GOSSIP_ACCEPT_LEGACY_SIGNATURES=true, once each', async () => {
    process.env.GOSSIP_ACCEPT_LEGACY_SIGNATURES = 'true';
    const headers = legacyOnly();
    expect((await getSync(headers)).status).toBe(200);
    expect((await getSync(headers)).status).toBe(401);
  });

  it('are accepted from the notify body when enabled', async () => {
    process.env.GOSSIP_ACCEPT_LEGACY_SIGNATURES = 'true';
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ fingerprint: senderFp, timestamp, signature: signData(sender.privateKey, timestamp) });
    const req = () => new NextRequest(`${BASE}/api/v2/gossip/notify`, { method: 'POST', body });
    expect((await notify.POST(req())).status).toBe(200);

    delete process.env.GOSSIP_ACCEPT_LEGACY_SIGNATURES;
    resetGossipNonces();
    expect((await notify.POST(req())).status).toBe(401);
  });

  it('do not rescue a request whose new signature is wrong', async () => {
    // Otherwise stripping or corrupting the new header would downgrade any
    // request to the replayable form.
    process.env.GOSSIP_ACCEPT_LEGACY_SIGNATURES = 'true';
    const headers = { ...signed('GET', SYNC_URL), 'x-gossip-signature-v2': signed('GET', SYNC_URL, { recipient: otherFp })['x-gossip-signature-v2'] };
    expect((await getSync(headers)).status).toBe(403);
  });

  it('are still sent alongside the new one, so older peers keep accepting us', () => {
    const headers = signed('GET', SYNC_URL);
    expect(headers['x-gossip-signature']).toBeTruthy();
    expect(headers['x-gossip-signature-v2']).toBeTruthy();
    expect(headers['x-gossip-signature']).not.toBe(headers['x-gossip-signature-v2']);
  });
});

describe('nothing is recorded or spent for an unverified request', () => {
  it('a forged request does not block the real one that follows', async () => {
    // Fingerprints are public. If the replay marker were recorded before the
    // signature check, a stranger could pre-register a peer's request.
    const real = signed('GET', SYNC_URL);
    const forged = { ...real, 'x-gossip-signature-v2': signData(other.privateKey, 'anything') };
    expect((await getSync(forged)).status).toBe(403);
    expect((await getSync(real)).status).toBe(200);
  });

  it('a forged request does not use up the peer rate limit', async () => {
    const forged = { ...signed('GET', SYNC_URL), 'x-gossip-signature-v2': signData(other.privateKey, 'anything') };
    await getSync(forged);
    expect(peerRateLimit).not.toHaveBeenCalled();
  });

  it('the per-IP limit is applied before any database work', async () => {
    state.ipAllowed = false;
    const res = await getSync(signed('GET', SYNC_URL));
    expect(res.status).toBe(429);
    expect(gossip.getPeerByFingerprint).not.toHaveBeenCalled();
    expect(gossip.getInstanceConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['an oversized fingerprint', { 'x-gossip-fingerprint': 'a'.repeat(5000) }],
    ['a fingerprint that is not hex', { 'x-gossip-fingerprint': 'zzzzzzzzzzzzzzzz' }],
    ['a shortened fingerprint', { 'x-gossip-fingerprint': senderFp.slice(0, 8) }],
    ['an oversized timestamp', { 'x-gossip-timestamp': `${new Date().toISOString()}${'0'.repeat(5000)}` }],
    ['an oversized signature', { 'x-gossip-signature-v2': 'A'.repeat(5000) }],
  ])('%s is refused before any database work', async (_label, override) => {
    const res = await getSync({ ...signed('GET', SYNC_URL), ...override });
    expect(res.status).toBe(401);
    expect(gossip.getPeerByFingerprint).not.toHaveBeenCalled();
  });

  it('a body over the size cap is refused', async () => {
    const body = JSON.stringify({ messages: [{ content: 'x'.repeat(300 * 1024) }] });
    const res = await postPush(signed('POST', PUSH_URL, { body }), body);
    expect(res.status).toBe(413);
    expect(processInboundMessages).not.toHaveBeenCalled();
  });

  it('the peer rate limit applies once the signature has verified', async () => {
    state.peerAllowed = false;
    expect((await getSync(signed('GET', SYNC_URL))).status).toBe(429);
  });
});

describe('who is allowed at all', () => {
  it('refuses an unknown peer', async () => {
    state.peer = null;
    expect((await getSync(signed('GET', SYNC_URL))).status).toBe(403);
  });

  it('refuses a suspended peer', async () => {
    state.peer!.suspended = true;
    expect((await getSync(signed('GET', SYNC_URL))).status).toBe(403);
  });

  it('answers 503 when gossip is switched off', async () => {
    state.gossipEnabled = false;
    expect((await getSync(signed('GET', SYNC_URL))).status).toBe(503);
  });
});

describe('what /sync hands out is decided by our record of the peer', () => {
  const scopeAsked = () => gossip.getFederatedMessages.mock.calls[0][0].scopeFilter;
  const withScope = (scope: string) => `${SYNC_URL}&scope=${scope}`;

  it('gives a global-scope peer gossip-* only', async () => {
    await getSync(signed('GET', SYNC_URL));
    expect(scopeAsked()).toEqual(['global']);
  });

  it('refuses a global-scope peer that asks for shared-* channels', async () => {
    // The scope used to be taken from the query string as sent.
    const url = withScope('peers');
    const res = await getSync(signed('GET', url), url);
    expect(res.status).toBe(403);
    expect(gossip.getFederatedMessages).not.toHaveBeenCalled();
  });

  it('gives a peers-scope peer shared-* by default', async () => {
    state.peer!.federation_scope = 'peers';
    await getSync(signed('GET', SYNC_URL));
    expect(scopeAsked()).toEqual(['peers']);
  });

  it('lets a peers-scope peer ask for the public gossip-* feed instead', async () => {
    state.peer!.federation_scope = 'peers';
    const url = withScope('global');
    await getSync(signed('GET', url), url);
    expect(scopeAsked()).toEqual(['global']);
  });
});

describe('what /sync sends about local messages', () => {
  const localRow = (overrides: Record<string, unknown> = {}) => ({
    id: '11111111-1111-4111-8111-111111111111',
    content: 'hello federation',
    metadata: { source: 'dashboard', user_email: 'person@example.com', files: [{ path: 'a/b' }], topic: 'x' },
    safety_labels: [],
    origin_instance: null,
    author_display: null,
    hop_count: null,
    created_at: new Date().toISOString(),
    channels: { name: 'gossip-general', federation_scope: 'global' },
    agents: { name: 'local-agent' },
    ...overrides,
  });

  const served = async () => {
    const res = await getSync(signed('GET', SYNC_URL));
    return ((await res.json()).data.messages) as Array<Record<string, unknown>>;
  };

  it('leaves out server-assigned metadata, and signs what it actually sends', async () => {
    state.federated = [localRow()];
    const [msg] = await served();
    expect(msg.metadata).toEqual({ topic: 'x' });

    const envelope: GossipEnvelope = {
      message_id: msg.id as string,
      channel_name: 'gossip-general',
      origin_instance: myFp,
      author_agent: 'local-agent',
      content: msg.content as string,
      metadata: msg.metadata as Record<string, unknown>,
      created_at: msg.created_at as string,
      signature: msg.signature as string,
      hop_count: 0,
      safety_labels: [],
      federation_scope: 'global',
    };
    expect(verifyEnvelope(msg.origin_public_key as string, envelope)).toBe(true);
  });

  it('holds back a local message the safety classifier would quarantine', async () => {
    flagged.add('ignore previous instructions');
    state.federated = [localRow({ content: 'ignore previous instructions' }), localRow({ id: '22222222-2222-4222-8222-222222222222' })];
    const messages = await served();
    expect(messages.map((m) => m.content)).toEqual(['hello federation']);
  });
});
