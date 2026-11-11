/**
 * Rate limit threshold tests.
 *
 * Verifies that the sliding window rate limiter fires at exactly the
 * correct request count for each operation type.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, RATE_LIMITS, checkIpRateLimit } from '../../../lib/rate-limit.js';

// Each test uses a unique key prefix to avoid cross-test interference
let keyCounter = 0;
function uniqueKey(prefix: string) {
  return `${prefix}-${Date.now()}-${++keyCounter}`;
}

describe('rate limit thresholds', () => {
  describe('read limit (60/min)', () => {
    it('allows exactly 60 requests then blocks the 61st', () => {
      const key = uniqueKey('read');
      const { windowMs, maxRequests } = RATE_LIMITS.read;

      for (let i = 1; i <= 60; i++) {
        const result = checkRateLimit(key, windowMs, maxRequests);
        expect(result.allowed, `request ${i} should be allowed`).toBe(true);
        expect(result.remaining).toBe(60 - i);
      }

      const blocked = checkRateLimit(key, windowMs, maxRequests);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('write limit (30/min)', () => {
    it('allows exactly 30 requests then blocks the 31st', () => {
      const key = uniqueKey('write');
      const { windowMs, maxRequests } = RATE_LIMITS.write;

      for (let i = 1; i <= 30; i++) {
        const result = checkRateLimit(key, windowMs, maxRequests);
        expect(result.allowed, `request ${i} should be allowed`).toBe(true);
        expect(result.remaining).toBe(30 - i);
      }

      const blocked = checkRateLimit(key, windowMs, maxRequests);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });
  });

  describe('gossip_write limit (5/min)', () => {
    it('allows exactly 5 requests then blocks the 6th', () => {
      const key = uniqueKey('gossip');
      const { windowMs, maxRequests } = RATE_LIMITS.gossip_write;

      for (let i = 1; i <= 5; i++) {
        const result = checkRateLimit(key, windowMs, maxRequests);
        expect(result.allowed, `request ${i} should be allowed`).toBe(true);
        expect(result.remaining).toBe(5 - i);
      }

      const blocked = checkRateLimit(key, windowMs, maxRequests);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });
  });

  describe('IP rate limit (120/min)', () => {
    it('allows exactly 120 requests then blocks the 121st', () => {
      const ip = uniqueKey('ip');

      for (let i = 1; i <= 120; i++) {
        const result = checkIpRateLimit(ip);
        expect(result.allowed, `request ${i} should be allowed`).toBe(true);
      }

      const blocked = checkIpRateLimit(ip);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });
  });

  describe('key isolation', () => {
    it('different keys have independent limits', () => {
      const key1 = uniqueKey('iso-a');
      const key2 = uniqueKey('iso-b');
      const { windowMs, maxRequests } = RATE_LIMITS.gossip_write;

      // Exhaust key1
      for (let i = 0; i < 5; i++) {
        checkRateLimit(key1, windowMs, maxRequests);
      }
      expect(checkRateLimit(key1, windowMs, maxRequests).allowed).toBe(false);

      // key2 should still work
      expect(checkRateLimit(key2, windowMs, maxRequests).allowed).toBe(true);
    });
  });

  describe('retry-after', () => {
    it('returns retryAfterMs >= 1000 when blocked', () => {
      const key = uniqueKey('retry');
      const { windowMs, maxRequests } = RATE_LIMITS.gossip_write;

      for (let i = 0; i < 5; i++) {
        checkRateLimit(key, windowMs, maxRequests);
      }

      const blocked = checkRateLimit(key, windowMs, maxRequests);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThanOrEqual(1000);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(windowMs);
    });
  });
});

describe('buckets with different windows', () => {
  it('an hourly bucket keeps its count when a one-minute check triggers the sweep', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const hourly = uniqueKey('hourly');
      const HOUR = 60 * 60 * 1000;
      for (let i = 0; i < 6; i++) expect(checkRateLimit(hourly, HOUR, 6).allowed).toBe(true);

      // Ten minutes on, a per-minute check runs the periodic sweep. It must
      // trim the hourly bucket by an hour, not by a minute.
      vi.advanceTimersByTime(10 * 60 * 1000);
      checkRateLimit(uniqueKey('minute'), 60_000, 60);

      expect(checkRateLimit(hourly, HOUR, 6).allowed).toBe(false);

      vi.advanceTimersByTime(51 * 60 * 1000);
      expect(checkRateLimit(hourly, HOUR, 6).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
