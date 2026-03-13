import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentChatClient } from '@agentchat/shared';
import {
  readMessages,
  sendMessage,
  sendDirectMessage,
  searchMessages,
  checkMentions,
  markMentionsRead,
  getFileUrl,
  downloadFile,
  setFileApiConfig,
} from '../handlers.js';

function createMockQuery(overrides: any = {}) {
  const mockQuery: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: undefined, // prevent auto-thenable detection
    ...overrides,
  };
  // Make the query itself awaitable by default (for chained queries that are awaited directly)
  // We do this by making it thenable when needed
  return mockQuery;
}

function createMockClient(overrides: any = {}) {
  const mockQuery = createMockQuery(overrides.query);

  const client: any = {
    from: vi.fn(() => mockQuery),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    _mockQuery: mockQuery,
    ...overrides.client,
  };

  return client as AgentChatClient & { _mockQuery: any };
}

// Helper to make a mock query resolve when awaited
function makeQueryResolve(mockQuery: any, data: any, error: any = null) {
  // When a Supabase query chain is awaited, it calls .then()
  // We simulate this by making the last chained method resolve
  const lastMethod = mockQuery.limit || mockQuery.order || mockQuery.single;
  // Override the mockQuery to be thenable
  mockQuery.then = (resolve: any, reject: any) => {
    return Promise.resolve({ data, error }).then(resolve, reject);
  };
}

describe('readMessages', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when channel is not found', async () => {
    const client = createMockClient({
      query: {
        single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
      },
    });

    await expect(readMessages(client, 'nonexistent')).rejects.toThrow('Channel #nonexistent not found');
  });

  it('fetches and formats messages in reversed order', async () => {
    const channelId = 'ch-123';
    const messages = [
      {
        id: 'msg-2',
        content: 'Second',
        created_at: '2024-01-02T00:00:00Z',
        agents: { id: 'a1', name: 'agent-one' },
        metadata: null,
        parent_message_id: null,
        pinned: false,
      },
      {
        id: 'msg-1',
        content: 'First',
        created_at: '2024-01-01T00:00:00Z',
        agents: { id: 'a2', name: 'agent-two' },
        metadata: null,
        parent_message_id: null,
        pinned: false,
      },
    ];

    // We need two different from() calls: first for channel lookup, then for messages
    let fromCallCount = 0;
    const channelQuery = createMockQuery({
      single: vi.fn().mockResolvedValue({ data: { id: channelId }, error: null }),
    });
    const messagesQuery = createMockQuery();
    makeQueryResolve(messagesQuery, messages);

    const client: any = {
      from: vi.fn(() => {
        fromCallCount++;
        if (fromCallCount === 1) return channelQuery;
        return messagesQuery;
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const result = await readMessages(client, 'general');

    expect(result.channel).toBe('general');
    expect(result.messages).toHaveLength(2);
    // Messages should be reversed (oldest first)
    expect(result.messages[0].id).toBe('msg-1');
    expect(result.messages[1].id).toBe('msg-2');
    expect(result.messages[0].author).toBe('agent-two');
    expect(result.messages[1].author).toBe('agent-one');
  });

  it('includes files array when present in metadata', async () => {
    const channelId = 'ch-123';
    const messages = [
      {
        id: 'msg-1',
        content: 'Check this file',
        created_at: '2024-01-01T00:00:00Z',
        agents: { id: 'a1', name: 'agent-one' },
        metadata: { files: [{ name: 'test.png', path: 'general/test.png' }] },
        parent_message_id: null,
        pinned: false,
      },
    ];

    let fromCallCount = 0;
    const channelQuery = createMockQuery({
      single: vi.fn().mockResolvedValue({ data: { id: channelId }, error: null }),
    });
    const messagesQuery = createMockQuery();
    makeQueryResolve(messagesQuery, messages);

    const client: any = {
      from: vi.fn(() => {
        fromCallCount++;
        if (fromCallCount === 1) return channelQuery;
        return messagesQuery;
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const result = await readMessages(client, 'general');
    expect(result.messages[0].files).toEqual([{ name: 'test.png', path: 'general/test.png' }]);
  });

  it('applies before pagination filter', async () => {
    const channelId = 'ch-123';

    let fromCallCount = 0;
    const channelQuery = createMockQuery({
      single: vi.fn().mockResolvedValue({ data: { id: channelId }, error: null }),
    });
    const messagesQuery = createMockQuery();
    makeQueryResolve(messagesQuery, []);

    const client: any = {
      from: vi.fn(() => {
        fromCallCount++;
        if (fromCallCount === 1) return channelQuery;
        return messagesQuery;
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    await readMessages(client, 'general', 20, '2024-01-01T00:00:00Z');
    expect(messagesQuery.lt).toHaveBeenCalledWith('created_at', '2024-01-01T00:00:00Z');
  });

  it('caps limit at 200', async () => {
    const channelId = 'ch-123';

    let fromCallCount = 0;
    const channelQuery = createMockQuery({
      single: vi.fn().mockResolvedValue({ data: { id: channelId }, error: null }),
    });
    const messagesQuery = createMockQuery();
    makeQueryResolve(messagesQuery, []);

    const client: any = {
      from: vi.fn(() => {
        fromCallCount++;
        if (fromCallCount === 1) return channelQuery;
        return messagesQuery;
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    await readMessages(client, 'general', 500);
    expect(messagesQuery.limit).toHaveBeenCalledWith(200);
  });
});

describe('sendMessage', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('calls RPC with correct arguments', async () => {
    const messageData = { id: 'msg-1', content: 'hello' };
    const client = createMockClient({
      client: {
        rpc: vi.fn().mockResolvedValue({ data: messageData, error: null }),
      },
    });

    process.env.AGENTCHAT_PROJECT = 'test-project';
    const result = await sendMessage(client, 'general', 'hello');

    expect(client.rpc).toHaveBeenCalledWith('send_message_with_auto_join', {
      channel_name: 'general',
      content: 'hello',
      parent_message_id: null,
      message_metadata: { project: 'test-project' },
    });
    expect(result.channel).toBe('general');
    expect(result.message).toEqual(messageData);
  });

  it('passes parent_message_id when provided', async () => {
    const client = createMockClient({
      client: {
        rpc: vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null }),
      },
    });

    process.env.AGENTCHAT_PROJECT = 'test';
    await sendMessage(client, 'general', 'reply', 'parent-uuid');

    expect(client.rpc).toHaveBeenCalledWith('send_message_with_auto_join', expect.objectContaining({
      parent_message_id: 'parent-uuid',
    }));
  });

  it('includes project context from env var', async () => {
    const client = createMockClient({
      client: {
        rpc: vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null }),
      },
    });

    process.env.AGENTCHAT_PROJECT = 'my-cool-project';
    await sendMessage(client, 'general', 'test');

    expect(client.rpc).toHaveBeenCalledWith('send_message_with_auto_join', expect.objectContaining({
      message_metadata: { project: 'my-cool-project' },
    }));
  });

  it('throws on RPC error', async () => {
    const client = createMockClient({
      client: {
        rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'RPC failed' } }),
      },
    });

    await expect(sendMessage(client, 'general', 'hello')).rejects.toThrow('Failed to send message: RPC failed');
  });
});

describe('sendDirectMessage', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('prepends @mention to content', async () => {
    const client = createMockClient({
      client: {
        rpc: vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null }),
      },
    });

    process.env.AGENTCHAT_PROJECT = 'test';
    await sendDirectMessage(client, 'target-agent', 'hello there');

    expect(client.rpc).toHaveBeenCalledWith('send_message_with_auto_join', expect.objectContaining({
      content: '@target-agent hello there',
    }));
  });

  it('always uses direct-messages channel', async () => {
    const client = createMockClient({
      client: {
        rpc: vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null }),
      },
    });

    process.env.AGENTCHAT_PROJECT = 'test';
    const result = await sendDirectMessage(client, 'target-agent', 'hello');

    expect(client.rpc).toHaveBeenCalledWith('send_message_with_auto_join', expect.objectContaining({
      channel_name: 'direct-messages',
    }));
    expect(result.channel).toBe('direct-messages');
    expect(result.target).toBe('target-agent');
  });
});

describe('searchMessages', () => {
  it('resolves channel filter when channel name provided', async () => {
    const channelQuery = createMockQuery({
      single: vi.fn().mockResolvedValue({ data: { id: 'ch-456' }, error: null }),
    });

    const rpcMock = vi.fn().mockResolvedValue({
      data: [
        { id: 'msg-1', channel_name: 'general', author_name: 'bot', content: 'found it', created_at: '2024-01-01' },
      ],
      error: null,
    });

    const client: any = {
      from: vi.fn(() => channelQuery),
      rpc: rpcMock,
    };

    const result = await searchMessages(client, 'test query', 'general');

    expect(rpcMock).toHaveBeenCalledWith('search_messages', {
      query_text: 'test query',
      channel_filter: 'ch-456',
    });
    expect(result.query).toBe('test query');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].channel).toBe('general');
  });

  it('maps results correctly', async () => {
    const rpcMock = vi.fn().mockResolvedValue({
      data: [
        { id: 'msg-1', channel_name: 'tech', author_name: 'agent-x', content: 'hello world', created_at: '2024-01-01T00:00:00Z' },
        { id: 'msg-2', channel_name: 'general', author_name: 'agent-y', content: 'goodbye world', created_at: '2024-01-02T00:00:00Z' },
      ],
      error: null,
    });

    const client: any = {
      from: vi.fn(),
      rpc: rpcMock,
    };

    const result = await searchMessages(client, 'world');

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      channel: 'tech',
      author: 'agent-x',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:00Z',
      id: 'msg-1',
    });
  });

  it('throws on RPC error', async () => {
    const client: any = {
      from: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'search failed' } }),
    };

    await expect(searchMessages(client, 'query')).rejects.toThrow('Search failed: search failed');
  });
});

describe('checkMentions', () => {
  it('defaults to only_unread=true', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
    const client: any = { rpc: rpcMock };

    await checkMentions(client);

    expect(rpcMock).toHaveBeenCalledWith('check_mentions', {
      only_unread: true,
      mention_limit: 20,
    });
  });

  it('caps limit at 100', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
    const client: any = { rpc: rpcMock };

    await checkMentions(client, true, 500);

    expect(rpcMock).toHaveBeenCalledWith('check_mentions', {
      only_unread: true,
      mention_limit: 100,
    });
  });

  it('maps mention data correctly', async () => {
    const rpcMock = vi.fn().mockResolvedValue({
      data: [{
        mention_id: 'm-1',
        message_id: 'msg-1',
        channel_name: 'general',
        author_name: 'bot-a',
        author_project: 'proj',
        content: 'hey @you',
        created_at: '2024-01-01T00:00:00Z',
        is_read: false,
      }],
      error: null,
    });
    const client: any = { rpc: rpcMock };

    const result = await checkMentions(client, false, 10);

    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]).toEqual({
      mention_id: 'm-1',
      message_id: 'msg-1',
      channel: 'general',
      from: 'bot-a',
      from_project: 'proj',
      content: 'hey @you',
      timestamp: '2024-01-01T00:00:00Z',
      read: false,
    });
  });
});

describe('markMentionsRead', () => {
  it('calls RPC with mention IDs and returns count', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const client: any = { rpc: rpcMock };

    const ids = ['m-1', 'm-2', 'm-3'];
    const result = await markMentionsRead(client, ids);

    expect(rpcMock).toHaveBeenCalledWith('mark_mentions_read', { mention_ids: ids });
    expect(result.marked_read).toBe(3);
  });

  it('throws on RPC error', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: { message: 'failed' } });
    const client: any = { rpc: rpcMock };

    await expect(markMentionsRead(client, ['m-1'])).rejects.toThrow('Failed to mark mentions read: failed');
  });
});

describe('getFileUrl', () => {
  beforeEach(() => {
    setFileApiConfig({ webUrl: 'http://test-server:3000', apiKey: 'test-key', agentName: 'test-agent' });
  });

  afterEach(() => {
    setFileApiConfig({ webUrl: '', apiKey: '', agentName: '' });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('constructs URL and returns signed URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ signed_url: 'https://storage.example.com/signed/file.png' }),
    }));

    const client: any = {};
    const result = await getFileUrl(client, 'general/file.png');

    expect(fetch).toHaveBeenCalledWith(
      'http://test-server:3000/api/files?path=general%2Ffile.png&url=true',
      expect.objectContaining({
        headers: {
          'x-agent-api-key': 'test-key',
          'x-agent-name': 'test-agent',
        },
      }),
    );
    expect(result.path).toBe('general/file.png');
    expect(result.signed_url).toBe('https://storage.example.com/signed/file.png');
    expect(result.expires_in).toBe('1 hour');
  });

  it('throws on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      json: () => Promise.resolve({ error: 'File not found' }),
    }));

    const client: any = {};
    await expect(getFileUrl(client, 'missing/file.png')).rejects.toThrow('Failed to get file URL: File not found');
  });
});

describe('downloadFile', () => {
  beforeEach(() => {
    setFileApiConfig({ webUrl: 'http://test-server:3000', apiKey: 'test-key', agentName: 'test-agent' });
  });

  afterEach(() => {
    setFileApiConfig({ webUrl: '', apiKey: '', agentName: '' });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns text content for text files', async () => {
    const textContent = 'Hello, world!';
    const encoder = new TextEncoder();
    const ab = encoder.encode(textContent).buffer;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => name === 'content-type' ? 'text/plain' : null },
      arrayBuffer: () => Promise.resolve(ab),
    }));

    const client: any = {};
    const result = await downloadFile(client, 'general/readme.txt');

    expect(result.path).toBe('general/readme.txt');
    expect(result.type).toBe('text/plain');
    expect(result.content).toBe(textContent);
    expect(result.size).toBe(textContent.length);
  });

  it('returns base64 content for image files', async () => {
    const ab = new ArrayBuffer(4);
    const view = new Uint8Array(ab);
    view.set([0x89, 0x50, 0x4e, 0x47]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => name === 'content-type' ? 'image/png' : null },
      arrayBuffer: () => Promise.resolve(ab),
    }));

    const client: any = {};
    const result = await downloadFile(client, 'general/screenshot.png');

    expect(result.path).toBe('general/screenshot.png');
    expect(result.type).toBe('image/png');
    expect(result.content_base64).toBe(Buffer.from(view).toString('base64'));
  });

  it('returns signed URL for binary files via getFileUrl', async () => {
    // Binary extensions skip the download entirely and go straight to getFileUrl
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ signed_url: 'https://storage.example.com/signed/data.bin' }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const client: any = {};
    const result = await downloadFile(client, 'general/data.bin');

    // Only one fetch call (getFileUrl), no download attempt
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('url=true'),
      expect.anything(),
    );
    expect(result.path).toBe('general/data.bin');
    expect((result as any).signed_url).toBe('https://storage.example.com/signed/data.bin');
    expect((result as any).expires_in).toBe('1 hour');
  });

  it('throws on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Forbidden',
      json: () => Promise.resolve({ error: 'Access denied' }),
    }));

    const client: any = {};
    await expect(downloadFile(client, 'general/secret.txt')).rejects.toThrow('Failed to download file: Access denied');
  });
});
