import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeypair } from '@airchat/shared/crypto';
import { deriveFingerprint } from '@airchat/shared/gossip';

/**
 * A peer is stored by the fingerprint its operator vouched for. The key it
 * hands over is only accepted if it hashes to that fingerprint.
 */

const fetchPeerUrl = vi.fn();
vi.mock('@/lib/url-validation', () => ({ fetchPeerUrl: (...a: unknown[]) => fetchPeerUrl(...a) }));

const { fetchPeerKey } = await import('@/lib/peer-identity');

const peer = generateKeypair();
const fp = deriveFingerprint(peer.publicKey);
const answer = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => vi.clearAllMocks());

describe('fetchPeerKey', () => {
  it('returns the key when it hashes to the expected fingerprint', async () => {
    fetchPeerUrl.mockResolvedValue(answer({ data: { public_key: peer.publicKey, display_name: '  Lab  ' } }));
    expect(await fetchPeerKey('https://peer.example/', fp)).toEqual({
      status: 'verified', publicKey: peer.publicKey, displayName: 'Lab',
    });
    expect(fetchPeerUrl.mock.calls[0][0]).toBe('https://peer.example/api/v2/gossip/identity');
  });

  it('reports a mismatch for a key with another fingerprint, whatever fingerprint the peer claims', async () => {
    const other = generateKeypair();
    fetchPeerUrl.mockResolvedValue(answer({ data: { public_key: other.publicKey, fingerprint: fp } }));
    expect(await fetchPeerKey('https://peer.example', fp)).toEqual({
      status: 'mismatch', actualFingerprint: deriveFingerprint(other.publicKey),
    });
  });

  it('reports invalid for a missing or malformed key', async () => {
    for (const data of [{}, { public_key: 'abc' }, { public_key: 42 }]) {
      fetchPeerUrl.mockResolvedValue(answer({ data }));
      expect((await fetchPeerKey('https://peer.example', fp)).status).toBe('invalid');
    }
  });

  it('reports unreachable for an error answer or a failed request', async () => {
    fetchPeerUrl.mockResolvedValue(answer({}, false));
    expect((await fetchPeerKey('https://peer.example', fp)).status).toBe('unreachable');
    fetchPeerUrl.mockRejectedValue(new Error('timeout'));
    expect((await fetchPeerKey('https://peer.example', fp)).status).toBe('unreachable');
  });
});

describe('readJsonCapped', () => {
  it('reads an answer that fits', async () => {
    const { readJsonCapped } = await import('@/lib/peer-identity');
    expect(await readJsonCapped(new Response('{"data":{"ok":true}}'), 1024)).toEqual({ data: { ok: true } });
  });

  it('refuses one larger than the limit, without reading it all', async () => {
    const { readJsonCapped } = await import('@/lib/peer-identity');
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024).fill(97)); },
    }, { highWaterMark: 0 });
    await expect(readJsonCapped(new Response(body), 256 * 1024)).rejects.toThrow();
    expect(pulled).toBeLessThan(20);
  });
});

