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
  /** `budgetMs`: give up on the request after this long (time left to the deadline). */
  checkWork(budgetMs?: number): Promise<W>;
  /** GET /api/v2/work/wait. Without `after` it answers at once with a cursor. */
  wait(after?: string, timeoutSeconds?: number, budgetMs?: number): Promise<{ cursor?: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Seconds one wait is held open. Under the client's 30 s request timeout. */
export const WAIT_HOLD_SECONDS = 20;
/**
 * A wait that comes back sooner than this with nothing to show for it was not
 * held. An honest server holds a wait until there is something to read, so a
 * run of such answers means a broken server or proxy (or several server
 * processes that do not know each other's cursors). The loop then pauses
 * before the next wait, longer each time, so it can never ask in a tight loop.
 */
export const QUICK_WAIT_MS = 1000;
const MAX_QUICK_PAUSE_MS = 30_000;

/**
 * How soon an answer counts as "not held": under a second, or under half the
 * time the server was asked to hold it, whichever is longer. A fixed second
 * alone would let a server answer every wait just after it and be asked again
 * at once, for ever. Measured against the hold, the fastest it can keep a
 * client going unpaused is one wait per half hold.
 */
export function quickWaitMs(holdSeconds: number): number {
  return Math.max(QUICK_WAIT_MS, (holdSeconds * 1000) / 2);
}

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

  /** Time left for one request, with a floor so it can still be made. */
  const budget = () => {
    const left = remaining();
    return left === null ? undefined : Math.max(1000, left);
  };

  let canWait = true;
  let cursor: string | undefined;
  /** Waits in a row that were answered at once. */
  let quick = 0;
  for (;;) {
    // The cursor is taken BEFORE the read.
    if (canWait && cursor === undefined) {
      try {
        cursor = (await io.wait(undefined, undefined, budget())).cursor;
      } catch (e) {
        if (statusOf(e) === 429) {
          if (!(await pause(retryAfterOf(e) ?? 5000))) return null;
          continue;
        }
        // No such endpoint, or turned off: poll.
        canWait = false;
      }
    }

    const work = await io.checkWork(budget());
    if (ready(work)) return work;

    if (quick > 0 && !(await pause(Math.min(QUICK_WAIT_MS * 2 ** (quick - 1), MAX_QUICK_PAUSE_MS)))) return null;

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
    const asked = io.now();
    try {
      // The request may outlast the hold by the time an answer takes to
      // travel, but not by more than a few seconds.
      cursor = (await io.wait(cursor, holdSeconds, holdSeconds * 1000 + 8000)).cursor;
      quick = io.now() - asked < quickWaitMs(holdSeconds) ? Math.min(quick + 1, 16) : 0;
    } catch (e) {
      quick = 0;
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
