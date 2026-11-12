import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ConversationError } from '@airchat/shared';

/**
 * The conversation routes: what they accept, and what they answer when the
 * storage layer refuses. Who may read a conversation is decided in the
 * database (migration 00040) and in the adapter; here it matters that a
 * refusal reaches the caller as "not found" and never as a 500 or a success.
 */

const ID = '3f0c8a52-1d7e-4b0a-9c55-2a1f6f0f7b11';
const conversation = { id: ID, title: null, created_at: '2026-11-11T00:00:00Z', participants: [] };

const scoped = {
  createConversation: vi.fn(async (_names: string[], _title?: string) => conversation),
  listConversations: vi.fn(async () => [conversation]),
  getConversation: vi.fn(async (_id: string, _opts?: unknown) => ({ conversation, messages: [], has_more: false })),
  sendConversationMessage: vi.fn(async (_id: string, content: string, _metadata?: unknown) => ({ id: 'm-1', content })),
  addConversationParticipant: vi.fn(async (_id: string, _agent: string) => conversation),
  listAllConversations: vi.fn(async (_opts?: unknown) => ({ conversations: [conversation], total: 1, limit: 50, offset: 0 })),
};
let source: string | undefined;
let readOnly = false;

vi.mock('@/lib/api-v2-auth', () => ({
  authenticateAgent: async () => (readOnly
    ? { agentId: 'tok-1', agentName: 'read-token:Owner', machineId: '', readOnly: true, includeDirectMessages: true }
    : { agentId: 'a-1', agentName: 'mac-a', machineId: 'm-1' }),
  isAuthError: () => false,
  checkAgentRateLimit: () => null,
  resolveTrustedSource: () => source,
  getStorageAdapter: () => ({ forAgent: () => scoped }),
}));

const list = await import('@/app/api/v2/conversations/route');
const one = await import('@/app/api/v2/conversations/[id]/route');
const messages = await import('@/app/api/v2/conversations/[id]/messages/route');
const participants = await import('@/app/api/v2/conversations/[id]/participants/route');

const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost:3002/api/v2/conversations${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (path: string) => new NextRequest(`http://localhost:3002/api/v2/conversations${path}`);
const at = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  source = undefined;
  readOnly = false;
});

describe('GET /api/v2/conversations with a read token', () => {
  it('lists every conversation, paged, and not the token\'s own (it has none)', async () => {
    readOnly = true;
    const res = await list.GET(get('?limit=20&offset=40&include_test=true'));
    expect(res.status).toBe(200);
    expect(scoped.listAllConversations).toHaveBeenCalledWith({ limit: 20, offset: 40, includeTest: true });
    expect(scoped.listConversations).not.toHaveBeenCalled();
    expect((await res.json()).data ?? {}).toMatchObject({ total: 1 });
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=1.5'])('refuses %s', async (query) => {
    readOnly = true;
    expect((await list.GET(get(`?${query}`))).status).toBe(400);
    expect(scoped.listAllConversations).not.toHaveBeenCalled();
  });

  it('answers "not found" if storage refuses the caller', async () => {
    readOnly = true;
    scoped.listAllConversations.mockRejectedValueOnce(new ConversationError('not_found', 'Conversation not found'));
    expect((await list.GET(get(''))).status).toBe(404);
  });

  it('leaves an agent\'s own list as it was', async () => {
    await list.GET(get('?limit=20&offset=40'));
    expect(scoped.listConversations).toHaveBeenCalled();
    expect(scoped.listAllConversations).not.toHaveBeenCalled();
  });
});

describe('starting a conversation', () => {
  it('starts one with the other agents, leaving the caller and repeats out of the list', async () => {
    const res = await list.POST(post('', { participants: ['nas-b', 'mac-a', 'nas-b', 'nas-c'], title: 'Plan' }));
    expect(res.status).toBe(201);
    expect(scoped.createConversation).toHaveBeenCalledWith(['nas-b', 'nas-c'], 'Plan');
    expect(scoped.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('sends the first message when one is given', async () => {
    const res = await list.POST(post('', { participants: ['nas-b'], content: '  hello  ' }));
    expect(res.status).toBe(201);
    expect(scoped.sendConversationMessage).toHaveBeenCalledWith(ID, 'hello', undefined);
  });

  it.each([
    ['no participants', {}],
    ['an empty list', { participants: [] }],
    ['only the caller', { participants: ['mac-a'] }],
    ['a name that is not a name', { participants: ['nas-b', 'Not A Name'] }],
    ['a non-string', { participants: ['nas-b', 7] }],
    ['more than eight in all', { participants: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'].map((n) => `nas-${n}`) }],
    ['a title that is not text', { participants: ['nas-b'], title: 5 }],
    ['a title that is too long', { participants: ['nas-b'], title: 'x'.repeat(121) }],
    ['an empty first message', { participants: ['nas-b'], content: '   ' }],
    ['a first message that is too long', { participants: ['nas-b'], content: 'x'.repeat(32001) }],
    ['a body that is not an object', [1, 2]],
    ['a body that is not JSON', '{'],
  ])('refuses %s and creates nothing', async (_what, body) => {
    const res = await list.POST(post('', body));
    expect(res.status).toBe(400);
    expect(scoped.createConversation).not.toHaveBeenCalled();
  });

  it('says so when a named agent does not exist', async () => {
    scoped.createConversation.mockRejectedValueOnce(new ConversationError('unknown_agent', 'No active agent named "nas-x"'));
    const res = await list.POST(post('', { participants: ['nas-x'] }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('nas-x');
  });
});

describe('a conversation the caller is not in', () => {
  const refuse = () => new ConversationError('not_found', 'Conversation not found');

  it('cannot be read', async () => {
    scoped.getConversation.mockRejectedValueOnce(refuse());
    const res = await one.GET(get(`/${ID}`), at(ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Conversation not found' });
  });

  it('cannot be written to', async () => {
    scoped.sendConversationMessage.mockRejectedValueOnce(refuse());
    const res = await messages.POST(post(`/${ID}/messages`, { content: 'hi' }), at(ID));
    expect(res.status).toBe(404);
  });

  it('cannot be joined', async () => {
    scoped.addConversationParticipant.mockRejectedValueOnce(refuse());
    const res = await participants.POST(post(`/${ID}/participants`, { agent: 'mac-a' }), at(ID));
    expect(res.status).toBe(404);
  });
});

describe('reading', () => {
  it('lists the caller\'s conversations', async () => {
    const res = await list.GET(get(''));
    expect(res.status).toBe(200);
    expect((await res.json()).data.conversations).toHaveLength(1);
  });

  it('passes the page asked for', async () => {
    await one.GET(get(`/${ID}?limit=10&before=2026-11-11T10:00:00Z`), at(ID));
    expect(scoped.getConversation).toHaveBeenCalledWith(ID, { limit: 10, before: '2026-11-11T10:00:00Z' });
  });

  it.each([
    ['an id that is not an id', 'nope', ''],
    ['a limit of zero', ID, '?limit=0'],
    ['a limit that is too large', ID, '?limit=201'],
    ['a limit that is not a number', ID, '?limit=ten'],
    ['a date that is not a date', ID, '?before=yesterday'],
    ['a date with something after it', ID, '?before=2026-11-11T10:00:00Zjunk'],
  ])('refuses %s', async (_what, id, query) => {
    const res = await one.GET(get(`/${id}${query}`), at(id));
    expect(res.status).toBe(400);
    expect(scoped.getConversation).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('sends trimmed text', async () => {
    const res = await messages.POST(post(`/${ID}/messages`, { content: ' on it ' }), at(ID));
    expect(res.status).toBe(201);
    expect(scoped.sendConversationMessage).toHaveBeenCalledWith(ID, 'on it', undefined);
  });

  it('marks a message a person wrote, from the server\'s own knowledge of the caller', async () => {
    source = 'claude.ai';
    await messages.POST(post(`/${ID}/messages`, { content: 'hi', metadata: { source: 'slack' } }), at(ID));
    expect(scoped.sendConversationMessage).toHaveBeenCalledWith(ID, 'hi', { source: 'claude.ai' });
  });

  it.each([
    ['no content', {}],
    ['content that is not text', { content: ['hi'] }],
    ['empty content', { content: ' ' }],
    ['content that is too long', { content: 'x'.repeat(32001) }],
  ])('refuses %s', async (_what, body) => {
    const res = await messages.POST(post(`/${ID}/messages`, body), at(ID));
    expect(res.status).toBe(400);
    expect(scoped.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('refuses an id that is not an id', async () => {
    const res = await messages.POST(post('/x/messages', { content: 'hi' }), at('x'));
    expect(res.status).toBe(400);
  });
});

describe('adding a participant', () => {
  it('adds the agent named', async () => {
    const res = await participants.POST(post(`/${ID}/participants`, { agent: 'nas-c' }), at(ID));
    expect(res.status).toBe(200);
    expect(scoped.addConversationParticipant).toHaveBeenCalledWith(ID, 'nas-c');
  });

  it('answers 409 when the conversation is full', async () => {
    scoped.addConversationParticipant.mockRejectedValueOnce(new ConversationError('too_many', 'full'));
    const res = await participants.POST(post(`/${ID}/participants`, { agent: 'nas-c' }), at(ID));
    expect(res.status).toBe(409);
  });

  it.each([
    ['no agent', {}],
    ['a name that is not a name', { agent: '@Nas C' }],
    ['a list of agents', { agent: ['nas-c'] }],
  ])('refuses %s', async (_what, body) => {
    const res = await participants.POST(post(`/${ID}/participants`, body), at(ID));
    expect(res.status).toBe(400);
    expect(scoped.addConversationParticipant).not.toHaveBeenCalled();
  });

  it('answers 500, without detail, for a failure it does not recognise', async () => {
    scoped.addConversationParticipant.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const res = await participants.POST(post(`/${ID}/participants`, { agent: 'nas-c' }), at(ID));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to add participant' });
  });
});

describe('what a conversation request may carry', () => {
  it.each([
    ['an escape sequence', 'deploy\u001b]0;owned\u0007'],
    ['a line break', 'one\ntwo'],
    ['a direction override', 'plan \u202e txt.exe'],
    ['a line separator', 'one\u2028two'],
  ])('refuses a title with %s', async (_what, title) => {
    const res = await list.POST(post('', { participants: ['nas-b'], title }));
    expect(res.status).toBe(400);
    expect(scoped.createConversation).not.toHaveBeenCalled();
  });

  it('accepts an ordinary title, accents and emoji included', async () => {
    const res = await list.POST(post('', { participants: ['nas-b'], title: 'Déploiement 🚀 v2' }));
    expect(res.status).toBe(201);
  });

  it('refuses a body past the size limit without parsing it', async () => {
    const huge = JSON.stringify({ participants: ['nas-b'], padding: 'x'.repeat(600 * 1024) });
    for (const run of [
      () => list.POST(post('', huge)),
      () => messages.POST(post(`/${ID}/messages`, huge), at(ID)),
      () => participants.POST(post(`/${ID}/participants`, huge), at(ID)),
    ]) {
      expect((await run()).status).toBe(400);
    }
    expect(scoped.createConversation).not.toHaveBeenCalled();
    expect(scoped.sendConversationMessage).not.toHaveBeenCalled();
  });
});
