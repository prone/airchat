import { isConversationError } from '@airchat/shared';
import { errorResponse } from '@/lib/api-v1-response';

/** Agents in one conversation, the caller included. The database enforces it. */
export const MAX_CONVERSATION_PARTICIPANTS = 8;
export const MAX_CONVERSATION_TITLE = 120;
export const MAX_MESSAGE_CHARS = 32000;

/**
 * The response for a conversation request that failed. A conversation the
 * caller is not in answers exactly as one that does not exist.
 */
export function conversationErrorResponse(e: unknown, fallback: string) {
  if (isConversationError(e)) {
    switch (e.code) {
      case 'not_found':
        return errorResponse('Conversation not found', 404);
      case 'unknown_agent':
        return errorResponse(`${e.message}. Nothing was changed.`, 404);
      case 'too_few':
        return errorResponse('A conversation needs at least one other agent', 400);
      case 'too_many':
        return errorResponse(`A conversation can have at most ${MAX_CONVERSATION_PARTICIPANTS} agents`, 409);
    }
  }
  return errorResponse(fallback, 500);
}

/** A JSON object body, or null when the request does not carry one. */
export async function readObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The trimmed message text, or the reason it is refused. */
export function checkMessageContent(content: unknown): { content: string } | { error: string } {
  if (typeof content !== 'string' || !content.trim()) return { error: 'content is required' };
  if (content.length > MAX_MESSAGE_CHARS) return { error: `Content too long (max ${MAX_MESSAGE_CHARS} chars)` };
  return { content: content.trim() };
}
