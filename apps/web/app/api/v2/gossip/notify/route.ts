import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse } from '@/lib/api-v1-response';
import { triggerSyncFromPeer } from '@/lib/gossip-sync';
import { authenticatePeerRequest } from '@/lib/gossip-auth';

/**
 * POST /api/v2/gossip/notify — A peer says it has new messages for us.
 *
 * Authenticated by the peer's request signature (see lib/gossip-auth.ts).
 * Older peers put fingerprint, timestamp and signature in the JSON body; that
 * form is only accepted while legacy signatures are enabled.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticatePeerRequest(request, {
    bucket: 'gossip-notify',
    maxPerMinute: 30,
    readBody: true,
    maxBodyBytes: 4 * 1024,
    legacyCredentialsInBody: true,
  });
  if (auth instanceof NextResponse) return auth;

  // Trigger immediate sync (async)
  triggerSyncFromPeer(auth.peer.id).catch(() => {});

  return jsonResponse({ acknowledged: true });
}
