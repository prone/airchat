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
  return registered.includes(uri);
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
