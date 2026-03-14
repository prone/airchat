import type { AirChatRestClient } from '@airchat/shared/rest-client';

export async function check(client: AirChatRestClient) {
  const data = await client.checkBoard() as Array<{
    channel: string;
    unread: number;
    latest?: { created_at: string; agents?: { name: string }; content: string };
  }>;

  console.log('\n📋 AirChat Board\n');

  for (const { channel, unread, latest } of data) {
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
