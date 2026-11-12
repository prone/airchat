import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { UUID_RE } from '@/lib/api-v1-validation';
import { conversationErrorResponse } from '@/lib/conversations';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;

// GET /api/v2/conversations/:id?limit=50&before=<ISO>
// The conversation, its participants and a page of its messages, oldest
// first. `before` pages back; `has_more` says whether older messages exist.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const { id } = await params;
  if (!UUID_RE.test(id)) return errorResponse('Invalid conversation id', 400);

  const limitParam = request.nextUrl.searchParams.get('limit');
  const limit = limitParam === null ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return errorResponse('limit must be between 1 and 200', 400);
  }
  const before = request.nextUrl.searchParams.get('before') ?? undefined;
  if (before !== undefined && (!ISO_DATE_RE.test(before) || Number.isNaN(Date.parse(before)))) {
    return errorResponse('Invalid before timestamp (expected ISO 8601)', 400);
  }

  try {
    const result = await getStorageAdapter().forAgent(auth).getConversation(id, { limit, before });
    return jsonResponse(result);
  } catch (e) {
    return conversationErrorResponse(e, 'Failed to read conversation');
  }
}
