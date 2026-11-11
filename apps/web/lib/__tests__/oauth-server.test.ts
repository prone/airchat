import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  resolveScope,
  grantedScopeString,
  verifyPkce,
  isRegisteredRedirectUri,
  isSecureRedirectUri,
  connectorAgentNameFor,
  describeRedirectTarget,
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

/**
 * What the token response echoes back.
 *
 * These exist because the connector reached the end of the flow and then
 * discarded the grant: two tokens were issued with the right audience and both
 * showed last_used_at NULL. The client asked for "read read-write" and was told
 * it received "read-write", which reads as a partial grant.
 */
describe('granted scope echoed in the token response', () => {
  it('names both scopes for a read-write grant, because it covers both', () => {
    expect(grantedScopeString('read-write')).toBe('read read-write');
  });

  it('names only read for a read grant', () => {
    expect(grantedScopeString('read')).toBe('read');
  });

  it('answers the full request claude.ai actually sends', () => {
    // The round trip that failed: request -> resolve -> echo.
    const granted = resolveScope('read read-write');
    expect(granted).not.toBeNull();
    expect(grantedScopeString(granted!)).toBe('read read-write');
  });

  it('never returns a scope the client did not ask for', () => {
    const granted = resolveScope('read');
    expect(grantedScopeString(granted!).split(' ')).not.toContain('read-write');
  });

  it('returns a space-delimited list, per RFC 6749 §3.3', () => {
    expect(grantedScopeString('read-write').split(/\s+/).sort()).toEqual(['read', 'read-write']);
  });
});

describe('connector agent naming when two users share a local part', () => {
  it('keeps the plain name when no disambiguator is given, so existing agents keep theirs', () => {
    expect(connectorAgentNameFor('alice@one.example')).toBe('alice-claude-ai');
    expect(connectorAgentNameFor('alice@two.example')).toBe('alice-claude-ai');
  });

  it('gives a distinct, stable name per user when disambiguated', () => {
    const a = connectorAgentNameFor('alice@two.example', 'user-a');
    const b = connectorAgentNameFor('alice@two.example', 'user-b');
    expect(a).not.toBe(b);
    expect(a).toBe(connectorAgentNameFor('alice@two.example', 'user-a'));
    expect(a).toMatch(/^alice-[0-9a-f]{8}-claude-ai$/);
    expect(a).not.toContain('user-a');
  });

  it('stays within the length of an undisambiguated name', () => {
    const long = `${'x'.repeat(200)}@example.com`;
    expect(connectorAgentNameFor(long, 'u').length).toBeLessThanOrEqual(connectorAgentNameFor(long).length);
  });
});

describe('what the consent screen says about the requesting application', () => {
  it('recognises the known hosts over https', () => {
    expect(describeRedirectTarget('https://claude.ai/api/mcp/auth_callback')).toEqual({ host: 'claude.ai', verified: true, loopback: false });
    expect(describeRedirectTarget('https://claude.com/cb').verified).toBe(true);
    expect(describeRedirectTarget('https://CLAUDE.AI/cb').verified).toBe(true);
  });

  it('does not recognise look-alike hosts', () => {
    // A registered name of "Claude" with one of these redirects is the attack.
    for (const uri of [
      'https://claude.ai.evil.example/cb',
      'https://evil.example/claude.ai',
      'https://notclaude.ai/cb',
      'https://sub.claude.ai/cb',
      'https://claude.ai:8443/cb',
      'https://claude.ai@evil.example/cb',
    ]) {
      expect(describeRedirectTarget(uri).verified, uri).toBe(false);
    }
  });

  it('shows the host the code is actually delivered to', () => {
    expect(describeRedirectTarget('https://claude.ai@evil.example/cb').host).toBe('evil.example');
    expect(describeRedirectTarget('https://evil.example:8443/cb').host).toBe('evil.example:8443');
  });

  it('reports a loopback redirect as unverified and local', () => {
    expect(describeRedirectTarget('http://localhost:5555/cb')).toEqual({ host: 'localhost:5555', verified: false, loopback: true });
    expect(describeRedirectTarget('http://127.0.0.1/cb').loopback).toBe(true);
    expect(describeRedirectTarget('http://[::1]:9/cb').loopback).toBe(true);
  });

  it('never verifies something that is not a URL', () => {
    expect(describeRedirectTarget('not a url')).toEqual({ host: 'not a url', verified: false, loopback: false });
  });
});
