import { NextRequest } from 'next/server';
import {
  checkTransition,
  TASK_ACTIONS,
  type TaskAction,
} from '@airchat/shared';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { UUID_RE } from '@/lib/api-v1-validation';

// GET /api/v2/tasks/:id — read one task.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const { id } = await params;
  if (!UUID_RE.test(id)) return errorResponse('Invalid task id', 400);

  const task = await getStorageAdapter().forAgent(auth).getTask(id);
  if (!task) return errorResponse('Task not found', 404);
  return jsonResponse({ task });
}

// POST /api/v2/tasks/:id — perform a transition.
// Body: { action: "claim" | "complete" | "cancel", result? }
//
// The precondition check (checkTransition) gates who may attempt what; the
// claim race itself is settled by the adapter's conditional UPDATE, so two
// simultaneous claims produce exactly one winner regardless of what the
// precondition read saw.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  const { id } = await params;
  if (!UUID_RE.test(id)) return errorResponse('Invalid task id', 400);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const action = body.action;
  if (typeof action !== 'string' || !TASK_ACTIONS.includes(action as TaskAction)) {
    return errorResponse(`Invalid action; expected one of ${TASK_ACTIONS.join(', ')}`, 400);
  }

  try {
    const scoped = getStorageAdapter().forAgent(auth);
    const task = await scoped.getTask(id);
    if (!task) return errorResponse('Task not found', 404);

    const check = checkTransition(task, action as TaskAction, auth.agentId, body.result);
    if (!check.ok) return errorResponse(check.error!, check.code ?? 400);

    switch (action as TaskAction) {
      case 'claim': {
        const claimed = await scoped.claimTask(id);
        if (!claimed) {
          // Guard failed after the precondition read: someone else won.
          return errorResponse('Task was claimed by another agent', 409);
        }
        return jsonResponse({ task: claimed });
      }

      case 'complete': {
        const result = body.result as string;
        // Store FIRST: the guarded UPDATE is what decides whether this worker
        // still owns the task — a janitor release (stale-claim timeout) can
        // strip ownership between the precondition read and here. Announcing
        // before the guard published false "done" messages for completions
        // that then 409'd with the result never stored.
        const done = await scoped.completeTask(id, result);
        try {
          const ch = await scoped.findChannelById(task.channel_id);
          if (ch) {
            const posted = await scoped.sendMessage(
              ch.name,
              `[task ${task.id.slice(0, 8)} done] ${task.title}\n${result}`,
              { task_id: task.id, task_event: 'completed' },
            );
            const resultMessageId = (posted as { id?: string })?.id;
            if (resultMessageId) {
              await scoped.linkTaskResultMessage(id, resultMessageId);
              done.result_message_id = resultMessageId;
            }
          }
        } catch {
          // The stored completion must not fail because the announcement did.
        }
        return jsonResponse({ task: done });
      }

      case 'cancel': {
        const cancelled = await scoped.cancelTask(id);
        return jsonResponse({ task: cancelled });
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Task transition failed';
    // Adapter guard failures surface as 409s (state changed underfoot).
    return errorResponse(message, 409);
  }
}
