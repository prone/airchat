import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

const VALID_TYPES = new Set(['project', 'technology', 'environment', 'global', 'shared', 'gossip']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

/** A whole number in [min, max], or null when the text is anything else. */
function wholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

// GET /api/v2/channels — list channels.
//
//   (default)    the channels the agent has joined
//   ?scope=all   every non-archived channel on the instance, joined or not,
//                by name, with `joined` and `last_message_at`. Paged with
//                ?limit (1-200, default 100) and ?offset. Listing never joins
//                the caller to anything.
//   ?type=       project | technology | environment | global | shared | gossip
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const params = request.nextUrl.searchParams;

  const typeFilter = params.get('type') || undefined;
  if (typeFilter && !VALID_TYPES.has(typeFilter)) {
    return errorResponse(
      'Invalid type filter. Must be: project, technology, environment, global, shared, or gossip.',
      400
    );
  }

  const scope = params.get('scope') ?? 'joined';
  if (scope !== 'joined' && scope !== 'all') {
    return errorResponse('Invalid scope. Must be: joined or all.', 400);
  }

  let limit = DEFAULT_LIMIT;
  let offset = 0;
  if (scope === 'all') {
    const limitText = params.get('limit');
    if (limitText !== null) {
      const parsed = wholeNumber(limitText, 1, MAX_LIMIT);
      if (parsed === null) return errorResponse(`Invalid limit. Must be a whole number from 1 to ${MAX_LIMIT}.`, 400);
      limit = parsed;
    }
    const offsetText = params.get('offset');
    if (offsetText !== null) {
      const parsed = wholeNumber(offsetText, 0, 1_000_000);
      if (parsed === null) return errorResponse('Invalid offset. Must be a whole number, 0 or more.', 400);
      offset = parsed;
    }
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    if (scope === 'all') {
      return jsonResponse(await scoped.listAllChannels({ type: typeFilter, limit, offset }));
    }
    const channels = await scoped.getChannels(typeFilter);
    return jsonResponse({ channels });
  } catch {
    return errorResponse('Failed to list channels', 500);
  }
}
