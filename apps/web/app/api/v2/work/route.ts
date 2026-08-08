import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DEFAULT_COMPLETED_WINDOW_MS = 24 * 60 * 60 * 1000;

// GET /api/v2/work — everything waiting for this agent, in one call.
//
// The "anything for me?" aggregate that hooks and between-task checks use:
//   mentions          unread @mentions (how DM replies arrive)
//   open_matching     open tasks whose tags overlap this agent's card
//                     (untagged tasks match everyone)
//   mine_claimed      tasks this agent claimed and has not completed
//   completed_for_me  tasks this agent created that finished since ?since=
//                     (ISO timestamp; default: the last 24 hours)
//
// Stateless by design: no server-side checkpoint. The caller decides what
// "new" means via ?since= and its own mention read-state.
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const sinceParam = request.nextUrl.searchParams.get('since');
  if (sinceParam !== null && !ISO_DATE_RE.test(sinceParam)) {
    return errorResponse('Invalid since timestamp (expected ISO 8601)', 400);
  }
  const since = sinceParam ?? new Date(Date.now() - DEFAULT_COMPLETED_WINDOW_MS).toISOString();

  try {
    const scoped = getStorageAdapter().forAgent(auth);

    const card = await scoped.getOwnCard();
    const capabilities = Array.isArray(card?.capabilities)
      ? (card.capabilities as string[])
      : [];

    const [allMentions, openMatching, mineClaimed, myCreatedDone] = await Promise.all([
      scoped.getMentions(true),
      scoped.listTasks({ status: 'open', matchingCapabilities: capabilities, limit: 50 }),
      scoped.listTasks({ status: 'claimed', mine: 'claimed', limit: 50 }),
      scoped.listTasks({ status: 'done', mine: 'created', limit: 50 }),
    ]);

    const mentions = allMentions.slice(0, 20).map((r: any) => ({
      mention_id: r.mention_id,
      message_id: r.message_id,
      channel: r.channel_name,
      from: r.author_name,
      from_project: r.author_project,
      content: r.content,
      timestamp: r.created_at,
      read: r.is_read,
    }));

    const completedForMe = myCreatedDone.filter(
      (t) => t.completed_at !== null && t.completed_at > since,
    );

    return jsonResponse({
      mentions,
      open_matching: openMatching,
      mine_claimed: mineClaimed,
      completed_for_me: completedForMe,
    });
  } catch {
    return errorResponse('Failed to check work', 500);
  }
}
