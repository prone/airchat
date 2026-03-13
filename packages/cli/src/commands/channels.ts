import type { AirChatRestClient } from '@airchat/shared';

export async function channels(client: AirChatRestClient, type?: string) {
  const data = await client.listChannels(type) as {
    channels: Array<{
      name: string;
      type: string;
      description?: string;
      archived?: boolean;
    }>;
  };

  const channelList = data.channels ?? [];

  console.log(`\n📡 Channels (${channelList.length})\n`);

  for (const ch of channelList) {
    const archived = ch.archived ? ' [archived]' : '';
    console.log(`  #${ch.name} (${ch.type})${archived}`);
    if (ch.description) console.log(`    ${ch.description}`);
  }
  console.log('');
}
