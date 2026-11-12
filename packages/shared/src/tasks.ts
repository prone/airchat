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

/**
 * Characters a title may not contain: control characters (line breaks
 * included), the Unicode line and paragraph separators, and the characters
 * that reverse the direction of text.
 *
 * A title is one line shown in lists, by programs that each have to display
 * it safely: the dashboard, the CLI, a hook that prints into a session.
 * Refusing these when the title is written means none of them has to be
 * relied on for it. It applies to the titles of tasks, notes and
 * conversations alike.
 */
const TITLE_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export function isPlainTitle(title: string): boolean {
  return !TITLE_FORBIDDEN_RE.test(title);
}
export const PLAIN_TITLE_ERROR = 'title must be one line of plain text (no line breaks or control characters)';

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
  if (!isPlainTitle(title)) {
    return { ok: false, error: PLAIN_TITLE_ERROR };
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
 * How many tasks one agent may hold in the `claimed` state at once. A claim
 * costs nothing, so without a limit a single agent could claim the whole
 * queue and sit on it (and claim it again each time stale claims are
 * released). Ten leaves room for a model worker running several jobs in
 * parallel on hosted backends while keeping the queue available to others.
 */
export const MAX_CONCURRENT_CLAIMS = 10;

/**
 * May an agent with these card capabilities claim this task, given how many
 * tasks it already holds?
 *
 * Tags say what a task needs. A tagged task may only be claimed by an agent
 * whose card lists at least one of them; before this check the tags only
 * filtered what an agent was shown, and any agent could claim any task by id.
 * An untagged task is open to everyone.
 */
export function checkClaimEligibility(
  task: Pick<Task, 'capability_tags'>,
  agentCapabilities: readonly string[],
  claimsHeld: number,
): TransitionCheck {
  const tags = Array.isArray(task.capability_tags) ? task.capability_tags : [];
  if (tags.length > 0 && !tags.some((tag) => agentCapabilities.includes(tag))) {
    return {
      ok: false,
      code: 403,
      error: `This task needs one of: ${tags.join(', ')}. Your agent card lists none of them.`,
    };
  }
  if (claimsHeld >= MAX_CONCURRENT_CLAIMS) {
    return {
      ok: false,
      code: 409,
      error: `You already hold ${claimsHeld} claimed tasks (limit ${MAX_CONCURRENT_CLAIMS}). Complete one before claiming another.`,
    };
  }
  return { ok: true };
}

/**
 * Channels where tasks may not be created. The queue coordinates the local
 * fleet; letting tasks ride federation would broadcast claimable work (and
 * its announcements) into other people's instances.
 */
export function isTaskChannelAllowed(channelName: string): boolean {
  return !channelName.startsWith('gossip-') && !channelName.startsWith('shared-');
}
