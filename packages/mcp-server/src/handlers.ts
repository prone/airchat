import type { AgentChatClient, ChannelMembershipWithChannel } from '@agentchat/shared';
import { DIRECT_MESSAGES_CHANNEL, fetchBoardSummary, fetchChannelMessages, markChannelRead, searchChannelMessages } from '@agentchat/shared';
import { sanitizeError, getProjectName } from './utils.js';

function getMessageMetadata(): Record<string, unknown> {
  const project = getProjectName();
  return project ? { project } : {};
}

export async function checkBoard(client: AgentChatClient) {
  try {
    const channels = await fetchBoardSummary(client);
    return { channels };
  } catch (e: any) {
    throw new Error(sanitizeError(e));
  }
}

export async function listChannels(client: AgentChatClient, type?: string) {
  const { data, error } = await client
    .from('channel_memberships')
    .select('role, channels(*)');

  if (error) throw new Error(`Failed to list channels: ${sanitizeError(error)}`);

  const channels = (data as ChannelMembershipWithChannel[]).map((m) => ({
    ...m.channels,
    role: m.role,
  }));

  if (type) {
    return { channels: channels.filter((c) => c.type === type) };
  }
  return { channels };
}

export async function readMessages(
  client: AgentChatClient,
  channelName: string,
  limit: number = 20,
  before?: string
) {
  const { channelId, messages } = await fetchChannelMessages(client, channelName, limit, before);

  // Auto-join channel for unread tracking, then update last_read_at
  await markChannelRead(client, channelId);

  return {
    channel: channelName,
    messages,
  };
}

export async function sendMessage(
  client: AgentChatClient,
  channelName: string,
  content: string,
  parentMessageId?: string
) {
  const metadata = getMessageMetadata();

  const { data, error } = await client.rpc('send_message_with_auto_join', {
    channel_name: channelName,
    content,
    parent_message_id: parentMessageId || null,
    message_metadata: metadata,
  });

  if (error) throw new Error(`Failed to send message: ${sanitizeError(error)}`);

  const message = Array.isArray(data) ? data[0] : data;
  return { message, channel: channelName };
}

export async function searchMessages(
  client: AgentChatClient,
  queryText: string,
  channelName?: string
) {
  const results = await searchChannelMessages(client, queryText, channelName);
  return { query: queryText, results };
}

export async function checkMentions(
  client: AgentChatClient,
  onlyUnread: boolean = true,
  limit: number = 20
) {
  const { data, error } = await client.rpc('check_mentions', {
    only_unread: onlyUnread,
    mention_limit: Math.min(limit, 100),
  });

  if (error) throw new Error(`Failed to check mentions: ${sanitizeError(error)}`);

  interface MentionResult {
    mention_id: string;
    message_id: string;
    channel_name: string;
    author_name: string;
    author_project: string | null;
    content: string;
    created_at: string;
    is_read: boolean;
  }

  return {
    mentions: (data as MentionResult[]).map((m) => ({
      mention_id: m.mention_id,
      message_id: m.message_id,
      channel: m.channel_name,
      from: m.author_name,
      from_project: m.author_project,
      content: m.content,
      timestamp: m.created_at,
      read: m.is_read,
    })),
  };
}

export async function markMentionsRead(
  client: AgentChatClient,
  mentionIds: string[]
) {
  const { error } = await client.rpc('mark_mentions_read', {
    mention_ids: mentionIds,
  });

  if (error) throw new Error(`Failed to mark mentions read: ${sanitizeError(error)}`);

  return { marked_read: mentionIds.length };
}

export async function sendDirectMessage(
  client: AgentChatClient,
  targetAgentName: string,
  content: string
) {
  const metadata = getMessageMetadata();
  // Prepend @mention so the trigger picks it up
  const fullContent = `@${targetAgentName} ${content}`;

  // Use global channel for direct messages
  const { data, error } = await client.rpc('send_message_with_auto_join', {
    channel_name: DIRECT_MESSAGES_CHANNEL,
    content: fullContent,
    parent_message_id: null,
    message_metadata: metadata,
  });

  if (error) throw new Error(`Failed to send direct message: ${sanitizeError(error)}`);

  const message = Array.isArray(data) ? data[0] : data;
  return { message, target: targetAgentName, channel: DIRECT_MESSAGES_CHANNEL };
}

// File operations go through the web API (/api/files) which has the service role key.
// This keeps the service role key off agent machines.

export interface FileApiConfig {
  webUrl: string;
  apiKey: string;
  agentName: string;
}

let _fileApiConfig: FileApiConfig | null = null;

export function setFileApiConfig(config: FileApiConfig): void {
  _fileApiConfig = config;
}

function getFileApiBase(): string {
  if (!_fileApiConfig?.webUrl) {
    throw new Error('AGENTCHAT_WEB_URL is not configured. Set it in ~/.agentchat/config or as an environment variable.');
  }
  return _fileApiConfig.webUrl;
}

function getAgentHeaders(): Record<string, string> {
  if (!_fileApiConfig?.apiKey) {
    throw new Error('AGENTCHAT_API_KEY is not configured.');
  }
  const headers: Record<string, string> = { 'x-agent-api-key': _fileApiConfig.apiKey };
  if (_fileApiConfig.agentName) headers['x-agent-name'] = _fileApiConfig.agentName;
  return headers;
}

export async function getFileUrl(
  _client: AgentChatClient,
  filePath: string
) {
  const base = getFileApiBase();
  const res = await fetch(`${base}/api/files?path=${encodeURIComponent(filePath)}&url=true`, {
    headers: getAgentHeaders(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Failed to get file URL: ${err.error}`);
  }

  const data = await res.json();
  return {
    path: filePath,
    signed_url: data.signed_url,
    expires_in: '1 hour',
  };
}

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'py', 'sh', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'log', 'env', 'sql']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

export async function downloadFile(
  _client: AgentChatClient,
  filePath: string
) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  // For unknown/binary extensions, skip download and return signed URL directly
  if (!TEXT_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(ext)) {
    return getFileUrl(_client, filePath);
  }

  const base = getFileApiBase();
  const res = await fetch(`${base}/api/files?path=${encodeURIComponent(filePath)}`, {
    headers: getAgentHeaders(),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Failed to download file: ${err.error}`);
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());

  if (contentType.startsWith('text/') || contentType === 'application/json') {
    return {
      path: filePath,
      type: contentType,
      size: buffer.length,
      content: buffer.toString('utf-8'),
    };
  }

  if (contentType.startsWith('image/')) {
    return {
      path: filePath,
      type: contentType,
      size: buffer.length,
      content_base64: buffer.toString('base64'),
    };
  }

  // Unexpected content-type for a known extension — fall back to signed URL
  return getFileUrl(_client, filePath);
}
