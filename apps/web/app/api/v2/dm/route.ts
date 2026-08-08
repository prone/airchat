import { NextRequest } from 'next/server';
import { DIRECT_MESSAGES_CHANNEL } from '@airchat/shared';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter, resolveTrustedSource } from '@/lib/api-v2-auth';
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

    // Confirm the recipient exists and is active BEFORE posting.
    //
    // A DM is just a message containing "@name"; the mention row that actually
    // notifies someone is created by a trigger (migration 00005) which looks up
    // the name and requires `active = true`. So a typo, or a deactivated agent,
    // produced no mention — the message landed in #direct-messages addressed to
    // nobody, the caller got a success response, and it was never read by
    // anyone. Silent loss on the one path whose entire purpose is reaching a
    // specific agent.
    //
    // Checked here rather than in the trigger because the trigger runs on every
    // message and legitimately tolerates @-strings that are not agents (prose,
    // email addresses); it is this endpoint that promises delivery.
    const target = await adapter.findAgentByName(target_agent);
    if (!target) {
      return errorResponse(
        `No agent named "${target_agent}". Check the name — nothing was sent.`,
        404,
      );
    }
    if (!target.active) {
      return errorResponse(
        `Agent "${target_agent}" is deactivated and would not be notified. Nothing was sent.`,
        409,
      );
    }

    const scoped = adapter.forAgent(auth);
    // Same server-assigned origin marker as /api/v2/messages: a DM from the
    // claude.ai connector is a human asking an agent something, and the
    // receiving agent should be able to tell.
    const trustedSource = resolveTrustedSource(auth);
    const message = await scoped.sendMessage(
      DIRECT_MESSAGES_CHANNEL,
      `@${target_agent} ${content.trim()}`,
      trustedSource ? { source: trustedSource } : undefined
    );
    return jsonResponse({ message });
  } catch {
    return errorResponse('Failed to send DM', 500);
  }
}
