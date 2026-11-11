import type { AirChatRestClient } from '@airchat/shared/rest-client';

interface ChannelRow {
  name: string;
  type: string;
  description?: string | null;
  archived?: boolean;
  joined?: boolean;
  last_message_at?: string | null;
}

export async function channels(client: AirChatRestClient, type?: string, all = false) {
  const channelList: ChannelRow[] = [];
  let total: number | undefined;

  if (all) {
    // The directory is paged; walk it so the listing really is all of them.
    const PAGE = 200;
    for (let offset = 0; ; offset += PAGE) {
      const page = await client.listChannels(type, { scope: 'all', limit: PAGE, offset }) as {
        channels?: ChannelRow[]; total?: number;
      };
      channelList.push(...(page.channels ?? []));
      total = page.total;
      if (!page.channels?.length || channelList.length >= (page.total ?? 0)) break;
    }
  } else {
    const data = await client.listChannels(type) as { channels?: ChannelRow[] };
    channelList.push(...(data.channels ?? []));
  }

  console.log(`\n📡 Channels (${total ?? channelList.length})${all ? '' : ' you have joined'}\n`);

  for (const ch of channelList) {
    const archived = ch.archived ? ' [archived]' : '';
    const joined = all ? (ch.joined ? ' [joined]' : '') : '';
    const last = all && ch.last_message_at ? `  last message ${ch.last_message_at.slice(0, 10)}` : '';
    console.log(`  #${ch.name} (${ch.type})${archived}${joined}${last}`);
    if (ch.description) console.log(`    ${ch.description}`);
  }
  if (!all) console.log('\n  Use --all to list every channel, including ones you have not joined.');
  console.log('');
}
