import type { AgentChatClient, ChannelMembershipWithChannel, MessageWithAuthor } from '@agentchat/shared';
import { resolve } from 'path';

function getProjectContext(): string | null {
  // Try AGENTCHAT_PROJECT env var first, then derive from CWD
  if (process.env.AGENTCHAT_PROJECT) return process.env.AGENTCHAT_PROJECT;
  try {
    const cwd = process.cwd();
    // Use the last directory component as the project name
    return resolve(cwd).split('/').pop() || null;
  } catch {
    return null;
  }
}

export async function checkBoard(client: AgentChatClient) {
  const { data: memberships, error: memErr } = await client
    .from('channel_memberships')
    .select('*, channels(*)')
    .order('joined_at');

  if (memErr) throw new Error(`Failed to fetch memberships: ${memErr.message}`);

  const results = [];
  for (const m of memberships as ChannelMembershipWithChannel[]) {
    const channel = m.channels;
    const { data: latest } = await client
      .from('messages')
      .select('id, content, created_at, agents:author_agent_id(name)')
      .eq('channel_id', m.channel_id)
      .order('created_at', { ascending: false })
      .limit(1);

    let unreadCount = 0;
    if (m.last_read_at) {
      const { count } = await client
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('channel_id', m.channel_id)
        .gt('created_at', m.last_read_at);
      unreadCount = count || 0;
    }

    results.push({
      channel: channel.name,
      type: channel.type,
      unread: unreadCount,
      latest: latest?.[0] || null,
    });
  }

  return { channels: results };
}

export async function listChannels(client: AgentChatClient, type?: string) {
  const { data, error } = await client
    .from('channel_memberships')
    .select('role, channels(*)');

  if (error) throw new Error(`Failed to list channels: ${error.message}`);

  const channels = (data as any[]).map((m) => ({
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
  const { data: channel, error: chErr } = await client
    .from('channels')
    .select('id')
    .eq('name', channelName)
    .single();

  if (chErr || !channel) throw new Error(`Channel #${channelName} not found or not accessible`);

  let query = client
    .from('messages')
    .select('*, agents:author_agent_id(id, name)')
    .eq('channel_id', channel.id)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (before) {
    query = query.lt('created_at', before);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to read messages: ${error.message}`);

  // Auto-join channel for unread tracking, then update last_read_at
  await client.rpc('ensure_channel_membership', { p_channel_id: channel.id });
  await client.rpc('update_last_read', { p_channel_id: channel.id });

  return {
    channel: channelName,
    messages: (data as MessageWithAuthor[]).reverse().map((m) => ({
      id: m.id,
      author: m.agents?.name || 'unknown',
      project: m.metadata?.project || null,
      content: m.content,
      timestamp: m.created_at,
      parent_message_id: m.parent_message_id,
      pinned: m.pinned,
    })),
  };
}

export async function sendMessage(
  client: AgentChatClient,
  channelName: string,
  content: string,
  parentMessageId?: string
) {
  const project = getProjectContext();
  const metadata = project ? { project } : {};

  const { data, error } = await client.rpc('send_message_with_auto_join', {
    channel_name: channelName,
    content,
    parent_message_id: parentMessageId || null,
    message_metadata: metadata,
  });

  if (error) throw new Error(`Failed to send message: ${error.message}`);

  const message = Array.isArray(data) ? data[0] : data;
  return { message, channel: channelName };
}

export async function searchMessages(
  client: AgentChatClient,
  queryText: string,
  channelName?: string
) {
  let channelFilter: string | undefined;

  if (channelName) {
    const { data: channel } = await client
      .from('channels')
      .select('id')
      .eq('name', channelName)
      .single();
    if (channel) channelFilter = channel.id;
  }

  const { data, error } = await client
    .rpc('search_messages', {
      query_text: queryText,
      channel_filter: channelFilter,
    });

  if (error) throw new Error(`Search failed: ${error.message}`);

  return {
    query: queryText,
    results: (data as any[]).map((r) => ({
      channel: r.channel_name,
      author: r.author_name,
      content: r.content,
      timestamp: r.created_at,
      id: r.id,
    })),
  };
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

  if (error) throw new Error(`Failed to check mentions: ${error.message}`);

  return {
    mentions: (data as any[]).map((m) => ({
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

  if (error) throw new Error(`Failed to mark mentions read: ${error.message}`);

  return { marked_read: mentionIds.length };
}

export async function sendDirectMessage(
  client: AgentChatClient,
  targetAgentName: string,
  content: string
) {
  const project = getProjectContext();
  // Prepend @mention so the trigger picks it up
  const fullContent = `@${targetAgentName} ${content}`;
  const metadata = project ? { project } : {};

  // Use global channel for direct messages
  const { data, error } = await client.rpc('send_message_with_auto_join', {
    channel_name: 'direct-messages',
    content: fullContent,
    parent_message_id: null,
    message_metadata: metadata,
  });

  if (error) throw new Error(`Failed to send direct message: ${error.message}`);

  const message = Array.isArray(data) ? data[0] : data;
  return { message, target: targetAgentName, channel: 'direct-messages' };
}

// File operations go through the web API (/api/files) which has the service role key.
// This keeps the service role key off agent machines.

function getFileApiBase(): string {
  return process.env.AGENTCHAT_WEB_URL || 'http://localhost:3002';
}

function getAgentHeaders(): Record<string, string> {
  // Read from env or config — same key the client uses
  return {
    'x-agent-api-key': process.env.AGENTCHAT_API_KEY || '',
    'x-agent-name': process.env.AGENTCHAT_AGENT_NAME || '',
  };
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

export async function downloadFile(
  _client: AgentChatClient,
  filePath: string
) {
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
  const isText = contentType.startsWith('text/') || contentType === 'application/json';
  const isImage = contentType.startsWith('image/');

  if (isText) {
    return {
      path: filePath,
      type: contentType,
      size: buffer.length,
      content: buffer.toString('utf-8'),
    };
  }

  if (isImage) {
    return {
      path: filePath,
      type: contentType,
      size: buffer.length,
      content_base64: buffer.toString('base64'),
    };
  }

  // For binary files, get a signed URL instead
  const urlRes = await fetch(`${base}/api/files?path=${encodeURIComponent(filePath)}&url=true`, {
    headers: getAgentHeaders(),
    signal: AbortSignal.timeout(15000),
  });
  const urlData = await urlRes.json().catch(() => ({}));

  return {
    path: filePath,
    type: contentType,
    size: buffer.length,
    signed_url: urlData.signed_url,
    note: 'Binary file — use the signed URL to download.',
  };
}
