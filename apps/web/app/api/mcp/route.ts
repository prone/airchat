/**
 * Streamable HTTP MCP endpoint for the claude.ai connector.
 *
 * ── Why there is no OAuth advertisement here ────────────────────────────────
 *
 * MCP clients run OAuth discovery BEFORE sending custom headers. If this
 * endpoint advertised OAuth in any form — a `WWW-Authenticate` challenge on the
 * 401, or an RFC 9728 protected-resource metadata document — the client would
 * enter the OAuth flow and never send `Authorization` at all. Cloudflare hit
 * exactly this in their own MCP server; their direct-token check never fired
 * because the header never arrived (cloudflare/mcp#95).
 *
 * So: 401s carry no challenge, and there is deliberately no
 * /.well-known/oauth-protected-resource route in this app. Adding either would
 * silently break the connector. Full OAuth 2.1 remains a separate, later
 * option for third-party self-hosters.
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

// Route handlers here call into the storage adapter and Node crypto.
export const runtime = 'nodejs';
// Auth depends on a per-request header, so nothing about this is cacheable.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await authenticateConnector(request);
  if (isConnectorAuthError(auth)) return auth;

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
    return await transport.handleRequest(request);
  } catch (error) {
    // Never surface internal detail to a remote caller.
    //
    // Sanitized because the message can embed a v2 route's error body, which
    // carries user-supplied channel names and note slugs. Without this, a
    // crafted slug could inject control characters into the server log.
    console.error('[mcp] request failed:', sanitizeForLog(error));
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
      { status: 500 },
    );
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
export function GET() {
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

/** Session termination — nothing to terminate without sessions. */
export function DELETE() {
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
