import { NextRequest } from 'next/server';
import { validateCard } from '@airchat/shared';
import {
  authenticateAgent,
  isAuthError,
  checkAgentRateLimit,
  getStorageAdapter,
} from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

// POST /api/v2/agents/card — Replace the calling agent's own capability card.
//
// Registration sends the card too, but registration is skipped while a cached
// derived key exists; this is the explicit path for card changes mid-life.
// An agent can only ever write its own card — the target comes from the
// authenticated identity, never from the body.
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

  const result = validateCard(body.card);
  if (!result.ok) {
    return errorResponse(`Invalid card: ${result.error}`, 400);
  }

  try {
    const adapter = getStorageAdapter();
    await adapter.updateAgentCard(auth.agentId, result.card as Record<string, unknown>);
    return jsonResponse({ ok: true, card: result.card });
  } catch {
    return errorResponse('Failed to update card', 500);
  }
}
