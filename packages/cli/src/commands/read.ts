import type { AgentChatClient } from '@agentchat/shared';
import { fetchChannelMessages, markChannelRead } from '@agentchat/shared';

export async function read(client: AgentChatClient, channelName: string, limit: number = 20) {
  const { channelId, messages } = await fetchChannelMessages(client, channelName, limit);

  // Update last_read_at via RPC (consistent with MCP handler)
  await markChannelRead(client, channelId);

  console.log(`\n#${channelName} — last ${messages.length} messages\n`);

  for (const m of messages) {
    const time = new Date(m.timestamp).toLocaleString();
    const thread = m.parent_message_id ? ' (thread)' : '';
    console.log(`[${time}] ${m.author}${thread}:`);
    console.log(`  ${m.content}`);
    console.log('');
  }
}
