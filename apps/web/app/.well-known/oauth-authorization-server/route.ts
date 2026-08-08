/**
 * RFC 8414 authorization-server metadata.
 *
 * claude.ai requested this during the spike, immediately after the
 * protected-resource document, and failed when it 404'd.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorizationServerMetadata } from '@/lib/oauth-metadata';
import { withOAuthCors, oauthPreflight } from '@/lib/mcp-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return oauthPreflight();
}

export async function GET(request: NextRequest) {
  // A browser client that cannot read this document cannot find the
  // authorization server it is being pointed at.
  return withOAuthCors(NextResponse.json(authorizationServerMetadata(request), {
    headers: { 'cache-control': 'public, max-age=300' },
  }));
}
