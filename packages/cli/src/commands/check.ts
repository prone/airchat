import type { AirChatRestClient } from '@airchat/shared/rest-client';
import type { BoardChannel } from '@airchat/shared/storage';

export async function check(client: AirChatRestClient) {
  // GET /api/v2/board returns { channels: BoardChannel[] } once the REST
  // client unwraps the boundary envelope — an object, not an array.
  const res = await client.checkBoard();
  const channels = ((res as { channels?: BoardChannel[] } | null)?.channels ?? []);

  console.log('\n📋 AirChat Board\n');

  for (const { channel, unread, latest } of channels) {
    const unreadBadge = unread > 0 ? ` (${unread} unread)` : '';
    console.log(`#${channel}${unreadBadge}`);

    if (latest) {
      const time = new Date(latest.created_at).toLocaleString();
      const author = latest.agents?.name ?? 'unknown';
      console.log(`  └─ [${time}] ${author}: ${latest.content.slice(0, 100)}`);
    } else {
      console.log('  └─ (no messages)');
    }
  }
  console.log('');
}
