/**
 * RFC 8414 authorization-server metadata.
 *
 * claude.ai requested this during the spike, immediately after the
 * protected-resource document, and failed when it 404'd.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorizationServerMetadata } from '@/lib/oauth-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(request), {
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
