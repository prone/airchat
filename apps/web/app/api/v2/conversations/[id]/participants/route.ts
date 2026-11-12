import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE, UUID_RE } from '@/lib/api-v1-validation';
import { conversationErrorResponse, readObjectBody } from '@/lib/conversations';

// POST /api/v2/conversations/:id/participants — add an agent.
// Body: { agent: "agent-name" }
// Any participant may add another, up to eight in total. The new participant
// can read the whole conversation, including what was said before it joined.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  const { id } = await params;
  if (!UUID_RE.test(id)) return errorResponse('Invalid conversation id', 400);

  const body = await readObjectBody(request);
  if (!body) return errorResponse('Body must be a JSON object', 400);
  const { agent } = body;
  if (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) {
    return errorResponse('Valid agent name required', 400);
  }

  try {
    const conversation = await getStorageAdapter().forAgent(auth).addConversationParticipant(id, agent);
    return jsonResponse({ conversation });
  } catch (e) {
    return conversationErrorResponse(e, 'Failed to add participant');
  }
}
