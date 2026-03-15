import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getGossipAdapter } from '@/lib/api-v2-auth';
import { triggerSyncFromPeer } from '@/lib/gossip-sync';
import { verifySignature } from '@airchat/shared/gossip';

/**
 * POST /api/v2/gossip/notify — Push notification from a peer.
 * Authenticated via signed timestamp.
 */
export async function POST(request: NextRequest) {
  let body: { fingerprint: string; timestamp: string; signature: string; message_count?: number };
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body', 400); }

  if (!body.fingerprint || !body.timestamp || !body.signature) {
    return errorResponse('fingerprint, timestamp, and signature required', 400);
  }

  // Replay protection
  const requestAge = Date.now() - new Date(body.timestamp).getTime();
  if (isNaN(requestAge) || Math.abs(requestAge) > 5 * 60 * 1000) {
    return errorResponse('Timestamp too old or invalid', 401);
  }

  const gossip = getGossipAdapter();

  const peer = await gossip.getPeerByFingerprint(body.fingerprint);
  if (!peer) return errorResponse('Unknown peer', 403);
  if (!peer.active || peer.suspended) return errorResponse('Peer is suspended', 403);

  if (!peer.public_key) return errorResponse('Peer public key not yet exchanged', 403);
  if (!verifySignature(peer.public_key, body.timestamp, body.signature)) {
    return errorResponse('Invalid signature', 403);
  }

  const config = await gossip.getInstanceConfig();
  if (!config?.gossip_enabled) return errorResponse('Gossip is disabled', 503);

  // Trigger immediate sync (async)
  triggerSyncFromPeer(peer.id).catch(() => {});

  return jsonResponse({ acknowledged: true });
}
