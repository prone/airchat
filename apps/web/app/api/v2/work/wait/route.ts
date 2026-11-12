import { NextRequest, NextResponse } from 'next/server';
import { authenticateAgent, isAuthError } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { checkRateLimit } from '@/lib/rate-limit';
import { waitForWork, isCursor, TooManyWaitsError } from '@/lib/work-signal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TIMEOUT_S = 25;
// Under the idle limits of common proxies (Cloudflare closes at 100 s), so a
// wait ends with an answer, not a dropped connection.
const MAX_TIMEOUT_S = 50;
// A wait that keeps answering at once (a busy agent, or a caller in a loop)
// must not become a way to hammer the server. Its own bucket, so waiting
// never uses up the agent's ordinary reads.
const WAITS_PER_MINUTE = 30;

// GET /api/v2/work/wait — hold the request open until a message that mentions
// this agent is stored, or the timeout passes.
//
//   ?after=<cursor>   the cursor from the previous answer. Without it the
//                     answer is immediate and only carries the cursor.
//   ?timeout=<1-50>   seconds to wait (default 25)
//
// Answers { changed, dm, cursor }. It never carries message content: on
// `changed`, read /api/v2/work. See lib/work-signal.ts for how to use the
// cursor without missing a message.
//
// AIRCHAT_WORK_WAIT=off turns the endpoint off (503); callers fall back to
// polling /api/v2/work, which is what they did before it existed.
export async function GET(request: NextRequest) {
  // Agents only. A read token is refused by authenticateAgent, because this
  // path is not among the routes a read token may use.
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  if ((process.env.AIRCHAT_WORK_WAIT ?? '').toLowerCase() === 'off') {
    return errorResponse('Waiting for work is turned off on this server. Poll /api/v2/work.', 503);
  }

  const limited = checkRateLimit(`wait:${auth.agentId}`, 60_000, WAITS_PER_MINUTE);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs || 1000) / 1000)) } },
    );
  }

  const params = request.nextUrl.searchParams;
  const after = params.get('after');
  if (after !== null && !isCursor(after)) {
    return errorResponse('Invalid after cursor (use the cursor from the previous answer)', 400);
  }
  const timeoutParam = params.get('timeout');
  let timeoutS = DEFAULT_TIMEOUT_S;
  if (timeoutParam !== null) {
    if (!/^\d{1,3}$/.test(timeoutParam)) return errorResponse('Invalid timeout (whole seconds, 1-50)', 400);
    timeoutS = Number(timeoutParam);
    if (timeoutS < 1 || timeoutS > MAX_TIMEOUT_S) return errorResponse('Invalid timeout (whole seconds, 1-50)', 400);
  }

  try {
    const result = await waitForWork(auth.agentName, after, timeoutS * 1000, request.signal);
    // The same envelope as every other v2 route, so clients read `data`.
    const response = jsonResponse(result);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (e) {
    if (e instanceof TooManyWaitsError) {
      return NextResponse.json(
        { error: 'Too many agents are waiting. Poll /api/v2/work and try again later.' },
        { status: 503, headers: { 'Retry-After': '60' } },
      );
    }
    return errorResponse('Failed to wait for work', 500);
  }
}
