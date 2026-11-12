import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  announceMessage, waitForWork, isCursor, openWaitCount, resetWorkSignal,
  TooManyWaitsError, MAX_WAITS_PER_AGENT, MAX_WAITS_TOTAL,
} from '@/lib/work-signal';

const dm = (to: string, from = 'sender') =>
  announceMessage({ channelName: 'direct-messages', content: `@${to} hello`, authorAgentName: from });

beforeEach(() => { vi.useFakeTimers(); resetWorkSignal(); });
afterEach(() => { resetWorkSignal(); vi.useRealTimers(); });

describe('the cursor', () => {
  it('answers at once with a cursor when none is given', async () => {
    const r = await waitForWork('nas-a', null, 50_000);
    expect(r.changed).toBe(false);
    expect(isCursor(r.cursor)).toBe(true);
    expect(openWaitCount()).toBe(0);
  });

  it('catches a message stored between two requests', async () => {
    const { cursor } = await waitForWork('nas-a', null, 50_000);
    dm('nas-a');
    const r = await waitForWork('nas-a', cursor, 50_000);
    expect(r).toMatchObject({ changed: true, dm: true });
    expect(r.cursor).not.toBe(cursor);
  });

  it('says "re-read" for a cursor this process did not issue', async () => {
    const r = await waitForWork('nas-a', '0123456789abcdef:7', 50_000);
    expect(r.changed).toBe(true);
    expect(openWaitCount()).toBe(0);
  });

  it('rejects malformed cursors', () => {
    for (const bad of ['', 'abc', '0123456789abcdef:', '0123456789ABCDEF:1', '0123456789abcdef:-1', '0123456789abcdef:1;x']) {
      expect(isCursor(bad), bad).toBe(false);
    }
  });
});

describe('waiting', () => {
  it('holds the request until a message names the agent', async () => {
    const { cursor } = await waitForWork('nas-a', null, 50_000);
    let done = false;
    const pending = waitForWork('nas-a', cursor, 50_000).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    expect(openWaitCount()).toBe(1);

    dm('nas-a');
    const r = await pending;
    expect(r).toMatchObject({ changed: true, dm: true });
    expect(openWaitCount()).toBe(0);
  });

  it('times out with changed false and the same cursor', async () => {
    const { cursor } = await waitForWork('nas-a', null, 50_000);
    const pending = waitForWork('nas-a', cursor, 25_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toEqual({ changed: false, dm: false, cursor });
    expect(openWaitCount()).toBe(0);
  });

  it('ends when the caller goes away', async () => {
    const { cursor } = await waitForWork('nas-a', null, 50_000);
    const gone = new AbortController();
    const pending = waitForWork('nas-a', cursor, 50_000, gone.signal);
    gone.abort();
    expect((await pending).changed).toBe(false);
    expect(openWaitCount()).toBe(0);
  });

  it('wakes every session of the agent, and nobody else', async () => {
    const a = (await waitForWork('nas-a', null, 1)).cursor;
    const b = (await waitForWork('nas-b', null, 1)).cursor;
    const first = waitForWork('nas-a', a, 50_000);
    const second = waitForWork('nas-a', a, 50_000);
    let other = false;
    void waitForWork('nas-b', b, 50_000).then(() => { other = true; });

    dm('nas-a');
    expect((await first).changed).toBe(true);
    expect((await second).changed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(other).toBe(false);
    expect(openWaitCount()).toBe(1);
  });
});

describe('what counts', () => {
  it('matches names the way the mention trigger does: any case, anywhere in the text', async () => {
    const { cursor } = await waitForWork('NAS-a', null, 1);
    announceMessage({ channelName: 'general', content: 'cc @nas-A and @someone-else', authorAgentName: 'x' });
    const r = await waitForWork('nas-a', cursor, 50_000);
    expect(r).toMatchObject({ changed: true, dm: false });
  });

  it('reports dm only for #direct-messages', async () => {
    const { cursor } = await waitForWork('nas-a', null, 1);
    announceMessage({ channelName: 'general', content: '@nas-a look', authorAgentName: 'x' });
    const afterMention = await waitForWork('nas-a', cursor, 1);
    expect(afterMention.dm).toBe(false);
    dm('nas-a');
    expect((await waitForWork('nas-a', afterMention.cursor, 1)).dm).toBe(true);
  });

  it('does not wake an agent for its own message', async () => {
    const { cursor } = await waitForWork('nas-a', null, 1);
    announceMessage({ channelName: 'general', content: 'note to self @nas-a', authorAgentName: 'NAS-A' });
    const pending = waitForWork('nas-a', cursor, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).changed).toBe(false);
  });

  it('ignores a message that names nobody who is tracked', async () => {
    const { cursor } = await waitForWork('nas-a', null, 1);
    announceMessage({ channelName: 'general', content: 'no names here, or only @strangers', authorAgentName: 'x' });
    const pending = waitForWork('nas-a', cursor, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).changed).toBe(false);
  });
});

describe('limits', () => {
  it('gives the oldest wait up when one agent opens too many', async () => {
    const { cursor } = await waitForWork('nas-a', null, 1);
    const settled: number[] = [];
    for (let i = 0; i < MAX_WAITS_PER_AGENT; i++) {
      void waitForWork('nas-a', cursor, 50_000).then(() => settled.push(i));
    }
    expect(openWaitCount()).toBe(MAX_WAITS_PER_AGENT);

    void waitForWork('nas-a', cursor, 50_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual([0]);
    expect(openWaitCount()).toBe(MAX_WAITS_PER_AGENT);
  });

  it('refuses a new wait once the server holds its maximum', async () => {
    for (let i = 0; i < MAX_WAITS_TOTAL; i++) {
      const { cursor } = await waitForWork(`agent-${i}`, null, 1);
      void waitForWork(`agent-${i}`, cursor, 50_000);
    }
    expect(openWaitCount()).toBe(MAX_WAITS_TOTAL);
    const { cursor } = await waitForWork('one-more', null, 1);
    await expect(waitForWork('one-more', cursor, 50_000)).rejects.toBeInstanceOf(TooManyWaitsError);
  });

  it('wakes at most a bounded number of agents per message', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `agent-${i}`);
    const cursors = new Map<string, string>();
    for (const n of names) cursors.set(n, (await waitForWork(n, null, 1)).cursor);
    announceMessage({ channelName: 'general', content: names.map((n) => `@${n}`).join(' '), authorAgentName: 'x' });
    let woken = 0;
    for (const n of names) {
      const pending = waitForWork(n, cursors.get(n)!, 1);
      await vi.advanceTimersByTimeAsync(1);
      if ((await pending).changed) woken++;
    }
    expect(woken).toBe(50);
  });
});

describe('a conversation message', () => {
  const say = (recipientNames: string[], content = 'hello all', from = 'nas-a') =>
    announceMessage({ channelName: 'direct-messages', content, authorAgentName: from, recipientNames });

  it('wakes the participants it is sent to', async () => {
    const b = await waitForWork('nas-b', null, 50_000);
    const c = await waitForWork('nas-c', null, 50_000);
    say(['NAS-B', 'nas-c']);
    expect(await waitForWork('nas-b', b.cursor, 50_000)).toMatchObject({ changed: true, dm: true });
    expect(await waitForWork('nas-c', c.cursor, 50_000)).toMatchObject({ changed: true, dm: true });
  });

  it('wakes nobody named only in its text', async () => {
    const outsider = await waitForWork('nas-z', null, 50_000);
    say(['nas-b'], 'ask @nas-z about this');
    const pending = waitForWork('nas-z', outsider.cursor, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).changed).toBe(false);
  });

  it('does not wake its author', async () => {
    const a = await waitForWork('nas-a', null, 50_000);
    say(['nas-a', 'nas-b']);
    const pending = waitForWork('nas-a', a.cursor, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).changed).toBe(false);
  });
});
