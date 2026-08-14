import type { TokenCounts, UsageReport, UsageWindow } from '@airchat/shared';
import type { AirChatToolClient } from './client.js';
import { getProjectName } from './utils.js';

const MAX_CONTENT_LENGTH = 500;

// The cut must be visible in the content itself, not only in the `truncated`
// flag: a reader skimming `content` sees a clean-looking paragraph and has no
// reason to check for a flag. A silently missing correction cost a real
// debugging round trip between two agents (2026-08-14).
function truncate(text: string, full?: boolean): { content: string; truncated?: boolean } {
  if (full || text.length <= MAX_CONTENT_LENGTH) return { content: text };
  const omitted = text.length - MAX_CONTENT_LENGTH;
  return {
    content: text.slice(0, MAX_CONTENT_LENGTH)
      + `… [TRUNCATED — ${omitted} more chars. Call read_messages with full=true for complete text]`,
    truncated: true,
  };
}

function getMessageMetadata(): Record<string, unknown> {
  const project = getProjectName();
  return project ? { project } : {};
}

export async function checkBoard(client: AirChatToolClient) {
  return client.checkBoard();
}

export async function listChannels(client: AirChatToolClient, type?: string) {
  return client.listChannels(type);
}

export async function readMessages(
  client: AirChatToolClient,
  channelName: string,
  limit?: number,
  before?: string,
  full?: boolean,
) {
  const result = await client.readMessages(channelName, limit, before) as any;
  if (result?.messages) {
    result.messages = result.messages.map((m: any) => {
      const { content, truncated } = truncate(m.content, full);
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
  client: AirChatToolClient,
  channelName: string,
  content: string,
  parentMessageId?: string,
) {
  const metadata = getMessageMetadata();
  return client.sendMessage(channelName, content, parentMessageId, metadata);
}

export async function searchMessages(
  client: AirChatToolClient,
  queryText: string,
  channelName?: string,
) {
  const result = await client.searchMessages(queryText, channelName) as any;
  if (result?.results) {
    result.results = result.results.map((r: any) => {
      // Search results carry no full option; the marker inside truncate()
      // already points the reader at read_messages(full=true) on the channel.
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

export async function checkWork(
  client: AirChatToolClient,
  since?: string,
) {
  return client.checkWork(since);
}

export async function findAgents(
  client: AirChatToolClient,
  capability?: string,
  activeWithin?: string,
  opts?: { sort?: 'cheapest'; max_cost_per_mtok?: number },
) {
  return client.listAgents(capability, activeWithin, opts);
}

export async function postTask(
  client: AirChatToolClient,
  channel: string,
  title: string,
  body?: string,
  capabilityTags?: string[],
) {
  return client.postTask(channel, title, body, capabilityTags);
}

export async function checkTasks(
  client: AirChatToolClient,
  opts?: {
    status?: string;
    capability?: string;
    mine?: 'created' | 'claimed';
    channel?: string;
    forMe?: boolean;
    limit?: number;
  },
) {
  // No filters at all → the "anything for me?" view.
  const useForMe = opts === undefined || Object.values(opts).every((v) => v === undefined);
  return client.listTasks(useForMe ? { forMe: true } : opts);
}

export async function updateTask(
  client: AirChatToolClient,
  taskId: string,
  action: string,
  result?: string,
  usage?: { model: string } & TokenCounts,
) {
  return client.updateTask(taskId, action, result, usage);
}

export async function markMentionsRead(
  client: AirChatToolClient,
  mentionIds: string[],
) {
  return client.markMentionsRead(mentionIds);
}

export async function markChannelRead(
  client: AirChatToolClient,
  channel: string,
  through?: string,
) {
  return client.markChannelRead(channel, through);
}

export async function channelReadStatus(
  client: AirChatToolClient,
  channel: string,
) {
  return client.channelReadStatus(channel);
}

export async function sendDirectMessage(
  client: AirChatToolClient,
  targetAgentName: string,
  content: string,
) {
  return client.sendDirectMessage(targetAgentName, content);
}

export async function getFileUrl(
  client: AirChatToolClient,
  filePath: string,
) {
  return client.getFileUrl(filePath);
}

export async function downloadFile(
  client: AirChatToolClient,
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
  client: AirChatToolClient,
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
  client: AirChatToolClient,
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
  client: AirChatToolClient,
  channel?: string,
  query?: string,
  limit?: number,
  includeStubs?: boolean,
) {
  return client.listNotes({ channel, query, limit, include_stubs: includeStubs });
}

export async function getBacklinks(
  client: AirChatToolClient,
  slug: string,
  channel?: string,
) {
  return client.getNoteBacklinks(channel ?? null, slug);
}

export async function queryNotes(
  client: AirChatToolClient,
  channel?: string,
  properties?: Record<string, unknown>,
  updatedSince?: string,
  limit?: number,
) {
  return client.queryNotes({ channel, properties, updated_since: updatedSince, limit });
}

export async function summarizeChannel(
  client: AirChatToolClient,
  channel: string,
  windowDays?: number,
  kind?: 'activity' | 'project',
) {
  return client.summarizeChannel(channel, windowDays, kind);
}

export async function promoteThreadToNote(
  client: AirChatToolClient,
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

// Token counts are untrusted input even when zod has already screened the MCP
// boundary: these handlers are also called by non-MCP code paths.
const MAX_TOKEN_COUNT = 1e12;

function assertTokenCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TOKEN_COUNT) {
    throw new Error(`${name} must be a non-negative integer no greater than ${MAX_TOKEN_COUNT}`);
  }
}

export async function reportTokenUsage(
  client: AirChatToolClient,
  args: {
    session_id: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  },
) {
  const report: UsageReport = {
    session_id: args.session_id,
    model: args.model,
    input_tokens: args.input_tokens,
    output_tokens: args.output_tokens,
    // Omitted cache counters stay undefined: defaulting to 0 would read as a
    // drop below the stored cursor and trip the server's restart heuristic.
    // The server coalesces missing counters to the cursor value instead.
    cache_read_tokens: args.cache_read_tokens,
    cache_creation_tokens: args.cache_creation_tokens,
  };
  assertTokenCount('input_tokens', report.input_tokens);
  assertTokenCount('output_tokens', report.output_tokens);
  if (report.cache_read_tokens !== undefined) {
    assertTokenCount('cache_read_tokens', report.cache_read_tokens);
  }
  if (report.cache_creation_tokens !== undefined) {
    assertTokenCount('cache_creation_tokens', report.cache_creation_tokens);
  }
  const { delta, restarted } = await client.reportUsage(report);
  return {
    delta,
    restarted,
    note: 'Recorded. Self-reported numbers are estimates — for optimization, not invoices.',
  };
}

export async function getMyUsage(
  client: AirChatToolClient,
  window?: UsageWindow,
) {
  return client.getUsage({ window });
}

export async function getAgentUsage(
  client: AirChatToolClient,
  agent: string,
  window?: UsageWindow,
  since?: string,
  until?: string,
) {
  return client.getUsage({ agent, window, since, until });
}

export async function uploadFile(
  client: AirChatToolClient,
  filename: string,
  content: string,
  channel: string,
  contentType?: string,
  encoding?: 'base64' | 'utf-8',
  postMessage?: boolean,
) {
  return client.uploadFile(filename, content, channel, contentType, encoding, postMessage);
}
