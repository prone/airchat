/**
 * A `fetch` for server-side Supabase clients that gives up after a fixed time.
 *
 * supabase-js has no request timeout of its own. When the database stops
 * answering, every request to it waits until the socket dies, and each waiting
 * request holds an API request open behind it; the callers retry, and the
 * pile grows. With a limit, a stalled call fails after 10 seconds and the
 * route returns an error the caller can act on.
 *
 * 10 seconds is far above any query this application sends (they are indexed
 * lookups and small aggregates) and below the 30-second timeout of the REST
 * clients that call the API, so the API answers before its caller hangs up.
 *
 * File transfers are the exception: an upload or download through Supabase
 * Storage is bounded by its size, not by a query, so those get two minutes.
 */

export const SUPABASE_REQUEST_TIMEOUT_MS = 10_000;
export const SUPABASE_STORAGE_TIMEOUT_MS = 120_000;

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as { url?: string }).url ?? '';
}

/**
 * Wrap `baseFetch` so each call is aborted after the time limit. A signal the
 * caller passed still works: the request stops at whichever fires first.
 */
export function fetchWithTimeout(
  timeoutMs: number = SUPABASE_REQUEST_TIMEOUT_MS,
  baseFetch: typeof fetch = (...args) => fetch(...args),
): typeof fetch {
  return (input, init) => {
    const limit = urlOf(input).includes('/storage/v1/')
      ? Math.max(timeoutMs, SUPABASE_STORAGE_TIMEOUT_MS)
      : timeoutMs;
    const timeout = AbortSignal.timeout(limit);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    return baseFetch(input, { ...init, signal });
  };
}
