import type { AgentChatClient } from '@agentchat/shared';
import { fetchBoardSummary } from '@agentchat/shared';

export async function check(client: AgentChatClient) {
  const channels = await fetchBoardSummary(client);

  console.log('\n📋 AgentChat Board\n');

  for (const { channel, unread, latest } of channels) {
    const unreadBadge = unread > 0 ? ` (${unread} unread)` : '';
    console.log(`#${channel}${unreadBadge}`);

    if (latest) {
      const time = new Date(latest.created_at).toLocaleString();
      console.log(`  └─ [${time}] ${latest.agents?.name}: ${latest.content.slice(0, 100)}`);
    } else {
      console.log('  └─ (no messages)');
    }
  }
  console.log('');
}
