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

// Notes are long-form; they get a larger budget than the 500-char message cap,
// with an explicit full-read opt-in.
const MAX_NOTE_LENGTH = 8000;

function truncateNote(text: string, full?: boolean): { body_md: string; truncated?: boolean } {
  if (full || text.length <= MAX_NOTE_LENGTH) return { body_md: text };
  return {
    body_md: text.slice(0, MAX_NOTE_LENGTH) + '…',
    truncated: true,
  };
}

export async function readNote(
  client: AirChatRestClient,
  slug: string,
  channel?: string,
  revision?: number,
  full?: boolean,
) {
  const raw = await client.readNote(channel ?? null, slug, revision) as any;
  // v2 API responses arrive in the jsonResponse boundary envelope ({data})
  const result = raw?.data ?? raw;
  if (result?.note) {
    const body = result.revision_body?.body_md ?? result.note.body_md;
    const { body_md, truncated } = truncateNote(body, full);
    return {
      slug: result.note.slug,
      channel: channel ?? 'global',
      title: result.revision_body?.title ?? result.note.title,
      body_md,
      ...(truncated ? { truncated, hint: 'Pass full=true to read the whole note' } : {}),
      properties: result.revision_body?.properties ?? result.note.properties,
      is_stub: result.note.is_stub,
      protected: result.note.protected,
      revision: result.revision_body?.revision ?? result.note.current_revision,
      current_revision: result.note.current_revision,
      updated_at: result.note.updated_at,
      recent_revisions: result.recent_revisions,
    };
  }
  return raw;
}

export async function writeNote(
  client: AirChatRestClient,
  slug: string,
  title: string,
  bodyMd: string,
  channel?: string,
  properties?: Record<string, unknown>,
  protect?: boolean,
  expectedRevision?: number,
) {
  return client.writeNote({
    channel: channel ?? null,
    slug,
    title,
    body_md: bodyMd,
    properties,
    protect,
    expected_revision: expectedRevision,
  });
}

export async function listNotes(
  client: AirChatRestClient,
  channel?: string,
  query?: string,
  limit?: number,
  includeStubs?: boolean,
) {
  return client.listNotes({ channel, query, limit, include_stubs: includeStubs });
}

export async function getBacklinks(
  client: AirChatRestClient,
  slug: string,
  channel?: string,
) {
  return client.getNoteBacklinks(channel ?? null, slug);
}

export async function queryNotes(
  client: AirChatRestClient,
  channel?: string,
  properties?: Record<string, unknown>,
  updatedSince?: string,
  limit?: number,
) {
  return client.queryNotes({ channel, properties, updated_since: updatedSince, limit });
}

export async function summarizeChannel(
  client: AirChatRestClient,
  channel: string,
  windowDays?: number,
) {
  return client.summarizeChannel(channel, windowDays);
}

export async function promoteThreadToNote(
  client: AirChatRestClient,
  channel: string,
  threadRootMessageId: string,
  slug: string,
  title: string,
  bodyMd: string,
  properties?: Record<string, unknown>,
) {
  // Provenance back to the source thread is what distinguishes promotion
  // from a plain write — keep it in properties so it is queryable later.
  return client.writeNote({
    channel,
    slug,
    title,
    body_md: bodyMd,
    properties: {
      ...(properties ?? {}),
      promoted_from: { channel, message_id: threadRootMessageId },
    },
  });
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
