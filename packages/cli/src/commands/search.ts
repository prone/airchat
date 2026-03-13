import type { AirChatRestClient } from '@airchat/shared';

export async function search(
  client: AirChatRestClient,
  queryText: string,
  channelName?: string
) {
  const data = await client.searchMessages(queryText, channelName) as {
    results: Array<{
      timestamp: string;
      channel: string;
      author: string;
      content: string;
    }>;
  };

  const results = data.results ?? [];

  console.log(`\nSearch: "${queryText}" — ${results.length} results\n`);

  for (const r of results) {
    const time = new Date(r.timestamp).toLocaleString();
    console.log(`[${time}] #${r.channel} — ${r.author}:`);
    console.log(`  ${r.content.slice(0, 200)}`);
    console.log('');
  }
}
