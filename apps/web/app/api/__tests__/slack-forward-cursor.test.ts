import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The forward cursor must never step over a message nobody received.
 *
 * It used to. `_lastPollTime` was set to "now" *before* the forwarding loop
 * ran, so anything that failed partway — a Slack outage, a hung webhook, a
 * restart — left those messages behind a cursor that had already moved past
 * them. They were never queried again. Silent, permanent loss on the one
 * endpoint whose entire job is delivery.
 *
 * The cursor now advances only over messages the run actually finished with,
 * so a failure means a retry rather than a hole.
 */

const SECRET = 'test-forward-secret';
const WEBHOOK = 'https://hooks.slack.com/services/T/B/X';

/** Messages the fake database will return, oldest first. */
let rows: Array<Record<string, unknown>> = [];
/** Slack's answer per call, so a run can succeed then fail. */
let slackResponses: Array<{ ok: boolean } | Error> = [];
let slackCalls: string[] = [];
/** Every `.gt('created_at', x)` the route issues — i.e. the cursor it used. */
let queriedSince: string[] = [];

/**
 * The first poll looks back 60 seconds, so fixtures have to be recent or the
 * route correctly finds nothing. `at(n)` is n seconds into that window.
 */
const WINDOW_START = Date.now() - 30_000;
const at = (seconds: number) => new Date(WINDOW_START + seconds * 1000).toISOString();

function message(id: string, createdAt: string, content = '@human help') {
  return {
    id,
    content,
    created_at: createdAt,
    metadata: {},
    channels: { name: 'human-messages' },
    agents: { name: 'some-agent' },
  };
}

vi.mock('@airchat/shared/supabase', () => ({
  createAdminClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        gt: (_col: string, value: string) => {
          queriedSince.push(value);
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            resolve({
              data: rows.filter(
                (r) => (r.created_at as string) > queriedSince[queriedSince.length - 1]
              ),
              error: null,
            })
          ),
      };
      return builder;
    },
  }),
}));

/**
 * The cursor lives in module scope, so every test imports the route afresh —
 * otherwise one test's cursor silently becomes the next test's starting point.
 */
let POST: (req: NextRequest) => Promise<Response>;

function post() {
  return POST(
    new NextRequest('http://localhost/api/slack/forward', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    })
  );
}

beforeEach(async () => {
  vi.resetModules();
  ({ POST } = await import('@/app/api/slack/forward/route'));

  process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  process.env.SLACK_FORWARD_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  process.env.SLACK_WATCHED_CHANNELS = 'human-messages';

  rows = [];
  slackResponses = [];
  slackCalls = [];
  queriedSince = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      slackCalls.push(JSON.parse(init.body).text);
      const next = slackResponses.shift() ?? { ok: true };
      if (next instanceof Error) throw next;
      return { ok: next.ok, status: next.ok ? 200 : 500 } as Response;
    })
  );
});

describe('slack forward cursor', () => {
  it('does not advance past a message Slack rejected', async () => {
    rows = [
      message('a', at(1)),
      message('b', at(2)),
      message('c', at(3)),
    ];
    // 'a' delivers, 'b' fails.
    slackResponses = [{ ok: true }, { ok: false }];

    const first = await post();
    const body = await first.json();

    expect(body.forwarded).toBe(1);
    expect(body.retrying).toBe(2);
    expect(slackCalls).toHaveLength(2);

    // The next poll must start from 'a' — the last message actually delivered —
    // so 'b' and 'c' are re-read rather than skipped.
    slackResponses = [{ ok: true }, { ok: true }];
    await post();

    expect(queriedSince[1]).toBe(at(1));
    expect(slackCalls.slice(2)).toEqual([
      expect.stringContaining('@human help'),
      expect.stringContaining('@human help'),
    ]);
  });

  it('does not advance past a webhook that throws', async () => {
    rows = [
      message('a', at(1)),
      message('b', at(2)),
    ];
    slackResponses = [{ ok: true }, new Error('The operation timed out')];

    const res = await post();
    const body = await res.json();

    expect(body.forwarded).toBe(1);
    expect(body.error).toMatch(/timed out/);

    await post();
    expect(queriedSince[1]).toBe(at(1));
  });

  it('advances over skipped messages, which are not pending delivery', async () => {
    // Neither is forwarded: one came from Slack, one matches nothing.
    const fromSlack = message('a', at(1));
    fromSlack.metadata = { source: 'slack' };
    const unrelated = message('b', at(2), 'nothing to see');
    unrelated.channels = { name: 'some-other-channel' };
    rows = [fromSlack, unrelated];

    const body = await (await post()).json();
    expect(body.forwarded).toBe(0);
    expect(slackCalls).toHaveLength(0);

    // Both are dealt with, so the cursor moves past them — a skip is not a
    // failure, and re-reading them forever would be a slow leak.
    await post();
    expect(queriedSince[1]).toBe(at(2));
  });

  it('advances to the newest message when everything succeeds', async () => {
    rows = [
      message('a', at(1)),
      message('b', at(2)),
    ];

    const body = await (await post()).json();
    expect(body.forwarded).toBe(2);
    expect(body.error).toBeUndefined();

    await post();
    expect(queriedSince[1]).toBe(at(2));
  });

  it('sends a timeout signal with every webhook call', async () => {
    rows = [message('a', at(1))];
    await post();

    const init = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1];
    expect((init as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('still refuses an unauthenticated caller', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/slack/forward', { method: 'POST' })
    );
    expect(res.status).toBe(401);
  });
});
