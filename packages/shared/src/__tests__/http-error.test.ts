/**
 * `Retry-After` has to survive the trip from response to caller.
 *
 * It did not before: the status and headers were flattened into an error
 * *message*, and the one consumer that wanted the header regexed it back out
 * of a string built from the response body. A header is never in a body, so
 * the parse never matched, every backoff silently used a 2s fallback against a
 * 60s window, and the integration tier could not pass two runs in a row.
 *
 * These tests pin the value being carried structurally instead.
 */

import { describe, it, expect } from 'vitest';
import { AirChatHttpError } from '../rest-client.js';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('AirChatHttpError', () => {
  it('carries the status', () => {
    const err = new AirChatHttpError('rate limited', 429, headers({}));
    expect(err.status).toBe(429);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AirChatHttpError');
  });

  it('converts Retry-After seconds to milliseconds', () => {
    const err = new AirChatHttpError('rate limited', 429, headers({ 'Retry-After': '42' }));
    expect(err.retryAfterMs).toBe(42_000);
  });

  it('reads the header case-insensitively', () => {
    // Headers is case-insensitive by spec, but the lookup is ours to get wrong.
    const err = new AirChatHttpError('rate limited', 429, headers({ 'retry-after': '7' }));
    expect(err.retryAfterMs).toBe(7_000);
  });

  it('leaves retryAfterMs undefined when the header is absent', () => {
    const err = new AirChatHttpError('bad request', 400, headers({}));
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('ignores an unparseable or non-positive Retry-After', () => {
    // A malformed header must not become NaN ms or a zero-length wait — both
    // would produce an immediate retry into the same closed window.
    for (const value of ['soon', '', '0', '-5']) {
      const err = new AirChatHttpError('rate limited', 429, headers({ 'Retry-After': value }));
      expect(err.retryAfterMs, `Retry-After: "${value}"`).toBeUndefined();
    }
  });

  it('survives having no headers at all', () => {
    const err = new AirChatHttpError('offline', 503);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBeUndefined();
  });
});
