import { describe, expect, it } from 'vitest';
import { Backoff, backoffDelayMs, describeFailure, formatDelay } from '../backoff.js';

const noJitter = { jitter: 0 };

describe('backoffDelayMs', () => {
  it('doubles from the base and caps at max', () => {
    const base = 20_000;
    const max = 5 * 60_000;
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, base, max))).toEqual([
      20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
  });

  it('returns 0 for a non-positive attempt', () => {
    expect(backoffDelayMs(0, 1000, 5000)).toBe(0);
  });

  it('does not overflow for absurd attempt counts', () => {
    expect(backoffDelayMs(10_000, 1000, 60_000)).toBe(60_000);
  });
});

describe('Backoff', () => {
  it('rejects a max below the base', () => {
    expect(() => new Backoff({ baseMs: 1000, maxMs: 500 })).toThrow();
  });

  it('is inactive until the first failure', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000, ...noJitter });
    expect(b.shouldSkip(0)).toBe(false);
    expect(b.attempts).toBe(0);
    expect(b.retryAt).toBe(0);
  });

  it('opens a window after a failure and closes it when time passes', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000, ...noJitter });
    const r = b.failure(10_000);
    expect(r).toEqual({ delayMs: 1000, attempts: 1, changed: true });
    expect(b.retryAt).toBe(11_000);
    expect(b.shouldSkip(10_500)).toBe(true);
    expect(b.shouldSkip(11_000)).toBe(false);
  });

  it('escalates on consecutive failures and reports each transition once', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 4000, ...noJitter });
    const results = [1, 2, 3, 4, 5].map((i) => b.failure(i * 100_000));
    expect(results.map((r) => r.delayMs)).toEqual([1000, 2000, 4000, 4000, 4000]);
    // 1000 -> 2000 -> 4000 are transitions; the two capped repeats are not.
    expect(results.map((r) => r.changed)).toEqual([true, true, true, false, false]);
    expect(b.attempts).toBe(5);
  });

  it('resets on success and reports how many failures preceded it', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000, ...noJitter });
    expect(b.success()).toBe(0);
    b.failure(0);
    b.failure(5000);
    expect(b.shouldSkip(5000)).toBe(true);
    expect(b.success()).toBe(2);
    expect(b.shouldSkip(5000)).toBe(false);
    expect(b.attempts).toBe(0);
    // The schedule restarts from the base, and the first failure is a transition again.
    expect(b.failure(20_000)).toEqual({ delayMs: 1000, attempts: 1, changed: true });
  });

  it('applies symmetric jitter within the configured fraction', () => {
    const low = new Backoff({ baseMs: 1000, maxMs: 1000, jitter: 0.2, random: () => 0 });
    const high = new Backoff({ baseMs: 1000, maxMs: 1000, jitter: 0.2, random: () => 0.999999 });
    const mid = new Backoff({ baseMs: 1000, maxMs: 1000, jitter: 0.2, random: () => 0.5 });
    expect(low.failure(0).delayMs).toBe(800);
    expect(high.failure(0).delayMs).toBe(1200);
    expect(mid.failure(0).delayMs).toBe(1000);
  });

  it('clamps jitter to [0, 1] and never produces a negative delay', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 1000, jitter: 5, random: () => 0 });
    expect(b.failure(0).delayMs).toBe(0);
    const c = new Backoff({ baseMs: 1000, maxMs: 1000, jitter: -1, random: () => 0 });
    expect(c.failure(0).delayMs).toBe(1000);
  });

  it('matches the model worker schedule: 20s doubling to a 5m cap', () => {
    const b = new Backoff({ baseMs: 20_000, maxMs: 5 * 60_000, ...noJitter });
    const delays = Array.from({ length: 7 }, (_, i) => b.failure(i * 1_000_000).delayMs);
    expect(delays).toEqual([20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  });
});

describe('formatDelay', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDelay(20_000)).toBe('20s');
    expect(formatDelay(90_000)).toBe('1m30s');
    expect(formatDelay(300_000)).toBe('5m');
    expect(formatDelay(5_400_000)).toBe('1h30m');
    expect(formatDelay(7_200_000)).toBe('2h');
  });
});

describe('describeFailure', () => {
  it('prefers an HTTP status when present', () => {
    expect(describeFailure(Object.assign(new Error('AirChat API GET /x failed'), { status: 503 }))).toBe('HTTP 503');
  });

  it('recognises fetch timeouts and aborts', () => {
    const t = new Error('The operation was aborted due to timeout');
    t.name = 'TimeoutError';
    expect(describeFailure(t)).toBe('timeout');
  });

  it('surfaces a socket error code, including one nested in cause', () => {
    expect(describeFailure(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe('ECONNRESET');
    expect(describeFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
  });

  it('falls back to the first line of the message, then to String()', () => {
    expect(describeFailure(new Error('line one\nline two'))).toBe('line one');
    expect(describeFailure('plain')).toBe('plain');
    expect(describeFailure(undefined)).toBe('undefined');
  });
});
