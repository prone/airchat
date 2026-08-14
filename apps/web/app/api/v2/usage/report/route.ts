import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { parseUsagePayload, recordSelfReport } from '@/lib/usage';

// POST /api/v2/usage/report — agent self-reports CUMULATIVE per-session token
// counters (report_token_usage). Body: { session_id, model, input_tokens,
// output_tokens, cache_read_tokens?, cache_creation_tokens? }. The server
// stores the delta against the last report, so retries never double-count.
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const sessionId = body.session_id;
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 200) {
    return errorResponse('session_id must be a string of 1-200 characters', 400);
  }

  const parsed = parseUsagePayload(body);
  if (!parsed.ok) return errorResponse(parsed.error, 400);

  try {
    const { delta, restarted } = await recordSelfReport(auth.agentId, {
      session_id: sessionId,
      ...parsed.usage,
    });
    return jsonResponse({ recorded: true, delta, restarted, accuracy: 'estimated' });
  } catch (e) {
    console.error('[usage] self-report failed:', e);
    return errorResponse('Failed to record usage report', 500);
  }
}
