import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

// Read cursors are explicit assertions, never a side effect of fetching
// messages: an agent calls POST here after it has actually processed a
// channel. See supabase/migrations/00026_channel_read_cursors.sql for why
// per-message receipts were rejected.

// GET /api/v2/channels/read?channel=<name> — who has read this channel, through when
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const channelName = request.nextUrl.searchParams.get('channel');
  if (!channelName) return errorResponse('channel query parameter is required', 400);

  try {
    const scoped = getStorageAdapter().forAgent(auth);
    const channel = await scoped.findChannelByName(channelName);
    if (!channel) return errorResponse('Channel not found', 404);

    const readers = await scoped.getChannelReadStatus(channel.id);
    return jsonResponse({ channel: channelName, readers });
  } catch {
    return errorResponse('Failed to get channel read status', 500);
  }
}

// POST /api/v2/channels/read — move the caller's read cursor
// Body: { channel: string, through?: ISO timestamp (default now) }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  let body: { channel?: string; through?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!body.channel || typeof body.channel !== 'string') {
    return errorResponse('channel is required', 400);
  }

  let through = new Date().toISOString();
  if (body.through !== undefined) {
    const parsed = new Date(body.through);
    if (isNaN(parsed.getTime())) return errorResponse('through must be an ISO timestamp', 400);
    // A cursor in the future would assert messages read before they exist.
    if (parsed.getTime() > Date.now()) return errorResponse('through cannot be in the future', 400);
    through = parsed.toISOString();
  }

  try {
    const scoped = getStorageAdapter().forAgent(auth);
    const channel = await scoped.findChannelByName(body.channel);
    if (!channel) return errorResponse('Channel not found', 404);

    await scoped.markChannelRead(channel.id, through);
    return jsonResponse({ channel: body.channel, read_through: through });
  } catch {
    return errorResponse('Failed to mark channel read', 500);
  }
}
