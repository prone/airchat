import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  resolveScope,
  verifyPkce,
  isRegisteredRedirectUri,
  isSecureRedirectUri,
  connectorAgentNameFor,
  sha256,
  randomToken,
  SUPPORTED_SCOPES,
} from '@/lib/oauth-server';

const challengeFor = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * PKCE is the only thing binding an authorization code to the client that
 * requested it. claude.ai is a public client holding no secret, so if this is
 * wrong, an intercepted code is redeemable by whoever intercepted it.
 */
describe('PKCE (RFC 7636 S256)', () => {
  it('accepts the verifier that produced the challenge', () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyPkce(verifier, challengeFor(verifier))).toBe(true);
  });

  it('rejects a different verifier', () => {
    const challenge = challengeFor(randomBytes(32).toString('base64url'));
    expect(verifyPkce(randomBytes(32).toString('base64url'), challenge)).toBe(false);
  });

  it('rejects a verifier that differs by one character', () => {
    const verifier = 'a'.repeat(43);
    expect(verifyPkce('a'.repeat(42) + 'b', challengeFor(verifier))).toBe(false);
  });

  it('rejects an empty verifier against a real challenge', () => {
    expect(verifyPkce('', challengeFor('some-verifier'))).toBe(false);
  });

  it('rejects the challenge being presented as the verifier', () => {
    // A client that confused the two would otherwise authenticate itself.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = challengeFor(verifier);
    expect(verifyPkce(challenge, challenge)).toBe(false);
  });

  it('does not treat a plain-text match as valid', () => {
    // OAuth 2.1 removes the `plain` method; only S256 is accepted.
    expect(verifyPkce('verifier', 'verifier')).toBe(false);
  });

  it('rejects a truncated challenge of the right prefix', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = challengeFor(verifier);
    expect(verifyPkce(verifier, challenge.slice(0, -1))).toBe(false);
  });
});

/**
 * Every loosening of redirect matching is a known open-redirect vector, and an
 * open redirect on an authorization endpoint hands an attacker live codes.
 */
describe('redirect URI matching', () => {
  const registered = ['https://claude.ai/api/mcp/callback'];

  it('accepts an exact match', () => {
    expect(isRegisteredRedirectUri('https://claude.ai/api/mcp/callback', registered)).toBe(true);
  });

  it('rejects a path suffix', () => {
    expect(isRegisteredRedirectUri('https://claude.ai/api/mcp/callback/evil', registered)).toBe(false);
  });

  it('rejects a trailing slash', () => {
    expect(isRegisteredRedirectUri('https://claude.ai/api/mcp/callback/', registered)).toBe(false);
  });

  it('rejects an added query string', () => {
    expect(isRegisteredRedirectUri('https://claude.ai/api/mcp/callback?x=1', registered)).toBe(false);
  });

  it('rejects a different host that starts the same', () => {
    expect(isRegisteredRedirectUri('https://claude.ai.evil.com/api/mcp/callback', registered)).toBe(false);
  });

  it('rejects a scheme downgrade', () => {
    expect(isRegisteredRedirectUri('http://claude.ai/api/mcp/callback', registered)).toBe(false);
  });

  it('rejects anything when nothing is registered', () => {
    expect(isRegisteredRedirectUri('https://claude.ai/cb', [])).toBe(false);
  });
});

describe('redirect URI transport safety (OAuth 2.1 §1.5)', () => {
  it('accepts https', () => {
    expect(isSecureRedirectUri('https://claude.ai/callback')).toBe(true);
  });

  it('accepts http on loopback, for native clients', () => {
    expect(isSecureRedirectUri('http://localhost:1234/cb')).toBe(true);
    expect(isSecureRedirectUri('http://127.0.0.1:1234/cb')).toBe(true);
  });

  it('rejects http to a remote host', () => {
    // A code delivered in clear text is a code an observer keeps.
    expect(isSecureRedirectUri('http://example.com/cb')).toBe(false);
  });

  it('rejects a fragment', () => {
    expect(isSecureRedirectUri('https://claude.ai/cb#frag')).toBe(false);
  });

  it('rejects a non-URL', () => {
    expect(isSecureRedirectUri('not a url')).toBe(false);
  });

  it('rejects javascript: and data: schemes', () => {
    expect(isSecureRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isSecureRedirectUri('data:text/html,x')).toBe(false);
  });
});

describe('connector agent naming', () => {
  it('follows the same convention as CLI issuance', () => {
    expect(connectorAgentNameFor('duncan@example.com')).toBe('duncan-claude-ai');
  });

  it('sanitises characters that are not valid in an agent name', () => {
    expect(connectorAgentNameFor('First.Last+tag@example.com')).toBe('first-last-tag-claude-ai');
  });

  it('collapses and trims separators', () => {
    expect(connectorAgentNameFor('a..b@x.com')).toBe('a-b-claude-ai');
    expect(connectorAgentNameFor('.leading@x.com')).toBe('leading-claude-ai');
  });

  it('produces a usable name from an unusable local part', () => {
    expect(connectorAgentNameFor('...@x.com')).toBe('user-claude-ai');
  });

  it('always ends with the connector suffix, so it cannot look like a real agent', () => {
    for (const email of ['a@x.com', 'macbook@x.com', 'nas@x.com']) {
      expect(connectorAgentNameFor(email)).toMatch(/-claude-ai$/);
    }
  });
});

describe('token generation', () => {
  it('produces distinct high-entropy values', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(seen.size).toBe(200);
    expect([...seen][0].length).toBeGreaterThanOrEqual(40);
  });

  it('hashes deterministically and irreversibly', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toContain('abc');
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('scopes', () => {
  it('are exactly the connector scopes that already exist', () => {
    // Not a second vocabulary: an OAuth grant maps onto the same read /
    // read-write distinction the CLI issues.
    expect([...SUPPORTED_SCOPES]).toEqual(['read', 'read-write']);
  });
});

/**
 * RFC 6749 §3.3: scope is a space-delimited LIST, not a single value.
 *
 * These exist because treating it as one string is what broke the first
 * end-to-end attempt: claude.ai sent "read read-write" and the authorize
 * endpoint answered invalid_scope, stopping the flow at the last step.
 */
describe('scope resolution', () => {
  it('accepts a single scope', () => {
    expect(resolveScope('read')).toBe('read');
    expect(resolveScope('read-write')).toBe('read-write');
  });

  it('accepts the space-delimited list claude.ai actually sends', () => {
    expect(resolveScope('read read-write')).toBe('read-write');
  });

  it('grants the superset when both are asked for, in either order', () => {
    expect(resolveScope('read-write read')).toBe('read-write');
  });

  it('tolerates extra whitespace', () => {
    expect(resolveScope('  read   read-write  ')).toBe('read-write');
  });

  it('defaults to read when absent or empty', () => {
    expect(resolveScope(null)).toBe('read');
    expect(resolveScope('')).toBe('read');
    expect(resolveScope('   ')).toBe('read');
  });

  it('rejects an unknown scope rather than ignoring it', () => {
    // A client that asked for something it did not get should be told, not
    // left believing it has access it does not.
    expect(resolveScope('admin')).toBeNull();
    expect(resolveScope('read admin')).toBeNull();
  });

  it('does not grant read-write from a lookalike', () => {
    expect(resolveScope('read-write-all')).toBeNull();
    expect(resolveScope('readwrite')).toBeNull();
  });
});
