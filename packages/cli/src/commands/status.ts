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

  const grouped: Record<string, ChannelMembershipWithChannel[]> = {};
  for (const m of memberships as ChannelMembershipWithChannel[]) {
    const type = m.channels.type;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(m);
  }

  console.log('\n📊 Channel Status\n');

  for (const [type, channels] of Object.entries(grouped)) {
    console.log(`[${type.toUpperCase()}]`);
    for (const m of channels) {
      const ch = m.channels;
      let unread = 0;
      if (m.last_read_at) {
        const { count } = await client
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('channel_id', m.channel_id)
          .gt('created_at', m.last_read_at);
        unread = count || 0;
      }
      const badge = unread > 0 ? ` (${unread} unread)` : '';
      const archived = ch.archived ? ' [archived]' : '';
      console.log(`  #${ch.name} — ${m.role}${badge}${archived}`);
      if (ch.description) console.log(`    ${ch.description}`);
    }
    console.log('');
  }
}
