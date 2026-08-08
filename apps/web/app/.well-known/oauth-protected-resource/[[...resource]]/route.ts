/**
 * RFC 9728 protected-resource metadata for the MCP endpoint.
 *
 * Served from an optional catch-all because clients request this document at
 * two different paths. RFC 9728 §3.1 inserts the resource's path after the
 * well-known segment, giving /.well-known/oauth-protected-resource/api/mcp,
 * while clients also probe the bare /.well-known/oauth-protected-resource.
 * claude.ai requested both, in that order, during the spike — so both answer.
 *
 * Any other suffix 404s rather than describing a resource this server does not
 * protect.
 */

import { NextRequest, NextResponse } from 'next/server';
import { protectedResourceMetadata, MCP_RESOURCE_PATH } from '@/lib/oauth-metadata';
import { withOAuthCors, oauthPreflight } from '@/lib/mcp-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The only resource this server protects, as path segments. */
const RESOURCE_SEGMENTS = MCP_RESOURCE_PATH.split('/').filter(Boolean).join('/');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ resource?: string[] }> },
) {
  const { resource } = await params;
  const requested = (resource ?? []).join('/');

  if (requested !== '' && requested !== RESOURCE_SEGMENTS) {
    return withOAuthCors(NextResponse.json({ error: 'Unknown resource' }, { status: 404 }));
  }

  return withOAuthCors(NextResponse.json(protectedResourceMetadata(request), {
    headers: {
      // Discovery documents are public and stable; a short cache spares the
      // origin repeated probes without making a change slow to take effect.
      'cache-control': 'public, max-age=300',
    },
  }));
}

export function OPTIONS() {
  return oauthPreflight();
}
