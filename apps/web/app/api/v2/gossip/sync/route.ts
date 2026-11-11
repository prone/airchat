import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { signEnvelope } from '@airchat/shared/gossip';
import { authenticatePeerRequest } from '@/lib/gossip-auth';
import { getPrivateKey, classifyOutbound } from '@/lib/gossip-sync';
import { stripReservedFederatedMetadata } from '@airchat/shared/supabase-gossip-adapter';

/**
 * GET /api/v2/gossip/sync — Pull federated messages from this instance.
 *
 * Authenticated by the peer's request signature (see lib/gossip-auth.ts).
 */
export async function GET(request: NextRequest) {
  const auth = await authenticatePeerRequest(request, { bucket: 'gossip-sync', maxPerMinute: 60 });
  if (auth instanceof NextResponse) return auth;
  const { peer, config, gossip } = auth;

  // Parse query params
  const since = request.nextUrl.searchParams.get('since');
  if (!since || isNaN(new Date(since).getTime())) {
    return errorResponse('since parameter required (ISO timestamp)', 400);
  }

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '100', 10) || 100, 100);

  // What this peer may receive is decided by OUR record of the peer, not by
  // what it asks for. shared-* channels (scope 'peers') go only to peers the
  // operator registered with federation_scope 'peers'; everyone else gets
  // gossip-* (scope 'global') and nothing more. The `scope` parameter can
  // narrow that — a 'peers' peer may ask for the public gossip-* feed — but
  // never widen it.
  const requested = request.nextUrl.searchParams.get('scope') || peer.federation_scope;
  if (!['peers', 'global'].includes(requested)) return errorResponse('scope must be "peers" or "global"', 400);
  if (requested === 'peers' && peer.federation_scope !== 'peers') {
    return errorResponse('This peer is not registered for shared channels', 403);
  }

  try {
    const scopeFilter = requested === 'peers' ? ['peers'] : ['global'];
    const allMessages = await gossip.getFederatedMessages({ since, limit, scopeFilter });

    // Post-filter: per-channel-type hop limits
    const withinHops = allMessages.filter((msg: Record<string, unknown>) => {
      const ch = msg.channels as unknown as { name: string };
      const maxHops = ch?.name?.startsWith('gossip-') ? 3 : 1;
      return ((msg.hop_count as number) ?? 0) < maxHops;
    });

    // Messages written on this instance are stored without safety labels, so
    // they are classified here, on the way out. Anything the classifier would
    // quarantine is not handed to peers. Relayed messages were classified when
    // they arrived and quarantined ones are already excluded by the query.
    const messages: Record<string, unknown>[] = [];
    for (const msg of withinHops) {
      if (messages.length >= limit) break;
      // Server-assigned metadata (who posted from the dashboard, their email,
      // stored file paths) describes this instance's users and storage and is
      // not handed to other instances.
      const metadata = stripReservedFederatedMetadata(msg.metadata as Record<string, unknown> | null);
      if (msg.origin_instance == null) {
        const outbound = classifyOutbound(typeof msg.content === 'string' ? msg.content : '', metadata);
        if (outbound.quarantined) continue;
        messages.push({ ...msg, metadata, safety_labels: outbound.labels });
      } else {
        messages.push({ ...msg, metadata });
      }
    }

    // Sign locally-originated messages that don't have envelope signatures yet.
    const privateKey = await getPrivateKey();

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
        origin_instance: config.fingerprint,
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
        origin_public_key: config.public_key,
        origin_instance: config.fingerprint,
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
