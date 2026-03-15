import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getSupabaseClient } from '@/lib/api-v2-auth';
import { triggerSyncFromPeer } from '@/lib/gossip-sync';
import { verifySignature } from '@airchat/shared/gossip';

/**
 * POST /api/v2/gossip/notify — Push notification from a peer.
 *
 * Authenticated via signed timestamp (same as sync endpoint).
 * Body: { fingerprint: string, timestamp: string, signature: string, message_count?: number }
 */
export async function POST(request: NextRequest) {
  let body: { fingerprint: string; timestamp: string; signature: string; message_count?: number };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!body.fingerprint || !body.timestamp || !body.signature) {
    return errorResponse('fingerprint, timestamp, and signature required', 400);
  }

  // Replay protection: reject timestamps more than 5 minutes old
  const requestAge = Date.now() - new Date(body.timestamp).getTime();
  if (isNaN(requestAge) || Math.abs(requestAge) > 5 * 60 * 1000) {
    return errorResponse('Timestamp too old or invalid', 401);
  }

  const supabase = getSupabaseClient();

  // Verify peer
  const { data: peer } = await supabase
    .from('gossip_peers')
    .select('id, endpoint, active, suspended, public_key')
    .eq('fingerprint', body.fingerprint)
    .single();

  if (!peer) {
    return errorResponse('Unknown peer', 403);
  }
  if (!peer.active || peer.suspended) {
    return errorResponse('Peer is suspended', 403);
  }

  // Verify signature
  if (!peer.public_key) {
    return errorResponse('Peer public key not yet exchanged', 403);
  }
  if (!verifySignature(peer.public_key, body.timestamp, body.signature)) {
    return errorResponse('Invalid signature', 403);
  }

  // Check gossip is enabled
  const { data: config } = await supabase
    .from('gossip_instance_config')
    .select('gossip_enabled')
    .limit(1)
    .single();

  if (!config?.gossip_enabled) {
    return errorResponse('Gossip is disabled', 503);
  }

  // Trigger immediate sync from this peer (async, don't block the response)
  triggerSyncFromPeer(peer.id).catch(() => {
    // Sync errors are logged internally, don't fail the notification
  });

  return jsonResponse({ acknowledged: true });
}
