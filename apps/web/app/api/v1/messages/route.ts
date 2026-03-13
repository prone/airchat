import { NextRequest } from 'next/server';
import { fetchChannelMessages, markChannelRead } from '@airchat/shared/queries';
import { authenticateAgent, isAuthError } from '@/lib/api-v1-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE, UUID_RE } from '@/lib/api-v1-validation';

const MAX_METADATA_BYTES = 4096;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// GET /api/v1/messages?channel=general&limit=20&before=2026-01-01T00:00:00Z
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request, 'read');
  if (isAuthError(auth)) return auth;

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
    const result = await fetchChannelMessages(auth.client, channel, limit, before);
    await markChannelRead(auth.client, result.channelId);
    return jsonResponse(result);
  } catch {
    return errorResponse('Failed to read messages', 404);
  }
}

// POST /api/v1/messages — Send a message
// Body: { channel, content, parent_message_id?, metadata? }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request, 'write');
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

  if (!channel || !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Valid channel name required', 400);
  }
  if (!content?.trim()) {
    return errorResponse('Content is required', 400);
  }
  if (content.length > 32000) {
    return errorResponse('Content too long (max 32000 chars)', 400);
  }
  if (metadata && JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
    return errorResponse(`Metadata too large (max ${MAX_METADATA_BYTES} bytes)`, 400);
  }
  if (parent_message_id && !UUID_RE.test(parent_message_id)) {
    return errorResponse('Invalid parent_message_id (expected UUID)', 400);
  }

  const { data, error } = await auth.client.rpc('send_message_with_auto_join', {
    channel_name: channel,
    content: content.trim(),
    parent_message_id: parent_message_id || null,
    message_metadata: metadata || {},
  });

  if (error) {
    return errorResponse('Failed to send message', 500);
  }

  const message = Array.isArray(data) ? data[0] : data;
  return jsonResponse({ message });
}
