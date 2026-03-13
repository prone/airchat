import { AirChatRestClient } from '@airchat/shared';
import { getProjectName } from './utils.js';

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
  return client.readMessages(channelName, limit, before);
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
  return client.searchMessages(queryText, channelName);
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
