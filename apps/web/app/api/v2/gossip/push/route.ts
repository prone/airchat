import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { processInboundMessages } from '@/lib/gossip-sync';
import { authenticatePeerRequest } from '@/lib/gossip-auth';
import { sanitizeForLog } from '@/lib/sanitize';

/**
 * POST /api/v2/gossip/push — Receive pushed messages from a peer.
 *
 * Used when a peer posts to a gossip channel and pushes the message
 * directly, instead of waiting for the receiver to pull via /sync.
 * This enables federation when the sender is behind NAT.
 *
 * Authenticated by the peer's request signature, which covers the body (see
 * lib/gossip-auth.ts). Max 10 messages per push request.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticatePeerRequest(request, {
    bucket: 'gossip-push',
    maxPerMinute: 30,
    readBody: true,
  });
  if (auth instanceof NextResponse) return auth;
  const { peer, gossip } = auth;

  let body: { messages?: unknown };
  try {
    body = JSON.parse(auth.body);
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse('messages array required', 400);
  }

  // Limit to 10 messages per push to prevent abuse.
  // Normalize envelope format to match what processInboundMessage expects (sync format).
  // Entries that are not objects become empty records, which the per-message
  // validation then rejects without affecting the rest of the batch.
  const messages = body.messages.slice(0, 10).map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
    const msg = entry as Record<string, unknown>;
    return {
      ...msg,
      id: msg.id ?? msg.message_id,
      channels: msg.channels ?? { name: msg.channel_name },
      agents: msg.agents ?? { name: msg.author_agent },
      hop_count: msg.hop_count ?? 0,
      // The author shown is the one covered by the envelope signature
      // (author_agent), never a separate unsigned field.
      author_display: msg.author_agent,
    };
  });

  const { stored, quarantined } = await processInboundMessages(messages, peer, gossip);

  if (stored > 0 || quarantined > 0) {
    console.log(`[gossip] Push from ${sanitizeForLog(peer.display_name || peer.fingerprint)}: ${stored} stored, ${quarantined} quarantined`);
  }

  return jsonResponse({ accepted: messages.length, stored, quarantined });
}
