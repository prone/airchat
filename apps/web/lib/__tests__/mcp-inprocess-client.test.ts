import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * The in-process client's job is to reach the SAME v2 route handlers the HTTP
 * client reaches, with the same parameters. These tests capture the request
 * each handler receives, so a mismatch in query-parameter names (which would
 * fail open as an empty result, not an error) is caught here.
 */

type Captured = { url: URL; method: string; body: unknown };
const captured: Captured[] = [];

function recorder(payload: unknown = { ok: true }) {
  return vi.fn(async (request: Request) => {
    let body: unknown = undefined;
    if (request.method === 'POST') {
      const text = await request.text();
      body = text ? JSON.parse(text) : undefined;
    }
    captured.push({ url: new URL(request.url), method: request.method, body });
    return NextResponse.json(payload);
  });
}

const boardGET = recorder({ channels: [] });
const channelsGET = recorder({ channels: [] });
const messagesGET = recorder({ messages: [] });
const messagesPOST = recorder({ message: { id: 'm1' } });
const dmPOST = recorder({ message: { id: 'dm1' } });
const mentionsGET = recorder({ mentions: [] });
const mentionsPOST = recorder({ marked_read: 1 });
const searchGET = recorder({ results: [] });
const notesGET = recorder({ notes: [] });
const notesPOST = recorder({ note: { slug: 'n' } });
const backlinksGET = recorder({ backlinks: [] });
const summarizePOST = recorder({ note: { slug: 'channel-summary' } });

vi.mock('@/app/api/v2/board/route', () => ({ GET: boardGET }));
vi.mock('@/app/api/v2/channels/route', () => ({ GET: channelsGET }));
vi.mock('@/app/api/v2/messages/route', () => ({ GET: messagesGET, POST: messagesPOST }));
vi.mock('@/app/api/v2/dm/route', () => ({ POST: dmPOST }));
vi.mock('@/app/api/v2/mentions/route', () => ({ GET: mentionsGET, POST: mentionsPOST }));
vi.mock('@/app/api/v2/search/route', () => ({ GET: searchGET }));
vi.mock('@/app/api/v2/notes/route', () => ({ GET: notesGET, POST: notesPOST }));
vi.mock('@/app/api/v2/notes/backlinks/route', () => ({ GET: backlinksGET }));
vi.mock('@/app/api/v2/channels/summarize/route', () => ({ POST: summarizePOST }));

const runAsAuthenticatedAgent = vi.fn(
  <T,>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
);
vi.mock('@/lib/api-v2-auth', () => ({ runAsAuthenticatedAgent }));

const { InProcessToolClient } = await import('@/lib/mcp-inprocess-client');

const CTX = { agentId: 'agent-1', agentName: 'connector', machineId: 'machine-1' };
let client: InstanceType<typeof InProcessToolClient>;

beforeEach(() => {
  captured.length = 0;
  vi.clearAllMocks();
  client = new InProcessToolClient(CTX);
});

const last = () => captured[captured.length - 1];

describe('InProcessToolClient — authenticated scope', () => {
  it('runs every call inside the verified-agent scope', async () => {
    await client.checkBoard();
    expect(runAsAuthenticatedAgent).toHaveBeenCalledOnce();
    expect(runAsAuthenticatedAgent.mock.calls[0][0]).toEqual(CTX);
  });
});

describe('InProcessToolClient — parameter mapping', () => {
  it('reads messages with channel, limit and before', async () => {
    await client.readMessages('general', 50, '2026-01-01T00:00:00Z');
    expect(last().url.pathname).toBe('/api/v2/messages');
    expect(last().url.searchParams.get('channel')).toBe('general');
    expect(last().url.searchParams.get('limit')).toBe('50');
    expect(last().url.searchParams.get('before')).toBe('2026-01-01T00:00:00Z');
  });

  it('omits optional message params when not supplied', async () => {
    await client.readMessages('general');
    expect(last().url.searchParams.has('limit')).toBe(false);
    expect(last().url.searchParams.has('before')).toBe(false);
  });

  it('searches using q, the name the route actually reads', async () => {
    await client.searchMessages('deploy runbook', 'general');
    expect(last().url.searchParams.get('q')).toBe('deploy runbook');
    expect(last().url.searchParams.get('channel')).toBe('general');
  });

  it('distinguishes list_notes from query_notes by flag', async () => {
    await client.listNotes({ channel: 'project-airchat', query: 'deploy' });
    expect(last().url.searchParams.get('list')).toBe('true');
    expect(last().url.searchParams.get('q')).toBe('deploy');

    await client.queryNotes({ properties: { status: 'unresolved' }, limit: 10 });
    expect(last().url.searchParams.get('query')).toBe('true');
    expect(JSON.parse(last().url.searchParams.get('properties')!)).toEqual({ status: 'unresolved' });
    expect(last().url.searchParams.get('limit')).toBe('10');
  });

  it('reads a note by slug, with optional channel and revision', async () => {
    await client.readNote('project-airchat', 'runbook', 3);
    expect(last().url.pathname).toBe('/api/v2/notes');
    expect(last().url.searchParams.get('slug')).toBe('runbook');
    expect(last().url.searchParams.get('channel')).toBe('project-airchat');
    expect(last().url.searchParams.get('revision')).toBe('3');
  });

  it('treats a null channel as instance-global (no channel param)', async () => {
    await client.readNote(null, 'runbook');
    expect(last().url.searchParams.has('channel')).toBe(false);
  });

  it('posts a note body through to the notes route', async () => {
    await client.writeNote({ channel: 'project-airchat', slug: 'n', title: 'T', body_md: 'B' });
    expect(last().method).toBe('POST');
    expect(last().body).toMatchObject({ slug: 'n', title: 'T', body_md: 'B' });
  });

  it('maps summarize_channel arguments to the route body', async () => {
    await client.summarizeChannel('general', 14, 'project');
    expect(last().url.pathname).toBe('/api/v2/channels/summarize');
    expect(last().body).toEqual({ channel: 'general', window_days: 14, kind: 'project' });
  });

  it('fetches backlinks by slug', async () => {
    await client.getNoteBacklinks('project-airchat', 'runbook');
    expect(last().url.pathname).toBe('/api/v2/notes/backlinks');
    expect(last().url.searchParams.get('slug')).toBe('runbook');
  });

  it('passes the channel type filter through', async () => {
    await client.listChannels('project');
    expect(last().url.searchParams.get('type')).toBe('project');
  });
});

describe('InProcessToolClient — message metadata', () => {
  it('drops the cwd-derived project stamp', async () => {
    // Server-side, `project` is the web server's working directory. Forwarding
    // it would attribute a claude.ai user's message to an unrelated project.
    await client.sendMessage('general', 'hi', undefined, { project: 'agentchat' });
    expect((last().body as { metadata: unknown }).metadata).toBeNull();
  });

  it('keeps any other metadata the caller supplied', async () => {
    await client.sendMessage('general', 'hi', undefined, { project: 'agentchat', tag: 'x' });
    expect((last().body as { metadata: unknown }).metadata).toEqual({ tag: 'x' });
  });

  it('threads a reply through parent_message_id', async () => {
    await client.sendMessage('general', 'reply', 'parent-uuid');
    expect(last().body).toMatchObject({ parent_message_id: 'parent-uuid' });
  });
});

describe('InProcessToolClient — error propagation', () => {
  it('throws with the status and body when a route fails', async () => {
    messagesGET.mockResolvedValueOnce(
      NextResponse.json({ error: 'Channel not found' }, { status: 404 }),
    );
    // One call, both facts: the status and the route's error body reach the
    // MCP handler, which is what AirChatRestClient does over HTTP.
    await expect(client.readMessages('nope')).rejects.toThrow(/HTTP 404 — .*Channel not found/);
  });

  it('surfaces a non-JSON body as an explicit error', async () => {
    messagesGET.mockResolvedValueOnce(new NextResponse('<html>oops</html>', { status: 200 }));
    await expect(client.readMessages('general')).rejects.toThrow(/non-JSON body/);
  });
});

describe('InProcessToolClient — tools outside the v1 surface', () => {
  it('refuses rather than half-working', () => {
    // Only the file tools remain outside v1; messaging was added once the
    // connector's purpose (ask an agent, read the reply) was clarified.
    expect(() => client.uploadFile()).toThrow(/not available through the AirChat connector/);
    expect(() => client.downloadFile()).toThrow(/not available/);
    expect(() => client.getFileUrl()).toThrow(/not available/);
  });
});

describe('InProcessToolClient — agent-to-agent messaging', () => {
  it('sends a direct message to a named agent', async () => {
    await client.sendDirectMessage('macbook-salmon', 'what is the deploy status?');
    expect(last().url.pathname).toBe('/api/v2/dm');
    expect(last().body).toEqual({
      target_agent: 'macbook-salmon',
      content: 'what is the deploy status?',
    });
  });

  it('reads mentions using `unread`, the name the route actually reads', async () => {
    // The route reads `unread`, not `unread_only`. Getting this wrong fails
    // OPEN — it would silently return all mentions rather than erroring.
    await client.checkMentions(true, 10);
    expect(last().url.pathname).toBe('/api/v2/mentions');
    expect(last().url.searchParams.get('unread')).toBe('true');
    expect(last().url.searchParams.get('limit')).toBe('10');
  });

  it('omits mention filters when not supplied', async () => {
    await client.checkMentions();
    expect(last().url.searchParams.has('unread')).toBe(false);
    expect(last().url.searchParams.has('limit')).toBe(false);
  });

  it('marks mentions read by id', async () => {
    await client.markMentionsRead(['11111111-1111-4111-8111-111111111111']);
    expect(last().url.pathname).toBe('/api/v2/mentions');
    expect(last().body).toEqual({ mention_ids: ['11111111-1111-4111-8111-111111111111'] });
  });
});

describe('InProcessToolClient — trusted origin marking', () => {
  it('runs every call in a scope declaring the connector as the source', async () => {
    await client.sendMessage('general', 'hello');
    // 3rd argument to runAsAuthenticatedAgent is the trusted source. It is not
    // sent in the body — the route stamps it, so it cannot be spoofed.
    expect(runAsAuthenticatedAgent.mock.calls[0][2]).toBe('claude.ai');
  });

  it('never puts source in the request body', async () => {
    await client.sendMessage('general', 'hello', undefined, { source: 'spoofed' });
    const body = last().body as { metadata: Record<string, unknown> | null };
    expect(body.metadata?.source).toBeUndefined();
  });
});
