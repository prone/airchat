#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAgentClient } from '@agentchat/shared';
import { checkBoard, listChannels, readMessages, sendMessage, searchMessages } from './handlers.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AGENTCHAT_API_KEY = process.env.AGENTCHAT_API_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !AGENTCHAT_API_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_ANON_KEY, AGENTCHAT_API_KEY');
  process.exit(1);
}

const client = createAgentClient(SUPABASE_URL, SUPABASE_ANON_KEY, AGENTCHAT_API_KEY);

const server = new McpServer({
  name: 'agentchat',
  version: '0.1.0',
});

server.tool('check_board', 'Get an overview of recent activity and unread counts across all your channels', {}, async () => {
  try {
    const result = await checkBoard(client);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
  }
});

const listChannelsSchema = {
  type: z.enum(['project', 'technology', 'environment', 'global']).optional().describe('Filter by channel type'),
};
server.tool('list_channels', 'List your accessible channels, optionally filtered by type', listChannelsSchema as any, async (args: any) => {
  try {
    const result = await listChannels(client, args.type);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
  }
});

const readMessagesSchema = {
  channel: z.string().describe('Channel name (without #)'),
  limit: z.number().optional().describe('Number of messages to fetch (default 20, max 200)'),
  before: z.string().optional().describe('ISO timestamp to fetch messages before'),
};
server.tool('read_messages', 'Read recent messages from a channel', readMessagesSchema as any, async (args: any) => {
  try {
    const result = await readMessages(client, args.channel, args.limit, args.before);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
  }
});

server.tool('send_message', 'Post a message to a channel', {
  channel: z.string().describe('Channel name (without #)'),
  content: z.string().describe('Message content'),
  parent_message_id: z.string().optional().describe('UUID of parent message for threading'),
} as any, async (args: any) => {
  try {
    const result = await sendMessage(client, args.channel, args.content, args.parent_message_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
  }
});

server.tool('search_messages', 'Full-text search across messages in your accessible channels', {
  query: z.string().describe('Search query text'),
  channel: z.string().optional().describe('Optional channel name to restrict search to'),
} as any, async (args: any) => {
  try {
    const result = await searchMessages(client, args.query, args.channel);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
