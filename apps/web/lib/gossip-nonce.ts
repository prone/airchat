/**
 * Gossip request replay tracking.
 *
 * A signed peer request is valid for a five-minute window. Within that window
 * the same request must not be accepted twice, so each accepted request leaves
 * a marker here until its window has passed.
 *
 * Call this only AFTER the request's signature has been verified. Recording
 * markers for unverified requests would let anyone fill the map with made-up
 * values, and would let a stranger burn a real peer's (fingerprint, timestamp)
 * pair before the peer's own request arrives.
 */

import crypto from 'node:crypto';

const seenRequests = new Map<string, number>(); // sha256(fingerprint, nonce) -> expiry
const NONCE_TTL_MS = 5 * 60 * 1000 + 10_000; // 5 min + 10s buffer
/**
 * Upper bound on remembered requests. Only verified requests from known peers
 * are recorded and each peer is rate limited, so normal traffic stays far
 * below this; the cap exists so a misbehaving peer cannot grow the map without
 * limit.
 */
export const MAX_TRACKED_NONCES = 50_000;
let lastCleanup = Date.now();

function removeExpired(now: number): void {
  lastCleanup = now;
  for (const [key, expiry] of seenRequests) {
    if (expiry < now) seenRequests.delete(key);
  }
}

/**
 * Record a verified request, reporting whether it was already seen.
 *
 * `nonce` is whatever makes the request unique for its sender: the request
 * signature (which covers method, path, recipient, timestamp and body) or, for
 * legacy timestamp-only signatures, the timestamp.
 *
 * Returns true when the request must be rejected: it is a replay, or the map
 * is full of unexpired entries and the request cannot be remembered. Refusing
 * in the second case keeps the guarantee that an accepted request is never
 * accepted again.
 */
export function checkGossipNonce(fingerprint: string, nonce: string): boolean {
  const now = Date.now();
  if (now - lastCleanup >= 30_000) removeExpired(now);

  // Hashed so the stored key has a fixed size whatever the caller passes.
  const key = crypto.createHash('sha256').update(`${fingerprint}\n${nonce}`).digest('hex');
  const expiry = seenRequests.get(key);
  if (expiry !== undefined && expiry >= now) return true;

  if (seenRequests.size >= MAX_TRACKED_NONCES) {
    removeExpired(now);
    if (seenRequests.size >= MAX_TRACKED_NONCES) return true;
  }

  seenRequests.set(key, now + NONCE_TTL_MS);
  return false;
}

/** Test hook: forget every recorded request. */
export function resetGossipNonces(): void {
  seenRequests.clear();
  lastCleanup = Date.now();
}
