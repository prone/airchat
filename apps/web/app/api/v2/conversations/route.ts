import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter, resolveTrustedSource } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE } from '@/lib/api-v1-validation';
import {
  MAX_CONVERSATION_PARTICIPANTS,
  MAX_CONVERSATION_TITLE,
  checkMessageContent,
  conversationErrorResponse,
  readObjectBody,
  titleIsPlain,
} from '@/lib/conversations';

// GET /api/v2/conversations — the caller's conversations, most recently
// active first, each with its participants and unread count.
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  try {
    const conversations = await getStorageAdapter().forAgent(auth).listConversations();
    return jsonResponse({ conversations });
  } catch {
    return errorResponse('Failed to list conversations', 500);
  }
}

// POST /api/v2/conversations — start a conversation.
// Body: { participants: ["agent-name", ...], title?, content? }
// `participants` are the other agents; the caller is always in it. With
// `content`, the first message is sent in the same request.
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  const body = await readObjectBody(request);
  if (!body) return errorResponse('Body must be a JSON object', 400);

  const { participants, title, content } = body;
  if (!Array.isArray(participants) || participants.length === 0
      || participants.some((p) => typeof p !== 'string' || !AGENT_NAME_RE.test(p))) {
    return errorResponse('participants must be a list of agent names', 400);
  }
  const others = [...new Set(participants as string[])].filter((name) => name !== auth.agentName);
  if (others.length === 0) {
    return errorResponse('A conversation needs at least one other agent', 400);
  }
  if (others.length + 1 > MAX_CONVERSATION_PARTICIPANTS) {
    return errorResponse(`A conversation can have at most ${MAX_CONVERSATION_PARTICIPANTS} agents`, 400);
  }
  if (title !== undefined && title !== null
      && (typeof title !== 'string' || title.length > MAX_CONVERSATION_TITLE)) {
    return errorResponse(`title must be a string of at most ${MAX_CONVERSATION_TITLE} characters`, 400);
  }
  if (typeof title === 'string' && !titleIsPlain(title)) {
    return errorResponse('title must be one line of plain text (no control characters)', 400);
  }
  let first: string | null = null;
  if (content !== undefined && content !== null) {
    const checked = checkMessageContent(content);
    if ('error' in checked) return errorResponse(checked.error, 400);
    first = checked.content;
  }

  try {
    const scoped = getStorageAdapter().forAgent(auth);
    const conversation = await scoped.createConversation(others, typeof title === 'string' ? title : undefined);
    if (first === null) return jsonResponse({ conversation }, 201);

    const trustedSource = resolveTrustedSource(auth);
    const message = await scoped.sendConversationMessage(
      conversation.id,
      first,
      trustedSource ? { source: trustedSource } : undefined
    );
    return jsonResponse({ conversation, message }, 201);
  } catch (e) {
    return conversationErrorResponse(e, 'Failed to start conversation');
  }
}
