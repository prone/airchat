import { describe, it, expect } from 'vitest';
import { waitForWorkLoop, type WaitForWorkIo, type WaitableWork } from '../wait-for-work.js';

/**
 * The loop a headless agent blocks in. What matters: it never reads the work
 * before it has a cursor (a message could fall between), it stops at the
 * timeout, and a server that cannot hold a wait degrades to polling.
 */

const NOTHING: WaitableWork = { mentions: [], open_matching: [] };
const MENTION: WaitableWork = { mentions: [{ mention_id: 'm1' }], open_matching: [] };
const TASK: WaitableWork = { mentions: [], open_matching: [{ id: 't1' }] };

const httpError = (status: number, retryAfterMs?: number) => Object.assign(new Error(`HTTP ${status}`), { status, retryAfterMs });

type WaitAnswer = { cursor?: string; changed?: boolean } | Error;

function harness(work: WaitableWork[], waits: WaitAnswer[]) {
  let now = 0;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const next = <T,>(list: T[]) => (list.length > 1 ? (list.shift() as T) : list[0]);
  const io: WaitForWorkIo<WaitableWork> = {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    checkWork: async () => { calls.push('work'); return next(work); },
    wait: async (after, seconds) => {
      calls.push(after === undefined ? 'cursor' : `wait:${after}:${seconds}`);
      const answer = next(waits);
      if (answer instanceof Error) throw answer;
      if (after !== undefined && !answer.changed) now += (seconds ?? 0) * 1000;
      return answer;
    },
  };
  return { io, calls, sleeps, elapsed: () => now };
}

describe('waitForWorkLoop', () => {
  it('returns at once when a mention is already waiting, cursor first', async () => {
    const h = harness([MENTION], [{ cursor: 'c1' }]);
    expect(await waitForWorkLoop(h.io)).toBe(MENTION);
    expect(h.calls).toEqual(['cursor', 'work']);
  });

  it('waits with the cursor, then reads when something changed', async () => {
    const h = harness([NOTHING, MENTION], [{ cursor: 'c1' }, { cursor: 'c2', changed: true }]);
    expect(await waitForWorkLoop(h.io)).toBe(MENTION);
    expect(h.calls).toEqual(['cursor', 'work', 'wait:c1:20', 'work']);
  });

  it('gives up at the timeout, shortening the last wait', async () => {
    const h = harness([NOTHING], [{ cursor: 'c1' }]);
    expect(await waitForWorkLoop(h.io, { timeoutMs: 50_000 })).toBeNull();
    expect(h.calls.filter((c) => c.startsWith('wait:'))).toEqual(['wait:c1:20', 'wait:c1:20', 'wait:c1:10']);
    expect(h.elapsed()).toBe(50_000);
  });

  it('looks once for a zero timeout', async () => {
    const h = harness([NOTHING], [{ cursor: 'c1' }]);
    expect(await waitForWorkLoop(h.io, { timeoutMs: 0 })).toBeNull();
    expect(h.calls).toEqual(['cursor', 'work']);
  });

  it('ignores open tasks unless asked', async () => {
    expect(await waitForWorkLoop(harness([TASK], [{ cursor: 'c1' }]).io, { timeoutMs: 20_000 })).toBeNull();
    expect(await waitForWorkLoop(harness([TASK], [{ cursor: 'c1' }]).io, { includeTasks: true })).toBe(TASK);
  });

  it('re-reads at least every poll interval when watching for tasks', async () => {
    const h = harness([NOTHING, NOTHING, TASK], [{ cursor: 'c1' }]);
    expect(await waitForWorkLoop(h.io, { includeTasks: true, pollIntervalMs: 10_000 })).toBe(TASK);
    expect(h.calls.filter((c) => c.startsWith('wait:'))).toEqual(['wait:c1:10', 'wait:c1:10']);
  });

  it.each([404, 503])('polls when the server cannot hold a wait (%i)', async (status) => {
    const h = harness([NOTHING, NOTHING, MENTION], [httpError(status)]);
    expect(await waitForWorkLoop(h.io, { pollIntervalMs: 15_000 })).toBe(MENTION);
    expect(h.sleeps).toEqual([15_000, 15_000]);
    expect(h.calls.filter((c) => c !== 'work')).toEqual(['cursor']);
  });

  it('waits as long as a rate limit asks', async () => {
    const h = harness([NOTHING, MENTION], [{ cursor: 'c1' }, httpError(429, 7000), { cursor: 'c2' }]);
    expect(await waitForWorkLoop(h.io)).toBe(MENTION);
    expect(h.sleeps).toEqual([7000]);
  });

  it('retries a server that is only too busy for now', async () => {
    const h = harness([NOTHING, NOTHING, MENTION], [
      { cursor: 'c1' }, httpError(503, 60_000), { cursor: 'c2' }, { cursor: 'c3', changed: true },
    ]);
    expect(await waitForWorkLoop(h.io)).toBe(MENTION);
    expect(h.sleeps).toEqual([60_000]);
    expect(h.calls).toContain('wait:c2:20');
  });

  it('starts again from a new cursor after a dropped connection', async () => {
    const h = harness([NOTHING, MENTION], [{ cursor: 'c1' }, new Error('fetch failed'), { cursor: 'c2' }]);
    expect(await waitForWorkLoop(h.io)).toBe(MENTION);
    expect(h.sleeps).toEqual([5000]);
    expect(h.calls.slice(-2)).toEqual(['cursor', 'work']);
  });
});
