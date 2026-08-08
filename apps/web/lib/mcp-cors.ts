/**
 * CORS for the MCP endpoint.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 *
 * MCP's Streamable HTTP transport is explicitly designed to be reachable from
 * browser-based clients, and a browser will not let a page talk to another
 * origin without them. A POST carrying `Authorization` and
 * `content-type: application/json` is not a simple request, so the browser
 * sends an OPTIONS preflight first and refuses the real request unless that
 * preflight answers with the right headers.
 *
 * Before this, /api/mcp answered the preflight with Next's default 204 and no
 * `Access-Control-*` headers at all. A browser client therefore never reached
 * our authentication — it was stopped one step earlier, and reported the
 * endpoint as unreachable rather than unauthorized. That is what
 * "Couldn't connect to the server. Check that the URL points to a valid MCP
 * server." means: a CORS failure is indistinguishable from an unreachable host
 * from inside the page.
 *
 * ── Why `*` is safe here ────────────────────────────────────────────────────
 *
 * This endpoint authenticates with a bearer token in a header, never a cookie.
 * `Access-Control-Allow-Credentials` stays unset, so browsers will not attach
 * cookies or HTTP auth to a cross-origin request regardless of what a page
 * asks for. A hostile page therefore gains nothing: it cannot obtain the user's
 * token, and without one every request here is a 401.
 *
 * This is the same reason a wildcard would NOT be acceptable on /api/v2, which
 * is cookie- and LAN-trust-based — and /api/v2 is not exposed through the
 * tunnel at all.
 *
 * ── Exposing WWW-Authenticate ───────────────────────────────────────────────
 *
 * By default a page can read almost none of a cross-origin response's headers.
 * The 401 challenge is the whole discovery mechanism — it names the
 * protected-resource metadata document that starts the OAuth flow — so it has
 * to be listed in `Access-Control-Expose-Headers` or a browser client sees a
 * bare 401 with no way to find the authorization server.
 */

/** Request headers an MCP client legitimately sends. */
const ALLOWED_REQUEST_HEADERS = [
  'content-type',
  'authorization',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
].join(', ');

/** Response headers a browser client must be able to read. */
const EXPOSED_RESPONSE_HEADERS = ['WWW-Authenticate', 'Mcp-Session-Id'].join(', ');

export const MCP_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': ALLOWED_REQUEST_HEADERS,
  'Access-Control-Expose-Headers': EXPOSED_RESPONSE_HEADERS,
  'Access-Control-Max-Age': '86400',
};

/**
 * Copy the CORS headers onto a response.
 *
 * Applied to every response the endpoint produces, including the 401 — an
 * error a browser client cannot read is an error it cannot act on.
 */
export function withMcpCors(response: Response): Response {
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

/**
 * CORS for the OAuth discovery documents and the endpoints a client calls
 * programmatically (registration, token exchange).
 *
 * A browser client cannot begin the flow it is being pointed at if it cannot
 * READ the metadata naming the authorization server, so these are as necessary
 * as the ones on /api/mcp. RFC 8414 §3.1 expects the metadata document to be
 * publicly readable for exactly this reason.
 *
 * Deliberately NOT applied to /api/oauth/authorize or /oauth/consent: those are
 * browser *navigations* that end in a redirect, not fetches, so CORS does not
 * govern them — and adding permissive headers to a consent screen would be a
 * poor instinct to encode.
 *
 * Credentials stay off here too. The token endpoint is authenticated by the
 * authorization code plus its PKCE verifier, never by a cookie.
 */
export const OAUTH_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Max-Age': '86400',
};

export function withOAuthCors(response: Response): Response {
  for (const [name, value] of Object.entries(OAUTH_CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

/** Shared preflight answer for the OAuth endpoints. */
export function oauthPreflight(): Response {
  return withOAuthCors(new Response(null, { status: 204 }));
}
