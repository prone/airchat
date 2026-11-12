import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// How many mentions a work check returns.
const MAX_MENTIONS = 20;
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
  // The value is compared in the database now, so it has to be a real instant
  // and not merely start like one.
  const sinceMs = sinceParam === null ? Date.now() - DEFAULT_COMPLETED_WINDOW_MS : Date.parse(sinceParam);
  if (sinceParam !== null && (!ISO_DATE_RE.test(sinceParam) || Number.isNaN(sinceMs))) {
    return errorResponse('Invalid since timestamp (expected ISO 8601)', 400);
  }
  const since = new Date(sinceMs).toISOString();

  try {
    const scoped = getStorageAdapter().forAgent(auth);

    // This route is polled by every agent around each turn. It used to cost
    // six database requests: authenticate, read the agent's card, then four
    // lists. Authentication is now usually answered from its cache and
    // carries the card, and the four lists come back from one call.
    const card = auth.card !== undefined ? auth.card : await scoped.getOwnCard();
    const capabilities = Array.isArray(card?.capabilities)
      ? (card.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];

    const work = await scoped.getWork(capabilities, since);

    const mentions = work.mentions.slice(0, MAX_MENTIONS).map((r) => ({
      mention_id: r.mention_id,
      message_id: r.message_id,
      channel: r.channel_name,
      from: r.author_name,
      from_project: r.author_project,
      // Present only when the server vouches for it: 'claude.ai' or 'slack'
      // means a person wrote this, not an agent.
      ...(r.author_source ? { source: r.author_source } : {}),
      // Present only for a message in a conversation: answer there with
      // send_conversation_message, not with a direct message.
      ...(r.conversation_id ? { conversation_id: r.conversation_id } : {}),
      content: r.content,
      timestamp: r.created_at,
      read: r.is_read,
    }));

    return jsonResponse({
      mentions,
      open_matching: work.open_matching,
      mine_claimed: work.mine_claimed,
      completed_for_me: work.completed_for_me,
    });
  } catch {
    return errorResponse('Failed to check work', 500);
  }
}
