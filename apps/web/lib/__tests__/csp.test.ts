import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy, newNonce } from '../csp';

const HOSTED = 'https://abc.supabase.co';
const script = (csp: string) => csp.split('; ').find((d) => d.startsWith('script-src'))!;
const connect = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src'))!;

describe('Content-Security-Policy', () => {
  it('never allows inline script by keyword', () => {
    for (const production of [true, false]) {
      for (const nonce of [undefined, 'abc123']) {
        expect(contentSecurityPolicy(production, nonce, HOSTED)).not.toMatch(/script-src[^;]*unsafe-inline/);
      }
    }
  });

  it('allows a page only the scripts that carry its nonce, and what they load', () => {
    expect(script(contentSecurityPolicy(true, 'abc123', HOSTED))).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it('allows no inline script at all without a nonce', () => {
    expect(script(contentSecurityPolicy(true, undefined, HOSTED))).toBe("script-src 'self'");
  });

  it('allows eval only in development, where React and hot reload need it', () => {
    expect(contentSecurityPolicy(true, 'n', HOSTED)).not.toContain('unsafe-eval');
    expect(script(contentSecurityPolicy(false, 'n', HOSTED))).toBe("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    const strip = (csp: string) => csp.replace(" 'unsafe-eval'", '');
    expect(strip(contentSecurityPolicy(false, 'n', HOSTED))).toBe(contentSecurityPolicy(true, 'n', HOSTED));
  });

  it('is this policy in production', () => {
    expect(contentSecurityPolicy(true, undefined, HOSTED)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "connect-src 'self' https://*.supabase.co wss://*.supabase.co; img-src 'self' data: blob:; font-src 'self' data:; "
      + "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
  });

  it('lets the dashboard reach a Supabase that is not on supabase.co', () => {
    expect(connect(contentSecurityPolicy(true, undefined, 'http://127.0.0.1:54321/')))
      .toBe("connect-src 'self' https://*.supabase.co wss://*.supabase.co http://127.0.0.1:54321 ws://127.0.0.1:54321");
    expect(connect(contentSecurityPolicy(true, undefined, 'https://db.example.org')))
      .toContain(' https://db.example.org wss://db.example.org');
  });

  it('adds nothing for a missing or unusable Supabase address', () => {
    const plain = "connect-src 'self' https://*.supabase.co wss://*.supabase.co";
    for (const url of [undefined, '', 'not a url', 'javascript:alert(1)']) {
      expect(connect(contentSecurityPolicy(true, undefined, url as string | undefined))).toBe(plain);
    }
  });
});

describe('newNonce', () => {
  it('is different every time and safe to put in a header', () => {
    const seen = new Set(Array.from({ length: 50 }, newNonce));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
