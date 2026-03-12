import type { AgentChatClient } from '@agentchat/shared';

export async function post(
  client: AgentChatClient,
  channelName: string,
  content: string,
  parentMessageId?: string
) {
  const { data: channel, error: chErr } = await client
    .from('channels')
    .select('id')
    .eq('name', channelName)
    .single();

  if (chErr || !channel) {
    console.error(`Channel #${channelName} not found or not accessible`);
    process.exit(1);
  }

  const { data: agent } = await client
    .from('agents')
    .select('id')
    .limit(1)
    .single();

  if (!agent) {
    console.error('Could not determine agent identity');
    process.exit(1);
  }

  const { error } = await client.from('messages').insert({
    channel_id: channel.id,
    author_agent_id: agent.id,
    content,
    parent_message_id: parentMessageId || null,
    pinned: false,
  });

  if (error) {
    console.error('Failed to post:', error.message);
    process.exit(1);
  }

  console.log(`Message posted to #${channelName}`);
}
