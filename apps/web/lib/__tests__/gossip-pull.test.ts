import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeypair } from '@airchat/shared/crypto';
import { deriveFingerprint, verifySignature } from '@airchat/shared/gossip';

/**
 * Pulling from a peer: how the request is signed, and how little is assumed
 * about the answer. The response body is written entirely by the peer.
 */

const me = generateKeypair();
const myFp = deriveFingerprint(me.publicKey);
const them = generateKeypair();
const theirFp = deriveFingerprint(them.publicKey);

const peer = {
  id: 'peer-1', endpoint: 'https://peer.example', fingerprint: theirFp, public_key: them.publicKey,
  display_name: 'Peer', peer_type: 'instance', federation_scope: 'global', active: true, suspended: false,
  last_sync_at: '2026-01-01T00:00:00.000Z', last_sync_error: 'HTTP 500', messages_received: 0, messages_quarantined: 0,
};

const gossip = {
  getInstanceConfig: vi.fn(async () => ({ id: 'cfg', public_key: me.publicKey, fingerprint: myFp, gossip_enabled: true })),
  getPeerById: vi.fn(async () => peer),
  listPeers: vi.fn(async () => [peer]),
  updatePeer: vi.fn(async (_id: string, _updates: Record<string, unknown>) => {}),
};
vi.mock('@/lib/api-v2-auth', () => ({ getGossipAdapter: () => gossip }));

const fetchPeerUrl = vi.fn();
vi.mock('@/lib/url-validation', () => ({ fetchPeerUrl: (...args: unknown[]) => fetchPeerUrl(...args) }));

process.env.INSTANCE_PRIVATE_KEY = me.privateKey;

const { triggerSyncFromPeer } = await import('@/lib/gossip-sync');
const { buildRequestSignPayload } = await import('@/lib/gossip-auth');

const answer = (body: unknown) => fetchPeerUrl.mockResolvedValue({ ok: true, status: 200, json: async () => body });
const savedCursor = () => gossip.updatePeer.mock.calls[0][1].last_sync_at as string;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the sync request', () => {
  it('is signed for this one peer and this exact URL, with the old signature alongside', async () => {
    answer({ data: { messages: [], retractions: [], sync_timestamp: new Date().toISOString() } });
    await triggerSyncFromPeer('peer-1');

    const [url, init] = fetchPeerUrl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('https://peer.example/api/v2/gossip/sync?since=');
    const payload = (recipientFingerprint: string) => buildRequestSignPayload({
      method: 'GET', url: new URL(url), recipientFingerprint,
      timestamp: init.headers['x-gossip-timestamp'], body: '',
    });
    expect(init.headers['x-gossip-fingerprint']).toBe(myFp);
    expect(verifySignature(me.publicKey, payload(theirFp), init.headers['x-gossip-signature-v2'])).toBe(true);
    expect(verifySignature(me.publicKey, payload(myFp), init.headers['x-gossip-signature-v2'])).toBe(false);
    expect(init.headers['x-gossip-signature']).toBeUndefined();
  });
});

describe('the sync response', () => {
  it.each([
    ['lists that are not lists', { data: { messages: 'nope', retractions: { length: 5 }, sync_timestamp: 12 } }],
    ['null', null],
    ['a bare string', 'hello'],
    ['entries that are not objects', { messages: [null, 3, 'x', []], retractions: [null, 3, 'x'] }],
  ])('is survived when it contains %s', async (_label, body) => {
    answer(body);
    await triggerSyncFromPeer('peer-1');
    // The sync completed: the earlier error is cleared rather than replaced.
    expect(gossip.updatePeer).toHaveBeenCalledTimes(1);
    expect(gossip.updatePeer.mock.calls[0][1]).toMatchObject({ last_sync_error: null });
  });

  it('uses the cursor the peer returns when it is a sane timestamp', async () => {
    const theirs = new Date(Date.now() - 1000).toISOString();
    answer({ messages: [], retractions: [], sync_timestamp: theirs });
    await triggerSyncFromPeer('peer-1');
    expect(savedCursor()).toBe(theirs);
  });

  it.each([
    ['far in the future', '2999-01-01T00:00:00.000Z'],
    ['not a date', 'whenever'],
    ['missing', undefined],
  ])('falls back to its own clock when the returned cursor is %s', async (_label, sync_timestamp) => {
    // A future cursor would make every later sync ask for "messages since
    // 2999" and silently receive nothing.
    const before = Date.now();
    answer({ messages: [], retractions: [], sync_timestamp });
    await triggerSyncFromPeer('peer-1');
    const saved = new Date(savedCursor()).getTime();
    expect(saved).toBeGreaterThanOrEqual(before - 1000);
    expect(saved).toBeLessThanOrEqual(Date.now());
  });
});
