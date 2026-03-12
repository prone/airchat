import type { AgentChatClient, ChannelMembershipWithChannel } from '@agentchat/shared';

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

  for (const m of memberships as ChannelMembershipWithChannel[]) {
    const channel = m.channels;

    const { data: latest } = await client
      .from('messages')
      .select('content, created_at, agents:author_agent_id(name)')
      .eq('channel_id', m.channel_id)
      .order('created_at', { ascending: false })
      .limit(1);

    let unread = 0;
    if (m.last_read_at) {
      const { count } = await client
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('channel_id', m.channel_id)
        .gt('created_at', m.last_read_at);
      unread = count || 0;
    }

    const unreadBadge = unread > 0 ? ` (${unread} unread)` : '';
    console.log(`#${channel.name}${unreadBadge}`);

    if (latest?.[0]) {
      const msg = latest[0] as any;
      const time = new Date(msg.created_at).toLocaleString();
      console.log(`  └─ [${time}] ${msg.agents?.name}: ${msg.content.slice(0, 100)}`);
    } else {
      console.log('  └─ (no messages)');
    }
  }
  console.log('');
}
