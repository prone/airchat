import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AirChatRestClient } from '@airchat/shared';
import {
  readMessages,
  sendMessage,
  sendDirectMessage,
  searchMessages,
  checkMentions,
  markMentionsRead,
  checkBoard,
  listChannels,
  getFileUrl,
  downloadFile,
  uploadFile,
} from '../handlers.js';

/**
 * Create a mock AirChatRestClient with all methods stubbed.
 * Override specific method return values via the `overrides` parameter.
 */
function createMockClient(overrides: Partial<Record<keyof AirChatRestClient, any>> = {}): AirChatRestClient {
  const mock = {
    getAgentName: vi.fn().mockReturnValue('test-agent'),
    checkBoard: vi.fn().mockResolvedValue({ channels: [] }),
    listChannels: vi.fn().mockResolvedValue({ channels: [] }),
    readMessages: vi.fn().mockResolvedValue({ channel: 'general', messages: [] }),
    sendMessage: vi.fn().mockResolvedValue({ message: { id: 'msg-1' }, channel: 'general' }),
    searchMessages: vi.fn().mockResolvedValue({ query: '', results: [] }),
    checkMentions: vi.fn().mockResolvedValue({ mentions: [] }),
    markMentionsRead: vi.fn().mockResolvedValue({ marked_read: 0 }),
    sendDirectMessage: vi.fn().mockResolvedValue({ message: { id: 'msg-1' }, target: '', channel: 'direct-messages' }),
    getFileUrl: vi.fn().mockResolvedValue({ path: '', signed_url: '', expires_in: '1 hour' }),
    downloadFile: vi.fn().mockResolvedValue({ path: '', type: 'text/plain', size: 0, content: '' }),
    uploadFile: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as AirChatRestClient;
  return mock;
}

describe('checkBoard', () => {
  it('delegates to restClient.checkBoard()', async () => {
    const boardData = { channels: [{ name: 'general', unread: 3 }] };
    const client = createMockClient({ checkBoard: vi.fn().mockResolvedValue(boardData) });

    const result = await checkBoard(client);
    expect(result).toEqual(boardData);
    expect(client.checkBoard).toHaveBeenCalled();
  });
});

describe('listChannels', () => {
  it('passes type filter to restClient', async () => {
    const channelData = { channels: [{ name: 'project-test', type: 'project' }] };
    const client = createMockClient({ listChannels: vi.fn().mockResolvedValue(channelData) });

    const result = await listChannels(client, 'project');
    expect(result).toEqual(channelData);
    expect(client.listChannels).toHaveBeenCalledWith('project');
  });

  it('calls without type when not provided', async () => {
    const client = createMockClient();
    await listChannels(client);
    expect(client.listChannels).toHaveBeenCalledWith(undefined);
  });
});

describe('readMessages', () => {
  it('delegates to restClient.readMessages()', async () => {
    const messagesData = {
      channel: 'general',
      messages: [
        { id: 'msg-1', content: 'First', author: 'agent-one', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'msg-2', content: 'Second', author: 'agent-two', timestamp: '2024-01-02T00:00:00Z' },
      ],
    };
    const client = createMockClient({ readMessages: vi.fn().mockResolvedValue(messagesData) });

    const result = await readMessages(client, 'general', 20) as any;

    expect(result.channel).toBe('general');
    expect(result.messages).toHaveLength(2);
    expect(client.readMessages).toHaveBeenCalledWith('general', 20, undefined);
  });

  it('passes before parameter for pagination', async () => {
    const client = createMockClient();
    await readMessages(client, 'general', 20, '2024-01-01T00:00:00Z');
    expect(client.readMessages).toHaveBeenCalledWith('general', 20, '2024-01-01T00:00:00Z');
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

  it('calls restClient.sendMessage with metadata', async () => {
    const messageData = { message: { id: 'msg-1', content: 'hello' }, channel: 'general' };
    const client = createMockClient({ sendMessage: vi.fn().mockResolvedValue(messageData) });

    process.env.AIRCHAT_PROJECT = 'test-project';
    const result = await sendMessage(client, 'general', 'hello') as any;

    expect(client.sendMessage).toHaveBeenCalledWith('general', 'hello', undefined, { project: 'test-project' });
    expect(result.channel).toBe('general');
    expect(result.message).toEqual({ id: 'msg-1', content: 'hello' });
  });

  it('passes parent_message_id when provided', async () => {
    const client = createMockClient();
    process.env.AIRCHAT_PROJECT = 'test';
    await sendMessage(client, 'general', 'reply', 'parent-uuid');

    expect(client.sendMessage).toHaveBeenCalledWith('general', 'reply', 'parent-uuid', { project: 'test' });
  });

  it('propagates errors from restClient', async () => {
    const client = createMockClient({
      sendMessage: vi.fn().mockRejectedValue(new Error('AirChat API POST /api/v2/messages failed: HTTP 500')),
    });

    await expect(sendMessage(client, 'general', 'hello')).rejects.toThrow();
  });
});

describe('sendDirectMessage', () => {
  it('delegates to restClient.sendDirectMessage()', async () => {
    const dmData = { message: { id: 'msg-1' }, target: 'target-agent', channel: 'direct-messages' };
    const client = createMockClient({ sendDirectMessage: vi.fn().mockResolvedValue(dmData) });

    const result = await sendDirectMessage(client, 'target-agent', 'hello there') as any;

    expect(client.sendDirectMessage).toHaveBeenCalledWith('target-agent', 'hello there');
    expect(result.channel).toBe('direct-messages');
    expect(result.target).toBe('target-agent');
  });
});

describe('searchMessages', () => {
  it('delegates to restClient.searchMessages()', async () => {
    const searchData = {
      query: 'test query',
      results: [{ id: 'msg-1', channel: 'general', author: 'agent-x', content: 'hello world', timestamp: '2024-01-01' }],
    };
    const client = createMockClient({ searchMessages: vi.fn().mockResolvedValue(searchData) });

    const result = await searchMessages(client, 'test query', 'general') as any;

    expect(client.searchMessages).toHaveBeenCalledWith('test query', 'general');
    expect(result.query).toBe('test query');
    expect(result.results).toHaveLength(1);
  });

  it('calls without channel filter when not provided', async () => {
    const client = createMockClient();
    await searchMessages(client, 'hello');
    expect(client.searchMessages).toHaveBeenCalledWith('hello', undefined);
  });
});

describe('checkMentions', () => {
  it('delegates to restClient.checkMentions()', async () => {
    const mentionsData = {
      mentions: [{
        mention_id: 'm-1',
        message_id: 'msg-1',
        channel: 'general',
        from: 'bot-a',
        from_project: 'proj',
        content: 'hey @you',
        timestamp: '2024-01-01T00:00:00Z',
        read: false,
      }],
    };
    const client = createMockClient({ checkMentions: vi.fn().mockResolvedValue(mentionsData) });

    const result = await checkMentions(client, true, 10) as any;

    expect(client.checkMentions).toHaveBeenCalledWith(true, 10);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].from).toBe('bot-a');
  });

  it('passes undefined for default parameters', async () => {
    const client = createMockClient();
    await checkMentions(client);
    expect(client.checkMentions).toHaveBeenCalledWith(undefined, undefined);
  });
});

describe('markMentionsRead', () => {
  it('delegates to restClient.markMentionsRead()', async () => {
    const client = createMockClient({ markMentionsRead: vi.fn().mockResolvedValue({ marked_read: 3 }) });

    const ids = ['m-1', 'm-2', 'm-3'];
    const result = await markMentionsRead(client, ids) as any;

    expect(client.markMentionsRead).toHaveBeenCalledWith(ids);
    expect(result.marked_read).toBe(3);
  });

  it('propagates errors from restClient', async () => {
    const client = createMockClient({
      markMentionsRead: vi.fn().mockRejectedValue(new Error('AirChat API failed')),
    });

    await expect(markMentionsRead(client, ['m-1'])).rejects.toThrow('AirChat API failed');
  });
});

describe('getFileUrl', () => {
  it('delegates to restClient.getFileUrl()', async () => {
    const fileData = { path: 'general/file.png', signed_url: 'https://storage.example.com/signed/file.png', expires_in: '1 hour' };
    const client = createMockClient({ getFileUrl: vi.fn().mockResolvedValue(fileData) });

    const result = await getFileUrl(client, 'general/file.png') as any;

    expect(client.getFileUrl).toHaveBeenCalledWith('general/file.png');
    expect(result.path).toBe('general/file.png');
    expect(result.signed_url).toBe('https://storage.example.com/signed/file.png');
  });
});

describe('downloadFile', () => {
  it('delegates to restClient.downloadFile()', async () => {
    const fileData = { path: 'general/readme.txt', type: 'text/plain', size: 13, content: 'Hello, world!' };
    const client = createMockClient({ downloadFile: vi.fn().mockResolvedValue(fileData) });

    const result = await downloadFile(client, 'general/readme.txt') as any;

    expect(client.downloadFile).toHaveBeenCalledWith('general/readme.txt');
    expect(result.path).toBe('general/readme.txt');
    expect(result.content).toBe('Hello, world!');
  });
});

describe('uploadFile', () => {
  it('delegates to restClient.uploadFile() with all parameters', async () => {
    const client = createMockClient({ uploadFile: vi.fn().mockResolvedValue({ success: true, path: 'general/file.txt' }) });

    const result = await uploadFile(client, 'file.txt', 'content', 'general', 'text/plain', 'utf-8', true) as any;

    expect(client.uploadFile).toHaveBeenCalledWith('file.txt', 'content', 'general', 'text/plain', 'utf-8', true);
    expect(result.success).toBe(true);
  });

  it('passes optional parameters as undefined when not provided', async () => {
    const client = createMockClient();
    await uploadFile(client, 'file.bin', 'base64data', 'general');

    expect(client.uploadFile).toHaveBeenCalledWith('file.bin', 'base64data', 'general', undefined, undefined, undefined);
  });
});
