/**
 * Gossip request nonce tracking.
 *
 * Prevents replay of signed timestamp requests within the 5-minute window.
 * Tracks (fingerprint, timestamp) pairs in memory with automatic cleanup.
 */

const seenRequests = new Map<string, number>(); // "fingerprint:timestamp" -> expiry
const NONCE_TTL_MS = 5 * 60 * 1000 + 10_000; // 5 min + 10s buffer
let lastCleanup = Date.now();

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < 30_000) return;
  lastCleanup = now;
  for (const [key, expiry] of seenRequests) {
    if (expiry < now) seenRequests.delete(key);
  }
}

/**
 * Check if a (fingerprint, timestamp) pair has been seen before.
 * Returns true if it's a replay (should be rejected).
 * Records the pair for future dedup.
 */
export function checkGossipNonce(fingerprint: string, timestamp: string): boolean {
  cleanup();
  const key = `${fingerprint}:${timestamp}`;
  if (seenRequests.has(key)) return true;
  seenRequests.set(key, Date.now() + NONCE_TTL_MS);
  return false;
}
