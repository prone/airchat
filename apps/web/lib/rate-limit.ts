/**
 * In-memory sliding window rate limiter.
 * Two layers: per-API-key and per-IP (prevents brute-force with rotating keys).
 * Resets on process restart (acceptable at this scale — matches
 * the existing _keyCache patterns).
 */

import crypto from 'crypto';

type WindowEntry = { timestamps: number[]; lastCleanup: number };

const windows = new Map<string, WindowEntry>();

// Cleanup stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WINDOW_ENTRIES = 10_000; // Prevent unbounded memory growth
let lastGlobalCleanup = Date.now();

function cleanupStaleEntries(windowMs: number) {
  const now = Date.now();
  if (now - lastGlobalCleanup < CLEANUP_INTERVAL_MS) return;
  lastGlobalCleanup = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of windows) {
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
    if (entry.timestamps.length === 0) {
      windows.delete(key);
    }
  }
  // Hard cap on map size to prevent memory exhaustion
  if (windows.size > MAX_WINDOW_ENTRIES) {
    const toDelete = windows.size - MAX_WINDOW_ENTRIES;
    const iter = windows.keys();
    for (let i = 0; i < toDelete; i++) {
      const key = iter.next().value;
      if (key) windows.delete(key);
    }
  }
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
};

function _checkWindow(
  bucketKey: string,
  windowMs: number,
  maxRequests: number
): RateLimitResult {
  const now = Date.now();
  cleanupStaleEntries(windowMs);

  let entry = windows.get(bucketKey);
  if (!entry) {
    entry = { timestamps: [], lastCleanup: now };
    windows.set(bucketKey, entry);
  }

  const cutoff = now - windowMs;
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfterMs = oldestInWindow + windowMs - now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(retryAfterMs, 1000),
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    remaining: maxRequests - entry.timestamps.length,
  };
}

/**
 * Check if a request is within rate limits.
 * Uses full SHA-256 hash to avoid collision-based bucket sharing.
 */
export function checkRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number
): RateLimitResult {
  const hashedKey = crypto.createHash('sha256').update(key).digest('hex');
  return _checkWindow(`key:${hashedKey}`, windowMs, maxRequests);
}

/**
 * IP-based rate limit — catches brute-force with rotating API keys.
 * More lenient than per-key limits.
 */
export function checkIpRateLimit(ip: string): RateLimitResult {
  const hashedIp = crypto.createHash('sha256').update(ip).digest('hex');
  return _checkWindow(`ip:${hashedIp}`, IP_RATE_LIMIT.windowMs, IP_RATE_LIMIT.maxRequests);
}

// Limits
export const RATE_LIMITS = {
  read: { windowMs: 60_000, maxRequests: 60 },           // 60 reads / minute per key
  write: { windowMs: 60_000, maxRequests: 30 },           // 30 writes / minute per key
  gossip_write: { windowMs: 60_000, maxRequests: 5 },     // 5 gossip writes / minute per key
  telemetry: { windowMs: 60_000, maxRequests: 60 },       // 60 usage-telemetry flushes / minute per key
} as const;

const IP_RATE_LIMIT = { windowMs: 60_000, maxRequests: 120 }; // 120 req / minute per IP
