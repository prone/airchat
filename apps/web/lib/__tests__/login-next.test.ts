import { describe, it, expect } from 'vitest';

/**
 * The ?next= handling on the login page.
 *
 * Signing in during the OAuth flow used to land the user on /dashboard with the
 * authorization request silently abandoned — they saw a bare {"error":"Not
 * found"} and the connector never completed. The login page ignored the ?next=
 * that the authorize endpoint had carefully attached.
 *
 * The logic is extracted here because the page is a client component; this is
 * the same expression it uses.
 */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

describe('post-login redirect', () => {
  it('returns the user to the authorization request that sent them', () => {
    const next = '/api/oauth/authorize?client_id=acl_x&response_type=code';
    expect(safeNext(next)).toBe(next);
  });

  it('falls back to the dashboard when there is nowhere to return to', () => {
    expect(safeNext(null)).toBe('/dashboard');
    expect(safeNext('')).toBe('/dashboard');
  });

  it('refuses an absolute URL', () => {
    // Otherwise the login page is an open redirect: a link that authenticates
    // someone and then bounces them to an attacker's page, arriving with the
    // credibility of having just signed in.
    expect(safeNext('https://evil.example/steal')).toBe('/dashboard');
    expect(safeNext('http://evil.example')).toBe('/dashboard');
  });

  it('refuses a protocol-relative URL', () => {
    // //evil.example is a URL, not a path — browsers resolve it against the
    // current scheme, so it leaves the origin despite starting with a slash.
    expect(safeNext('//evil.example/x')).toBe('/dashboard');
  });

  it('refuses a scheme-bearing value that is not a path', () => {
    expect(safeNext('javascript:alert(1)')).toBe('/dashboard');
    expect(safeNext('data:text/html,x')).toBe('/dashboard');
  });
});
