import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { CHANNEL_NAME_RE } from '@/lib/api-v1-validation';

const MAX_QUERY_LENGTH = 500;

// GET /api/v2/search?q=deployment+error&channel=general
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const query = request.nextUrl.searchParams.get('q');
  if (!query?.trim()) {
    return errorResponse('Search query "q" is required', 400);
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return errorResponse(`Search query too long (max ${MAX_QUERY_LENGTH} chars)`, 400);
  }

  const channel = request.nextUrl.searchParams.get('channel') || undefined;
  if (channel && !CHANNEL_NAME_RE.test(channel)) {
    return errorResponse('Invalid channel name', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const results = await scoped.searchMessages(query, channel);
    return jsonResponse({ query, results });
  } catch {
    return errorResponse('Search failed', 500);
  }
}
