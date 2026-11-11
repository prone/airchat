import { describe, it, expect, vi } from 'vitest';
import { forwardNewMessages, type ForwardableMessage } from '../forwarder.js';

/**
 * A channel's cursor moves only past messages that were actually delivered.
 * With one cursor for all channels, a pass that posted channel A and then
 * failed on channel B posted A's messages again after every such failure.
 */

const START = '2026-01-01T00:00:00Z';
const m = (minute: number, content: string, extra: Partial<ForwardableMessage> = {}): ForwardableMessage => ({
  content, author: 'macbook-agent', timestamp: `2026-01-01T00:0${minute}:00Z`, ...extra,
});

function setup(byChannel: Record<string, ForwardableMessage[]>) {
  const posted: string[] = [];
  const failRead = new Set<string>();
  let failPostContaining: string | null = null;
  const deps = {
    readMessages: vi.fn(async (channel: string) => {
      if (failRead.has(channel)) throw new Error('HTTP 503');
      return { messages: byChannel[channel] ?? [] };
    }),
    postToSlack: vi.fn(async (text: string) => {
      if (failPostContaining && text.includes(failPostContaining)) throw new Error('Slack webhook answered HTTP 500');
      posted.push(text);
    }),
  };
  return { posted, failRead, deps, failPostOn: (s: string | null) => { failPostContaining = s; } };
}

const bodies = (posted: string[]) => posted.map((p) => p.split('\n')[1]);

describe('forwardNewMessages', () => {
  it('forwards new messages oldest first, whatever order the API returned', async () => {
    const t = setup({ a: [m(2, 'second'), m(1, 'first')] });
    await forwardNewMessages(['a'], new Map(), START, t.deps);
    expect(bodies(t.posted)).toEqual(['first', 'second']);
  });

  it('does not re-post channel A when channel B fails', async () => {
    const t = setup({ a: [m(1, 'from a')], b: [m(1, 'from b')] });
    const cursors = new Map<string, string>();
    t.failRead.add('b');

    await expect(forwardNewMessages(['a', 'b'], cursors, START, t.deps)).rejects.toThrow();
    expect(t.posted).toHaveLength(1);

    t.failRead.clear();
    await forwardNewMessages(['a', 'b'], cursors, START, t.deps);
    expect(t.posted.filter((p) => p.includes('from a'))).toHaveLength(1);
    expect(t.posted.filter((p) => p.includes('from b'))).toHaveLength(1);
  });

  it('resumes at the message whose delivery failed, without repeating earlier ones', async () => {
    const t = setup({ a: [m(1, 'one'), m(2, 'two'), m(3, 'three')] });
    const cursors = new Map<string, string>();
    t.failPostOn('two');

    await expect(forwardNewMessages(['a'], cursors, START, t.deps)).rejects.toThrow(/webhook/);
    t.failPostOn(null);
    await forwardNewMessages(['a'], cursors, START, t.deps);

    expect(bodies(t.posted)).toEqual(['one', 'two', 'three']);
  });

  it('forwards nothing twice across successful passes', async () => {
    const t = setup({ a: [m(1, 'one')] });
    const cursors = new Map<string, string>();
    await forwardNewMessages(['a'], cursors, START, t.deps);
    await forwardNewMessages(['a'], cursors, START, t.deps);
    expect(t.posted).toHaveLength(1);
  });

  it('skips messages that came from Slack, and anything older than startup', async () => {
    const t = setup({ a: [
      m(1, 'echo', { metadata: { source: 'slack' } }),
      m(2, 'echo by project', { project: 'slack' }),
      { content: 'ancient', author: 'x', timestamp: '2025-12-31T00:00:00Z' },
      m(3, 'real'),
    ] });
    expect(await forwardNewMessages(['a'], new Map(), START, t.deps)).toBe(1);
    expect(t.posted[0]).toContain('real');
  });

  it('escapes Slack markup and flags @human', async () => {
    const t = setup({ a: [m(1, '@human look at <!channel> & this')] });
    await forwardNewMessages(['a'], new Map(), START, t.deps);
    expect(t.posted[0].startsWith(':rotating_light: ')).toBe(true);
    expect(t.posted[0]).toContain('&lt;!channel&gt; &amp; this');
  });
});
