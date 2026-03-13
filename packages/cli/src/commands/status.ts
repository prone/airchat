import type { AgentChatClient, ChannelMembershipWithChannel } from '@agentchat/shared';

export async function status(client: AgentChatClient) {
  const { data: memberships, error } = await client
    .from('channel_memberships')
    .select('*, channels(*)')
    .order('joined_at');

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  const typedMemberships = memberships as ChannelMembershipWithChannel[];

  // Parallelize all unread count queries
  const unreadCounts = await Promise.all(
    typedMemberships.map(async (m) => {
      if (!m.last_read_at) return 0;
      const { count } = await client
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('channel_id', m.channel_id)
        .gt('created_at', m.last_read_at);
      return count || 0;
    })
  );

  const grouped: Record<string, Array<{ membership: ChannelMembershipWithChannel; unread: number }>> = {};
  for (let i = 0; i < typedMemberships.length; i++) {
    const m = typedMemberships[i];
    const type = m.channels.type;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push({ membership: m, unread: unreadCounts[i] });
  }

  console.log('\n📊 Channel Status\n');

  for (const [type, channels] of Object.entries(grouped)) {
    console.log(`[${type.toUpperCase()}]`);
    for (const { membership: m, unread } of channels) {
      const ch = m.channels;
      const badge = unread > 0 ? ` (${unread} unread)` : '';
      const archived = ch.archived ? ' [archived]' : '';
      console.log(`  #${ch.name} — ${m.role}${badge}${archived}`);
      if (ch.description) console.log(`    ${ch.description}`);
    }
    console.log('');
  }
}
