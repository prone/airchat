import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clientIp, trustedProxyMode } from '@/lib/client-ip';

/**
 * Rate limiting is only as good as the identity it buckets on.
 *
 * These exist because every route used to read the LEFTMOST X-Forwarded-For
 * entry, which is the value the caller wrote. A proxy appends to that list, it
 * does not vet what is already there — so anyone could send a random
 * X-Forwarded-For and get a fresh bucket per request. That made the IP limit on
 * POST /api/oauth/register — the only unauthenticated writer of the only
 * publicly writable table — decorative.
 */

const req = (headers: Record<string, string>) => ({
  headers: {
    get: (name: string) => headers[name.toLowerCase()] ?? null,
  },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('with no trusted proxy configured (the default)', () => {
  beforeEach(() => {
    vi.stubEnv('AIRCHAT_TRUSTED_PROXY', '');
  });

  it('ignores CF-Connecting-IP, which a direct caller can write itself', () => {
    // The attack: connect straight to the app and send a different
    // CF-Connecting-IP on every request to get a fresh allowance each time.
    const a = clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '203.0.113.7' }));
    const b = clientIp(req({ 'cf-connecting-ip': '2.2.2.2', 'x-forwarded-for': '203.0.113.7' }));
    expect(a).toBe('203.0.113.7');
    expect(b).toBe(a);
  });

  it('ignores X-Real-IP for the same reason', () => {
    const a = clientIp(req({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '203.0.113.7' }));
    const b = clientIp(req({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '203.0.113.7' }));
    expect(a).toBe('203.0.113.7');
    expect(b).toBe(a);
  });

  it('puts a caller that sends only those headers in the shared bucket', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '1.1.1.1' }))).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': '1.1.1.1' }))).toBe('unknown');
  });

  it('takes the rightmost XFF entry, not the one the caller wrote first', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 203.0.113.7' })))
      .toBe('203.0.113.7');
  });

  it('treats an unrecognised setting as no proxy', () => {
    vi.stubEnv('AIRCHAT_TRUSTED_PROXY', 'cloudfare');
    expect(trustedProxyMode()).toBe('none');
    expect(clientIp(req({ 'cf-connecting-ip': '1.1.1.1' }))).toBe('unknown');
  });
});

describe('AIRCHAT_TRUSTED_PROXY=cloudflare', () => {
  beforeEach(() => {
    vi.stubEnv('AIRCHAT_TRUSTED_PROXY', 'cloudflare');
  });

  it('ignores a client-supplied XFF when Cloudflare names the caller', () => {
    // The attack: prepend your own entry and the leftmost read believes it.
    const ip = clientIp(req({
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '1.2.3.4, 203.0.113.7',
    }));
    expect(ip).toBe('203.0.113.7');
    expect(ip).not.toBe('1.2.3.4');
  });

  it('gives two spoofed values the same bucket behind Cloudflare', () => {
    // Rotating the forged header must not produce a new allowance.
    const a = clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': 'aaa' }));
    const b = clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': 'bbb' }));
    expect(a).toBe(b);
  });

  it('does not believe X-Real-IP, which Cloudflare does not set', () => {
    expect(clientIp(req({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '203.0.113.7' })))
      .toBe('203.0.113.7');
  });

  it('matches header names case-insensitively and trims the value', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '  198.51.100.1  ' }))).toBe('198.51.100.1');
  });

  it('does not treat an empty header as an identity', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '   ' }))).toBe('unknown');
  });
});

describe('AIRCHAT_TRUSTED_PROXY=true (a reverse proxy that sets X-Real-IP)', () => {
  beforeEach(() => {
    vi.stubEnv('AIRCHAT_TRUSTED_PROXY', 'true');
  });

  it('prefers X-Real-IP over any XFF entry', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' })))
      .toBe('203.0.113.7');
  });

  it('does not believe CF-Connecting-IP, which this proxy does not set', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '203.0.113.7' })))
      .toBe('203.0.113.7');
  });
});

describe('degenerate input', () => {
  it('falls back to a single shared bucket when nothing identifies the caller', () => {
    // Deliberately a constant, not a random value: an unidentifiable caller
    // should contend with other unidentifiable callers, not get a private
    // allowance.
    expect(clientIp(req({}))).toBe('unknown');
  });

  it('does not treat an empty header as an identity', () => {
    expect(clientIp(req({ 'x-forwarded-for': '' }))).toBe('unknown');
  });

  it('skips empty entries in a trailing-comma list', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, ' }))).toBe('203.0.113.7');
  });

  it('trims surrounding whitespace', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4,   203.0.113.7   ' }))).toBe('203.0.113.7');
  });

  it('handles a single-entry XFF', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });
});
