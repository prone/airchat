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

/** The largest request body a conversation route reads. A full message is a quarter of it. */
export const MAX_BODY_BYTES = 512 * 1024;

/**
 * Characters a title may not contain: control characters (line breaks
 * included) and the ones that reverse the direction of text. A title is one
 * line shown in lists, by programs that each have to display it safely;
 * refusing these here means none of them has to be relied on for it.
 */
const TITLE_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export function titleIsPlain(title: string): boolean {
  return !TITLE_FORBIDDEN_RE.test(title);
}

/** The body as text, or null once it passes `maxBytes`. It is never held whole past that. */
async function readTextCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** A JSON object body, or null when the request does not carry one or it is too large. */
export async function readObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await readTextCapped(request, MAX_BODY_BYTES);
    if (text === null) return null;
    const body: unknown = JSON.parse(text);
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
