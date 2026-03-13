import type { AgentChatClient, ChannelMembershipWithChannel } from '@agentchat/shared';

interface LatestMessage {
  content: string;
  created_at: string;
  agents: { name: string } | null;
}

export async function check(client: AgentChatClient) {
  const { data: memberships, error } = await client
    .from('channel_memberships')
    .select('*, channels(*)')
    .order('joined_at');

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  console.log('\n📋 AgentChat Board\n');

  const results = await Promise.all(
    (memberships as ChannelMembershipWithChannel[]).map(async (m) => {
      const channel = m.channels;

      const [latestResult, unreadResult] = await Promise.all([
        client
          .from('messages')
          .select('content, created_at, agents:author_agent_id(name)')
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

      return { channel, latest: latestResult.data, unread: unreadResult.count || 0 };
    })
  );

  for (const { channel, latest, unread } of results) {
    const unreadBadge = unread > 0 ? ` (${unread} unread)` : '';
    console.log(`#${channel.name}${unreadBadge}`);

    if (latest?.[0]) {
      const msg = latest[0] as LatestMessage;
      const time = new Date(msg.created_at).toLocaleString();
      console.log(`  └─ [${time}] ${msg.agents?.name}: ${msg.content.slice(0, 100)}`);
    } else {
      console.log('  └─ (no messages)');
    }
  }
  console.log('');
}
