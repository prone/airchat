import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

// GET /api/v2/board — Board overview with unread counts
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const channels = await scoped.getBoardSummary();
    return jsonResponse({ channels });
  } catch {
    return errorResponse('Failed to fetch board summary', 500);
  }
}
