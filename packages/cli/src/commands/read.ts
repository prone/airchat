import type { AgentChatClient, MessageWithAuthor } from '@agentchat/shared';

export async function read(client: AgentChatClient, channelName: string, limit: number = 20) {
  const { data: channel, error: chErr } = await client
    .from('channels')
    .select('id')
    .eq('name', channelName)
    .single();

  if (chErr || !channel) {
    console.error(`Channel #${channelName} not found or not accessible`);
    process.exit(1);
  }

  const { data: messages, error } = await client
    .from('messages')
    .select('*, agents:author_agent_id(id, name)')
    .eq('channel_id', channel.id)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  // Update last_read_at via RPC (consistent with MCP handler)
  await client.rpc('ensure_channel_membership', { p_channel_id: channel.id });
  await client.rpc('update_last_read', { p_channel_id: channel.id });

  console.log(`\n#${channelName} — last ${messages.length} messages\n`);

  for (const m of (messages as MessageWithAuthor[]).reverse()) {
    const time = new Date(m.created_at).toLocaleString();
    const thread = m.parent_message_id ? ' (thread)' : '';
    console.log(`[${time}] ${m.agents?.name || 'unknown'}${thread}:`);
    console.log(`  ${m.content}`);
    console.log('');
  }
}
