/**
 * Task janitor — the queue's self-healing loop (fleet backlog #3).
 *
 * Modeled on gossip-sync.ts/digest-worker.ts: a module-singleton setInterval
 * worker started from instrumentation.ts. Pull-claims remain the routing
 * mechanism; the janitor handles only the exceptions the queue cannot heal
 * itself:
 *
 *  1. Stale claims — a worker died mid-inference and its task sits `claimed`
 *     forever. Released back to `open` after AIRCHAT_TASK_CLAIM_TIMEOUT_MIN
 *     (default 30; workers' own inference timeout is 10), with a visible
 *     announcement in the task's channel.
 *  2. Orphaned tasks — `open` past the orphan age with no active agent
 *     advertising a matching capability. Warned once, in the task's channel
 *     (never auto-cancelled: cancel is creator-only by design). Silence is
 *     the failure mode this exists to remove — a poller can't tell "nobody
 *     can serve this" from "not served yet".
 *
 * IO discipline (the disk-budget lesson): one sweep per 5 minutes, reads
 * first, writes only when something needs fixing. A quiet queue costs two
 * SELECTs per sweep and zero writes.
 */

import { getStorageAdapter, getSupabaseClient } from '@/lib/api-v2-auth';
import type { AgentContext, Task } from '@airchat/shared';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const ORPHAN_AGE_MS = 60 * 60 * 1000;
/** "Active" for coverage purposes: last_seen bumps on any authenticated call
 *  (throttled to 5 min), so half an hour of silence means genuinely gone. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const JANITOR_AGENT_NAME = 'janitor';

function claimTimeoutMs(): number {
  const parsed = parseInt(process.env.AIRCHAT_TASK_CLAIM_TIMEOUT_MIN ?? '', 10);
  return (Number.isInteger(parsed) && parsed >= 5 ? parsed : 30) * 60 * 1000;
}

// ── Pure decision helpers (unit-tested) ─────────────────────────────────────

/** Untagged tasks are claimable by anyone, so any live agent covers them;
 *  tagged tasks need at least one active agent sharing a tag. */
export function isCovered(
  tags: string[] | null,
  activeCapabilities: Set<string>,
  anyActiveAgents: boolean,
): boolean {
  if (!tags || tags.length === 0) return anyActiveAgents;
  return tags.some((t) => activeCapabilities.has(t));
}

/**
 * Warn exactly once, with no cohort ever silently skipped: the window runs
 * from wherever the previous successful orphan check left off (a cursor, so
 * failed sweeps and interval drift extend the next window instead of leaving
 * a gap) up to the orphan threshold. On the first sweep after startup the
 * cursor is seeded one interval back — the stateless best available.
 */
export function warnWindow(
  now: number,
  orphanAgeMs: number,
  sweepIntervalMs: number,
  warnedThroughMs: number | null,
): { fromMs: number; toMs: number; fromIso: string; toIso: string } {
  const toMs = now - orphanAgeMs;
  const fromMs = warnedThroughMs ?? (toMs - sweepIntervalMs);
  return {
    fromMs,
    toMs,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
  };
}

/** System principals whose activity must not count as task coverage — the
 *  janitor's own announcements would otherwise suppress the very warnings
 *  it exists to emit. */
export const SYSTEM_AGENT_NAMES = ['janitor', 'summarizer', 'dashboard-admin'];

// ── Janitor identity (system agent, same pattern as the summarizer) ─────────

let _janitor: AgentContext | null = null;

async function ensureJanitorAgent(): Promise<AgentContext> {
  if (_janitor) return _janitor;
  const client = getSupabaseClient();
  const { data: existing } = await client
    .from('agents')
    .select('id, name')
    .eq('name', JANITOR_AGENT_NAME)
    .single();
  if (existing) {
    _janitor = { agentId: existing.id, agentName: existing.name, machineId: '' };
    return _janitor;
  }
  const { data: created, error } = await client
    .from('agents')
    .insert({
      name: JANITOR_AGENT_NAME,
      description: 'System task janitor — releases stale claims, warns on unservable tasks. Not machine-owned.',
      api_key_hash: null,
      active: true,
    })
    .select('id, name')
    .single();
  if (error || !created) {
    throw new Error(`Failed to create janitor agent: ${error?.message ?? 'unknown'}`);
  }
  _janitor = { agentId: created.id, agentName: created.name, machineId: '' };
  return _janitor;
}

// ── Sweep ───────────────────────────────────────────────────────────────────

async function announce(taskChannelId: string, content: string, taskId: string, event: string): Promise<void> {
  try {
    const scoped = getStorageAdapter().forAgent(await ensureJanitorAgent());
    const channel = await scoped.findChannelById(taskChannelId);
    if (!channel) return;
    await scoped.sendMessage(channel.name, content, { task_id: taskId, task_event: event });
  } catch (err) {
    // Announcements are visibility, not correctness — never fail the sweep.
    console.error(`[task-janitor] announce failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Cursor for the orphan check: where the last successful pass warned through.
// In-memory: a restart reseeds one interval back (see warnWindow).
let warnedThroughMs: number | null = null;

async function sweep(): Promise<void> {
  const adapter = getStorageAdapter();
  const now = Date.now();

  // 1. Stale claims → back to open, with a visible trace. Isolated so a
  //    failure here never starves the orphan check below.
  try {
    const released = await adapter.releaseStaleClaims(new Date(now - claimTimeoutMs()).toISOString());
    for (const task of released) {
      console.log(`[task-janitor] released stale claim on task ${task.id} (${task.title})`);
      await announce(
        task.channel_id,
        `[task ${task.id.slice(0, 8)}] released back to open — its worker did not complete within ${Math.round(claimTimeoutMs() / 60000)} minutes. A matching worker can claim it again.`,
        task.id,
        'released',
      );
    }
  } catch (err) {
    console.error(`[task-janitor] stale-claim pass failed: ${err instanceof Error ? err.message : err}`);
  }

  // 2. Orphan warnings — every task whose age crossed the threshold since the
  //    last successful pass (cursor-based; hiccups widen the window, never
  //    skip a cohort).
  const { fromIso, toIso, toMs, fromMs } = warnWindow(now, ORPHAN_AGE_MS, SWEEP_INTERVAL_MS, warnedThroughMs);
  if (toMs <= fromMs) return;
  const candidates = await adapter.listOpenTasksCreatedBetween(fromIso, toIso);
  if (candidates.length === 0) {
    warnedThroughMs = toMs;
    return;
  }

  const { capabilities, anyActiveAgents } = await adapter.getActiveCapabilities(
    new Date(now - ACTIVE_WINDOW_MS).toISOString(),
    SYSTEM_AGENT_NAMES,
  );
  for (const task of candidates as Task[]) {
    if (isCovered(task.capability_tags, capabilities, anyActiveAgents)) continue;
    console.log(`[task-janitor] task ${task.id} has no active worker for tags [${(task.capability_tags ?? []).join(', ')}]`);
    await announce(
      task.channel_id,
      `[task ${task.id.slice(0, 8)}] warning: open for an hour with no active agent advertising ${task.capability_tags?.length ? `any of: ${task.capability_tags.join(', ')}` : 'any capability'}. It will stay queued until a matching worker comes online — or its creator can cancel it.`,
      task.id,
      'unserviced',
    );
  }
  warnedThroughMs = toMs;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let janitorInterval: ReturnType<typeof setInterval> | null = null;

export function startTaskJanitor(): void {
  if (janitorInterval) return;
  if (process.env.AIRCHAT_TASK_JANITOR === 'off') {
    console.log('[task-janitor] disabled via AIRCHAT_TASK_JANITOR=off');
    return;
  }
  console.log(`[task-janitor] started (sweep every ${SWEEP_INTERVAL_MS / 60000}m, claim timeout ${claimTimeoutMs() / 60000}m)`);
  janitorInterval = setInterval(() => { sweep().catch((err) => console.error('[task-janitor] sweep failed:', err)); }, SWEEP_INTERVAL_MS);
}

export function stopTaskJanitor(): void {
  if (janitorInterval) { clearInterval(janitorInterval); janitorInterval = null; }
}
