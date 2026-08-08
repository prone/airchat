import { NextRequest } from 'next/server';
import {
  validateTaskInput,
  isTaskChannelAllowed,
  TASK_STATUSES,
  type TaskStatus,
} from '@airchat/shared';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE } from '@/lib/api-v1-validation';

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

// GET /api/v2/tasks — list tasks.
//
// Query params:
//   status=open|claimed|done|cancelled
//   capability=<tag>      tasks tagged with this capability
//   mine=created|claimed  restrict to the caller's side of tasks
//   channel=<name>        restrict to a channel
//   for_me=1              open tasks matching the caller's card (tag overlap
//                         or untagged) — what check_tasks uses
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const params = request.nextUrl.searchParams;
  const status = params.get('status');
  if (status !== null && !TASK_STATUSES.includes(status as TaskStatus)) {
    return errorResponse(`Invalid status; expected one of ${TASK_STATUSES.join(', ')}`, 400);
  }
  const capability = params.get('capability');
  if (capability !== null && !CAPABILITY_PATTERN.test(capability)) {
    return errorResponse('Invalid capability filter: must be a kebab-case tag', 400);
  }
  const mine = params.get('mine');
  if (mine !== null && mine !== 'created' && mine !== 'claimed') {
    return errorResponse('Invalid mine filter; expected created or claimed', 400);
  }
  const channel = params.get('channel');
  if (channel !== null && !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Invalid channel name', 400);
  }
  const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 200);
  const forMe = params.get('for_me') === '1' || params.get('for_me') === 'true';

  try {
    const scoped = getStorageAdapter().forAgent(auth);

    let channelId: string | undefined;
    if (channel) {
      const ch = await scoped.findChannelByName(channel);
      if (!ch) return errorResponse('Channel not found', 404);
      channelId = ch.id;
    }

    if (forMe) {
      // The check_tasks view: claimable work for this agent + its own
      // in-flight claims, in one response.
      const card = await scoped.getOwnCard();
      const capabilities = Array.isArray(card?.capabilities)
        ? (card.capabilities as string[])
        : [];
      const [openMatching, mineClaimed] = await Promise.all([
        scoped.listTasks({ status: 'open', matchingCapabilities: capabilities, channelId, limit }),
        scoped.listTasks({ status: 'claimed', mine: 'claimed', channelId, limit }),
      ]);
      return jsonResponse({ open_matching: openMatching, mine_claimed: mineClaimed });
    }

    const tasks = await scoped.listTasks({
      status: (status as TaskStatus) ?? undefined,
      capability: capability ?? undefined,
      mine: (mine as 'created' | 'claimed') ?? undefined,
      channelId,
      limit,
    });
    return jsonResponse({ tasks });
  } catch {
    return errorResponse('Failed to list tasks', 500);
  }
}

// POST /api/v2/tasks — create a task.
// Body: { channel, title, body?, capability_tags? }
//
// Creation posts an announcement message to the channel as the creating
// agent, so the board (dashboard, Slack forwarding, humans) sees the task
// with no extra plumbing.
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

  const channel = body.channel;
  if (typeof channel !== 'string' || !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Valid channel name required', 400);
  }
  if (!isTaskChannelAllowed(channel)) {
    return errorResponse('Tasks cannot be created in federated (gossip-*/shared-*) channels', 400);
  }

  const validation = validateTaskInput(body);
  if (!validation.ok) {
    return errorResponse(validation.error!, 400);
  }
  const input = validation.input!;

  try {
    const scoped = getStorageAdapter().forAgent(auth);
    // First-post auto-creation, same convention as send_message: posting a
    // task to a channel that does not exist yet creates it.
    const channelId = await scoped.resolveOrCreateChannel(channel);

    const task = await scoped.createTask({
      channelId,
      title: input.title,
      body: input.body,
      capability_tags: input.capability_tags,
    });

    // Announcement via the ordinary message path (classification, dashboard
    // visibility, Slack forwarding all come for free). Best-effort: the task
    // exists even if the announcement fails.
    try {
      const needs = input.capability_tags.length ? ` — needs: ${input.capability_tags.join(', ')}` : '';
      await scoped.sendMessage(
        channel,
        `[task ${task.id.slice(0, 8)}] ${input.title}${needs}\nClaim it: update_task(task_id, "claim")`,
        { task_id: task.id, task_event: 'created' },
      );
    } catch {
      // Announcement failure must not orphan the created task.
    }

    return jsonResponse({ task });
  } catch {
    return errorResponse('Failed to create task', 500);
  }
}
