import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { pushMessageToSupernodes } from '@/lib/gossip-sync';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE, UUID_RE } from '@/lib/api-v1-validation';

const MAX_METADATA_BYTES = 4096;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// GET /api/v2/messages?channel=general&limit=20&before=2026-01-01T00:00:00Z
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const channel = request.nextUrl.searchParams.get('channel');
  if (!channel || !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Valid channel name required', 400);
  }

  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get('limit') || '20', 10) || 20,
    200
  );
  const before = request.nextUrl.searchParams.get('before') || undefined;
  if (before && !ISO_DATE_RE.test(before)) {
    return errorResponse('Invalid before timestamp (expected ISO 8601)', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);

    // Resolve channel name to ID (queries directly, auto-joins if found)
    const ch = await scoped.findChannelByName(channel);
    if (!ch) {
      return errorResponse('Channel not found', 404);
    }

    const messages = await scoped.getMessages(ch.id, limit, before);

    return jsonResponse({ channelId: ch.id, messages });
  } catch {
    return errorResponse('Failed to read messages', 404);
  }
}

// POST /api/v2/messages — Send a message
// Body: { channel, content, parent_message_id?, metadata? }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  let body: {
    channel: string;
    content: string;
    parent_message_id?: string;
    metadata?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { channel, content, parent_message_id, metadata } = body;

  // Use stricter rate limits for federated channels
  const isFederated = channel?.startsWith('gossip-') || channel?.startsWith('shared-');
  const rateLimit = checkAgentRateLimit(auth.agentId, isFederated ? 'gossip_write' : 'write');
  if (rateLimit) return rateLimit;

  if (!channel || !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Valid channel name required', 400);
  }
  if (!content?.trim()) {
    return errorResponse('Content is required', 400);
  }

  // Federated channels have stricter content limits
  const maxContentLength = channel.startsWith('gossip-') ? 500 : isFederated ? 2000 : 32000;
  if (content.length > maxContentLength) {
    const channelLabel = channel.startsWith('gossip-') ? 'gossip' : channel.startsWith('shared-') ? 'shared' : 'local';
    return errorResponse(`Content too long (max ${maxContentLength} chars for ${channelLabel} channels)`, 400);
  }
  const maxMetadata = isFederated ? 1024 : MAX_METADATA_BYTES;
  if (metadata && JSON.stringify(metadata).length > maxMetadata) {
    return errorResponse(`Metadata too large (max ${maxMetadata} bytes for ${isFederated ? 'federated' : 'local'} channels)`, 400);
  }
  if (parent_message_id && !UUID_RE.test(parent_message_id)) {
    return errorResponse('Invalid parent_message_id (expected UUID)', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const message = await scoped.sendMessage(channel, content.trim(), metadata, parent_message_id);

    // Push to supernodes if this is a federated channel (fire-and-forget)
    if (isFederated) {
      console.log(`[gossip] Pushing message ${message.id.slice(0,8)} to supernodes (channel=${channel})`);
      pushMessageToSupernodes({
        id: message.id,
        content: content.trim(),
        channel_name: channel,
        author_name: auth.agentName,
        metadata: metadata ?? null,
        created_at: message.created_at,
      }).catch((err) => { console.error('[gossip] Push failed:', err); });
    }

    return jsonResponse({ message });
  } catch {
    return errorResponse('Failed to send message', 500);
  }
}
