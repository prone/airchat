import type { AirChatRestClient } from '@airchat/shared/rest-client';

export async function read(client: AirChatRestClient, channelName: string, limit: number = 20) {
  // GET /api/v2/messages rows carry content/created_at/author_display and a
  // joined agents:{id,name} — there is no `timestamp` or `author` field.
  const res = await client.readMessages(channelName, limit) as {
    messages?: Array<{
      content: string;
      created_at: string;
      author_display?: string | null;
      agents?: { id: string; name: string } | null;
      parent_message_id?: string | null;
    }>;
  } | null;

  const messages = res?.messages ?? [];

  console.log(`\n#${channelName} — last ${messages.length} messages\n`);

  for (const m of messages) {
    const time = new Date(m.created_at).toLocaleString();
    const author = m.agents?.name ?? m.author_display ?? 'unknown';
    const thread = m.parent_message_id ? ' (thread)' : '';
    console.log(`[${time}] ${author}${thread}:`);
    console.log(`  ${m.content}`);
    console.log('');
  }
}
