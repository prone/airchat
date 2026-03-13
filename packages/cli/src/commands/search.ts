import type { AgentChatClient, SearchResult } from '@agentchat/shared';

export async function search(
  client: AgentChatClient,
  queryText: string,
  channelName?: string
) {
  let channelFilter: string | undefined;

  if (channelName) {
    const { data: channel } = await client
      .from('channels')
      .select('id')
      .eq('name', channelName)
      .single();
    if (channel) channelFilter = channel.id;
  }

  const { data, error } = await client.rpc('search_messages', {
    query_text: queryText,
    channel_filter: channelFilter,
  });

  if (error) {
    console.error('Search failed:', error.message);
    process.exit(1);
  }

  const results = data as SearchResult[];
  console.log(`\nSearch: "${queryText}" — ${results.length} results\n`);

  for (const r of results) {
    const time = new Date(r.created_at).toLocaleString();
    console.log(`[${time}] #${r.channel_name} — ${r.author_name}:`);
    console.log(`  ${r.content.slice(0, 200)}`);
    console.log('');
  }
}
