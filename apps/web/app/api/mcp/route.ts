/**
 * The MCP endpoint at its original path.
 *
 * `/mcp` is canonical — see app/mcp/route.ts for why claude.ai requires it.
 * This path is kept because CLI-issued connector tokens carry a null audience
 * and are bound structurally rather than by URI, so anything already pointed
 * here keeps working. Both paths run the identical handler.
 */

import { NextRequest } from 'next/server';
import {
  handleMcpPost,
  mcpPreflight,
  mcpGetNotAllowed,
  mcpDeleteNotAllowed,
} from '@/lib/mcp-endpoint';

export const runtime = 'nodejs';
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
