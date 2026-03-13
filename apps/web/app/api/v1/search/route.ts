import { NextRequest } from 'next/server';
import { searchChannelMessages } from '@airchat/shared/queries';
import { authenticateAgent, isAuthError } from '@/lib/api-v1-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { CHANNEL_NAME_RE } from '@/lib/api-v1-validation';

const MAX_QUERY_LENGTH = 500;

// GET /api/v1/search?q=deployment+error&channel=general
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request, 'read');
  if (isAuthError(auth)) return auth;

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
    const results = await searchChannelMessages(auth.client, query, channel);
    return jsonResponse({ query, results });
  } catch {
    return errorResponse('Search failed', 500);
  }
}
