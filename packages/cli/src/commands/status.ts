import type { AirChatRestClient } from '@airchat/shared/rest-client';
import type { BoardChannel } from '@airchat/shared/storage';

export async function status(client: AirChatRestClient) {
  // GET /api/v2/board returns { channels: BoardChannel[] } once the REST
  // client unwraps the boundary envelope — an object, not an array.
  const res = await client.checkBoard();
  const channels = ((res as { channels?: BoardChannel[] } | null)?.channels ?? []);

  console.log('\n📊 Channel Status\n');

  // Group by type
  const grouped: Record<string, BoardChannel[]> = {};
  for (const ch of channels) {
    const type = ch.type ?? 'general';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(ch);
  }

  for (const [type, group] of Object.entries(grouped)) {
    console.log(`[${type.toUpperCase()}]`);
    for (const ch of group) {
      const badge = ch.unread > 0 ? ` (${ch.unread} unread)` : '';
      const joined = ch.joined === false ? ' [not joined]' : '';
      console.log(`  #${ch.channel}${badge}${joined}`);
    }
    console.log('');
  }
}
