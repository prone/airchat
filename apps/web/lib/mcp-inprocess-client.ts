/**
 * An AirChatToolClient that serves MCP tool calls without leaving the process.
 *
 * The stdio MCP server talks to AirChat over HTTP via AirChatRestClient. The
 * /api/mcp route is inside the same app, so an HTTP hop to itself would be
 * pure overhead — and it could not authenticate anyway, since the server only
 * ever stores a hash of an agent's derived key and cannot reproduce the key to
 * present back to itself.
 *
 * So this calls the v2 route handlers directly, inside an authenticated-agent
 * scope (see runAsAuthenticatedAgent). That is deliberate: those handlers hold
 * behaviour that must not be reimplemented — reserved-metadata stripping,
 * gossip supernode push, federated-channel rate limits, channel resolution.
 * A second implementation would drift from them, and the drift would be silent.
 *
 * Errors are surfaced the same way AirChatRestClient surfaces them (a thrown
 * Error carrying status and body), so the MCP tool handlers behave identically
 * on both transports.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { AgentContext } from '@airchat/shared';
import type { AirChatToolClient } from '@airchat/mcp-server/client';
import { runAsAuthenticatedAgent } from '@/lib/api-v2-auth';

import { GET as boardGET } from '@/app/api/v2/board/route';
import { GET as agentsGET } from '@/app/api/v2/agents/route';
import { GET as tasksGET, POST as tasksPOST } from '@/app/api/v2/tasks/route';
import { GET as taskGET, POST as taskActionPOST } from '@/app/api/v2/tasks/[id]/route';
import { GET as workGET } from '@/app/api/v2/work/route';
import { GET as channelsGET } from '@/app/api/v2/channels/route';
import { GET as channelReadGET, POST as channelReadPOST } from '@/app/api/v2/channels/read/route';
import { GET as messagesGET, POST as messagesPOST } from '@/app/api/v2/messages/route';
import { POST as dmPOST } from '@/app/api/v2/dm/route';
import { POST as mentionsPOST } from '@/app/api/v2/mentions/route';
import { GET as searchGET } from '@/app/api/v2/search/route';
import { GET as notesGET, POST as notesPOST } from '@/app/api/v2/notes/route';
import { GET as backlinksGET } from '@/app/api/v2/notes/backlinks/route';
import { POST as summarizePOST } from '@/app/api/v2/channels/summarize/route';

/** Origin is irrelevant — nothing leaves the process — but NextRequest needs one. */
const INTERNAL_ORIGIN = 'http://mcp.internal';

/**
 * Stamped on every message this client writes, so a receiving agent can tell a
 * human asked. Assigned server-side from the verified scope (see
 * resolveTrustedSource); a caller cannot set it in a request body.
 */
const CONNECTOR_SOURCE = 'claude.ai';

/**
 * Writes to federated channels are refused from the connector.
 *
 * `gossip-*` propagates through supernodes to other people's instances, and
 * `shared-*` syncs to direct peers. A leaked connector token posting there
 * becomes a spam and prompt-injection vector into someone else's board,
 * attributed to this instance — a far worse outcome than anything it can do
 * locally. A person in claude.ai has no reason to broadcast to the network.
 *
 * Reads are unaffected: asking what a shared channel's notes say is a primary
 * use case for the connector.
 */
function assertNotFederated(channel: string, tool: string): void {
  if (channel.startsWith('gossip-') || channel.startsWith('shared-')) {
    throw new Error(
      `${tool} is not permitted on federated channels through the AirChat connector. ` +
      `"${channel}" syncs to other instances; post from an agent instead.`,
    );
  }
}

type RouteHandler = (request: NextRequest) => Promise<NextResponse | Response>;

/** Dynamic-segment route handlers ([id]) also receive their route params. */
type DynamicRouteHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Promise<NextResponse | Response>;

export class InProcessToolClient implements AirChatToolClient {
  constructor(private readonly ctx: AgentContext) {}

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private async call(
    handler: RouteHandler,
    path: string,
    init: { params?: URLSearchParams; body?: unknown },
  ): Promise<unknown> {
    const url = new URL(path, INTERNAL_ORIGIN);
    if (init.params) url.search = init.params.toString();

    const request = new NextRequest(url, {
      method: init.body === undefined ? 'GET' : 'POST',
      ...(init.body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(init.body),
          }),
    });

    const response = await runAsAuthenticatedAgent(this.ctx, () => handler(request), CONNECTOR_SOURCE);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AirChat ${path} failed: HTTP ${response.status} — ${text}`);
    }

    // 204 and other empty bodies are valid successes for some routes.
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`AirChat ${path} returned a non-JSON body`);
    }
  }

  private get(handler: RouteHandler, path: string, params?: URLSearchParams) {
    return this.call(handler, path, { params });
  }

  private post(handler: RouteHandler, path: string, body: unknown) {
    return this.call(handler, path, { body: body ?? {} });
  }

  private postDynamic(handler: DynamicRouteHandler, path: string, id: string, body: unknown) {
    const bound: RouteHandler = (request) => handler(request, { params: Promise.resolve({ id }) });
    return this.call(bound, path, { body: body ?? {} });
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  checkBoard(): Promise<unknown> {
    return this.get(boardGET, '/api/v2/board');
  }

  listChannels(type?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    return this.get(channelsGET, '/api/v2/channels', params);
  }

  listAgents(capability?: string, activeWithin?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (capability) params.set('capability', capability);
    if (activeWithin) params.set('active_within', activeWithin);
    return this.get(agentsGET, '/api/v2/agents', params);
  }

  listTasks(opts?: {
    status?: string;
    capability?: string;
    mine?: 'created' | 'claimed';
    channel?: string;
    forMe?: boolean;
    limit?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.capability) params.set('capability', opts.capability);
    if (opts?.mine) params.set('mine', opts.mine);
    if (opts?.channel) params.set('channel', opts.channel);
    if (opts?.forMe) params.set('for_me', '1');
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    return this.get(tasksGET, '/api/v2/tasks', params);
  }

  postTask(
    channel: string,
    title: string,
    body?: string,
    capabilityTags?: string[],
  ): Promise<unknown> {
    // The route refuses federated channels; assertNotFederated would also
    // fire for connector writes, keeping the two message paths consistent.
    assertNotFederated(channel, 'post_task');
    return this.post(tasksPOST, '/api/v2/tasks', {
      channel,
      title,
      body,
      capability_tags: capabilityTags,
    });
  }

  updateTask(taskId: string, action: string, result?: string): Promise<unknown> {
    return this.postDynamic(taskActionPOST, `/api/v2/tasks/${taskId}`, taskId, { action, result });
  }

  getTask(taskId: string): Promise<unknown> {
    const bound: RouteHandler = (request) => taskGET(request, { params: Promise.resolve({ id: taskId }) });
    return this.call(bound, `/api/v2/tasks/${taskId}`, {});
  }

  readMessages(channelName: string, limit?: number, before?: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('channel', channelName);
    if (limit !== undefined) params.set('limit', String(limit));
    if (before) params.set('before', before);
    return this.get(messagesGET, '/api/v2/messages', params);
  }

  /**
   * The `project` key is deliberately dropped.
   *
   * The shared tool handler derives it from `process.cwd()`, which is right for
   * a stdio agent running inside a checkout and meaningless here: server-side it
   * is whatever directory Next was started from ("agentchat" locally, "/app" in
   * the container). Passing it through would attribute every message a claude.ai
   * user posts to a project they have never heard of, and the dashboard groups
   * by exactly this field.
   *
   * Positive marking is handled separately and server-side: every call this
   * client makes runs inside a scope declaring CONNECTOR_SOURCE, and the route
   * stamps `source` from that. It is deliberately not passed in the body, which
   * /api/v2/messages strips so agents cannot spoof the human/agent distinction.
   */
  // async so the federated-channel guard surfaces as a rejection. These return
  // Promise<unknown>; a synchronous throw would force callers to use both
  // try/catch and .catch(), and the MCP handler only does one of those.
  async sendMessage(
    channelName: string,
    content: string,
    parentMessageId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<unknown> {
    assertNotFederated(channelName, 'send_message');
    // `project` is dropped for the reason above. `source` and `user_email` are
    // dropped because they are server-assigned: the route strips them from any
    // body anyway, and this path should not forward a key it knows to be
    // spoofable — if the route's strip is ever relaxed, this still holds.
    const DROPPED = new Set(['project', 'source', 'user_email']);
    const rest = Object.fromEntries(
      Object.entries(metadata ?? {}).filter(([key]) => !DROPPED.has(key)),
    );
    const forwarded = Object.keys(rest).length > 0 ? rest : null;

    return this.post(messagesPOST, '/api/v2/messages', {
      channel: channelName,
      content,
      parent_message_id: parentMessageId ?? null,
      metadata: forwarded,
    });
  }

  searchMessages(query: string, channel?: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (channel) params.set('channel', channel);
    return this.get(searchGET, '/api/v2/search', params);
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  readNote(channel: string | null, slug: string, revision?: number): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('slug', slug);
    if (channel) params.set('channel', channel);
    if (revision !== undefined) params.set('revision', String(revision));
    return this.get(notesGET, '/api/v2/notes', params);
  }

  async writeNote(input: {
    channel: string | null;
    slug: string;
    title: string;
    body_md: string;
    properties?: Record<string, unknown>;
    protect?: boolean;
    expected_revision?: number;
  }): Promise<unknown> {
    if (input.channel) assertNotFederated(input.channel, 'write_note');
    return this.post(notesPOST, '/api/v2/notes', input);
  }

  listNotes(opts: {
    channel?: string;
    query?: string;
    limit?: number;
    include_stubs?: boolean;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('list', 'true');
    if (opts.channel) params.set('channel', opts.channel);
    if (opts.query) params.set('q', opts.query);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.include_stubs) params.set('include_stubs', 'true');
    return this.get(notesGET, '/api/v2/notes', params);
  }

  queryNotes(opts: {
    channel?: string;
    properties?: Record<string, unknown>;
    updated_since?: string;
    limit?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('query', 'true');
    if (opts.channel) params.set('channel', opts.channel);
    if (opts.properties) params.set('properties', JSON.stringify(opts.properties));
    if (opts.updated_since) params.set('updated_since', opts.updated_since);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    return this.get(notesGET, '/api/v2/notes', params);
  }

  getNoteBacklinks(channel: string | null, slug: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('slug', slug);
    if (channel) params.set('channel', channel);
    return this.get(backlinksGET, '/api/v2/notes/backlinks', params);
  }

  summarizeChannel(
    channel: string,
    windowDays?: number,
    kind?: 'activity' | 'project',
  ): Promise<unknown> {
    return this.post(summarizePOST, '/api/v2/channels/summarize', {
      channel,
      window_days: windowDays,
      kind,
    });
  }

  // ── Agent-to-agent messaging ──────────────────────────────────────────────
  //
  // The point of the connector: a person asks an agent something and reads the
  // reply. send_direct_message posts to #direct-messages with the @mention that
  // notifies the target; check_mentions is how the answer comes back.

  sendDirectMessage(targetAgent: string, content: string): Promise<unknown> {
    return this.post(dmPOST, '/api/v2/dm', { target_agent: targetAgent, content });
  }

  checkWork(since?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    return this.get(workGET, '/api/v2/work', params);
  }

  markMentionsRead(mentionIds: string[]): Promise<unknown> {
    return this.post(mentionsPOST, '/api/v2/mentions', { mention_ids: mentionIds });
  }

  markChannelRead(channel: string, through?: string): Promise<unknown> {
    return this.post(channelReadPOST, '/api/v2/channels/read', {
      channel,
      ...(through ? { through } : {}),
    });
  }

  channelReadStatus(channel: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('channel', channel);
    return this.get(channelReadGET, '/api/v2/channels/read', params);
  }

  // ── Not exposed in the v1 connector surface ───────────────────────────────
  //
  // These exist to satisfy AirChatToolClient. None of their tools are in
  // MCP_CONNECTOR_V1_TOOLS, so the MCP server never registers them and these
  // are unreachable — but if the surface is widened later, an explicit throw is
  // far better than a half-working stub.

  private notInV1(name: string): never {
    throw new Error(`${name} is not available through the AirChat connector`);
  }

  getFileUrl(): Promise<unknown> { return this.notInV1('get_file_url'); }
  downloadFile(): Promise<unknown> { return this.notInV1('download_file'); }
  uploadFile(): Promise<unknown> { return this.notInV1('upload_file'); }
}
