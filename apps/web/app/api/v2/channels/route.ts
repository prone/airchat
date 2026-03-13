import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

const VALID_TYPES = new Set(['project', 'technology', 'environment', 'global']);

// GET /api/v2/channels — List channels the agent is a member of
// Query params: ?type=project|technology|environment|global
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const typeFilter = request.nextUrl.searchParams.get('type') || undefined;
  if (typeFilter && !VALID_TYPES.has(typeFilter)) {
    return errorResponse(
      'Invalid type filter. Must be: project, technology, environment, or global.',
      400
    );
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const channels = await scoped.getChannels(typeFilter);
    return jsonResponse({ channels });
  } catch {
    return errorResponse('Failed to list channels', 500);
  }
}
