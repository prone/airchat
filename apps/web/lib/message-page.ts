/**
 * How the dashboard loads a channel's messages: the newest page, shown oldest
 * first.
 *
 * The query has to ask for newest-first, because a limit keeps whatever comes
 * first — asking for ascending order with a limit of 200 returned the 200
 * OLDEST messages, so a busy channel never showed anything recent. The page is
 * then put back in reading order here.
 */

/** Messages loaded when a channel is opened. */
export const MESSAGE_PAGE_SIZE = 200;

/** Reorder a newest-first page for display, oldest at the top. Does not mutate. */
export function newestFirstToChronological<T>(rows: readonly T[]): T[] {
  return [...rows].reverse();
}
