import { describe, it, expect } from 'vitest';
import { clientIp } from '@/lib/client-ip';

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

describe('a spoofed X-Forwarded-For cannot pick the bucket', () => {
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

  it('takes the rightmost XFF entry when nothing better exists', () => {
    // The rightmost is what the nearest proxy appended; the leftmost is the
    // caller's own claim.
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 203.0.113.7' })))
      .toBe('203.0.113.7');
  });

  it('prefers X-Real-IP over any XFF entry', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' })))
      .toBe('203.0.113.7');
  });
});

describe('header precedence', () => {
  it('uses CF-Connecting-IP ahead of X-Real-IP', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '198.51.100.1', 'x-real-ip': '203.0.113.7' })))
      .toBe('198.51.100.1');
  });

  it('matches header names case-insensitively', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '198.51.100.1' }))).toBe('198.51.100.1');
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
    expect(clientIp(req({ 'cf-connecting-ip': '   ' }))).toBe('unknown');
    expect(clientIp(req({ 'x-forwarded-for': '' }))).toBe('unknown');
  });

  it('skips empty entries in a trailing-comma list', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, ' }))).toBe('203.0.113.7');
  });

  it('trims surrounding whitespace', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '  203.0.113.7  ' }))).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4,   203.0.113.7   ' }))).toBe('203.0.113.7');
  });

  it('handles a single-entry XFF', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });
});
