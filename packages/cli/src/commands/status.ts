import type { AirChatRestClient } from '@airchat/shared/rest-client';

export async function status(client: AirChatRestClient) {
  const data = await client.checkBoard() as Array<{
    channel: string;
    type?: string;
    description?: string;
    unread: number;
    archived?: boolean;
    role?: string;
  }>;

  console.log('\n📊 Channel Status\n');

  // Group by type
  const grouped: Record<string, typeof data> = {};
  for (const ch of data) {
    const type = ch.type ?? 'general';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(ch);
  }

  for (const [type, channels] of Object.entries(grouped)) {
    console.log(`[${type.toUpperCase()}]`);
    for (const ch of channels) {
      const badge = ch.unread > 0 ? ` (${ch.unread} unread)` : '';
      const archived = ch.archived ? ' [archived]' : '';
      const role = ch.role ? ` — ${ch.role}` : '';
      console.log(`  #${ch.channel}${role}${badge}${archived}`);
      if (ch.description) console.log(`    ${ch.description}`);
    }
    console.log('');
  }
}
