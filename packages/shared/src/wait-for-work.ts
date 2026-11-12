/**
 * Block until something is waiting for an agent: the loop behind
 * `AirChatRestClient.waitForWork` and `airchat wait`, for agents with no
 * harness to prompt them.
 *
 * It follows the protocol of GET /api/v2/work/wait: take a cursor, read the
 * work, then hold a request open with that cursor. A message stored after the
 * cursor was issued ends the wait at once, so none can arrive unnoticed
 * between the read and the wait. On a server that cannot hold a wait it reads
 * the work every `pollIntervalMs` instead.
 */

export interface WaitableWork {
  mentions?: unknown[];
  open_matching?: unknown[];
}

export interface WaitForWorkOptions {
  /** Give up and return null after this long. Omitted: wait as long as it takes. */
  timeoutMs?: number;
  /** Also return when an open task matches the agent's card. */
  includeTasks?: boolean;
  /** How often to re-read when polling, or when watching for tasks. Default 30 s. */
  pollIntervalMs?: number;
}

/** What the loop needs from the outside; replaced in tests. */
export interface WaitForWorkIo<W extends WaitableWork> {
  checkWork(): Promise<W>;
  /** GET /api/v2/work/wait. Without `after` it answers at once with a cursor. */
  wait(after?: string, timeoutSeconds?: number): Promise<{ cursor?: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Seconds one wait is held open. Under the client's 30 s request timeout. */
export const WAIT_HOLD_SECONDS = 20;

const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;
const retryAfterOf = (e: unknown): number | undefined => (e as { retryAfterMs?: number } | null)?.retryAfterMs;

export async function waitForWorkLoop<W extends WaitableWork>(
  io: WaitForWorkIo<W>,
  opts: WaitForWorkOptions = {},
): Promise<W | null> {
  const deadline = opts.timeoutMs === undefined ? null : io.now() + Math.max(0, opts.timeoutMs);
  const pollMs = Math.max(1000, opts.pollIntervalMs ?? 30_000);
  const remaining = () => (deadline === null ? null : deadline - io.now());
  const ready = (work: W) =>
    (work.mentions?.length ?? 0) > 0 || (opts.includeTasks === true && (work.open_matching?.length ?? 0) > 0);
  /** Sleep, but not past the deadline. False when time is up. */
  const pause = async (ms: number) => {
    const left = remaining();
    if (left !== null && left <= 0) return false;
    await io.sleep(left === null ? ms : Math.min(ms, left));
    return true;
  };

  let canWait = true;
  let cursor: string | undefined;
  for (;;) {
    // The cursor is taken BEFORE the read.
    if (canWait && cursor === undefined) {
      try {
        cursor = (await io.wait()).cursor;
      } catch (e) {
        if (statusOf(e) === 429) {
          if (!(await pause(retryAfterOf(e) ?? 5000))) return null;
          continue;
        }
        // No such endpoint, or turned off: poll.
        canWait = false;
      }
    }

    const work = await io.checkWork();
    if (ready(work)) return work;

    const left = remaining();
    if (left !== null && left <= 0) return null;

    if (!canWait || cursor === undefined) {
      if (!(await pause(pollMs))) return null;
      continue;
    }

    // With tasks, wake at least every poll interval to re-read.
    let holdMs = opts.includeTasks ? Math.min(WAIT_HOLD_SECONDS * 1000, pollMs) : WAIT_HOLD_SECONDS * 1000;
    if (left !== null) holdMs = Math.min(holdMs, left);
    const holdSeconds = Math.max(1, Math.floor(holdMs / 1000));
    try {
      cursor = (await io.wait(cursor, holdSeconds)).cursor;
    } catch (e) {
      cursor = undefined;
      const status = statusOf(e);
      const retryAfter = retryAfterOf(e);
      if (status === 429) {
        if (!(await pause(retryAfter ?? 5000))) return null;
      } else if ((status === 404 || status === 503) && retryAfter === undefined) {
        canWait = false;
      } else if (!(await pause(retryAfter ?? (status === undefined ? 5000 : pollMs)))) {
        // No status: the connection dropped or timed out. Start again from a
        // new cursor after a short pause.
        return null;
      }
    }
  }
}
