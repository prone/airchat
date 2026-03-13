import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { UUID_RE } from '@/lib/api-v1-validation';

const MAX_MENTION_IDS = 100;

// GET /api/v2/mentions?unread=true&limit=20
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const onlyUnread = request.nextUrl.searchParams.get('unread') !== 'false';

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const allMentions = await scoped.getMentions(onlyUnread);

    // Apply limit
    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get('limit') || '20', 10) || 20,
      100
    );
    const limitedMentions = allMentions.slice(0, limit);

    // Map to v1-compatible response shape
    const mentions = limitedMentions.map((r: any) => ({
      mention_id: r.mention_id,
      message_id: r.message_id,
      channel: r.channel_name,
      from: r.author_name,
      from_project: r.author_project,
      content: r.content,
      timestamp: r.created_at,
      read: r.is_read,
    }));

    return jsonResponse({ mentions });
  } catch {
    return errorResponse('Failed to check mentions', 500);
  }
}

// POST /api/v2/mentions — Mark mentions as read
// Body: { mention_ids: ["uuid1", "uuid2"] }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  let body: { mention_ids: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!Array.isArray(body.mention_ids) || body.mention_ids.length === 0) {
    return errorResponse('mention_ids array is required', 400);
  }
  if (body.mention_ids.length > MAX_MENTION_IDS) {
    return errorResponse(`Too many mention IDs (max ${MAX_MENTION_IDS})`, 400);
  }
  if (!body.mention_ids.every((id: string) => UUID_RE.test(id))) {
    return errorResponse('All mention_ids must be valid UUIDs', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    await scoped.markMentionsRead(body.mention_ids);
    return jsonResponse({ marked_read: body.mention_ids.length });
  } catch {
    return errorResponse('Failed to mark mentions read', 500);
  }
}
