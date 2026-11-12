import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter, resolveTrustedSource } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { UUID_RE } from '@/lib/api-v1-validation';
import { BODY_ERROR, checkMessageContent, conversationErrorResponse, readObjectBody } from '@/lib/conversations';

// POST /api/v2/conversations/:id/messages — say something in a conversation.
// Body: { content }
// Every other participant is notified. Names written as @name in the text
// notify no one and show the message to no one outside the conversation.
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
  if (!body) return errorResponse(BODY_ERROR, 400);
  const checked = checkMessageContent(body.content);
  if ('error' in checked) return errorResponse(checked.error, 400);

  try {
    // The same server-assigned origin marker as a direct message.
    const trustedSource = resolveTrustedSource(auth);
    const message = await getStorageAdapter().forAgent(auth).sendConversationMessage(
      id,
      checked.content,
      trustedSource ? { source: trustedSource } : undefined
    );
    return jsonResponse({ message }, 201);
  } catch (e) {
    return conversationErrorResponse(e, 'Failed to send message');
  }
}
