import type { AgentChatClient, ChannelMembershipWithChannel, MessageWithAuthor, SearchResult } from './types.js';

export interface BoardChannel {
  channel: string;
  type: string;
  unread: number;
  latest: { id: string; content: string; created_at: string; agents: { name: string } | null } | null;
}

export async function fetchBoardSummary(client: AgentChatClient): Promise<BoardChannel[]> {
  const { data: memberships, error: memErr } = await client
    .from('channel_memberships')
    .select('*, channels(*)')
    .order('joined_at');

  if (memErr) throw new Error(`Failed to fetch memberships: ${memErr.message}`);

  const results = await Promise.all(
    (memberships as ChannelMembershipWithChannel[]).map(async (m) => {
      const channel = m.channels;

      const [latestResult, unreadResult] = await Promise.all([
        client
          .from('messages')
          .select('id, content, created_at, agents:author_agent_id(name)')
          .eq('channel_id', m.channel_id)
          .order('created_at', { ascending: false })
          .limit(1),
        (() => {
          let query = client
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('channel_id', m.channel_id);
          if (m.last_read_at) {
            query = query.gt('created_at', m.last_read_at);
          }
          return query;
        })(),
      ]);

      return {
        channel: channel.name,
        type: channel.type,
        unread: unreadResult.count || 0,
        latest: latestResult.data?.[0] || null,
      };
    })
  );

  return results;
}

export interface FormattedMessage {
  id: string;
  author: string;
  project: string | null;
  content: string;
  timestamp: string;
  parent_message_id: string | null;
  pinned: boolean;
  files?: Array<Record<string, unknown>>;
}

function formatMessage(m: MessageWithAuthor): FormattedMessage {
  const msg: FormattedMessage = {
    id: m.id,
    author: m.agents?.name || 'unknown',
    project: (m.metadata?.project as string) || null,
    content: m.content,
    timestamp: m.created_at,
    parent_message_id: m.parent_message_id,
    pinned: m.pinned,
  };
  const files = m.metadata?.files as Array<Record<string, unknown>> | undefined;
  if (files?.length) {
    msg.files = files;
  }
  return msg;
}

export async function fetchChannelMessages(
  client: AgentChatClient,
  channelName: string,
  limit: number = 20,
  before?: string
): Promise<{ channelId: string; messages: FormattedMessage[] }> {
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

  return {
    channelId: channel.id,
    messages: (data as MessageWithAuthor[]).reverse().map(formatMessage),
  };
}

export async function markChannelRead(client: AgentChatClient, channelId: string): Promise<void> {
  await Promise.all([
    client.rpc('ensure_channel_membership', { p_channel_id: channelId }),
    client.rpc('update_last_read', { p_channel_id: channelId }),
  ]);
}

export interface SearchResultItem {
  channel: string;
  author: string;
  content: string;
  timestamp: string;
  id: string;
}

export async function searchChannelMessages(
  client: AgentChatClient,
  queryText: string,
  channelName?: string
): Promise<SearchResultItem[]> {
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

  return (data as SearchResult[]).map((r) => ({
    channel: r.channel_name,
    author: r.author_name,
    content: r.content,
    timestamp: r.created_at,
    id: r.id,
  }));
}
