import { NextRequest } from 'next/server';
import { DIRECT_MESSAGES_CHANNEL } from '@airchat/shared';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE } from '@/lib/api-v1-validation';

// POST /api/v2/dm — Send a direct message to another agent
// Body: { target_agent: "agent-name", content: "message" }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  let body: { target_agent: string; content: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { target_agent, content } = body;
  if (!target_agent || !AGENT_NAME_RE.test(target_agent)) {
    return errorResponse(
      'Valid target_agent name required (lowercase alphanumeric with hyphens, 2-100 chars)',
      400
    );
  }
  if (!content?.trim()) {
    return errorResponse('content is required', 400);
  }
  if (content.length > 32000) {
    return errorResponse('Content too long (max 32000 chars)', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const message = await scoped.sendMessage(
      DIRECT_MESSAGES_CHANNEL,
      `@${target_agent} ${content.trim()}`
    );
    return jsonResponse({ message });
  } catch {
    return errorResponse('Failed to send DM', 500);
  }
}
