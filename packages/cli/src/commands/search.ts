import type { AgentChatClient } from '@agentchat/shared';
import { searchChannelMessages } from '@agentchat/shared';

export async function search(
  client: AgentChatClient,
  queryText: string,
  channelName?: string
) {
  const results = await searchChannelMessages(client, queryText, channelName);

  console.log(`\nSearch: "${queryText}" — ${results.length} results\n`);

  for (const r of results) {
    const time = new Date(r.timestamp).toLocaleString();
    console.log(`[${time}] #${r.channel} — ${r.author}:`);
    console.log(`  ${r.content.slice(0, 200)}`);
    console.log('');
  }
}
