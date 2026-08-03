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

const MAX_ATTEMPTS = 4;
const FALLBACK_DELAY_MS = 2_000;

function isRateLimited(error: unknown): boolean {
  return error instanceof Error && / 429\b/.test(error.message);
}

/** Retry-After is in seconds; fall back to a fixed delay when absent. */
function delayFor(error: unknown, attempt: number): number {
  const seconds = error instanceof Error
    ? Number(/Retry-After[":\s]+(\d+)/i.exec(error.message)?.[1])
    : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : FALLBACK_DELAY_MS * attempt;
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
