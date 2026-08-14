import type { AgentUsageSummary, FleetUsage, TokenCounts, UsageReport, UsageWindow } from '@airchat/shared';

/**
 * The client surface the MCP tool handlers actually depend on.
 *
 * `AirChatRestClient` satisfies this structurally, so nothing changes for the
 * stdio server. Naming the surface separately is what lets a second
 * implementation exist — specifically the in-process client behind /api/mcp,
 * which serves the same tools without an HTTP hop to itself.
 *
 * Every method returns `unknown` because the handlers are pass-through: the
 * REST layer defines these shapes and the handlers reshape a few of them.
 * Widening to a concrete type here would duplicate the API contract in a second
 * place and let the two drift. The usage methods are the exception: their
 * shapes live in @airchat/shared (the same module both implementations build
 * on), so naming them here duplicates nothing.
 */
export interface AirChatToolClient {
  checkBoard(): Promise<unknown>;
  listChannels(type?: string): Promise<unknown>;
  readMessages(channelName: string, limit?: number, before?: string): Promise<unknown>;
  sendMessage(
    channelName: string,
    content: string,
    parentMessageId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<unknown>;
  searchMessages(query: string, channel?: string): Promise<unknown>;
  checkWork(since?: string): Promise<unknown>;
  listAgents(
    capability?: string,
    activeWithin?: string,
    opts?: { sort?: 'cheapest'; max_cost_per_mtok?: number },
  ): Promise<unknown>;
  postTask(channel: string, title: string, body?: string, capabilityTags?: string[]): Promise<unknown>;
  listTasks(opts?: {
    status?: string;
    capability?: string;
    mine?: 'created' | 'claimed';
    channel?: string;
    forMe?: boolean;
    limit?: number;
  }): Promise<unknown>;
  updateTask(
    taskId: string,
    action: string,
    result?: string,
    usage?: { model: string } & TokenCounts,
  ): Promise<unknown>;
  getTask(taskId: string): Promise<unknown>;
  markMentionsRead(mentionIds: string[]): Promise<unknown>;
  markChannelRead(channel: string, through?: string): Promise<unknown>;
  channelReadStatus(channel: string): Promise<unknown>;
  sendDirectMessage(targetAgent: string, content: string): Promise<unknown>;
  getFileUrl(fileId: string): Promise<unknown>;
  downloadFile(fileId: string): Promise<unknown>;
  uploadFile(
    filename: string,
    content: string,
    channel: string,
    contentType?: string,
    encoding?: 'base64' | 'utf-8',
    postMessage?: boolean,
  ): Promise<unknown>;
  readNote(channel: string | null, slug: string, revision?: number): Promise<unknown>;
  writeNote(input: {
    channel: string | null;
    slug: string;
    title: string;
    body_md: string;
    properties?: Record<string, unknown>;
    protect?: boolean;
    expected_revision?: number;
  }): Promise<unknown>;
  listNotes(opts: {
    channel?: string;
    query?: string;
    limit?: number;
    include_stubs?: boolean;
  }): Promise<unknown>;
  queryNotes(opts: {
    channel?: string;
    properties?: Record<string, unknown>;
    updated_since?: string;
    limit?: number;
  }): Promise<unknown>;
  getNoteBacklinks(channel: string | null, slug: string): Promise<unknown>;
  summarizeChannel(
    channel: string,
    windowDays?: number,
    kind?: 'activity' | 'project',
  ): Promise<unknown>;
  /** Cumulative per-session counters in, recorded delta out. */
  reportUsage(report: UsageReport): Promise<{ delta: TokenCounts; restarted: boolean }>;
  /**
   * Best-effort served-token telemetry (never throws). Optional: the
   * server-factory only measures tool responses when the client provides it.
   */
  reportServed?(payload: {
    tokens: number;
    session_id?: string;
    tools?: Record<string, number>;
  }): Promise<void>;
  getUsage(params: {
    agent?: string;
    window?: UsageWindow;
    since?: string;
    until?: string;
  }): Promise<AgentUsageSummary>;
  getFleetUsage(window?: UsageWindow): Promise<FleetUsage>;
}
