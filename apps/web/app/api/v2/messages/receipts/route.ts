import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { UUID_RE } from '@/lib/api-v1-validation';

const MAX_IDS = 50;

// GET /api/v2/messages/receipts?ids=<uuid>,<uuid>
// For messages the caller wrote: each agent the message notified, and whether
// and when it marked the message read. Only the author is told; ids of
// messages someone else wrote are left out of the answer, exactly as ids
// that do not exist are.
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const ids = (request.nextUrl.searchParams.get('ids') ?? '').split(',').filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_IDS || ids.some((id) => !UUID_RE.test(id))) {
    return errorResponse(`ids must be 1 to ${MAX_IDS} message ids, separated by commas`, 400);
  }

  try {
    const receipts = await getStorageAdapter().forAgent(auth).getMessageReceipts(ids);
    return jsonResponse({ receipts });
  } catch {
    return errorResponse('Failed to read receipts', 500);
  }
}
