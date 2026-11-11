import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The janitor loop also keeps the usage table from growing without end —
 * events older than 90 days are deleted, in batches, at most once a day — and
 * never starts a sweep while the previous one is still running.
 */

type Result = { data: unknown; error: { code?: string; message: string } | null };

const purge = vi.fn<(args: Record<string, unknown>) => Promise<Result>>();
const releaseStaleClaims = vi.fn();
const listOpenTasksCreatedBetween = vi.fn();

vi.mock('@/lib/api-v2-auth', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'purge_llm_usage') throw new Error(`unexpected function ${fn}`);
      return purge(args);
    },
  }),
  getStorageAdapter: () => ({
    releaseStaleClaims,
    listOpenTasksCreatedBetween,
    getActiveCapabilities: async () => ({ capabilities: new Set<string>(), anyActiveAgents: false }),
  }),
}));

const { purgeOldUsage, resetUsagePurgeClock, guardedSweep, USAGE_RETENTION_DAYS } = await import('@/lib/task-janitor');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-10T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  resetUsagePurgeClock();
  purge.mockResolvedValue({ data: 0, error: null });
  releaseStaleClaims.mockResolvedValue([]);
  listOpenTasksCreatedBetween.mockResolvedValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('usage retention', () => {
  it('keeps 90 days and deletes 5000 rows per request', async () => {
    await purgeOldUsage(T0);
    expect(USAGE_RETENTION_DAYS).toBe(90);
    expect(purge).toHaveBeenCalledWith({ p_keep_days: 90, p_batch: 5000 });
  });

  it('runs at most once a day', async () => {
    await purgeOldUsage(T0);
    // The janitor sweeps every five minutes.
    for (let t = T0 + 5 * 60_000; t < T0 + DAY; t += 5 * 60_000) await purgeOldUsage(t);
    expect(purge).toHaveBeenCalledTimes(1);

    await purgeOldUsage(T0 + DAY);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('keeps deleting while batches come back full, and stops at the first short one', async () => {
    purge
      .mockResolvedValueOnce({ data: 5000, error: null })
      .mockResolvedValueOnce({ data: 5000, error: null })
      .mockResolvedValueOnce({ data: 120, error: null });
    expect(await purgeOldUsage(T0)).toBe(10_120);
    expect(purge).toHaveBeenCalledTimes(3);
  });

  it('stops after 20 batches in one run, leaving the rest for the next day', async () => {
    purge.mockResolvedValue({ data: 5000, error: null });
    expect(await purgeOldUsage(T0)).toBe(100_000);
    expect(purge).toHaveBeenCalledTimes(20);
  });

  it('does nothing, quietly, on a database without the function', async () => {
    purge.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
    expect(await purgeOldUsage(T0)).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    // And does not ask again every five minutes.
    await purgeOldUsage(T0 + 5 * 60_000);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('logs a failure, never throws, and tries again on the next sweep', async () => {
    purge.mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } });
    await expect(purgeOldUsage(T0)).resolves.toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);

    await purgeOldUsage(T0 + 5 * 60_000);
    expect(purge).toHaveBeenCalledTimes(2);
  });
});

describe('sweeps do not overlap', () => {
  it('skips a sweep that would start while the previous one is still running', async () => {
    let finish!: (rows: unknown[]) => void;
    releaseStaleClaims.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    const first = guardedSweep();
    // The interval fires again before the first sweep is done.
    await guardedSweep();
    await guardedSweep();
    expect(releaseStaleClaims).toHaveBeenCalledTimes(1);

    finish([]);
    await first;

    await guardedSweep();
    expect(releaseStaleClaims).toHaveBeenCalledTimes(2);
  });

  it('purges after the queue work of the same sweep', async () => {
    const order: string[] = [];
    releaseStaleClaims.mockImplementation(async () => { order.push('queue'); return []; });
    purge.mockImplementation(async () => { order.push('purge'); return { data: 0, error: null }; });
    await guardedSweep();
    expect(order).toEqual(['queue', 'purge']);
  });

  // Last in the file: a failed sweep opens the janitor's backoff window, which
  // is module state and would make later sweeps in this file skip.
  it('still runs retention, and releases the guard, when the queue work fails', async () => {
    listOpenTasksCreatedBetween.mockRejectedValueOnce(new Error('boom'));
    await guardedSweep();
    expect(purge).toHaveBeenCalledTimes(1);

    // Not stuck "running": the next tick gets as far as the backoff check
    // rather than being turned away by the guard, and returns normally.
    await expect(guardedSweep()).resolves.toBeUndefined();
  });
});
