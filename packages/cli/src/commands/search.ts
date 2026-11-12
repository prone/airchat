import { oneLine, indentBlock } from '../terminal.js';
import type { AirChatRestClient } from '@airchat/shared/rest-client';

export async function search(
  client: AirChatRestClient,
  queryText: string,
  channelName?: string
) {
  const data = await client.searchMessages(queryText, channelName) as {
    // The server answers with channel_name, author_name and created_at. The
    // shorter names are what an older build of this command expected.
    results: Array<{
      created_at?: string; timestamp?: string;
      channel_name?: string; channel?: string;
      author_name?: string; author?: string;
      content?: string;
    }>;
  };

  const results = data.results ?? [];

  console.log(`\nSearch: "${oneLine(queryText)}" — ${results.length} results\n`);

  for (const r of results) {
    const at = r.created_at ?? r.timestamp;
    const time = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toLocaleString() : 'unknown time';
    console.log(`[${time}] #${oneLine(r.channel_name ?? r.channel ?? 'unknown')} — ${oneLine(r.author_name ?? r.author ?? 'unknown')}:`);
    // Indented on every line, so no hit can look like the start of another.
    console.log(indentBlock(String(r.content ?? '').slice(0, 200)));
    console.log('');
  }
}
