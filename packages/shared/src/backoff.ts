/**
 * Exponential backoff for polling loops.
 *
 * Why this exists: from 2026-09-03 to 2026-09-19 the production database
 * collapsed every day (a Nano instance exhausting its disk IO budget), and
 * every AirChat loop — model worker, task janitor, gossip sync — kept polling
 * at full rate through the outage. Each poll was also an auth lookup, so our
 * own background traffic was part of what kept the instance from recovering.
 *
 * The helper is deliberately tiny and pure so every loop shares one schedule
 * and one log discipline:
 *   - after a failure, the next attempt waits base * 2^(n-1), capped at max,
 *     with +/- `jitter` randomisation so a fleet of workers does not retry in
 *     lock-step;
 *   - loops driven by setInterval keep their timer and simply skip ticks that
 *     fall inside the window (`shouldSkip`), so the effective delay rounds up
 *     to the next tick;
 *   - `failure()` reports whether the delay changed, so callers log once per
 *     transition (entering backoff, each escalation, recovery) rather than
 *     once per skipped attempt.
 */

export interface BackoffOptions {
  /** Delay after the first failure, in milliseconds. */
  baseMs: number;
  /** Ceiling for the delay, in milliseconds. */
  maxMs: number;
  /** Fractional jitter applied to every delay (0.2 = +/- 20%). Default 0.2. */
  jitter?: number;
  /** Random source in [0, 1); injectable for tests. Default Math.random. */
  random?: () => number;
}

export interface BackoffFailure {
  /** Milliseconds until the next attempt is allowed. */
  delayMs: number;
  /** Consecutive failures so far, including this one. */
  attempts: number;
  /** True when the nominal delay grew (first failure or an escalation). */
  changed: boolean;
}

/**
 * Nominal (un-jittered) delay for the n-th consecutive failure, n >= 1.
 * Exported for tests and for callers that want to display the schedule.
 */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt < 1) return 0;
  // Cap the exponent so 2^n cannot overflow to Infinity for absurd counts.
  const exp = Math.min(attempt - 1, 40);
  return Math.min(baseMs * 2 ** exp, maxMs);
}

export class Backoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;
  private readonly random: () => number;
  private failures = 0;
  private untilMs = 0;
  private lastNominalMs = 0;

  constructor(opts: BackoffOptions) {
    if (!(opts.baseMs > 0)) throw new Error('Backoff: baseMs must be > 0');
    if (!(opts.maxMs >= opts.baseMs)) throw new Error('Backoff: maxMs must be >= baseMs');
    this.baseMs = opts.baseMs;
    this.maxMs = opts.maxMs;
    this.jitter = Math.min(Math.max(opts.jitter ?? 0.2, 0), 1);
    this.random = opts.random ?? Math.random;
  }

  /** Consecutive failures recorded since the last success. */
  get attempts(): number {
    return this.failures;
  }

  /** Epoch milliseconds when the current window ends (0 when not backing off). */
  get retryAt(): number {
    return this.untilMs;
  }

  /** True while a backoff window is in effect: the caller should skip this attempt. */
  shouldSkip(now: number = Date.now()): boolean {
    return now < this.untilMs;
  }

  /** Record a failed attempt and open (or extend) the backoff window. */
  failure(now: number = Date.now()): BackoffFailure {
    this.failures += 1;
    const nominal = backoffDelayMs(this.failures, this.baseMs, this.maxMs);
    const changed = nominal !== this.lastNominalMs;
    this.lastNominalMs = nominal;
    // Jitter in [-jitter, +jitter], never below zero.
    const factor = 1 + this.jitter * (2 * this.random() - 1);
    const delayMs = Math.max(0, Math.round(nominal * factor));
    this.untilMs = now + delayMs;
    return { delayMs, attempts: this.failures, changed };
  }

  /**
   * Record a successful attempt. Returns the number of failures that preceded
   * it (0 when the loop was already healthy) so callers can log a recovery
   * exactly once.
   */
  success(): number {
    const had = this.failures;
    this.failures = 0;
    this.untilMs = 0;
    this.lastNominalMs = 0;
    return had;
  }
}

/** Human-readable delay for log lines: "20s", "5m", "1h30m". */
export function formatDelay(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
}

/**
 * Summarise an error for a backoff log line without dumping a stack:
 * "HTTP 503", "timeout", "ECONNRESET", or the message's first line.
 */
export function describeFailure(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; status?: number; code?: string; message?: string; cause?: { code?: string } };
    if (typeof e.status === 'number') return `HTTP ${e.status}`;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
    const code = e.code ?? e.cause?.code;
    if (code) return code;
    if (e.message) return e.message.split('\n')[0].slice(0, 160);
  }
  return String(err).slice(0, 160);
}
