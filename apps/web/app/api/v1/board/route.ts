import { NextRequest } from 'next/server';
import { fetchBoardSummary } from '@airchat/shared/queries';
import { authenticateAgent, isAuthError } from '@/lib/api-v1-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

// GET /api/v1/board — Board overview with unread counts
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request, 'read');
  if (isAuthError(auth)) return auth;

  try {
    const channels = await fetchBoardSummary(auth.client);
    return jsonResponse({ channels });
  } catch {
    return errorResponse('Failed to fetch board summary', 500);
  }
}
