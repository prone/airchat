/**
 * The canonical MCP endpoint: `/mcp`.
 *
 * The path is not cosmetic. claude.ai's custom connector silently fails the
 * post-token handshake when the endpoint path is anything other than `/mcp`:
 * it completes OAuth, receives a working token, then never sends an
 * authenticated MCP request, re-registers a fresh OAuth client and reports
 * "Authorization with the MCP server failed"
 * (anthropics/claude-ai-mcp#423, open).
 *
 * We hit exactly that on `/api/mcp`. The tunnel log showed register →
 * authorize → consent → approve → token, a token issued with the correct
 * audience and scope, and then nothing at all — with a brand-new client
 * registered on every attempt, which is the re-registration loop that issue
 * describes. Nothing was wrong with this server; the path was.
 *
 * `/api/mcp` still serves the same handler for CLI-issued tokens.
 */

import { NextRequest } from 'next/server';
import {
  handleMcpPost,
  mcpPreflight,
  mcpGetNotAllowed,
  mcpDeleteNotAllowed,
} from '@/lib/mcp-endpoint';

// Calls into the storage adapter and Node crypto.
export const runtime = 'nodejs';
// Auth depends on a per-request header, so nothing here is cacheable.
export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return mcpPreflight();
}

export async function POST(request: NextRequest) {
  return handleMcpPost(request);
}

export function GET() {
  return mcpGetNotAllowed();
}

export function DELETE() {
  return mcpDeleteNotAllowed();
}
