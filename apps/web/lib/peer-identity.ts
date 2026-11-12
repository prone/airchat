import { readBodyCapped } from '@airchat/shared/rest-client';
import { deriveFingerprint } from '@airchat/shared/gossip';
import { fetchPeerUrl } from '@/lib/url-validation';
import { PUBLIC_KEY_RE } from '@/lib/gossip-auth';

/**
 * Ask a peer for its public key and check it against the fingerprint the
 * operator vouched for.
 *
 * The fingerprint a remote reports about itself is just a string it chose.
 * What identifies it is its public key, so the fingerprint is recomputed from
 * the key it returned and compared with the expected one. A key that does not
 * hash to that fingerprint is never returned as verified.
 */
export type PeerKeyResult =
  | { status: 'verified'; publicKey: string; displayName: string | null }
  /** No usable answer: the peer is down, slow, or returned an error. Worth trying again. */
  | { status: 'unreachable' }
  /** It answered, without a well-formed public key. */
  | { status: 'invalid' }
  /** It answered with a key belonging to a different fingerprint. */
  | { status: 'mismatch'; actualFingerprint: string };

/**
 * A response body as JSON, read with a limit. What answers a request to a
 * peer chooses how much it sends; `res.json()` would hold all of it.
 */
export async function readJsonCapped(res: Response, maxBytes: number): Promise<any> {
  // A real response to a request always has a body stream.
  if (!res.body) return res.json();
  return JSON.parse(await readBodyCapped(res, maxBytes, 'throw'));
}

export async function fetchPeerKey(endpoint: string, expectedFingerprint: string): Promise<PeerKeyResult> {
  let identity: { public_key?: unknown; display_name?: unknown } | null = null;
  try {
    const res = await fetchPeerUrl(`${endpoint.replace(/\/$/, '')}/api/v2/gossip/identity`, { timeoutMs: 10000 });
    if (!res.ok) return { status: 'unreachable' };
    // An identity is a few hundred bytes, and a stranger is answering.
    const json = await readJsonCapped(res, 64 * 1024);
    // The identity endpoint wraps its answer: the fields are under `data`.
    identity = json?.data ?? json;
  } catch {
    return { status: 'unreachable' };
  }

  const key = identity?.public_key;
  if (typeof key !== 'string' || !PUBLIC_KEY_RE.test(key)) return { status: 'invalid' };
  const actualFingerprint = deriveFingerprint(key);
  if (actualFingerprint !== expectedFingerprint) return { status: 'mismatch', actualFingerprint };
  return { status: 'verified', publicKey: key, displayName: peerDisplayName(identity?.display_name) };
}

/** A display name as text of bounded length, or null. The remote one is whatever the peer chose to send. */
export function peerDisplayName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : null;
}
