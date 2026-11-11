/**
 * Where to send someone after they sign in.
 *
 * The login page accepts `?next=` so a flow that needed a signed-in user (the
 * OAuth authorize endpoint, for one) gets them back afterwards. Only a path on
 * this site may be followed. Anything else would make the login page an open
 * redirect: a link that signs a person in and then delivers them to someone
 * else's page, arriving with the credibility of having just logged in.
 *
 * "Starts with one slash" is not enough to prove that. Browsers read a
 * backslash in an http(s) URL as a forward slash, so `/\evil.example` is the
 * protocol-relative `//evil.example`, and they drop tabs and newlines before
 * parsing, so `/<tab>/evil.example` is too. Both are refused outright, and the
 * value is then resolved the way a browser would to confirm it stays here.
 */

const FALLBACK = '/dashboard';

// A stand-in for "this site". The real origin is not needed: the question is
// only whether resolving `next` against some origin leaves that origin.
const PROBE_ORIGIN = 'http://same-origin.invalid';

export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return FALLBACK;
  // Backslashes and control characters (including tab, CR, LF and DEL).
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return FALLBACK;
  try {
    if (new URL(next, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return FALLBACK;
  } catch {
    return FALLBACK;
  }
  return next;
}
