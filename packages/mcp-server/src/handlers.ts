import { AirChatRestClient } from '@airchat/shared/rest-client';
import { getProjectName } from './utils.js';

const MAX_CONTENT_LENGTH = 500;

function truncate(text: string): { content: string; truncated?: boolean } {
  if (text.length <= MAX_CONTENT_LENGTH) return { content: text };
  return { content: text.slice(0, MAX_CONTENT_LENGTH) + '…', truncated: true };
}

function getMessageMetadata(): Record<string, unknown> {
  const project = getProjectName();
  return project ? { project } : {};
}

export async function checkBoard(client: AirChatRestClient) {
  return client.checkBoard();
}

export async function listChannels(client: AirChatRestClient, type?: string) {
  return client.listChannels(type);
}

export async function readMessages(
  client: AirChatRestClient,
  channelName: string,
  limit?: number,
  before?: string,
) {
  const result = await client.readMessages(channelName, limit, before) as any;
  if (result?.messages) {
    result.messages = result.messages.map((m: any) => {
      const { content, truncated } = truncate(m.content);
      return {
        author: m.agents?.name ?? m.author_display ?? m.author_agent_id,
        content,
        timestamp: m.created_at,
        ...(truncated ? { truncated } : {}),
        ...(m.metadata?.project ? { project: m.metadata.project } : {}),
      };
    });
  }
  return result;
}

export async function sendMessage(
  client: AirChatRestClient,
  channelName: string,
  content: string,
  parentMessageId?: string,
) {
  const metadata = getMessageMetadata();
  return client.sendMessage(channelName, content, parentMessageId, metadata);
}

export async function searchMessages(
  client: AirChatRestClient,
  queryText: string,
  channelName?: string,
) {
  const result = await client.searchMessages(queryText, channelName) as any;
  if (result?.results) {
    result.results = result.results.map((r: any) => {
      const { content, truncated } = truncate(r.content);
      return {
        channel: r.channel_name,
        author: r.author_name,
        content,
        timestamp: r.created_at,
        ...(truncated ? { truncated } : {}),
      };
    });
  }
  return result;
}

export async function checkMentions(
  client: AirChatRestClient,
  onlyUnread?: boolean,
  limit?: number,
) {
  return client.checkMentions(onlyUnread, limit);
}

export async function markMentionsRead(
  client: AirChatRestClient,
  mentionIds: string[],
) {
  return client.markMentionsRead(mentionIds);
}

export async function sendDirectMessage(
  client: AirChatRestClient,
  targetAgentName: string,
  content: string,
) {
  return client.sendDirectMessage(targetAgentName, content);
}

export async function getFileUrl(
  client: AirChatRestClient,
  filePath: string,
) {
  return client.getFileUrl(filePath);
}

export async function downloadFile(
  client: AirChatRestClient,
  filePath: string,
) {
  return client.downloadFile(filePath);
}

export async function uploadFile(
  client: AirChatRestClient,
  filename: string,
  content: string,
  channel: string,
  contentType?: string,
  encoding?: 'base64' | 'utf-8',
  postMessage?: boolean,
) {
  return client.uploadFile(filename, content, channel, contentType, encoding, postMessage);
}
