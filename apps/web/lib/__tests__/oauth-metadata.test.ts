import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  MCP_RESOURCE_PATH,
  canonicalResourceUri,
  protectedResourceMetadata,
  resourceMetadataUrl,
  wwwAuthenticateValue,
  publicOrigin,
} from '@/lib/oauth-metadata';

const req = (url = 'https://mcp.airchat.work/mcp') => new NextRequest(url);

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('canonical resource URI', () => {
  it('is the origin plus the MCP path', () => {
    expect(canonicalResourceUri(req())).toBe('https://mcp.airchat.work/mcp');
  });

  it('has no trailing slash', () => {
    // RFC 9728 and the MCP spec both call for the form without one, and an
    // audience check is an exact string comparison — a stray slash is a
    // rejected token, not a cosmetic difference.
    expect(canonicalResourceUri(req())).not.toMatch(/\/$/);
  });

  it('has no fragment', () => {
    // RFC 8707 §2 lists a fragment as making the URI invalid.
    expect(canonicalResourceUri(req())).not.toContain('#');
  });

  it('preserves a non-default port', () => {
    expect(canonicalResourceUri(req('http://100.99.11.124:3003/mcp')))
      .toBe('http://100.99.11.124:3003/mcp');
  });
});

describe('public origin', () => {
  it('prefers the configured value over the request', () => {
    // The audience ends up inside issued tokens, and Host is
    // attacker-influenceable. Configuration is the only unspoofable source.
    vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work');
    expect(publicOrigin(req('https://attacker.example/mcp')))
      .toBe('https://mcp.airchat.work');
  });

  it('strips a trailing slash from the configured value', () => {
    vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work/');
    expect(canonicalResourceUri(req())).toBe('https://mcp.airchat.work/mcp');
  });

  it('falls back to the request origin when unset', () => {
    expect(publicOrigin(req('https://tunnel.example/api/mcp')))
      .toBe('https://tunnel.example');
  });
});

describe('protected-resource metadata (RFC 9728)', () => {
  it('names itself as the resource', () => {
    expect(protectedResourceMetadata(req()).resource)
      .toBe('https://mcp.airchat.work/mcp');
  });

  it('lists at least one authorization server, as the MCP spec requires', () => {
    const meta = protectedResourceMetadata(req());
    expect(meta.authorization_servers.length).toBeGreaterThan(0);
    expect(() => new URL(meta.authorization_servers[0])).not.toThrow();
  });

  it('advertises the connector scopes that already exist, not a new vocabulary', () => {
    expect(protectedResourceMetadata(req()).scopes_supported).toEqual(['read', 'read-write']);
  });

  it('declares header-based bearer usage', () => {
    // The spec forbids the token in a query string.
    expect(protectedResourceMetadata(req()).bearer_methods_supported).toEqual(['header']);
  });

  it('is JSON-serialisable with no undefined fields', () => {
    const meta = protectedResourceMetadata(req());
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});

describe('metadata URL', () => {
  it('inserts the resource path after the well-known segment (RFC 9728 §3.1)', () => {
    expect(resourceMetadataUrl(req()))
      .toBe('https://mcp.airchat.work/.well-known/oauth-protected-resource/mcp');
  });
});

describe('WWW-Authenticate challenge (RFC 9728 §5.1)', () => {
  it('uses the Bearer scheme and points at the metadata', () => {
    const v = wwwAuthenticateValue(req());
    expect(v).toMatch(/^Bearer /);
    expect(v).toContain('resource_metadata="https://mcp.airchat.work/.well-known/oauth-protected-resource/mcp"');
  });

  it('includes an OAuth error code when given one', () => {
    expect(wwwAuthenticateValue(req(), 'invalid_token')).toContain('error="invalid_token"');
  });

  it('omits the error parameter when not given one', () => {
    expect(wwwAuthenticateValue(req())).not.toContain('error=');
  });

  it('quotes parameter values, so a parser sees one directive not two', () => {
    const v = wwwAuthenticateValue(req(), 'invalid_token');
    // Both parameters quoted, comma-separated after the scheme.
    expect(v).toMatch(/^Bearer resource_metadata="[^"]+", error="[^"]+"$/);
  });
});

/**
 * The endpoint path is a compatibility constraint, not a naming preference.
 *
 * claude.ai's custom connector silently fails the post-token handshake when the
 * MCP endpoint is served anywhere other than `/mcp`: OAuth completes, a working
 * token is issued, and the client then never sends an authenticated request —
 * it re-registers and reports "Authorization with the MCP server failed"
 * (anthropics/claude-ai-mcp#423). This server did exactly that on `/api/mcp`.
 *
 * If someone renames the path, these fail before a person has to rediscover
 * that from a tunnel log.
 */
describe('the advertised resource path is /mcp', () => {
  it('is exactly /mcp', () => {
    expect(MCP_RESOURCE_PATH).toBe('/mcp');
  });

  it('is not the /api-prefixed path that broke the connector', () => {
    expect(MCP_RESOURCE_PATH).not.toBe('/api/mcp');
  });

  it('puts /mcp in the token audience', () => {
    expect(canonicalResourceUri(req())).toBe('https://mcp.airchat.work/mcp');
  });

  it('points the metadata document at /mcp', () => {
    expect(resourceMetadataUrl(req()))
      .toBe('https://mcp.airchat.work/.well-known/oauth-protected-resource/mcp');
  });
});
