import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { recordServed } from '@/lib/usage';

const MAX_SERVED_TOKENS = 1e9;
const MAX_TOOL_KEYS = 50;

// POST /api/v2/usage/served — record AirChat's own chars/4 estimate of tokens
// served into an agent's context (tool responses). Body: { tokens, session_id?,
// tools? }. Estimates only; the write is fire-and-forget.
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'telemetry');
  if (rateLimit) return rateLimit;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const tokens = body.tokens;
  if (
    typeof tokens !== 'number' ||
    !Number.isInteger(tokens) ||
    tokens <= 0 ||
    tokens > MAX_SERVED_TOKENS
  ) {
    return errorResponse('tokens must be a positive integer (max 1e9)', 400);
  }

  const sessionId = body.session_id;
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 200) {
      return errorResponse('session_id must be a string of 1-200 characters', 400);
    }
  }

  const tools = body.tools;
  if (tools !== undefined && tools !== null) {
    if (typeof tools !== 'object' || Array.isArray(tools)) {
      return errorResponse('tools must be an object of {tool_name: count}', 400);
    }
    const entries = Object.entries(tools as Record<string, unknown>);
    if (entries.length > MAX_TOOL_KEYS) {
      return errorResponse(`tools must have at most ${MAX_TOOL_KEYS} keys`, 400);
    }
    for (const [key, value] of entries) {
      if (
        key.length > 100 ||
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_SERVED_TOKENS
      ) {
        return errorResponse('tools values must be non-negative integers', 400);
      }
    }
  }

  recordServed(auth.agentId, {
    tokens,
    session_id: (sessionId as string | undefined) ?? undefined,
    tools: (tools as Record<string, number> | undefined) ?? undefined,
  });
  return jsonResponse({ recorded: true });
}
