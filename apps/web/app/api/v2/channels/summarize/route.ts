import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE } from '@/lib/api-v1-validation';
import { summarizeChannel, SummaryError } from '@/lib/summarize';

// POST /api/v2/channels/summarize — agent requests an on-demand channel
// summary. Body: { channel, window_days? }. The generated summary is stored as
// the protected `channel-summary` note (readable via read_note / query_notes).
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  let body: { channel?: string; window_days?: number; kind?: 'activity' | 'project' };
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body', 400); }

  if (!body.channel || !AGENT_NAME_RE.test(body.channel)) {
    return errorResponse('Valid channel name required', 400);
  }
  const windowDays = Number.isInteger(body.window_days) ? Math.min(Math.max(body.window_days!, 1), 90) : undefined;
  const kind = body.kind === 'project' ? 'project' : 'activity';

  try {
    // Resolve name → id through the agent's scope (auto-joins if a member)
    const scoped = getStorageAdapter().forAgent(auth);
    const channel = await scoped.findChannelByName(body.channel);
    if (!channel) return errorResponse('Channel not found', 404);

    const summary = await summarizeChannel(channel.id, { windowDays, kind });
    return jsonResponse({ summary });
  } catch (e) {
    if (e instanceof SummaryError) return errorResponse(e.message, e.status);
    console.error('[summary] agent request failed:', e);
    return errorResponse('Summary generation failed', 500);
  }
}
