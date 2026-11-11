import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { generateKeypair } from '@airchat/shared/crypto';
import { deriveFingerprint } from '@airchat/shared/gossip';

/**
 * Adding a peer stores the public key every later request from that peer is
 * checked against. The operator vouches for a fingerprint; the key has to be
 * the one that fingerprint is derived from. Comparing against the fingerprint
 * the remote *reports* proves nothing, since the remote can report anything.
 */

const real = generateKeypair();
const realFp = deriveFingerprint(real.publicKey);
const attacker = generateKeypair();

let identity: unknown = null;
let identityReachable = true;

const addPeer = vi.fn(async (peer: Record<string, unknown>) => ({ id: 'p-1', ...peer }));
vi.mock('@/lib/api-v2-auth', () => ({ getGossipAdapter: () => ({ addPeer }) }));
vi.mock('@/lib/instance-admin', () => ({
  requireInstanceAdmin: async () => null,
  authenticateAgentOrAdmin: async () => ({}),
}));
vi.mock('@/lib/url-validation', () => ({
  validatePeerEndpoint: async () => ({ valid: true }),
  fetchPeerUrl: async () => {
    if (!identityReachable) throw new Error('unreachable');
    return { ok: true, json: async () => ({ data: identity }) };
  },
}));

const { POST } = await import('@/app/api/v2/gossip/peers/route');

const add = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/v2/gossip/peers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://peer.example', ...body }),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  identityReachable = true;
  identity = { public_key: real.publicKey, fingerprint: realFp, display_name: 'Real Peer' };
});

describe('adding a peer', () => {
  it('stores the key when it hashes to the fingerprint the operator gave', async () => {
    const res = await add({ fingerprint: realFp });
    expect(res.status).toBe(201);
    expect(addPeer).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: realFp, public_key: real.publicKey }));
  });

  it('refuses a key that does not hash to that fingerprint, whatever fingerprint the remote reports', async () => {
    // The remote echoes the expected fingerprint but hands over its own key.
    identity = { public_key: attacker.publicKey, fingerprint: realFp };
    const res = await add({ fingerprint: realFp });
    expect(res.status).toBe(409);
    expect(addPeer).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['not a string', 12345],
    ['the wrong length', 'abcd'],
  ])('refuses a remote public key that is %s', async (_label, public_key) => {
    identity = { public_key, fingerprint: realFp };
    expect((await add({ fingerprint: realFp })).status).toBe(409);
    expect(addPeer).not.toHaveBeenCalled();
  });

  it.each([
    ['the first 8 characters', realFp.slice(0, 8)],
    ['15 characters', realFp.slice(0, 15)],
    ['17 characters', `${realFp}0`],
    ['not hex', 'zzzzzzzzzzzzzzzz'],
    ['missing', undefined],
    ['not a string', 1234567890123456],
  ])('requires the full fingerprint: refuses %s', async (_label, fingerprint) => {
    expect((await add({ fingerprint })).status).toBe(400);
    expect(addPeer).not.toHaveBeenCalled();
  });

  it('accepts the fingerprint in uppercase or with surrounding spaces', async () => {
    expect((await add({ fingerprint: ` ${realFp.toUpperCase()} ` })).status).toBe(201);
    expect(addPeer).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: realFp }));
  });

  it('adds the peer without a key when the remote cannot be reached', async () => {
    identityReachable = false;
    expect((await add({ fingerprint: realFp })).status).toBe(201);
    expect(addPeer).toHaveBeenCalledWith(expect.objectContaining({ public_key: null }));
  });

  it('does not store a display name that is not text', async () => {
    identity = { public_key: real.publicKey, fingerprint: realFp, display_name: { toString: () => 'x' } };
    await add({ fingerprint: realFp });
    expect(addPeer).toHaveBeenCalledWith(expect.objectContaining({ display_name: null }));
  });
});
