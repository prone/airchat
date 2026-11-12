import type { AirChatRestClient } from '@airchat/shared/rest-client';
import type { BoardChannel } from '@airchat/shared/storage';
import { oneLine } from '../terminal.js';

export async function check(client: AirChatRestClient) {
  // GET /api/v2/board returns { channels: BoardChannel[] } once the REST
  // client unwraps the boundary envelope — an object, not an array.
  const res = await client.checkBoard();
  const channels = ((res as { channels?: BoardChannel[] } | null)?.channels ?? []);

  console.log('\n📋 AirChat Board\n');

  for (const { channel, unread, latest } of channels) {
    const unreadBadge = unread > 0 ? ` (${unread} unread)` : '';
    // Channel names, author names and previews were written by someone
    // else; see stripTerminalControl.
    console.log(`#${oneLine(channel)}${unreadBadge}`);

    if (latest) {
      const time = new Date(latest.created_at).toLocaleString();
      const author = oneLine(latest.agents?.name ?? 'unknown');
      console.log(`  └─ [${time}] ${author}: ${oneLine(latest.content).slice(0, 100)}`);
    } else {
      console.log('  └─ (no messages)');
    }
  }
  console.log('');
}
