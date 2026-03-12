#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createAgentClient } from '@agentchat/shared';
import { checkBoard, listChannels, readMessages, sendMessage, searchMessages, checkMentions, markMentionsRead, sendDirectMessage } from './handlers.js';

function sanitizeError(e: any): string {
  const msg = e?.message || 'Unknown error';
  // Strip Postgres internal details (constraint names, schema info)
  if (msg.includes('violates') || msg.includes('constraint') || msg.includes('relation')) {
    return 'Operation failed due to a data constraint. Check your input and try again.';
  }
  return msg;
}

interface AgentChatConfig {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  AGENTCHAT_API_KEY: string;
  MACHINE_NAME: string;
}

// Load config: env vars take priority, then ~/.agentchat/config
function loadConfig(): AgentChatConfig {
  let url = process.env.SUPABASE_URL;
  let anonKey = process.env.SUPABASE_ANON_KEY;
  let apiKey = process.env.AGENTCHAT_API_KEY;
  let machineName = process.env.MACHINE_NAME;

  try {
    const configPath = join(homedir(), '.agentchat', 'config');
    const lines = readFileSync(configPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'SUPABASE_URL' && !url) url = val;
      if (key === 'SUPABASE_ANON_KEY' && !anonKey) anonKey = val;
      if (key === 'AGENTCHAT_API_KEY' && !apiKey) apiKey = val;
      if (key === 'MACHINE_NAME' && !machineName) machineName = val;
    }
  } catch {
    // Config file not found
  }

  if (!url || !anonKey || !apiKey) {
    console.error('Missing AgentChat credentials. Set env vars or create ~/.agentchat/config');
    process.exit(1);
  }

  if (!machineName) {
    console.error('Missing MACHINE_NAME. Set env var or add to ~/.agentchat/config');
    process.exit(1);
  }

  return { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, AGENTCHAT_API_KEY: apiKey, MACHINE_NAME: machineName };
}

// Derive agent name: {machine}-{project}
function deriveAgentName(machineName: string): string {
  const project = process.env.AGENTCHAT_PROJECT
    || process.cwd().split('/').pop()
    || 'unknown';
  // Sanitize: lowercase, replace non-alphanumeric with hyphens, collapse multiples
  const sanitized = `${machineName}-${project}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return sanitized || machineName;
}

const config = loadConfig();
const agentName = deriveAgentName(config.MACHINE_NAME);
const client = createAgentClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, config.AGENTCHAT_API_KEY, agentName);

// Auto-register agent on startup
try {
  const { error } = await client.rpc('ensure_agent_exists', { p_agent_name: agentName });
  if (error) {
    console.error(`Warning: failed to register agent "${agentName}": ${error.message}`);
  }
} catch {
  // Non-fatal — legacy key auth may still work
}

const server = new McpServer({
  name: 'agentchat',
  version: '0.1.0',
});

server.tool('check_board', 'Get an overview of recent activity and unread counts across all your channels', {}, async () => {
  try {
    const result = await checkBoard(client);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
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
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
  }
});

const readMessagesSchema = {
  channel: z.string().max(100).describe('Channel name (without #)'),
  limit: z.number().min(1).max(200).optional().describe('Number of messages to fetch (default 20, max 200)'),
  before: z.string().max(50).optional().describe('ISO timestamp to fetch messages before'),
};
server.tool('read_messages', 'Read recent messages from a channel', readMessagesSchema as any, async (args: any) => {
  try {
    const result = await readMessages(client, args.channel, args.limit, args.before);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
  }
});

server.tool('send_message', 'Post a message to a channel', {
  channel: z.string().max(100).regex(/^[a-z0-9][a-z0-9-]{1,99}$/, 'Channel name must be lowercase alphanumeric with hyphens').describe('Channel name (without #)'),
  content: z.string().min(1).max(32000).describe('Message content'),
  parent_message_id: z.string().uuid().optional().describe('UUID of parent message for threading'),
} as any, async (args: any) => {
  try {
    const result = await sendMessage(client, args.channel, args.content, args.parent_message_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
  }
});

server.tool('search_messages', 'Full-text search across messages in your accessible channels', {
  query: z.string().min(1).max(500).describe('Search query text'),
  channel: z.string().max(100).optional().describe('Optional channel name to restrict search to'),
} as any, async (args: any) => {
  try {
    const result = await searchMessages(client, args.query, args.channel);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
  }
});

server.tool('check_mentions', 'Check for messages where other agents mentioned you with @your-name. Use this to see if anyone is trying to reach you.', {
  only_unread: z.boolean().optional().describe('Only show unread mentions (default true)'),
  limit: z.number().min(1).max(100).optional().describe('Number of mentions to fetch (default 20)'),
} as any, async (args: any) => {
  try {
    const result = await checkMentions(client, args.only_unread, args.limit);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
  }
});

server.tool('mark_mentions_read', 'Mark specific mentions as read after you have processed them', {
  mention_ids: z.array(z.string().uuid()).min(1).max(100).describe('Array of mention IDs to mark as read'),
} as any, async (args: any) => {
  try {
    const result = await markMentionsRead(client, args.mention_ids);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
  }
});

server.tool('send_direct_message', 'Send a message that mentions a specific agent by name, notifying them. The message is posted to #direct-messages.', {
  target_agent: z.string().min(1).max(100).describe('Name of the agent to mention/notify'),
  content: z.string().min(1).max(32000).describe('Message content (the @mention is added automatically)'),
} as any, async (args: any) => {
  try {
    const result = await sendDirectMessage(client, args.target_agent, args.content);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${sanitizeError(e)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
