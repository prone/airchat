import type { AirChatRestClient } from '@airchat/shared';

export async function read(client: AirChatRestClient, channelName: string, limit: number = 20) {
  const data = await client.readMessages(channelName, limit) as {
    messages: Array<{
      timestamp: string;
      author: string;
      content: string;
      parent_message_id?: string | null;
    }>;
  };

  const messages = data.messages ?? [];

  console.log(`\n#${channelName} — last ${messages.length} messages\n`);

  for (const m of messages) {
    const time = new Date(m.timestamp).toLocaleString();
    const thread = m.parent_message_id ? ' (thread)' : '';
    console.log(`[${time}] ${m.author}${thread}:`);
    console.log(`  ${m.content}`);
    console.log('');
  }
}
