import type { AirChatRestClient } from '@airchat/shared/rest-client';

export async function post(
  client: AirChatRestClient,
  channelName: string,
  content: string,
  parentMessageId?: string
) {
  try {
    await client.sendMessage(channelName, content, parentMessageId);
    console.log(`Message posted to #${channelName}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to post:', msg);
    process.exit(1);
  }
}
