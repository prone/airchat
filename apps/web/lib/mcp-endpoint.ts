/**
 * Streamable HTTP MCP endpoint for the claude.ai connector.
 *
 * Served at TWO paths by thin route modules: `/mcp` (canonical) and `/api/mcp`
 * (retained for CLI-issued tokens). See MCP_RESOURCE_PATH in lib/oauth-metadata
 * for why `/mcp` is the advertised one.
 *
 * ── This endpoint DOES advertise OAuth, and must keep doing so ──────────────
 *
 * An earlier version of this comment said the opposite: that 401s deliberately
 * carried no challenge and that no protected-resource route existed, because
 * MCP clients run OAuth discovery before sending custom headers
 * (cloudflare/mcp#95) and advertising discovery would stop a client ever
 * sending a bearer.
 *
 * That reasoning is sound for a client that can send a static bearer. claude.ai
 * cannot. The spike settled it: given no OAuth metadata it probed
 * /.well-known/oauth-protected-resource (both path forms),
 * /.well-known/oauth-authorization-server and POST /register, got four 404s and
 * failed — without ever sending `Authorization`. Silence did not preserve a
 * bearer flow; it produced an error. See anthropics/claude-ai-mcp#112 (closed
 * NOT_PLANNED) and #10.
 *
 * So the design was reversed in #50 and the connector works *because* of it:
 * `mcp-auth.ts` returns 401 WITH `WWW-Authenticate`, and
 * app/.well-known/oauth-protected-resource/ exists. Removing either breaks the
 * connector. Static bearers still work for CLI-issued tokens — the challenge is
 * additive, giving a discovery-only client somewhere to go.
 *
 * ── Statelessness ───────────────────────────────────────────────────────────
 *
 * A new transport and a new server are constructed per request, with no session
 * ID. Next.js route handlers are not guaranteed to run in the same process
 * across requests, so server-held session state would be unreliable; a stateless
 * endpoint is both simpler and correct under horizontal scaling. The cost is
 * that resumable SSE streams are unavailable, which the connector does not use.
 */

import { NextRequest, NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer, connectorToolsForScope } from '@airchat/mcp-server/server-factory';
import { authenticateConnector, isConnectorAuthError } from '@/lib/mcp-auth';
import { InProcessToolClient } from '@/lib/mcp-inprocess-client';
import { sanitizeForLog } from '@/lib/sanitize';
import { withMcpCors } from '@/lib/mcp-cors';

/**
 * CORS preflight.
 *
 * A browser sends this before any POST carrying `Authorization`, and refuses
 * the real request unless it is answered. Without this handler Next returned a
 * bare 204 with no Access-Control-* headers, so a browser-based client was
 * stopped before reaching authentication and reported the endpoint as
 * unreachable rather than unauthorized. See lib/mcp-cors.ts.
 */
export function mcpPreflight() {
  return withMcpCors(new NextResponse(null, { status: 204 }));
}

export async function handleMcpPost(request: NextRequest) {
  const auth = await authenticateConnector(request);
  // The 401 carries the WWW-Authenticate challenge that begins discovery, so it
  // needs the CORS headers too — an error a browser cannot read is an error it
  // cannot act on.
  if (isConnectorAuthError(auth)) return withMcpCors(auth);

  const client = new InProcessToolClient(auth.ctx);
  const server = createServer(client, {
    // A read-only token never gets the write tools registered at all, so they
    // are not merely refused — they do not exist on its server.
    tools: connectorToolsForScope(auth.scope),
    // The connector is a remote client; local-config diagnostics do not apply
    // and airchat_doctor is not in the v1 surface anyway.
    notices: [],
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session ID is generated or validated.
    sessionIdGenerator: undefined,
    // Return a plain JSON body rather than opening an SSE stream. The connector
    // issues discrete request/response tool calls and nothing here streams
    // partial results, so a stream would just hold a connection open.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return withMcpCors(await transport.handleRequest(request));
  } catch (error) {
    // Never surface internal detail to a remote caller.
    //
    // Sanitized because the message can embed a v2 route's error body, which
    // carries user-supplied channel names and note slugs. Without this, a
    // crafted slug could inject control characters into the server log.
    console.error('[mcp] request failed:', sanitizeForLog(error));
    return withMcpCors(NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
      { status: 500 },
    ));
  } finally {
    // Release the per-request server, which closes the transport with it and
    // drops the transport's per-request stream state.
    //
    // Note for anyone switching this endpoint to SSE: no keep-alive timer is
    // armed in enableJsonResponse mode — the SDK returns before it would arm
    // one — so this close is NOT currently what stops a timer leaking. Turning
    // JSON mode off changes that, and the cleanup story needs rechecking.
    await server.close().catch(() => {});
  }
}

/**
 * GET is how a client opens the server-initiated SSE stream. Stateless mode has
 * no stream to attach to, so this is 405 rather than a broken stream. The MCP
 * spec allows a server to decline this.
 */
export function mcpGetNotAllowed() {
  return withMcpCors(NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null },
    { status: 405, headers: { Allow: 'POST' } },
  ));
}

/** Session termination — nothing to terminate without sessions. */
export function mcpDeleteNotAllowed() {
  return withMcpCors(NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null },
    { status: 405, headers: { Allow: 'POST' } },
  ));
}
