import { NextRequest } from 'next/server';
import { USAGE_WINDOWS, USAGE_WINDOW_MS, type UsageWindow } from '@airchat/shared';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getFleetUsage, getUsageSummary, UsageNotFoundError } from '@/lib/usage';

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

// GET /api/v2/usage — token usage summaries. All numbers are estimates (they
// mix exact provider counts with self-reports and chars/4 estimates).
//
// Params:
//   agent?        agent name to query (default: the caller). Any authenticated
//                 agent may query any agent BY DESIGN — cost-aware routing
//                 needs cross-agent visibility; future E-B2 ACLs land inside
//                 getUsageSummary, not here.
//   window?       '24h' | '7d' | '30d' (default '7d'), OR:
//   since/until?  ISO timestamps (until defaults to now; max 90 days).
//   all?          'true' → compact per-agent fleet totals (agent param invalid).
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const params = request.nextUrl.searchParams;
  const all = params.get('all') === 'true';
  const agentParam = params.get('agent');
  const windowParam = params.get('window');
  const sinceParam = params.get('since');
  const untilParam = params.get('until');

  if (all && agentParam) {
    return errorResponse('agent cannot be combined with all=true', 400);
  }
  if (windowParam && (sinceParam || untilParam)) {
    return errorResponse('Pass window or since/until, not both', 400);
  }
  if (untilParam && !sinceParam) {
    return errorResponse('until requires since', 400);
  }
  if (windowParam && !USAGE_WINDOWS.includes(windowParam as UsageWindow)) {
    return errorResponse(`window must be one of ${USAGE_WINDOWS.join(', ')}`, 400);
  }

  let since: Date;
  let until: Date;
  if (sinceParam) {
    since = new Date(sinceParam);
    if (Number.isNaN(since.getTime())) return errorResponse('Invalid since timestamp', 400);
    until = untilParam ? new Date(untilParam) : new Date();
    if (Number.isNaN(until.getTime())) return errorResponse('Invalid until timestamp', 400);
    if (until.getTime() <= since.getTime()) {
      return errorResponse('until must be after since', 400);
    }
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      return errorResponse('Range too large (max 90 days)', 400);
    }
  } else {
    const window = (windowParam ?? '7d') as UsageWindow;
    until = new Date();
    since = new Date(until.getTime() - USAGE_WINDOW_MS[window]);
  }

  try {
    if (all) {
      const agents = await getFleetUsage(since, until);
      return jsonResponse({
        usage: {
          since: since.toISOString(),
          until: until.toISOString(),
          agents,
          accuracy: 'estimated',
        },
      });
    }
    const usage = await getUsageSummary(agentParam ?? auth.agentName, since, until);
    return jsonResponse({ usage });
  } catch (e) {
    if (e instanceof UsageNotFoundError) return errorResponse(e.message, 404);
    console.error('[usage] query failed:', e);
    return errorResponse('Usage query failed', 500);
  }
}
