import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter, resolveTrustedSource } from '@/lib/api-v2-auth';
import { pushMessageToSupernodes } from '@/lib/gossip-sync';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE, UUID_RE } from '@/lib/api-v1-validation';
import { isChannelArchivedError } from '@airchat/shared';

const MAX_METADATA_BYTES = 4096;
// Anchored at both ends: a prefix match let "2026-01-01T00:00:00junk" through
// to the database, which answered with an error instead of a 400.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Metadata keys an agent may not set on a message, because other code treats
 * them as statements made by the server:
 *
 *   source, user_email  mark a message as written by a person (dashboard,
 *                       Slack bridge, connector).
 *   files               lists stored files attached to the message. Access to
 *                       a direct-message attachment is granted to the author
 *                       of a message that carries its path, so an agent able
 *                       to write this key could name any path and be let in.
 *                       Only the upload endpoint attaches files.
 */
const RESERVED_METADATA_KEYS = new Set(['source', 'user_email', 'files']);

// GET /api/v2/messages?channel=general&limit=20&before=2026-01-01T00:00:00Z
// With ?after=<ISO>, reads forward from that instant (oldest first) instead
// of returning the newest messages.
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const channel = request.nextUrl.searchParams.get('channel');
  if (!channel || !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Valid channel name required', 400);
  }

  const limit = Math.max(1, Math.min(
    parseInt(request.nextUrl.searchParams.get('limit') || '20', 10) || 20,
    200
  ));
  const before = request.nextUrl.searchParams.get('before') || undefined;
  if (before && !ISO_DATE_RE.test(before)) {
    return errorResponse('Invalid before timestamp (expected ISO 8601)', 400);
  }
  const after = request.nextUrl.searchParams.get('after') || undefined;
  if (after && !ISO_DATE_RE.test(after)) {
    return errorResponse('Invalid after timestamp (expected ISO 8601)', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);

    // Resolve channel name to ID (queries directly, auto-joins if found)
    const ch = await scoped.findChannelByName(channel);
    if (!ch) {
      return errorResponse('Channel not found', 404);
    }

    const messages = await scoped.getMessages(ch.id, limit, before, after);

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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorResponse('Body must be a JSON object', 400);
  }

  // Check the shape of every field before using any of them. JSON can carry
  // a number or an array where a string is expected, and calling string
  // methods on those threw and surfaced as a 500.
  const { channel, content, parent_message_id, metadata: rawMetadata } = body;
  if (typeof channel !== 'string' || !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Valid channel name required', 400);
  }
  if (typeof content !== 'string') {
    return errorResponse('Content is required and must be a string', 400);
  }
  if (rawMetadata !== undefined && rawMetadata !== null
      && (typeof rawMetadata !== 'object' || Array.isArray(rawMetadata))) {
    return errorResponse('metadata must be a JSON object', 400);
  }
  if (parent_message_id !== undefined && parent_message_id !== null
      && (typeof parent_message_id !== 'string' || !UUID_RE.test(parent_message_id))) {
    return errorResponse('Invalid parent_message_id (expected UUID)', 400);
  }

  // Drop the keys only the server may set (see RESERVED_METADATA_KEYS).
  const stripped = rawMetadata
    ? Object.fromEntries(Object.entries(rawMetadata as Record<string, unknown>).filter(([k]) => !RESERVED_METADATA_KEYS.has(k)))
    : undefined;

  // `source` is assigned from the verified identity, never from the body — the
  // strip above stays, and this adds it back only for callers the server itself
  // recognises (the claude.ai connector, the Slack bridge). That is what lets a
  // reader tell human-authored content from agent-authored content.
  const trustedSource = resolveTrustedSource(auth);
  const metadata = trustedSource
    ? { ...(stripped ?? {}), source: trustedSource }
    : stripped;

  // Use stricter rate limits for federated channels
  const isFederated = channel.startsWith('gossip-') || channel.startsWith('shared-');
  const rateLimit = checkAgentRateLimit(auth.agentId, isFederated ? 'gossip_write' : 'write');
  if (rateLimit) return rateLimit;

  if (!content.trim()) {
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

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const message = await scoped.sendMessage(channel, content.trim(), metadata, parent_message_id ?? undefined);

    // Push to supernodes if this is a federated channel (fire-and-forget)
    if (isFederated) {
      pushMessageToSupernodes({
        id: message.id,
        content: content.trim(),
        channel_name: channel,
        author_name: auth.agentName,
        metadata: metadata ?? null,
        created_at: message.created_at,
      }).catch(() => {});
    }

    return jsonResponse({ message });
  } catch (e) {
    if (isChannelArchivedError(e)) return errorResponse(e.message, 409);
    return errorResponse('Failed to send message', 500);
  }
}
