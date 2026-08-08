/**
 * Shared pieces of the OAuth 2.1 authorization server.
 *
 * Secrets here follow the same rule as everywhere else in this codebase: the
 * plaintext exists for one response and only its SHA256 is stored. That covers
 * client secrets, authorization codes and access tokens alike.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Authorization codes are short-lived by design — they are exchanged at once. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

/** Issued access token lifetime. Re-consent on expiry; no refresh tokens yet. */
export const ACCESS_TOKEN_TTL_DAYS = 30;

export const SUPPORTED_SCOPES = ['read', 'read-write'] as const;
export type OAuthScope = (typeof SUPPORTED_SCOPES)[number];

/**
 * Resolve an OAuth `scope` parameter to the single connector scope to grant.
 *
 * RFC 6749 §3.3 defines scope as a space-delimited LIST, not one value.
 * claude.ai sends "read read-write" — it asks for everything it might use and
 * expects the server to grant what it will. Treating the parameter as a single
 * string rejected that outright with invalid_scope, which is what stopped the
 * first end-to-end attempt.
 *
 * Returns null if any requested scope is unknown, rather than silently
 * dropping it: a client that asked for something it did not get should be told,
 * not left believing it has access it does not.
 *
 * Where both are requested, read-write wins — it is the superset, and the
 * consent screen shows the user what is actually being granted.
 */
export function resolveScope(raw: string | null): OAuthScope | null {
  if (!raw || !raw.trim()) return 'read';

  const requested = raw.trim().split(/\s+/);
  const known: readonly string[] = SUPPORTED_SCOPES;
  if (!requested.every((s) => known.includes(s))) return null;

  return requested.includes('read-write') ? 'read-write' : 'read';
}

/**
 * The granted scope as the space-delimited LIST a token response must carry.
 *
 * `resolveScope` collapses a request to the single scope we store, because one
 * value decides the tool surface. But that collapsed value is the wrong thing to
 * echo back: claude.ai asks for "read read-write" and was told it got only
 * "read-write", so a client checking that it received everything it requested
 * sees `read` missing.
 *
 * read-write is a superset of read — a read-write token can do everything a
 * read token can — so naming both is accurate, not generous. RFC 6749 §5.1
 * requires the response to state the granted scope whenever it differs from the
 * request; stating it as a list is what makes it comparable to the request.
 */
export function grantedScopeString(scope: OAuthScope): string {
  return scope === 'read-write' ? 'read read-write' : 'read';
}

export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** URL-safe random string for codes, client ids and tokens. */
export const randomToken = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url');

/**
 * PKCE S256 verification (RFC 7636).
 *
 * S256 only — `plain` offers no protection against an intercepted code, and
 * OAuth 2.1 removes it. The migration constrains the column to match, so a
 * `plain` challenge cannot even be stored.
 *
 * Compared in constant time: the challenge is a secret-derived value, and a
 * short-circuiting comparison leaks how much of it a guess got right.
 */
export function verifyPkce(codeVerifier: string, storedChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(storedChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Redirect URI matching, per RFC 6749 §3.1.2.3 and the MCP spec: exact string
 * comparison against a registered value.
 *
 * No prefix matching, no wildcards, no ignoring a trailing slash. Every
 * loosening of this rule is a known open-redirect vector, and an open redirect
 * on an authorization endpoint hands an attacker authorization codes.
 */
export function isRegisteredRedirectUri(uri: string, registered: string[]): boolean {
  // Written as an explicit `===` rather than `registered.includes(uri)`.
  // Array.prototype.includes is already exact-match, but it reads identically
  // to String.prototype.includes, which is a substring test — and a substring
  // test here would accept https://claude.ai.evil.com/... as a match for
  // https://claude.ai/... . Static analysis flags the ambiguity, and it is a
  // fair thing to flag: the two differ by the type of one variable.
  return registered.some((candidate) => candidate === uri);
}

/**
 * A redirect URI is only acceptable if it is HTTPS or a loopback address.
 * OAuth 2.1 §1.5 requires it, and it stops a code being delivered in clear text.
 */
export function isSecureRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1');
}

/** OAuth error responses are a defined shape; clients parse `error`. */
export function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json({ error, error_description: description }, { status });
}

/**
 * Derive the connector agent name for a consenting user.
 *
 * Mirrors the CLI convention (`<label>-claude-ai`) so both issuance paths
 * produce the same shape of identity. The agent is created without any API
 * credential, and migration 00023's trigger rejects binding a token to an agent
 * that has one — so a derived name can never collide onto a real Claude Code
 * agent in a way that grants access.
 */
export function connectorAgentNameFor(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  const sanitized = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${sanitized || 'user'}-claude-ai`;
}
