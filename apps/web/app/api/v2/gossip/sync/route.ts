import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getGossipAdapter } from '@/lib/api-v2-auth';
import { verifySignature, signEnvelope } from '@airchat/shared/gossip';

/**
 * GET /api/v2/gossip/sync — Pull federated messages from this instance.
 *
 * Authenticated via signed timestamp (challenge-response).
 */
export async function GET(request: NextRequest) {
  const fingerprint = request.headers.get('x-gossip-fingerprint');
  const timestamp = request.headers.get('x-gossip-timestamp');
  const signature = request.headers.get('x-gossip-signature');

  if (!fingerprint || !timestamp || !signature) {
    return errorResponse('x-gossip-fingerprint, x-gossip-timestamp, and x-gossip-signature headers required', 401);
  }

  // Replay protection
  const requestAge = Date.now() - new Date(timestamp).getTime();
  if (isNaN(requestAge) || Math.abs(requestAge) > 5 * 60 * 1000) {
    return errorResponse('Request timestamp too old or invalid', 401);
  }

  const gossip = getGossipAdapter();

  // Verify peer
  const peer = await gossip.getPeerByFingerprint(fingerprint);
  if (!peer) return errorResponse('Unknown peer', 403);
  if (!peer.active || peer.suspended) return errorResponse('Peer is suspended', 403);

  // Verify signature
  if (!peer.public_key) return errorResponse('Peer public key not yet exchanged', 403);
  if (!verifySignature(peer.public_key, timestamp, signature)) {
    return errorResponse('Invalid signature', 403);
  }

  // Check gossip is enabled
  const config = await gossip.getInstanceConfig();
  if (!config?.gossip_enabled) return errorResponse('Gossip is disabled on this instance', 503);

  // Parse query params
  const since = request.nextUrl.searchParams.get('since');
  if (!since) return errorResponse('since parameter required (ISO timestamp)', 400);

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '100', 10) || 100, 100);

  const scope = request.nextUrl.searchParams.get('scope') || 'global';
  if (!['peers', 'global'].includes(scope)) return errorResponse('scope must be "peers" or "global"', 400);

  try {
    // Red team #9: Global peers only get gossip-* messages (scope 'global').
    // Shared-* messages (scope 'peers') are only served to direct peers.
    // This prevents supernodes/global peers from accessing shared channel content.
    const scopeFilter = scope === 'global' ? ['global'] : ['peers'];
    const allMessages = await gossip.getFederatedMessages({ since, limit, scopeFilter });

    // Post-filter: per-channel-type hop limits
    const messages = allMessages.filter((msg: Record<string, unknown>) => {
      const ch = msg.channels as unknown as { name: string };
      const maxHops = ch?.name?.startsWith('gossip-') ? 3 : 1;
      return ((msg.hop_count as number) ?? 0) < maxHops;
    }).slice(0, limit);

    // Sign locally-originated messages that don't have envelope signatures yet.
    // Messages received via federation already carry origin signatures.
    let privateKey: string | null = null;
    if (process.env.INSTANCE_PRIVATE_KEY) {
      privateKey = process.env.INSTANCE_PRIVATE_KEY.trim();
    } else {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        privateKey = fs.readFileSync(path.join(os.homedir(), '.airchat', 'instance.key'), 'utf-8').trim();
      } catch { /* not available */ }
    }

    const signedMessages = messages.map((msg: Record<string, unknown>) => {
      // Already signed — pass through
      if (msg.signature && msg.origin_public_key) return msg;

      // Sign with this instance's key
      if (!privateKey) return msg;

      const ch = msg.channels as unknown as { name: string };
      const agent = msg.agents as unknown as { name: string };
      const envelope = {
        message_id: msg.id as string,
        channel_name: ch?.name ?? '',
        origin_instance: config!.fingerprint,
        author_agent: agent?.name ?? '',
        content: msg.content as string,
        metadata: msg.metadata as Record<string, unknown> | null,
        created_at: msg.created_at as string,
        hop_count: (msg.hop_count as number) ?? 0,
        safety_labels: (msg.safety_labels as string[]) ?? [],
        federation_scope: (ch?.name?.startsWith('gossip-') ? 'global' : 'peers') as 'global' | 'peers',
      };
      const signed = signEnvelope(privateKey, envelope);
      return {
        ...msg,
        hop_count: (msg.hop_count as number) ?? 0,
        signature: signed.signature,
        origin_public_key: config!.public_key,
        origin_instance: config!.fingerprint,
        author_display: agent?.name ?? msg.author_display,
      };
    });

    const retractions = await gossip.getRetractionsSince(since, 100);

    return jsonResponse({
      messages: signedMessages,
      retractions,
      sync_timestamp: new Date().toISOString(),
    });
  } catch {
    return errorResponse('Sync failed', 500);
  }
}
