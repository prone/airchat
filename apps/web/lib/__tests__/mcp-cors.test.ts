import { describe, it, expect } from 'vitest';
import { withMcpCors, withOAuthCors, oauthPreflight, MCP_CORS_HEADERS } from '@/lib/mcp-cors';

/**
 * CORS on the connector surface.
 *
 * These exist because /api/mcp answered a browser's preflight with Next's bare
 * 204 and no Access-Control-* headers at all. A browser client was therefore
 * stopped one step BEFORE authentication and reported the endpoint as
 * unreachable — "Couldn't connect to the server" — rather than unauthorized. A
 * CORS failure is indistinguishable from a dead host from inside the page,
 * which is what made it so hard to see: every server-side probe passed.
 */

describe('the preflight a browser actually sends is answerable', () => {
  it('allows the methods the transport uses', () => {
    const methods = MCP_CORS_HEADERS['Access-Control-Allow-Methods'];
    for (const m of ['POST', 'GET', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(m);
    }
  });

  it('allows Authorization, which is what makes the request preflighted at all', () => {
    expect(MCP_CORS_HEADERS['Access-Control-Allow-Headers']).toContain('authorization');
  });

  it('allows the MCP protocol headers', () => {
    const allowed = MCP_CORS_HEADERS['Access-Control-Allow-Headers'];
    expect(allowed).toContain('mcp-session-id');
    expect(allowed).toContain('mcp-protocol-version');
  });
});

describe('the 401 challenge is readable by a browser client', () => {
  it('exposes WWW-Authenticate', () => {
    // Without this a page sees a bare 401 and cannot find the authorization
    // server — the challenge IS the discovery mechanism.
    expect(MCP_CORS_HEADERS['Access-Control-Expose-Headers']).toContain('WWW-Authenticate');
  });

  it('keeps the challenge intact when the headers are applied', () => {
    const res = withMcpCors(
      new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="x"' } }),
    );
    expect(res.headers.get('www-authenticate')).toBe('Bearer resource_metadata="x"');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('credentials are never enabled', () => {
  it('does not set Allow-Credentials on either surface', () => {
    // A wildcard origin is only safe because of this. The endpoint authenticates
    // with a bearer header, never a cookie, so a hostile page gains nothing:
    // it cannot obtain the token, and without one every request is a 401.
    for (const res of [withMcpCors(new Response()), withOAuthCors(new Response()), oauthPreflight()]) {
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
});

describe('applying the headers preserves the response', () => {
  it('keeps the status code', () => {
    expect(withMcpCors(new Response(null, { status: 405 })).status).toBe(405);
  });

  it('keeps no-store on a token response', () => {
    const res = withOAuthCors(new Response('{}', { headers: { 'cache-control': 'no-store' } }));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps the body', async () => {
    expect(await withOAuthCors(new Response('{"a":1}')).text()).toBe('{"a":1}');
  });
});

describe('the OAuth preflight', () => {
  it('answers 204 with no body', async () => {
    const res = oauthPreflight();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('permits the methods the OAuth endpoints expose', () => {
    const methods = oauthPreflight().headers.get('access-control-allow-methods')!;
    expect(methods).toContain('POST');
    expect(methods).toContain('GET');
  });
});
