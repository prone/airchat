/**
 * Task primitive — shared types, validation, and transition rules.
 *
 * The rules live here as pure functions so the API routes, the adapter, and
 * the unit tests all agree on one state machine:
 *
 *   open ──claim──▶ claimed ──complete──▶ done
 *     │                │
 *     └───cancel───────┴──cancel──▶ cancelled   (creator only)
 *
 * Claiming is enforced atomically in SQL (conditional UPDATE guarded on
 * status='open'); these functions gate everything the guard can't express —
 * who may attempt which transition, and input shape.
 */

export const TASK_STATUSES = ['open', 'claimed', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_ACTIONS = ['claim', 'complete', 'cancel'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export interface Task {
  id: string;
  channel_id: string;
  title: string;
  body: string | null;
  capability_tags: string[];
  status: TaskStatus;
  created_by: string;
  claimed_by: string | null;
  result: string | null;
  result_message_id: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  /** Channel name joined onto listTasks rows (`channels:channel_id(name)`)
   *  so consumers can act in the task's channel without a membership-scoped
   *  channel lookup. Absent on rows fetched without the join. */
  channels?: { name: string } | null;
}

const MAX_TITLE = 200;
const MAX_BODY = 8000;
const MAX_RESULT = 32000;
const MAX_TASK_TAGS = 10;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

export interface TaskInputValidation {
  ok: boolean;
  error?: string;
  /** Normalized input — present when ok. */
  input?: { title: string; body: string | null; capability_tags: string[] };
}

export function validateTaskInput(raw: {
  title?: unknown;
  body?: unknown;
  capability_tags?: unknown;
}): TaskInputValidation {
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
    return { ok: false, error: 'title is required' };
  }
  const title = raw.title.trim();
  if (title.length > MAX_TITLE) {
    return { ok: false, error: `title must be at most ${MAX_TITLE} characters` };
  }

  let body: string | null = null;
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body !== 'string') {
      return { ok: false, error: 'body must be a string' };
    }
    body = raw.body;
    if (body.length > MAX_BODY) {
      return { ok: false, error: `body must be at most ${MAX_BODY} characters` };
    }
  }

  const capability_tags: string[] = [];
  if (raw.capability_tags !== undefined && raw.capability_tags !== null) {
    if (!Array.isArray(raw.capability_tags)) {
      return { ok: false, error: 'capability_tags must be an array of strings' };
    }
    if (raw.capability_tags.length > MAX_TASK_TAGS) {
      return { ok: false, error: `capability_tags must have at most ${MAX_TASK_TAGS} tags` };
    }
    for (const tag of raw.capability_tags) {
      if (typeof tag !== 'string') {
        return { ok: false, error: 'capability_tags must be an array of strings' };
      }
      const trimmed = tag.trim().toLowerCase();
      if (trimmed.length === 0) continue;
      if (!TAG_PATTERN.test(trimmed)) {
        return {
          ok: false,
          error: `capability tag "${trimmed.slice(0, 60)}" must be kebab-case (lowercase alphanumeric and hyphens, max 50 chars)`,
        };
      }
      if (!capability_tags.includes(trimmed)) capability_tags.push(trimmed);
    }
  }

  return { ok: true, input: { title, body, capability_tags } };
}

export interface TransitionCheck {
  ok: boolean;
  /** HTTP-ish status suggestion: 403 forbidden, 409 wrong state, 400 bad input. */
  code?: 400 | 403 | 409;
  error?: string;
}

/**
 * May `agentId` perform `action` on `task`? Pure precondition check — the
 * claim race itself is settled by the SQL guard, not here.
 */
export function checkTransition(
  task: Pick<Task, 'status' | 'created_by' | 'claimed_by'>,
  action: TaskAction,
  agentId: string,
  result?: unknown,
): TransitionCheck {
  switch (action) {
    case 'claim':
      if (task.status !== 'open') {
        return { ok: false, code: 409, error: `Task is ${task.status}, not open` };
      }
      return { ok: true };

    case 'complete':
      if (task.status !== 'claimed') {
        return { ok: false, code: 409, error: `Task is ${task.status}, not claimed` };
      }
      if (task.claimed_by !== agentId) {
        return { ok: false, code: 403, error: 'Only the claimant can complete a task' };
      }
      if (typeof result !== 'string' || result.trim().length === 0) {
        return { ok: false, code: 400, error: 'complete requires a non-empty result' };
      }
      if (result.length > MAX_RESULT) {
        return { ok: false, code: 400, error: `result must be at most ${MAX_RESULT} characters` };
      }
      return { ok: true };

    case 'cancel':
      if (task.created_by !== agentId) {
        return { ok: false, code: 403, error: 'Only the creator can cancel a task' };
      }
      if (task.status !== 'open' && task.status !== 'claimed') {
        return { ok: false, code: 409, error: `Task is ${task.status}; only open or claimed tasks can be cancelled` };
      }
      return { ok: true };

    default:
      return { ok: false, code: 400, error: `Unknown action` };
  }
}

/**
 * Channels where tasks may not be created. The queue coordinates the local
 * fleet; letting tasks ride federation would broadcast claimable work (and
 * its announcements) into other people's instances.
 */
export function isTaskChannelAllowed(channelName: string): boolean {
  return !channelName.startsWith('gossip-') && !channelName.startsWith('shared-');
}
