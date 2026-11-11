import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * What the Slack forwarder must never send, and who may call it.
 *
 * The forwarder reads messages with the service role, so nothing in the
 * database stops it seeing everything. It used to forward any message that
 * said "@human" — including quarantined ones, ones that arrived from other
 * instances, and private direct messages — and compared its shared secret with
 * a plain `!==`.
 */

const SECRET = 'test-forward-secret';
const WEBHOOK = 'https://hooks.slack.com/services/T/B/X';

let rows: Array<Record<string, unknown>> = [];
let slackCalls: string[] = [];
/** Filters the route put on its query, as [method, column, value]. */
let filters: Array<[string, string, unknown]> = [];
const ipLimit = { allowed: true };

const recent = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm',
    content: '@human please look',
    created_at: recent(10),
    metadata: {},
    origin_instance: null,
    quarantined: false,
    channels: { name: 'general' },
    agents: { name: 'some-agent' },
    ...overrides,
  };
}

vi.mock('@airchat/shared/supabase', () => ({
  createAdminClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        gt: () => builder,
        eq: (col: string, value: unknown) => { filters.push(['eq', col, value]); return builder; },
        is: (col: string, value: unknown) => { filters.push(['is', col, value]); return builder; },
        // The fake applies the same filters a real database would, so a test
        // can tell "filtered by the query" from "filtered in the loop".
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({
            data: rows.filter((r) => filters.every(([, col, value]) => (r[col] ?? null) === value)),
            error: null,
          })),
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkIpRateLimit: () => (ipLimit.allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1000 }),
}));

let POST: (req: NextRequest) => Promise<Response>;

function post(authorization: string | null = `Bearer ${SECRET}`) {
  return POST(new NextRequest('http://localhost/api/slack/forward', {
    method: 'POST',
    headers: authorization === null ? {} : { authorization },
  }));
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
  slackCalls = [];
  filters = [];
  ipLimit.allowed = true;

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    slackCalls.push(JSON.parse(init.body).text);
    return { ok: true, status: 200 } as Response;
  }));
});

describe('what is forwarded', () => {
  it('forwards an ordinary local @human message', async () => {
    rows = [message()];
    expect((await (await post()).json()).forwarded).toBe(1);
  });

  it.each([
    ['ping @human when ready', 1],
    ['(@human)', 1],
    ['mail me at someone@human.example', 0],
    ['@humanity is fine', 0],
  ])('treats %j as %i mention(s) of @human', async (content, expected) => {
    rows = [message({ content })];
    expect((await (await post()).json()).forwarded).toBe(expected);
  });

  it('asks the database for non-quarantined, locally written messages only', async () => {
    await post();
    expect(filters).toContainEqual(['eq', 'quarantined', false]);
    expect(filters).toContainEqual(['is', 'origin_instance', null]);
  });

  it('does not forward a quarantined message', async () => {
    rows = [message({ quarantined: true })];
    expect((await (await post()).json()).forwarded).toBe(0);
    expect(slackCalls).toHaveLength(0);
  });

  it('does not forward a message that arrived from another instance', async () => {
    rows = [message({ origin_instance: 'abcdef0123456789', channels: { name: 'gossip-general' } })];
    await post();
    expect(slackCalls).toHaveLength(0);
  });

  it.each(['gossip-general', 'shared-partners'])(
    'does not forward from the federated channel %s, even when it is watched',
    async (channel) => {
      process.env.SLACK_WATCHED_CHANNELS = `human-messages,${channel}`;
      rows = [message({ channels: { name: channel } })];
      const body = await (await post()).json();
      expect(body.forwarded).toBe(0);
      expect(slackCalls).toHaveLength(0);
    },
  );

  it('does not let @human in a direct message page Slack', async () => {
    rows = [message({ channels: { name: 'direct-messages' }, content: '@human this is private' })];
    await post();
    expect(slackCalls).toHaveLength(0);
  });

  it('moves the cursor past messages it refuses, so they are not re-read forever', async () => {
    rows = [message({ channels: { name: 'gossip-general' } }), message({ id: 'n', created_at: recent(5) })];
    const body = await (await post()).json();
    expect(body.forwarded).toBe(1);
    expect(body.checked).toBe(2);
  });
});

describe('who may call it', () => {
  it.each([
    ['no header', null],
    ['a wrong secret', 'Bearer wrong'],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, -1)}`],
    ['the secret with extra characters', `Bearer ${SECRET}x`],
    ['the secret without the scheme', SECRET],
  ])('refuses %s', async (_label, header) => {
    rows = [message()];
    const res = await post(header);
    expect(res.status).toBe(401);
    expect(slackCalls).toHaveLength(0);
  });

  it('refuses a caller over the per-IP limit before looking at the secret', async () => {
    ipLimit.allowed = false;
    rows = [message()];
    const res = await post();
    expect(res.status).toBe(429);
    expect(slackCalls).toHaveLength(0);
  });
});
