import { describe, it, expect } from 'vitest';
import { safeNextPath } from '@/lib/safe-next';

/**
 * The ?next= handling on the login page.
 *
 * Signing in during the OAuth flow used to land the user on /dashboard with the
 * authorization request silently abandoned — they saw a bare {"error":"Not
 * found"} and the connector never completed. The login page ignored the ?next=
 * that the authorize endpoint had carefully attached.
 *
 * The page is a client component, so the decision lives in a small function
 * of its own that the page calls and these tests drive.
 */
const safeNext = safeNextPath;

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

  it('refuses a backslash, which browsers read as a forward slash', () => {
    // /\evil.example resolves to //evil.example, a different site.
    expect(safeNext('/\\evil.example')).toBe('/dashboard');
    expect(safeNext('/\\/evil.example')).toBe('/dashboard');
    expect(safeNext('/ok\\..\\evil')).toBe('/dashboard');
  });

  it('refuses control characters, which browsers strip before parsing', () => {
    // "/<tab>/evil.example" becomes "//evil.example" once the tab is removed.
    expect(safeNext('/\t/evil.example')).toBe('/dashboard');
    expect(safeNext('/\n/evil.example')).toBe('/dashboard');
    expect(safeNext('/\r/evil.example')).toBe('/dashboard');
    expect(safeNext('/\u0000/evil.example')).toBe('/dashboard');
  });

  it('still follows ordinary paths with queries and encoded characters', () => {
    const next = '/oauth/consent?client_id=acl_x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=a%5Cb';
    expect(safeNext(next)).toBe(next);
    expect(safeNext('/dashboard/notes#top')).toBe('/dashboard/notes#top');
  });
});
