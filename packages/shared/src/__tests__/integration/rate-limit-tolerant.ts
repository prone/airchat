/**
 * Wraps an AirChatRestClient so calls survive the server's rate limits.
 *
 * These tests run against a live server that allows 30 writes per minute per
 * key. A single pass of api.integration makes about 20, so one run fits and two
 * within the same minute do not — which is exactly what happens when anyone
 * iterates on the suite. The failures that produces are not bugs in the code
 * under test; they are the server behaving as designed.
 *
 * So this retries on 429 and nothing else. A 400, 404 or 500 fails immediately,
 * because those are the answers the tests exist to check. Retries are bounded,
 * and it honours Retry-After when the server sends one.
 *
 * Not for production use: AirChatRestClient deliberately does not retry, so a
 * real agent surfaces rate limiting to its caller rather than hiding it behind
 * a delay.
 */

import { AirChatHttpError } from '../../rest-client.js';

const MAX_ATTEMPTS = 4;

/**
 * Only used when the server sends no Retry-After. It has to exceed the
 * limiter's 60s window, because a key that has spent its budget cannot recover
 * before the window slides — backing off for less guarantees the retry is
 * rejected too. The old value was 2s.
 */
const FALLBACK_DELAY_MS = 65_000;

function isRateLimited(error: unknown): boolean {
  if (error instanceof AirChatHttpError) return error.status === 429;
  // Anything still throwing a plain Error keeps the old text check, so a
  // caller that has not been converted does not silently stop retrying.
  return error instanceof Error && / 429\b/.test(error.message);
}

/**
 * Prefer the server's own number. It knows exactly when the window slides;
 * anything guessed here is either too short to work or too long to be pleasant.
 *
 * This used to regex `Retry-After` out of `error.message`, which is built from
 * the response *body* — a header never appeared there, so the parse never once
 * matched and every wait silently used the fallback. Reading it off the error
 * is both correct and impossible to get subtly wrong.
 */
function delayFor(error: unknown, attempt: number): number {
  if (error instanceof AirChatHttpError && error.retryAfterMs) {
    // A second of slack, so the retry lands after the window slides, not on it.
    return error.retryAfterMs + 1_000;
  }
  return FALLBACK_DELAY_MS * attempt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns a proxy that forwards every method call, retrying on 429.
 *
 * A proxy rather than a wrapper class so the tests keep calling the client's
 * real methods — a hand-written wrapper would need updating every time the
 * client gains one, and would quietly stop covering whatever it missed.
 */
export function rateLimitTolerant<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      return (...args: unknown[]) => {
        const first = value.apply(target, args);

        // Synchronous methods (getAgentName, for one) must pass straight
        // through. Wrapping them in a promise would turn a string into a
        // Promise, and a caller interpolating it gets "[object Promise]" —
        // which is how this helper first broke the DM tests.
        if (!(first instanceof Promise)) return first;

        return (async () => {
          let lastError: unknown;

          try {
            return await first;
          } catch (error) {
            if (!isRateLimited(error)) throw error;
            lastError = error;
            await sleep(delayFor(error, 1));
          }

          for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
              return await value.apply(target, args);
            } catch (error) {
              if (!isRateLimited(error)) throw error;
              lastError = error;
              if (attempt < MAX_ATTEMPTS) await sleep(delayFor(error, attempt));
            }
          }

          throw new Error(
            `Rate limited after ${MAX_ATTEMPTS} attempts calling ${String(prop)}(). ` +
            `The server allows 30 writes/minute per key; if this is reproducible, ` +
            `the suite is making more calls than that rather than being unlucky.\n` +
            `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          );
        })();
      };
    },
  });
}
