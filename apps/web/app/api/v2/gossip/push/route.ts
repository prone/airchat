import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getGossipAdapter } from '@/lib/api-v2-auth';
import { verifySignature } from '@airchat/shared/gossip';
import { processInboundMessages } from '@/lib/gossip-sync';
import { checkRateLimit } from '@/lib/rate-limit';
import { checkGossipNonce } from '@/lib/gossip-nonce';

/**
 * POST /api/v2/gossip/push — Receive pushed messages from a peer.
 *
 * Used when a peer posts to a gossip channel and pushes the message
 * directly, instead of waiting for the receiver to pull via /sync.
 * This enables federation when the sender is behind NAT.
 *
 * Authenticated via signed timestamp (same as /sync and /notify).
 * Max 10 messages per push request.
 */
export async function POST(request: NextRequest) {
  const fingerprint = request.headers.get('x-gossip-fingerprint');
  const timestamp = request.headers.get('x-gossip-timestamp');
  const signature = request.headers.get('x-gossip-signature');

  if (!fingerprint || !timestamp || !signature) {
    return errorResponse('x-gossip-fingerprint, x-gossip-timestamp, and x-gossip-signature headers required', 401);
  }

  // Replay protection: timestamp window
  const requestAge = Date.now() - new Date(timestamp).getTime();
  if (isNaN(requestAge) || Math.abs(requestAge) > 5 * 60 * 1000) {
    return errorResponse('Request timestamp too old or invalid', 401);
  }

  // Replay protection: nonce dedup
  if (checkGossipNonce(fingerprint, timestamp)) {
    return errorResponse('Duplicate request', 401);
  }

  const gossip = getGossipAdapter();

  const peer = await gossip.getPeerByFingerprint(fingerprint);
  if (!peer) return errorResponse('Unknown peer', 403);
  if (!peer.active || peer.suspended) return errorResponse('Peer is suspended', 403);

  // Per-peer rate limiting (30 pushes/min)
  const rateLimit = checkRateLimit(`gossip-push:${fingerprint}`, 60_000, 30);
  if (!rateLimit.allowed) {
    return errorResponse('Rate limit exceeded', 429);
  }

  if (!peer.public_key) return errorResponse('Peer public key not yet exchanged', 403);
  if (!verifySignature(peer.public_key, timestamp, signature)) {
    return errorResponse('Invalid signature', 403);
  }

  const config = await gossip.getInstanceConfig();
  if (!config?.gossip_enabled) return errorResponse('Gossip is disabled on this instance', 503);

  let body: { messages: Array<Record<string, unknown>> };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse('messages array required', 400);
  }

  // Limit to 10 messages per push to prevent abuse
  // Normalize envelope format to match what processInboundMessage expects (sync format)
  // Note: author_display is derived from signed author_agent only (not from raw input)
  const messages = body.messages.slice(0, 10).map((msg: Record<string, unknown>) => ({
    ...msg,
    id: msg.id ?? msg.message_id,
    channels: msg.channels ?? { name: msg.channel_name },
    agents: msg.agents ?? { name: msg.author_agent },
    hop_count: (msg.hop_count as number) ?? 0,
    // Security: derive author_display from signed author_agent only
    author_display: msg.author_agent,
  }));

  const { stored, quarantined } = await processInboundMessages(messages, peer, gossip);

  if (stored > 0 || quarantined > 0) {
    console.log(`[gossip] Push from ${peer.display_name || peer.fingerprint}: ${stored} stored, ${quarantined} quarantined`);
  }

  return jsonResponse({ accepted: messages.length, stored, quarantined });
}
