/**
 * SupabaseStorageAdapter — implements StorageAdapter using a Supabase
 * service role client with explicit agentId in WHERE clauses (no RLS headers).
 *
 * This replaces the old pattern of per-agent Supabase clients with
 * x-agent-api-key headers. All queries use explicit agent IDs passed
 * through AgentContext.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Agent, Channel, ChannelDirectoryEntry, ChannelDirectoryPage, ChannelType, ConnectorToken, FederationScope, Message, Note, NoteBacklink, NoteRevision, SearchResult } from './types.js';
import { extractWikiLinks, MAX_LINKS_PER_NOTE_WRITE, MODEL_INVENTORY_TYPE, modelInventoryOwner, type WikiLinkTarget } from './notes.js';
import { DIRECT_MESSAGES_CHANNEL } from './constants.js';
import { trustedMessageSource } from './message-source.js';
import type { Task, TaskStatus } from './tasks.js';
import type {
  AgentContext,
  AgentWork,
  BoardChannel,
  MachineKey,
  MentionWithContext,
  ChannelReadCursor,
  ScopedStorageAdapter,
  StorageAdapter,
} from './storage.js';
import type { ChannelMembershipWithChannel } from './types.js';
import type { PatternSet, ClassificationResult } from './safety/types.js';
import { classifyMessage } from './safety/classifier.js';

/**
 * Thrown by every write that lands in a channel (a message, a task, a note)
 * when the channel has been archived. An archived channel is one the operators
 * have retired: it stays readable and takes nothing new. Routes answer 409.
 */
export class ChannelArchivedError extends Error {
  constructor(channelName: string) {
    super(`Channel "${channelName}" is archived and no longer accepts new messages, tasks or notes`);
    this.name = 'ChannelArchivedError';
  }
}

/** True for a ChannelArchivedError, including one that crossed a module boundary. */
export function isChannelArchivedError(e: unknown): e is ChannelArchivedError {
  return e instanceof Error && e.name === 'ChannelArchivedError';
}

// ── SupabaseStorageAdapter ─────────────────────────────────────────────────

/** What a listener is told about a message that was just stored. */
export interface MessageSentEvent {
  channelName: string;
  content: string;
  authorAgentName: string;
}
export type MessageSentListener = (event: MessageSentEvent) => void;

export class SupabaseStorageAdapter implements StorageAdapter {
  private patternSet: PatternSet | null = null;

  private readonly onMessageSent: MessageSentListener | null;

  constructor(
    private readonly client: SupabaseClient,
    options: { patternSet?: PatternSet; onMessageSent?: MessageSentListener } = {}
  ) {
    this.patternSet = options.patternSet ?? null;
    this.onMessageSent = options.onMessageSent ?? null;
  }

  /** Set the pattern set used for safety classification on federated channels. */
  setPatternSet(patterns: PatternSet): void {
    this.patternSet = patterns;
  }

  async findAgentByDerivedKeyHash(hash: string): Promise<Agent | null> {
    // The agent's machine is fetched alongside it: switching a machine off
    // must stop every agent registered from it, not only new registrations.
    // An agent with no machine (machine_id is null) has nothing to check.
    const { data, error } = await this.client
      .from('agents')
      .select('*, machine_keys(active)')
      .eq('derived_key_hash', hash)
      .eq('active', true)
      .single();

    if (error || !data) return null;
    const { machine_keys: machine, ...agent } = data as Agent & { machine_keys?: { active: boolean } | null };
    if (machine && machine.active === false) return null;
    return agent as Agent;
  }

  async findMachineByPublicKey(machineName: string): Promise<MachineKey | null> {
    const { data, error } = await this.client
      .from('machine_keys')
      .select('id, machine_name, public_key, active, created_at')
      .eq('machine_name', machineName)
      .eq('active', true)
      .single();

    if (error || !data) return null;
    return data as MachineKey;
  }

  async registerAgent(
    agentName: string,
    machineId: string,
    derivedKeyHash: string,
    card?: Record<string, unknown> | null
  ): Promise<Agent> {
    // Registration is the only writer of agents.metadata, so setting the
    // whole column (rather than a jsonb merge) is safe. A registration
    // without a card leaves any existing card untouched.
    const cardPatch = card ? { metadata: { card } } : {};

    // Conditional UPDATE: only update if the agent is owned by this machine
    // AND has not been deactivated. This avoids a SELECT-then-UPDATE TOCTOU
    // race.
    //
    // An agent with no owning machine is NOT claimable. Those rows are the
    // ones the server creates for itself (dashboard-admin, janitor,
    // summarizer), the claude.ai connector agents and agents from federated
    // peers. Registration used to adopt them, which let any machine install
    // its own key on one and then read that identity's direct messages and
    // post under its name.
    //
    // `active` is matched, never set. Re-registration used to set it true,
    // which meant an operator could not switch an agent off: deactivating it
    // caused a 401, the client re-registered, and the agent turned itself back
    // on. Deactivation was a suggestion. Matching on it instead means a
    // disabled agent stays disabled and cannot install a fresh key either —
    // re-enabling is a deliberate act, which is what the prune script and the
    // dashboard have always claimed.
    const { data: updated, error: updateErr } = await this.client
      .from('agents')
      .update({
        derived_key_hash: derivedKeyHash,
        machine_id: machineId,
        ...cardPatch,
      })
      .eq('name', agentName)
      .eq('active', true)
      .eq('machine_id', machineId)
      .select('*')
      .single();

    if (updated) {
      return updated as Agent;
    }

    // UPDATE matched 0 rows — the agent does not exist, is owned by a
    // different machine, or has been deactivated.
    if (updateErr && updateErr.code !== 'PGRST116') {
      // PGRST116 = "JSON object requested, multiple (or no) rows returned"
      throw new Error(`Failed to update agent: ${updateErr.message}`);
    }

    const { data: existing } = await this.client
      .from('agents')
      .select('id, machine_id, active')
      .eq('name', agentName)
      .single();

    if (existing) {
      // Ownership is reported first, so a machine that does not own the name
      // learns nothing about the agent's state beyond the name being taken —
      // which the conflict already tells it.
      const ownedByCaller = existing.machine_id === machineId;
      if (!ownedByCaller) {
        throw new Error('CONFLICT: Agent name is owned by a different machine');
      }
      throw new Error(
        'DEACTIVATED: This agent has been deactivated. Re-enable it from the ' +
          'dashboard before registering again.'
      );
    }

    // New agent — insert
    const { data: created, error: insertErr } = await this.client
      .from('agents')
      .insert({
        name: agentName,
        machine_id: machineId,
        derived_key_hash: derivedKeyHash,
        api_key_hash: null, // Legacy column, not used in v2
        active: true,
        ...cardPatch,
      })
      .select('*')
      .single();

    if (insertErr || !created) {
      throw new Error(`Failed to create agent: ${insertErr?.message ?? 'unknown error'}`);
    }
    return created as Agent;
  }

  async updateAgentCard(agentId: string, card: Record<string, unknown>): Promise<void> {
    const { error } = await this.client
      .from('agents')
      .update({ metadata: { card } })
      .eq('id', agentId);
    if (error) {
      throw new Error(`Failed to update agent card: ${error.message}`);
    }
  }

  async findAgentByName(name: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from('agents')
      .select('*')
      .eq('name', name)
      .single();

    if (error || !data) return null;
    return data as Agent;
  }

  async countAgentsByMachine(machineId: string): Promise<number> {
    const { count, error } = await this.client
      .from('agents')
      .select('id', { count: 'exact', head: true })
      .eq('machine_id', machineId)
      .eq('active', true);

    if (error) throw new Error(`Failed to count agents: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Look up a live connector token by hash.
   *
   * Revocation and expiry are filtered in the query, so an expired or revoked
   * token is indistinguishable from one that never existed. The caller gets
   * null in every failure case and cannot probe for token existence.
   */
  async findConnectorTokenByHash(hash: string): Promise<ConnectorToken | null> {
    const { data, error } = await this.client
      .from('connector_tokens')
      .select('*')
      .eq('token_hash', hash)
      .is('revoked_at', null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .single();

    if (error || !data) return null;
    return data as ConnectorToken;
  }

  /**
   * Best-effort last-used stamp. Deliberately swallows errors: a failure to
   * record usage must never turn an otherwise valid request into a 500.
   */
  async touchConnectorToken(tokenId: string): Promise<void> {
    try {
      await this.client
        .from('connector_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', tokenId);
    } catch {
      // Intentionally ignored.
    }
  }

  async releaseStaleClaims(cutoffIso: string): Promise<Array<{ id: string; title: string; channel_id: string }>> {
    const { data, error } = await this.client
      .from('tasks')
      .update({ status: 'open', claimed_by: null, claimed_at: null })
      .eq('status', 'claimed')
      .lt('claimed_at', cutoffIso)
      .select('id, title, channel_id');
    if (error) throw new Error(`Failed to release stale claims: ${error.message}`);
    return data ?? [];
  }

  async listOpenTasksCreatedBetween(fromIso: string, toIso: string): Promise<Task[]> {
    const { data, error } = await this.client
      .from('tasks')
      .select('*')
      .eq('status', 'open')
      .gte('created_at', fromIso)
      .lt('created_at', toIso);
    if (error) throw new Error(`Failed to list open tasks: ${error.message}`);
    return (data ?? []) as Task[];
  }

  async getActiveCapabilities(sinceIso: string, excludeNames?: string[]): Promise<{ capabilities: Set<string>; anyActiveAgents: boolean }> {
    let query = this.client
      .from('agents')
      .select('metadata')
      .eq('active', true)
      .gte('last_seen_at', sinceIso);
    if (excludeNames && excludeNames.length > 0) {
      query = query.not('name', 'in', `(${excludeNames.join(',')})`);
    }
    const { data, error } = await query;
    if (error) throw new Error(`Failed to load active capabilities: ${error.message}`);
    const capabilities = new Set<string>();
    for (const row of data ?? []) {
      const card = (row.metadata as { card?: { capabilities?: unknown } } | null)?.card;
      if (Array.isArray(card?.capabilities)) {
        for (const cap of card.capabilities) {
          if (typeof cap === 'string') capabilities.add(cap);
        }
      }
    }
    return { capabilities, anyActiveAgents: (data ?? []).length > 0 };
  }

  forAgent(ctx: AgentContext): ScopedStorageAdapter {
    return new SupabaseScopedAdapter(this.client, ctx, this.patternSet, this.onMessageSent);
  }
}

// ── SupabaseScopedAdapter ──────────────────────────────────────────────────

/**
 * How far back to look in #direct-messages for a board preview the caller is
 * allowed to see. The newest messages there usually belong to other agents, so
 * a `limit(1)` preview would almost always be filtered away to nothing.
 */
const DM_PREVIEW_SCAN = 20;

/** The board is an overview: show enough of the latest message to recognise it. */
const BOARD_PREVIEW_CHARS = 300;

function boardPreview(row: unknown): BoardChannel['latest'] {
  if (!row) return null;
  const latest = row as NonNullable<BoardChannel['latest']>;
  const content = String(latest.content ?? '');
  if (content.length <= BOARD_PREVIEW_CHARS) return latest;
  return {
    ...latest,
    content:
      content.slice(0, BOARD_PREVIEW_CHARS) +
      `… [TRUNCATED — ${content.length - BOARD_PREVIEW_CHARS} more chars. Call read_messages with full=true for complete text]`,
  };
}

/** How many unread mentions and tasks per list a work check returns. */
const WORK_MENTION_LIMIT = 20;
const WORK_TASK_LIMIT = 50;

/** One row of board_summary() (migration 00039). */
interface BoardSummaryRow {
  channel: string;
  type: string;
  federation_scope: string;
  unread: number;
  joined: boolean;
  latest_id: string | null;
  /** At most the first BOARD_PREVIEW_CHARS characters. */
  latest_content: string | null;
  /** Length of the whole message as JavaScript counts it (UTF-16 units). */
  latest_content_units: number | null;
  latest_created_at: string | null;
  latest_author_agent_id: string | null;
  latest_author_name: string | null;
}

/**
 * Turn a board_summary() row into the object the board has always returned.
 * The database sends only the start of a long message plus its full length,
 * so the truncation notice can be written without the rest of the text
 * crossing the wire.
 */
function boardChannelFromRow(row: BoardSummaryRow): BoardChannel {
  let latest: BoardChannel['latest'] = null;
  if (row.latest_id) {
    const head = row.latest_content ?? '';
    const fullLength = row.latest_content_units ?? head.length;
    latest = {
      id: row.latest_id,
      content:
        fullLength <= BOARD_PREVIEW_CHARS
          ? head
          : head.slice(0, BOARD_PREVIEW_CHARS) +
            `… [TRUNCATED — ${fullLength - BOARD_PREVIEW_CHARS} more chars. Call read_messages with full=true for complete text]`,
      created_at: row.latest_created_at ?? '',
      author_agent_id: row.latest_author_agent_id,
      agents: row.latest_author_name === null ? null : { name: row.latest_author_name },
    } as BoardChannel['latest'];
  }
  return {
    channel: row.channel,
    type: row.type,
    federation_scope: row.federation_scope,
    unread: row.unread ?? 0,
    joined: row.joined,
    latest,
  };
}

const MESSAGE_COLUMNS =
  'id, channel_id, author_agent_id, content, metadata, parent_message_id, pinned, created_at, author_display, agents:author_agent_id(id, name)';

/**
 * The board counts unread messages up to this many and stops: `unread: 100`
 * means "100 or more". The field stays a number so no client has to change;
 * counting exactly meant reading every unread row of a busy channel on every
 * board check.
 */
export const BOARD_UNREAD_CAP = 100;

/**
 * PostgREST's answer when a function does not exist (or has no overload with
 * these arguments): the database has not had the migration that adds it.
 * Callers fall back to the queries the function replaces, so the application
 * can be deployed before or after the migration.
 */
function isMissingFunction(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PGRST202';
}

// ── Small in-process caches for the read path ──────────────────────────────
//
// A scoped adapter is built per request, so anything remembered on the
// instance is forgotten before it can be reused. These live at module level
// instead. Both are bounded, and both hold only facts whose staleness is
// harmless for the stated time.

/**
 * (agent, channel) pairs known to have a membership row, with the time each
 * was confirmed. Reading a channel calls ensureChannelMembership every time;
 * for an existing member that was a write request that changed nothing. An
 * entry is trusted for 10 minutes, so if a membership row is removed, a read
 * within 10 minutes of the last confirmation does not recreate it and the
 * first read after that does. 20,000 pairs is about 150 agents in 130
 * channels each; when full, the map is emptied and refills.
 */
const MEMBERSHIP_TTL_MS = 10 * 60_000;
const MEMBERSHIP_CACHE_MAX = 20_000;
const knownMemberships = new Map<string, number>();

function membershipKnown(agentId: string, channelId: string): boolean {
  const confirmedAt = knownMemberships.get(`${agentId}:${channelId}`);
  return confirmedAt !== undefined && Date.now() - confirmedAt < MEMBERSHIP_TTL_MS;
}

function rememberMembership(agentId: string, channelId: string): void {
  if (knownMemberships.size >= MEMBERSHIP_CACHE_MAX) knownMemberships.clear();
  knownMemberships.set(`${agentId}:${channelId}`, Date.now());
}

/**
 * Channel rows by name, for 30 seconds. Every message read starts by turning a
 * channel name into its row, and channels change rarely. Staleness means: for
 * up to 30 seconds after a channel is renamed, archived or edited, a read by
 * its old name still resolves and the row returned still shows the old
 * description and archived flag. Only channels that exist are cached, so a
 * channel created a moment ago is found at once. 500 names is several times
 * the number of channels on an instance; when full, the map is emptied.
 */
const CHANNEL_CACHE_TTL_MS = 30_000;
const CHANNEL_CACHE_MAX = 500;
const channelsByName = new Map<string, { channel: Channel; cachedAt: number }>();

function cachedChannel(name: string): Channel | null {
  const hit = channelsByName.get(name);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt >= CHANNEL_CACHE_TTL_MS) {
    channelsByName.delete(name);
    return null;
  }
  return hit.channel;
}

function rememberChannel(channel: Channel): void {
  if (channelsByName.size >= CHANNEL_CACHE_MAX) channelsByName.clear();
  channelsByName.set(channel.name, { channel, cachedAt: Date.now() });
}

/** Empty the module-level caches. For tests, which reuse ids across cases. */
export function resetAdapterCaches(): void {
  knownMemberships.clear();
  channelsByName.clear();
}

class SupabaseScopedAdapter implements ScopedStorageAdapter {
  constructor(
    private readonly client: SupabaseClient,
    private readonly ctx: AgentContext,
    private readonly patternSet: PatternSet | null = null,
    private readonly onMessageSent: MessageSentListener | null = null
  ) {}

  // ── Direct-message privacy ───────────────────────────────────────────────
  //
  // Channels are readable by any agent by design: separation is by naming
  // convention, not permission. #direct-messages is the one place that model
  // does not hold, because it is a single shared channel carrying every
  // agent's private conversations. Without the filter below, any agent — or
  // any read-scoped connector token — can read all of them.
  //
  // Every read path that can surface message content has to apply it, not just
  // the obvious one: search, the board preview and note backlinks all reach
  // messages by other routes.

  /** `undefined` = not looked up yet; `null` = the channel does not exist. */
  private dmChannelId?: string | null;

  /**
   * Names of channels this instance has already resolved, by id. A message
   * read resolves the channel by name and then reads it by id on the same
   * instance, so "is this #direct-messages?" can be answered from the name
   * already in hand instead of a lookup per read.
   */
  private readonly resolvedChannelNames = new Map<string, string>();

  /** Whether `channelId` is #direct-messages; one lookup only if not yet known. */
  private async isDirectMessagesChannel(channelId: string): Promise<boolean> {
    const name = this.resolvedChannelNames.get(channelId);
    if (name !== undefined) return name === DIRECT_MESSAGES_CHANNEL;
    return channelId === (await this.directMessagesChannelId());
  }

  private async directMessagesChannelId(): Promise<string | null> {
    if (this.dmChannelId === undefined) {
      const { data } = await this.client
        .from('channels')
        .select('id')
        .eq('name', DIRECT_MESSAGES_CHANNEL)
        .maybeSingle();
      this.dmChannelId = (data?.id as string | undefined) ?? null;
    }
    return this.dmChannelId;
  }

  /** True only for a read token that an admin issued with DM access. */
  private seesAllDirectMessages(): boolean {
    return this.ctx.readOnly === true && this.ctx.includeDirectMessages === true;
  }

  /**
   * Drop rows in #direct-messages that the caller is not a party to.
   *
   * A DM is visible when the caller wrote it or was mentioned in it — the two
   * parties it was addressed to. Mentions are the authority rather than
   * parsing `@name` out of the content, because the mention rows are what
   * delivery already relies on.
   *
   * Rows outside #direct-messages pass through untouched, and the extra query
   * only runs when the batch actually contains someone else's DM.
   */
  private async filterDirectMessages<T>(
    rows: T[],
    identify: (row: T) => {
      id: string;
      authorId: string | null;
      isDirectMessage: boolean;
    }
  ): Promise<T[]> {
    // A read token issued with DM access sees the whole channel. Both flags
    // are required: includeDirectMessages on an agent context means nothing.
    if (this.seesAllDirectMessages()) return rows;

    const foreign = rows.filter((row) => {
      const { authorId, isDirectMessage } = identify(row);
      return isDirectMessage && authorId !== this.ctx.agentId;
    });
    if (foreign.length === 0) return rows;

    const { data } = await this.client
      .from('mentions')
      .select('message_id')
      .eq('mentioned_agent_id', this.ctx.agentId)
      .in(
        'message_id',
        foreign.map((row) => identify(row).id)
      );
    const addressedToMe = new Set(
      ((data as { message_id: string }[] | null) ?? []).map((m) => m.message_id)
    );

    return rows.filter((row) => {
      const { id, authorId, isDirectMessage } = identify(row);
      if (!isDirectMessage) return true;
      return authorId === this.ctx.agentId || addressedToMe.has(id);
    });
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  async createTask(input: {
    channelId: string;
    title: string;
    body: string | null;
    capability_tags: string[];
  }): Promise<Task> {
    const { data, error } = await this.client
      .from('tasks')
      .insert({
        channel_id: input.channelId,
        title: input.title,
        body: input.body,
        capability_tags: input.capability_tags,
        created_by: this.ctx.agentId,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(`Failed to create task: ${error?.message ?? 'unknown'}`);
    return data as Task;
  }

  async getTask(id: string): Promise<Task | null> {
    const { data, error } = await this.client
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) return null;
    return data as Task;
  }

  async listTasks(opts: {
    status?: TaskStatus;
    capability?: string;
    matchingCapabilities?: string[];
    mine?: 'created' | 'claimed';
    channelId?: string;
    limit?: number;
  }): Promise<Task[]> {
    // The channel-name join lets workers act in a task's channel (overflow
    // uploads) without a channel listing — GET /api/v2/channels only returns
    // channels the agent is a member of, while tasks match fleet-wide.
    let query = this.client
      .from('tasks')
      .select('*, channels:channel_id(name)')
      .order('created_at', { ascending: false })
      .limit(Math.min(opts.limit ?? 50, 200));

    if (opts.status) query = query.eq('status', opts.status);
    if (opts.channelId) query = query.eq('channel_id', opts.channelId);
    if (opts.capability) query = query.contains('capability_tags', [opts.capability]);
    if (opts.mine === 'created') query = query.eq('created_by', this.ctx.agentId);
    if (opts.mine === 'claimed') query = query.eq('claimed_by', this.ctx.agentId);

    if (opts.matchingCapabilities) {
      // Tags overlap the agent's capabilities, or the task is untagged
      // (anyone may claim). Tags are validated kebab-case, so embedding them
      // in the PostgREST or() expression cannot break its syntax.
      const caps = opts.matchingCapabilities;
      if (caps.length > 0) {
        query = query.or(`capability_tags.ov.{${caps.join(',')}},capability_tags.eq.{}`);
      } else {
        query = query.eq('capability_tags', '{}');
      }
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list tasks: ${error.message}`);
    return (data ?? []) as Task[];
  }

  async claimTask(id: string): Promise<Task | null> {
    // The whole point: a single conditional UPDATE guarded on status='open'.
    // Two racing claimants both run this; the row matches for exactly one.
    const { data, error } = await this.client
      .from('tasks')
      .update({
        status: 'claimed',
        claimed_by: this.ctx.agentId,
        claimed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'open')
      .select('*')
      .single();
    if (error || !data) return null;
    return data as Task;
  }

  async completeTask(id: string, result: string, resultMessageId?: string): Promise<Task> {
    const { data, error } = await this.client
      .from('tasks')
      .update({
        status: 'done',
        result,
        result_message_id: resultMessageId ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'claimed')
      .eq('claimed_by', this.ctx.agentId)
      .select('*')
      .single();
    if (error || !data) throw new Error('Failed to complete task (not claimed by you, or state changed)');
    return data as Task;
  }

  async linkTaskResultMessage(id: string, resultMessageId: string): Promise<void> {
    const { error } = await this.client
      .from('tasks')
      .update({ result_message_id: resultMessageId })
      .eq('id', id)
      .eq('status', 'done')
      .eq('claimed_by', this.ctx.agentId);
    if (error) throw new Error(`Failed to link result message: ${error.message}`);
  }

  async cancelTask(id: string): Promise<Task> {
    const { data, error } = await this.client
      .from('tasks')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('created_by', this.ctx.agentId)
      .in('status', ['open', 'claimed'])
      .select('*')
      .single();
    if (error || !data) throw new Error('Failed to cancel task (not yours, or state changed)');
    return data as Task;
  }

  async resolveOrCreateChannel(name: string): Promise<string> {
    const channelId = await this.findOrCreateChannel(name);
    await this.ensureChannelMembership(channelId);
    return channelId;
  }

  async findChannelById(id: string): Promise<Channel | null> {
    const { data, error } = await this.client
      .from('channels')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) return null;
    this.resolvedChannelNames.set(data.id, data.name);
    return data as Channel;
  }

  async getOwnCard(): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.client
      .from('agents')
      .select('metadata')
      .eq('id', this.ctx.agentId)
      .single();
    if (error || !data) return null;
    const card = (data.metadata as Record<string, unknown> | null)?.card;
    return card && typeof card === 'object' ? (card as Record<string, unknown>) : null;
  }

  async getChannels(type?: string): Promise<Channel[]> {
    let query = this.client
      .from('channel_memberships')
      .select('channels(*)')
      .eq('agent_id', this.ctx.agentId);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list channels: ${error.message}`);

    const channels = (data as unknown as { channels: Channel }[]).map(
      (row) => row.channels
    );

    if (type) {
      return channels.filter((c) => c.type === type);
    }
    return channels;
  }

  async listAllChannels(
    opts: { type?: string; limit?: number; offset?: number } = {},
  ): Promise<ChannelDirectoryPage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 200));
    const offset = Math.max(0, opts.offset ?? 0);

    // One request: channel_directory() (migration 00039) returns the page,
    // the total, `joined` and each channel's newest visible message time. The
    // code below it asked once per channel on the page — up to 200 requests —
    // and remains only for a database that does not have the function yet.
    const { data: directory, error: directoryError } = await this.client.rpc('channel_directory', {
      p_agent_id: this.ctx.agentId,
      p_type: opts.type ?? null,
      p_limit: limit,
      p_offset: offset,
    });
    if (!directoryError) {
      const result = (directory ?? {}) as { total?: number; channels?: ChannelDirectoryEntry[] };
      const page = result.channels ?? [];
      return {
        // Named fields, as below: whatever the function returns, a directory
        // row carries exactly these.
        channels: page.map((ch) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          federation_scope: ch.federation_scope,
          description: ch.description,
          created_at: ch.created_at,
          joined: ch.joined === true,
          last_message_at: ch.last_message_at ?? null,
        })),
        total: Number(result.total ?? page.length),
        limit,
        offset,
      };
    }
    if (!isMissingFunction(directoryError)) {
      throw new Error(`Failed to list channels: ${directoryError.message}`);
    }

    let query = this.client
      .from('channels')
      .select('id, name, type, federation_scope, description, created_at', { count: 'exact' })
      .eq('archived', false)
      .order('name', { ascending: true })
      .range(offset, offset + limit - 1);
    if (opts.type) query = query.eq('type', opts.type);

    const [{ data: rows, error, count }, { data: memberships, error: memberError }] = await Promise.all([
      query,
      this.client.from('channel_memberships').select('channel_id').eq('agent_id', this.ctx.agentId),
    ]);
    if (error) throw new Error(`Failed to list channels: ${error.message}`);
    if (memberError) throw new Error(`Failed to list channels: ${memberError.message}`);

    const joined = new Set((memberships ?? []).map((m: { channel_id: string }) => m.channel_id));
    const channels = (rows ?? []) as Array<Omit<ChannelDirectoryEntry, 'joined' | 'last_message_at'>>;

    // Newest visible message per channel. One indexed lookup each
    // (idx_messages_channel_created), run a few at a time so a page of 200
    // channels cannot open 200 connections at once.
    const lastMessageAt = new Map<string, string | null>();
    const LOOKUPS_AT_ONCE = 20;
    for (let i = 0; i < channels.length; i += LOOKUPS_AT_ONCE) {
      await Promise.all(channels.slice(i, i + LOOKUPS_AT_ONCE).map(async (ch) => {
        // Activity in #direct-messages is other agents' private traffic.
        if (ch.name === DIRECT_MESSAGES_CHANNEL) return;
        const { data, error: latestError } = await this.client
          .from('messages')
          .select('created_at')
          .eq('channel_id', ch.id)
          .eq('quarantined', false)
          .order('created_at', { ascending: false })
          .limit(1);
        if (latestError) throw new Error(`Failed to list channels: ${latestError.message}`);
        lastMessageAt.set(ch.id, (data as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null);
      }));
    }

    return {
      // Named fields, not a spread: a directory row must never carry channel
      // metadata or its creator, whatever the query happened to return.
      channels: channels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        type: ch.type,
        federation_scope: ch.federation_scope,
        description: ch.description,
        created_at: ch.created_at,
        joined: joined.has(ch.id),
        last_message_at: lastMessageAt.get(ch.id) ?? null,
      })),
      total: count ?? channels.length,
      limit,
      offset,
    };
  }

  async findChannelByName(name: string): Promise<Channel | null> {
    let channel = cachedChannel(name);
    if (!channel) {
      const { data, error } = await this.client
        .from('channels')
        .select('*')
        .eq('name', name)
        .single();

      if (error || !data) return null;
      channel = data as Channel;
      rememberChannel(channel);
    }
    this.resolvedChannelNames.set(channel.id, channel.name);

    // Auto-join the channel
    await this.ensureChannelMembership(channel.id);

    return channel;
  }

  async getMessages(
    channelId: string,
    limit: number,
    before?: string,
    after?: string
  ): Promise<Message[]> {
    const cap = Math.min(limit, 200);
    // `after` reads FORWARD from a point (oldest first), which is how a reader
    // works through a backlog in order; without it the newest `limit` are
    // returned. Either way the result is chronological.
    const forward = after !== undefined;

    if (!this.seesAllDirectMessages() && (await this.isDirectMessagesChannel(channelId))) {
      return this.getDirectMessages(channelId, cap, before, after);
    }

    let query = this.client
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('channel_id', channelId)
      .eq('quarantined', false) // Never show quarantined messages to agents
      .order('created_at', { ascending: forward })
      .limit(cap);

    if (before) query = query.lt('created_at', before);
    if (after) query = query.gt('created_at', after);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to read messages: ${error.message}`);

    const rows = data as unknown as Message[];
    if (!forward) return rows.reverse();

    // A forward reader resumes from the last row's timestamp ("after" is
    // strictly greater-than). If the page ended in the middle of a group of
    // messages that share one timestamp — a batch written in one transaction —
    // the rest of the group would be skipped for good. So a full page is
    // completed with every other message at its final timestamp; the page may
    // run a few rows over `limit`, and nothing is lost between pages.
    if (rows.length === cap && rows.length > 0) {
      const lastAt = rows[rows.length - 1].created_at;
      const { data: tied, error: tiedError } = await this.client
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .eq('channel_id', channelId)
        .eq('quarantined', false)
        .eq('created_at', lastAt)
        .limit(200);
      if (tiedError) throw new Error(`Failed to read messages: ${tiedError.message}`);
      const have = new Set(rows.map((r) => r.id));
      for (const extra of (tied ?? []) as unknown as Message[]) {
        if (!have.has(extra.id)) rows.push(extra);
      }
    }
    return rows;
  }

  /**
   * Read #direct-messages as this agent: the DMs it wrote plus the DMs that
   * mention it, and nothing else.
   *
   * The privacy rule has to be part of the QUERY, not applied to its result.
   * This used to fetch the newest `limit` rows of the whole channel and then
   * drop the ones the caller may not see. On a busy board nearly all of those
   * rows belong to other agents, so a caller asking for its last 20 DMs got
   * the few of its own that happened to be among everyone's last 20 — often
   * none — and older ones were unreachable no matter how it paged.
   *
   * The newest N of (mine ∪ addressed-to-me) is the newest N of the union of
   * each set's newest N, so three bounded queries are enough.
   */
  private async getDirectMessages(
    channelId: string,
    cap: number,
    before?: string,
    after?: string
  ): Promise<Message[]> {
    const forward = after !== undefined;

    const page = () => {
      let q = this.client
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .eq('channel_id', channelId)
        .eq('quarantined', false);
      if (before) q = q.lt('created_at', before);
      if (after) q = q.gt('created_at', after);
      return q;
    };

    // A mention row is written by the insert trigger in the same transaction
    // as its message, so the two share a created_at and the window can be
    // applied to the mention. The message query below applies it again.
    let mentionQuery = this.client
      .from('mentions')
      .select('message_id')
      .eq('mentioned_agent_id', this.ctx.agentId)
      .eq('channel_id', channelId)
      .order('created_at', { ascending: forward })
      .limit(cap);
    if (before) mentionQuery = mentionQuery.lt('created_at', before);
    if (after) mentionQuery = mentionQuery.gt('created_at', after);

    const [authored, mentioned] = await Promise.all([
      page()
        .eq('author_agent_id', this.ctx.agentId)
        .order('created_at', { ascending: forward })
        .limit(cap),
      mentionQuery,
    ]);
    if (authored.error) throw new Error(`Failed to read messages: ${authored.error.message}`);
    if (mentioned.error) throw new Error(`Failed to read messages: ${mentioned.error.message}`);

    const addressedIds = ((mentioned.data as { message_id: string }[] | null) ?? []).map(
      (m) => m.message_id
    );
    let addressedRows: Message[] = [];
    if (addressedIds.length > 0) {
      const addressed = await page().in('id', addressedIds);
      if (addressed.error) throw new Error(`Failed to read messages: ${addressed.error.message}`);
      addressedRows = addressed.data as unknown as Message[];
    }

    const byId = new Map<string, Message>();
    for (const m of [...(authored.data as unknown as Message[]), ...addressedRows]) {
      byId.set(m.id, m);
    }
    // Compare instants, not strings: "…:05+00:00" and "…:05.5+00:00" sort the
    // wrong way round as text. The string breaks ties below a millisecond.
    const chronological = [...byId.values()].sort((a, b) => {
      const as = String(a.created_at ?? '');
      const bs = String(b.created_at ?? '');
      return (Date.parse(as) || 0) - (Date.parse(bs) || 0) || (as < bs ? -1 : as > bs ? 1 : 0);
    });
    // Forward: the first `cap` after the point — plus any further messages at
    // the same timestamp as the last one, so a reader resuming from it skips
    // nothing (see getMessages). Otherwise: the newest `cap`.
    if (!forward) return chronological.slice(-cap);
    let end = Math.min(cap, chronological.length);
    while (end > 0 && end < chronological.length
        && chronological[end].created_at === chronological[end - 1].created_at) end++;
    return chronological.slice(0, end);
  }

  async sendMessage(
    channelName: string,
    content: string,
    metadata?: Record<string, unknown>,
    parentMessageId?: string
  ): Promise<Message> {
    // A send used to be five requests in a row: find the channel, upsert the
    // membership, read the channel again for its federation scope, insert,
    // then update the membership's last_read_at. It is now three: the first
    // lookup returns the scope, and one upsert after the insert both creates
    // the membership if it is missing and moves last_read_at.

    // 1. Find or create channel by name (with its federation scope)
    const channel = await this.findOrCreateChannelWithScope(channelName);
    const channelId = channel.id;

    // 2. Classify if channel is federated (shared or gossip)
    let safetyLabels: string[] = [];
    let quarantined = false;
    let classification: Record<string, unknown> | null = null;

    if (channel.federation_scope !== 'local' && this.patternSet) {
      const result: ClassificationResult = classifyMessage(
        content,
        metadata ?? null,
        this.patternSet
      );
      safetyLabels = result.labels;
      quarantined = result.label === 'quarantined';
      classification = {
        matched_patterns: result.matched_patterns,
        route_to_sandbox: result.route_to_sandbox,
        sandbox_priority: result.sandbox_priority,
      };
    }

    // 3. Insert message with author_agent_id = ctx.agentId.
    //
    // The row is returned with the same columns a read returns, not `*`: the
    // caller (and the send_message tool, which prints it into the agent's
    // context) has no use for the search vector, the classifier's working
    // notes or the safety labels.
    const { data: message, error } = await this.client
      .from('messages')
      .insert({
        channel_id: channelId,
        author_agent_id: this.ctx.agentId,
        content,
        metadata: metadata ?? null,
        parent_message_id: parentMessageId ?? null,
        safety_labels: safetyLabels,
        quarantined,
        classification,
      })
      .select(MESSAGE_COLUMNS)
      .single();

    if (error || !message) {
      throw new Error(`Failed to send message: ${error?.message ?? 'unknown error'}`);
    }
    const sent = message as unknown as Message;

    // Tell whoever is listening (the web app wakes agents waiting on
    // /api/v2/work/wait). A quarantined message is hidden from readers, so it
    // is not announced either. A listener that throws must not fail the send.
    if (this.onMessageSent && !quarantined) {
      try {
        this.onMessageSent({ channelName, content, authorAgentName: this.ctx.agentName });
      } catch { /* the message is stored; announcing it is best effort */ }
    }

    // 4. Make the author a member and mark the channel read through this
    // post, in one write. Without ignoreDuplicates this is ON CONFLICT DO
    // UPDATE, which is wanted here: last_read_at has to move. Like the update
    // it replaces, a failure does not undo a message that is already sent.
    if (!this.ctx.readOnly) {
      const { error: memberError } = await this.client
        .from('channel_memberships')
        .upsert(
          {
            agent_id: this.ctx.agentId,
            channel_id: channelId,
            last_read_at: new Date().toISOString(),
          },
          { onConflict: 'agent_id,channel_id' }
        );
      if (!memberError) rememberMembership(this.ctx.agentId, channelId);
    }

    // 5. Record wiki-links from message content (backlinks only — message-side
    // links never create stubs; see design doc §3.2/§10)
    if (content.includes('[[')) {
      await this.recordLinks('message', sent.id, extractWikiLinks(content), channelId)
        .catch(() => {}); // link recording must not fail the send
    }

    return sent;
  }

  async searchMessages(
    query: string,
    channel?: string
  ): Promise<SearchResult[]> {
    // Resolve channel name to ID if provided
    let channelFilter: string | undefined;
    if (channel) {
      const { data: ch } = await this.client
        .from('channels')
        .select('id')
        .eq('name', channel)
        .single();
      if (ch) channelFilter = ch.id;
    }

    // The viewer is passed so the function applies the #direct-messages rule
    // BEFORE its limit; filtering afterwards (below) let other agents' DMs
    // take up the result slots and push real hits out.
    let { data, error } = await this.client.rpc('search_messages', {
      query_text: query,
      channel_filter: channelFilter,
      // NULL turns the function's DM rule off, for a token allowed to see them.
      viewer_agent_id: this.seesAllDirectMessages() ? null : this.ctx.agentId,
    });

    // PGRST202 = no function with these arguments: the database has not had
    // migration 00030 yet. Fall back to the old call; the filter below still
    // keeps private rows out.
    if (error && (error as { code?: string }).code === 'PGRST202') {
      ({ data, error } = await this.client.rpc('search_messages', {
        query_text: query,
        channel_filter: channelFilter,
      }));
    }

    if (error) throw new Error(`Search failed: ${error.message}`);

    // Deliberately filtered again here even when the function applied the DM
    // rule: it costs one small query only when DM rows are present, and keeps
    // private rows out if the function is ever replaced or rolled back.
    return this.filterDirectMessages(data as SearchResult[], (r) => ({
      id: r.id,
      authorId: r.author_agent_id,
      isDirectMessage: r.channel_name === DIRECT_MESSAGES_CHANNEL,
    }));
  }

  async getMentions(unreadOnly: boolean, limit = 100): Promise<MentionWithContext[]> {
    // Direct query instead of check_mentions RPC (which uses get_agent_id())
    let query = this.client
      .from('mentions')
      .select(`
        id,
        message_id,
        channel_id,
        read,
        created_at,
        messages!inner(content, metadata, quarantined),
        channels!inner(name),
        mentioning_agent:agents!mentions_mentioning_agent_id_fkey(name)
      `)
      .eq('mentioned_agent_id', this.ctx.agentId)
      // A mention is the most trusted way content reaches an agent (the
      // prompt hook prints it), so a quarantined message must not arrive by it.
      .eq('messages.quarantined', false)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 100)));

    if (unreadOnly) {
      query = query.eq('read', false);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch mentions: ${error.message}`);

    return (data as any[]).map((row) => ({
      mention_id: row.id,
      message_id: row.message_id,
      channel_name: row.channels.name,
      author_name: row.mentioning_agent?.name ?? 'unknown',
      author_project: row.messages?.metadata?.project ?? null,
      author_source: trustedMessageSource(row.messages?.metadata, row.channels.name),
      content: row.messages?.content ?? '',
      created_at: row.created_at,
      is_read: row.read,
    }));
  }

  /**
   * Everything waiting for this agent — unread mentions, open tasks it could
   * claim, tasks it has claimed, and its own tasks completed after
   * `completedSince` — in one request (agent_work(), migration 00039).
   *
   * The work check is polled by every agent around each turn; this used to be
   * four requests per poll. On a database without the function it still is.
   */
  async getWork(capabilities: string[], completedSince: string): Promise<AgentWork> {
    const { data, error } = await this.client.rpc('agent_work', {
      p_agent_id: this.ctx.agentId,
      p_capabilities: capabilities,
      p_completed_since: completedSince,
      p_mention_limit: WORK_MENTION_LIMIT,
      p_task_limit: WORK_TASK_LIMIT,
    });

    if (error) {
      if (!isMissingFunction(error)) throw new Error(`Failed to check work: ${error.message}`);
      const sinceMs = Date.parse(completedSince);
      const [mentions, openMatching, mineClaimed, myCreatedDone] = await Promise.all([
        this.getMentions(true, WORK_MENTION_LIMIT),
        this.listTasks({ status: 'open', matchingCapabilities: capabilities, limit: WORK_TASK_LIMIT }),
        this.listTasks({ status: 'claimed', mine: 'claimed', limit: WORK_TASK_LIMIT }),
        this.listTasks({ status: 'done', mine: 'created', limit: WORK_TASK_LIMIT }),
      ]);
      return {
        mentions,
        open_matching: openMatching,
        mine_claimed: mineClaimed,
        completed_for_me: myCreatedDone.filter(
          (t) => t.completed_at !== null && Date.parse(t.completed_at) > sinceMs
        ),
      };
    }

    const work = (data ?? {}) as {
      mentions?: Array<{
        id: string;
        message_id: string;
        read: boolean;
        created_at: string;
        channel_name: string;
        author_name: string | null;
        content: string | null;
        metadata: Record<string, unknown> | null;
      }>;
      open_matching?: Task[];
      mine_claimed?: Task[];
      completed_for_me?: Task[];
    };
    return {
      mentions: (work.mentions ?? []).map((row) => ({
        mention_id: row.id,
        message_id: row.message_id,
        channel_name: row.channel_name,
        author_name: row.author_name ?? 'unknown',
        author_project: ((row.metadata?.project as string | null | undefined) ?? null),
        author_source: trustedMessageSource(row.metadata, row.channel_name),
        content: row.content ?? '',
        created_at: row.created_at,
        is_read: row.read,
      })),
      open_matching: work.open_matching ?? [],
      mine_claimed: work.mine_claimed ?? [],
      completed_for_me: work.completed_for_me ?? [],
    };
  }

  async markMentionsRead(mentionIds: string[]): Promise<void> {
    // Direct update with explicit agent_id check instead of mark_mentions_read RPC
    const { error } = await this.client
      .from('mentions')
      .update({ read: true })
      .in('id', mentionIds)
      .eq('mentioned_agent_id', this.ctx.agentId);

    if (error) throw new Error(`Failed to mark mentions read: ${error.message}`);
  }

  async markChannelRead(channelId: string, readThrough: string): Promise<void> {
    // agent_id always comes from the bound context — a caller can move only
    // its own cursor. Upsert: one row per (channel, agent), moved in place.
    const { error } = await this.client
      .from('channel_read_cursors')
      .upsert(
        {
          channel_id: channelId,
          agent_id: this.ctx.agentId,
          read_through: readThrough,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'channel_id,agent_id' }
      );

    if (error) throw new Error(`Failed to mark channel read: ${error.message}`);
  }

  async getChannelReadStatus(channelId: string): Promise<ChannelReadCursor[]> {
    const { data, error } = await this.client
      .from('channel_read_cursors')
      .select('read_through, updated_at, agents(name)')
      .eq('channel_id', channelId)
      .order('read_through', { ascending: false });

    if (error) throw new Error(`Failed to get channel read status: ${error.message}`);
    return (data ?? []).map((row: any) => ({
      agent_name: row.agents?.name ?? '(unknown)',
      read_through: row.read_through,
      updated_at: row.updated_at,
    }));
  }

  async getBoardSummary(): Promise<BoardChannel[]> {
    // One request: board_summary() (migration 00039) returns a row per
    // channel with its capped unread count and newest visible message. The
    // code below it did the same with two requests per joined channel, all at
    // once, and counted every unread row; it remains only as the fallback for
    // a database that does not have the function yet.
    const { data: summary, error: summaryError } = await this.client.rpc('board_summary', {
      p_agent_id: this.ctx.agentId,
      p_see_all_dms: this.seesAllDirectMessages(),
    });
    if (!summaryError) {
      return ((summary as BoardSummaryRow[] | null) ?? []).map(boardChannelFromRow);
    }
    if (!isMissingFunction(summaryError)) {
      throw new Error(`Failed to fetch board summary: ${summaryError.message}`);
    }

    // Fetch all channel memberships for this agent
    const { data: memberships, error: memErr } = await this.client
      .from('channel_memberships')
      .select('*, channels(*)')
      .eq('agent_id', this.ctx.agentId)
      .order('joined_at');

    if (memErr) throw new Error(`Failed to fetch memberships: ${memErr.message}`);

    // "Unread" means newer than the last thing this agent did to show it had
    // seen the channel: posted there, or acknowledged it with
    // mark_channel_read. It used to count from the last POST only, so a
    // channel an agent reads but never writes to stayed unread forever, and
    // acknowledging it changed nothing.
    const { data: cursorRows } = await this.client
      .from('channel_read_cursors')
      .select('channel_id, read_through')
      .eq('agent_id', this.ctx.agentId);
    const readThrough = new Map<string, string>(
      ((cursorRows as { channel_id: string; read_through: string }[] | null) ?? []).map(
        (c) => [c.channel_id, c.read_through]
      )
    );
    const seenThrough = (channelId: string, lastPostedAt: string | null): string | null => {
      const cursor = readThrough.get(channelId) ?? null;
      if (!cursor) return lastPostedAt;
      if (!lastPostedAt) return cursor;
      return new Date(cursor) > new Date(lastPostedAt) ? cursor : lastPostedAt;
    };

    const results = await Promise.all(
      (memberships as ChannelMembershipWithChannel[]).map(async (m) => {
        const channel = m.channels;

        const isDm = channel.name === DIRECT_MESSAGES_CHANNEL;

        // Neither posted nor acknowledged: count from when the agent joined,
        // not from the channel's first message.
        const since = seenThrough(m.channel_id, m.last_read_at) ?? m.joined_at ?? null;

        const [latestResult, unreadResult] = await Promise.all([
          this.client
            .from('messages')
            .select('id, content, created_at, author_agent_id, agents:author_agent_id(name)')
            .eq('channel_id', m.channel_id)
            .eq('quarantined', false) // quarantined content never reaches agents
            .order('created_at', { ascending: false })
            // In #direct-messages most recent messages belong to other agents,
            // so look back far enough to find one this agent may actually see.
            .limit(isDm ? DM_PREVIEW_SCAN : 1),
          (() => {
            if (isDm) {
              // In the shared DM channel only messages addressed to this agent
              // are its unread; everyone else's are not its business.
              let q = this.client
                .from('mentions')
                .select('id', { count: 'exact', head: true })
                .eq('mentioned_agent_id', this.ctx.agentId)
                .eq('channel_id', m.channel_id)
                // A DM is dealt with either by acknowledging the mention or by
                // marking the channel read; both must clear the count.
                .eq('read', false);
              if (since) q = q.gt('created_at', since);
              return q;
            }
            let q = this.client
              .from('messages')
              .select('id', { count: 'exact', head: true })
              .eq('channel_id', m.channel_id)
              .eq('quarantined', false)
              // An agent's own posts are not unread to it.
              .neq('author_agent_id', this.ctx.agentId);
            if (since) q = q.gt('created_at', since);
            return q;
          })(),
        ]);

        const visible = await this.filterDirectMessages(
          (latestResult.data as any[]) ?? [],
          (msg) => ({
            id: msg.id,
            authorId: msg.author_agent_id,
            isDirectMessage: isDm,
          })
        );

        return {
          channel: channel.name,
          type: channel.type,
          federation_scope: channel.federation_scope,
          unread: unreadResult.count || 0,
          joined: true,
          latest: boardPreview(visible[0]),
        };
      })
    );

    // For new agents with few memberships, show active channels they can discover
    if (results.length < 5) {
      const joinedIds = new Set(
        (memberships as ChannelMembershipWithChannel[]).map(m => m.channel_id)
      );

      const { data: activeChannels } = await this.client
        .from('channels')
        .select('id, name, type, federation_scope')
        .order('created_at', { ascending: false })
        .limit(20);

      if (activeChannels) {
        for (const ch of activeChannels) {
          if (joinedIds.has(ch.id)) continue;

          const chIsDm = ch.name === DIRECT_MESSAGES_CHANNEL;

          const { data: latestRows } = await this.client
            .from('messages')
            .select('id, content, created_at, author_agent_id, agents:author_agent_id(name)')
            .eq('channel_id', ch.id)
            .eq('quarantined', false)
            .order('created_at', { ascending: false })
            .limit(chIsDm ? DM_PREVIEW_SCAN : 1);

          const latest = await this.filterDirectMessages(
            (latestRows as any[]) ?? [],
            (msg) => ({
              id: msg.id,
              authorId: msg.author_agent_id,
              isDirectMessage: chIsDm,
            })
          );

          if (!latest?.[0]) continue; // Skip empty channels

          results.push({
            channel: ch.name,
            type: ch.type,
            federation_scope: ch.federation_scope,
            unread: 0,
            joined: false,
            latest: boardPreview(latest[0]),
          });

          if (results.length >= 15) break;
        }
      }
    }

    return results;
  }

  async ensureChannelMembership(channelId: string): Promise<void> {
    // A read token is not an agent: there is nothing to join, and its id in
    // channel_memberships.agent_id would violate the foreign key.
    if (this.ctx.readOnly) return;
    // Confirmed recently: there is nothing to write, so nothing is sent.
    if (membershipKnown(this.ctx.agentId, channelId)) return;
    // Insert-if-missing. `ignoreDuplicates` makes this ON CONFLICT DO NOTHING:
    // without it the upsert was DO UPDATE, which rewrote the row (a new tuple
    // and a WAL record) on every message read by an existing member.
    const { error } = await this.client
      .from('channel_memberships')
      .upsert(
        {
          agent_id: this.ctx.agentId,
          channel_id: channelId,
        },
        { onConflict: 'agent_id,channel_id', ignoreDuplicates: true }
      );

    if (error) {
      throw new Error(`Failed to ensure channel membership: ${error.message}`);
    }
    rememberMembership(this.ctx.agentId, channelId);
  }

  // ── Notes (knowledge layer, Phase 1) ───────────────────────────────────

  async getNote(
    channelName: string | null,
    slug: string,
    revision?: number
  ): Promise<{ note: Note; revision_body?: NoteRevision } | null> {
    const scope = await this.resolveNoteScope(channelName, false);
    if (scope === undefined) return null;

    const note = await this.findNoteInScope(scope, slug);
    if (!note) return null;

    if (revision !== undefined && revision !== note.current_revision) {
      const { data: rev } = await this.client
        .from('note_revisions')
        .select('*')
        .eq('note_id', note.id)
        .eq('revision', revision)
        .single();
      if (!rev) throw new Error(`NOT_FOUND: revision ${revision} does not exist`);
      return { note, revision_body: rev as NoteRevision };
    }

    return { note };
  }

  async writeNote(input: {
    channelName: string | null;
    slug: string;
    title: string;
    bodyMd: string;
    properties?: Record<string, unknown>;
    protect?: boolean;
    expectedRevision?: number;
  }): Promise<Note> {
    const scope = await this.resolveNoteScope(input.channelName, true);
    if (scope === undefined) {
      throw new Error(`NOT_FOUND: channel ${input.channelName} not found`);
    }

    const existing = await this.findNoteInScope(scope, input.slug);
    let saved: Note;

    // A model inventory tells other agents where to send prompts, so only the
    // machine's own model worker may publish one: the note `models-<machine>`
    // written by the agent `<machine>-models`. Without this any agent could
    // publish an inventory pointing a model name at an endpoint it controls.
    // The same agent is the only one that may change a note that already is
    // an inventory.
    const claimsInventory = input.properties?.type === MODEL_INVENTORY_TYPE;
    const isInventory = (existing?.properties as Record<string, unknown> | undefined)?.type === MODEL_INVENTORY_TYPE;
    const ownsInventorySlug = scope === null && this.ctx.agentName === modelInventoryOwner(input.slug);
    if ((claimsInventory || (isInventory && scope === null)) && !ownsInventorySlug) {
      throw new Error(
        `PROTECTED: a model inventory is the global note models-<machine>, ` +
        `and only the agent <machine>-models may write it.`
      );
    }
    // The worker publishing its own inventory takes the note over if someone
    // else got to the name first (a stub from a link, or a note squatting on
    // it), so nobody can block a machine from publishing.
    const reclaimsInventory = claimsInventory && ownsInventorySlug;

    // A stub is a placeholder made when someone linked to a note that did not
    // exist yet. Whoever writes the real note is its creator; the linker is
    // not, and must not be able to protect or lock a note they never wrote.
    const takesOwnership = !!existing
      && existing.created_by !== this.ctx.agentId
      && (existing.is_stub || reclaimsInventory);
    const isCreator = !!existing && (existing.created_by === this.ctx.agentId || takesOwnership);

    if (existing) {
      if (existing.protected && !isCreator) {
        throw new Error(
          'PROTECTED: this note only accepts writes from its creator. ' +
          'Propose changes via a message @mentioning them instead.'
        );
      }
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.current_revision
      ) {
        throw new Error(
          `CONFLICT: note is at revision ${existing.current_revision}, ` +
          `expected ${input.expectedRevision}. Re-read and retry.`
        );
      }

      // Conditional update on current_revision avoids a read-then-write race
      const { data: updated, error } = await this.client
        .from('notes')
        .update({
          title: input.title,
          body_md: input.bodyMd,
          properties: input.properties ?? existing.properties,
          updated_by: this.ctx.agentId,
          updated_at: new Date().toISOString(),
          is_stub: false,
          ...(takesOwnership ? { created_by: this.ctx.agentId } : {}),
          ...(input.protect !== undefined && isCreator
            ? { protected: input.protect }
            : {}),
          current_revision: existing.current_revision + 1,
        })
        .eq('id', existing.id)
        .eq('current_revision', existing.current_revision)
        .select('*')
        .single();

      if (error || !updated) {
        throw new Error(
          'CONFLICT: note was modified concurrently. Re-read and retry.'
        );
      }
      saved = updated as Note;
    } else {
      const { data: created, error } = await this.client
        .from('notes')
        .insert({
          slug: input.slug,
          channel_id: scope,
          title: input.title,
          body_md: input.bodyMd,
          properties: input.properties ?? {},
          created_by: this.ctx.agentId,
          updated_by: this.ctx.agentId,
          protected: input.protect ?? false,
          is_stub: false,
        })
        .select('*')
        .single();

      if (error || !created) {
        throw new Error(`Failed to create note: ${error?.message ?? 'unknown error'}`);
      }
      saved = created as Note;
    }

    // Append full revision snapshot (append-only history)
    await this.client.from('note_revisions').insert({
      note_id: saved.id,
      revision: saved.current_revision,
      title: saved.title,
      body_md: saved.body_md,
      properties: saved.properties,
      author_agent_id: this.ctx.agentId,
    });

    // Re-extract links and create stubs (note-side links DO create stubs)
    const links = extractWikiLinks(input.bodyMd);
    await this.client
      .from('note_links')
      .delete()
      .eq('source_type', 'note')
      .eq('source_id', saved.id);
    await this.recordLinks('note', saved.id, links, scope, true).catch(() => {});

    return saved;
  }

  async listNotes(opts: {
    channelName?: string | null;
    query?: string;
    limit?: number;
    includeStubs?: boolean;
  }): Promise<any> {
    const limit = Math.min(opts.limit ?? 50, 200);

    if (opts.query) {
      // FTS with explicit scoping. The search_notes RPC scopes via
      // get_agent_id(), which is null on the service-role connection this
      // adapter uses — so the RPC is only usable by direct agent-key
      // clients, and the API path filters here instead.
      let query = this.client
        .from('notes')
        .select('slug, channel_id, title, is_stub, updated_at, channels:channel_id(name)')
        .textSearch('content_tsv', opts.query, { type: 'websearch', config: 'english' })
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (opts.channelName) {
        const scope = await this.resolveNoteScope(opts.channelName, false);
        if (scope === undefined) return [];
        query = scope === null ? query.is('channel_id', null) : query.eq('channel_id', scope);
      } else {
        // All scopes the agent can see: member channels + instance-global
        const { data: mems } = await this.client
          .from('channel_memberships')
          .select('channel_id')
          .eq('agent_id', this.ctx.agentId);
        const ids = (mems ?? []).map((m: any) => m.channel_id);
        query = ids.length
          ? query.or(`channel_id.is.null,channel_id.in.(${ids.join(',')})`)
          : query.is('channel_id', null);
      }

      const { data, error } = await query;
      if (error) throw new Error(`Note search failed: ${error.message}`);
      return (data as any[]).map((n) => ({
        slug: n.slug,
        channel_id: n.channel_id,
        channel_name: n.channels?.name ?? null,
        title: n.title,
        is_stub: n.is_stub,
        updated_at: n.updated_at,
      }));
    }

    let query = this.client
      .from('notes')
      .select('slug, channel_id, title, is_stub, protected, current_revision, updated_at, channels:channel_id(name)')
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (opts.channelName !== undefined) {
      const scope = await this.resolveNoteScope(opts.channelName, false);
      if (scope === undefined) return [];
      query = scope === null ? query.is('channel_id', null) : query.eq('channel_id', scope);
    }
    if (!opts.includeStubs) {
      query = query.eq('is_stub', false);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list notes: ${error.message}`);

    return (data as any[]).map((n) => ({
      slug: n.slug,
      channel_id: n.channel_id,
      channel_name: n.channels?.name ?? null,
      title: n.title,
      is_stub: n.is_stub,
      protected: n.protected,
      current_revision: n.current_revision,
      updated_at: n.updated_at,
    }));
  }

  async queryNotes(opts: {
    channelName?: string | null;
    properties?: Record<string, unknown>;
    updatedSince?: string;
    limit?: number;
  }): Promise<any> {
    let query = this.client
      .from('notes')
      .select('slug, channel_id, title, is_stub, protected, current_revision, updated_at, properties, channels:channel_id(name), creator:created_by(name), updater:updated_by(name)')
      .order('updated_at', { ascending: false })
      .limit(Math.min(opts.limit ?? 50, 200));

    if (opts.properties && Object.keys(opts.properties).length) {
      // JSONB containment — uses the GIN index on notes.properties
      query = query.contains('properties', opts.properties);
    }
    if (opts.updatedSince) {
      query = query.gte('updated_at', opts.updatedSince);
    }

    if (opts.channelName !== undefined && opts.channelName !== null) {
      const scope = await this.resolveNoteScope(opts.channelName, false);
      if (scope === undefined) return [];
      query = scope === null ? query.is('channel_id', null) : query.eq('channel_id', scope);
    } else {
      // All scopes the agent can see: member channels + instance-global
      const { data: mems } = await this.client
        .from('channel_memberships')
        .select('channel_id')
        .eq('agent_id', this.ctx.agentId);
      const ids = (mems ?? []).map((m: any) => m.channel_id);
      query = ids.length
        ? query.or(`channel_id.is.null,channel_id.in.(${ids.join(',')})`)
        : query.is('channel_id', null);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Note query failed: ${error.message}`);

    return (data as any[]).map((n) => ({
      slug: n.slug,
      channel_id: n.channel_id,
      channel_name: n.channels?.name ?? null,
      title: n.title,
      is_stub: n.is_stub,
      protected: n.protected,
      current_revision: n.current_revision,
      updated_at: n.updated_at,
      properties: n.properties,
      // Who created the note and who wrote it last, by agent name. Properties
      // are free-form and any agent can write a note, so a reader that acts
      // on them (the model inventory does) needs to know whose they are.
      created_by_name: n.creator?.name ?? null,
      updated_by_name: n.updater?.name ?? null,
    }));
  }

  async getNoteBacklinks(channelName: string | null, slug: string): Promise<NoteBacklink[]> {
    const scope = await this.resolveNoteScope(channelName, false);
    if (scope === undefined) return [];

    let query = this.client
      .from('note_links')
      .select('source_type, source_id, created_at')
      .eq('target_slug', slug)
      .order('created_at', { ascending: false })
      .limit(100);
    query = scope === null ? query.is('target_channel_id', null) : query.eq('target_channel_id', scope);

    const { data: links, error } = await query;
    if (error) throw new Error(`Failed to fetch backlinks: ${error.message}`);

    const noteIds = (links as any[]).filter((l) => l.source_type === 'note').map((l) => l.source_id);
    const messageIds = (links as any[]).filter((l) => l.source_type === 'message').map((l) => l.source_id);

    const [noteSources, messageSources] = await Promise.all([
      noteIds.length
        ? this.client
            .from('notes')
            .select('id, slug, channels:channel_id(name), agents:updated_by(name), updated_at')
            .in('id', noteIds)
        : Promise.resolve({ data: [] }),
      messageIds.length
        ? this.client
            .from('messages')
            .select('id, content, created_at, author_agent_id, channels:channel_id(name), agents:author_agent_id(name)')
            .in('id', messageIds)
            // A quarantined message is held back from agents everywhere
            // else; its opening words must not surface here either.
            .eq('quarantined', false)
        : Promise.resolve({ data: [] }),
    ]);

    // A DM that links a note would otherwise leak its first 120 characters here.
    const visibleMessageSources = await this.filterDirectMessages(
      ((messageSources.data as any[]) ?? []),
      (m) => ({
        id: m.id,
        authorId: m.author_agent_id,
        isDirectMessage: m.channels?.name === DIRECT_MESSAGES_CHANNEL,
      })
    );

    const backlinks: NoteBacklink[] = [];
    for (const n of (noteSources.data as any[]) ?? []) {
      backlinks.push({
        source_type: 'note',
        source_id: n.id,
        source_label: n.slug,
        channel_name: n.channels?.name ?? null,
        author_name: n.agents?.name ?? null,
        created_at: n.updated_at,
      });
    }
    for (const m of visibleMessageSources) {
      backlinks.push({
        source_type: 'message',
        source_id: m.id,
        source_label: (m.content as string).slice(0, 120),
        channel_name: m.channels?.name ?? null,
        author_name: m.agents?.name ?? null,
        created_at: m.created_at,
      });
    }

    return backlinks.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getNoteRevisions(
    channelName: string | null,
    slug: string,
    limit?: number
  ): Promise<Array<Pick<NoteRevision, 'revision' | 'author_agent_id' | 'created_at'> & { author_name: string | null }>> {
    const scope = await this.resolveNoteScope(channelName, false);
    if (scope === undefined) return [];
    const note = await this.findNoteInScope(scope, slug);
    if (!note) return [];

    const { data, error } = await this.client
      .from('note_revisions')
      .select('revision, author_agent_id, author_user_email, created_at, agents:author_agent_id(name)')
      .eq('note_id', note.id)
      .order('revision', { ascending: false })
      .limit(Math.min(limit ?? 20, 100));

    if (error) throw new Error(`Failed to fetch revisions: ${error.message}`);

    return (data as any[]).map((r) => ({
      revision: r.revision,
      author_agent_id: r.author_agent_id,
      // Human revisions have no agent; show the editor's email instead
      author_name: r.agents?.name ?? (r.author_user_email ? `${r.author_user_email} (human)` : null),
      created_at: r.created_at,
    }));
  }

  // ── Notes: private helpers ─────────────────────────────────────────────

  /**
   * Resolve a channel name to a note scope.
   * Returns: channel id, null for the global scope, or undefined when the
   * channel does not exist (and createIfMissing is false).
   */
  private async resolveNoteScope(
    channelName: string | null | undefined,
    createIfMissing: boolean
  ): Promise<string | null | undefined> {
    if (channelName === null || channelName === undefined || channelName === 'global') {
      return null;
    }
    // Notes are readable by every agent, and #direct-messages is the one
    // channel that is not. A note filed there would look private and be
    // public, so the scope does not exist for notes: reads find nothing and
    // writes are refused.
    if (channelName === DIRECT_MESSAGES_CHANNEL) {
      if (createIfMissing) {
        throw new Error('PROTECTED: notes cannot be kept in direct-messages. Use a project channel or the global scope.');
      }
      return undefined;
    }
    if (createIfMissing) {
      const id = await this.findOrCreateChannel(channelName);
      await this.ensureChannelMembership(id);
      return id;
    }
    const { data } = await this.client
      .from('channels')
      .select('id')
      .eq('name', channelName)
      .single();
    return data?.id ?? undefined;
  }

  private async findNoteInScope(scope: string | null, slug: string): Promise<Note | null> {
    let query = this.client.from('notes').select('*').eq('slug', slug);
    query = scope === null ? query.is('channel_id', null) : query.eq('channel_id', scope);
    const { data } = await query.single();
    return (data as Note) ?? null;
  }

  /**
   * Record wiki-links into note_links. currentScope is the scope unqualified
   * [[slug]] links resolve against. When createStubs is true (note-side links
   * only), missing targets in resolvable scopes get stub notes.
   */
  private async recordLinks(
    sourceType: 'note' | 'message',
    sourceId: string,
    links: WikiLinkTarget[],
    currentScope: string | null,
    createStubs = false
  ): Promise<void> {
    if (!links.length) return;

    const rows: Array<{ source_type: string; source_id: string; target_channel_id: string | null; target_slug: string }> = [];

    // Each link costs lookups and may create a stub note, so one write is
    // only allowed so many. Links past the cap still render as text; they are
    // simply not recorded as backlinks and get no stub.
    for (const link of links.slice(0, MAX_LINKS_PER_NOTE_WRITE)) {
      let targetScope: string | null | undefined;
      if (link.global) {
        targetScope = null;
      } else if (link.channel === DIRECT_MESSAGES_CHANNEL) {
        // No notes live in the direct-messages scope, so there is nothing to
        // link to and no stub to create there.
        continue;
      } else if (link.channel) {
        // Cross-channel link: record only if the channel exists (never create
        // a channel as a side effect of a link)
        const { data } = await this.client
          .from('channels')
          .select('id')
          .eq('name', link.channel)
          .single();
        targetScope = data?.id ?? undefined;
        if (targetScope === undefined) continue;
      } else {
        targetScope = currentScope;
      }

      rows.push({
        source_type: sourceType,
        source_id: sourceId,
        target_channel_id: targetScope,
        target_slug: link.slug,
      });

      if (createStubs) {
        const existing = await this.findNoteInScope(targetScope, link.slug);
        if (!existing) {
          await this.client.from('notes').insert({
            slug: link.slug,
            channel_id: targetScope,
            title: link.slug,
            body_md: '',
            created_by: this.ctx.agentId,
            updated_by: this.ctx.agentId,
            is_stub: true,
          });
          // Ignore unique-violation races — a concurrent stub/note is fine
        }
      }
    }

    if (rows.length) {
      await this.client
        .from('note_links')
        .upsert(rows, { onConflict: 'source_type,source_id,target_channel_id,target_slug', ignoreDuplicates: true });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async findOrCreateChannel(channelName: string): Promise<string> {
    return (await this.findOrCreateChannelWithScope(channelName)).id;
  }

  /**
   * Find or create a channel, returning its federation scope with its id so a
   * sender does not need a second request to decide whether to classify.
   * Used only by writes. Throws ChannelArchivedError for an archived channel.
   */
  private async findOrCreateChannelWithScope(
    channelName: string
  ): Promise<{ id: string; federation_scope: string }> {
    // Try to find existing channel
    const { data: existing } = await this.client
      .from('channels')
      .select('id, federation_scope, archived')
      .eq('name', channelName)
      .single();

    if (existing) {
      // Every write to a channel resolves it here, so this is the one place
      // that keeps an archived channel closed to all of them.
      if (existing.archived) throw new ChannelArchivedError(channelName);
      return { id: existing.id, federation_scope: existing.federation_scope };
    }

    // Channel does not exist — create it
    // Determine channel type and federation scope from name
    const { type, federationScope } = this.inferChannelTier(channelName);

    const { data: created, error } = await this.client
      .from('channels')
      .insert({
        name: channelName,
        type,
        federation_scope: federationScope,
        created_by: this.ctx.agentId,
      })
      .select('id, federation_scope')
      .single();

    if (error) {
      // Race condition: another request may have created it
      const { data: raced } = await this.client
        .from('channels')
        .select('id, federation_scope')
        .eq('name', channelName)
        .single();

      if (raced) return raced;
      throw new Error(`Failed to create channel: ${error.message}`);
    }

    return created!;
  }

  private inferChannelTier(
    channelName: string
  ): { type: ChannelType; federationScope: FederationScope } {
    // Federated channel prefixes (gossip layer)
    if (channelName.startsWith('gossip-')) {
      return { type: 'gossip', federationScope: 'global' };
    }
    if (channelName.startsWith('shared-')) {
      return { type: 'shared', federationScope: 'peers' };
    }

    // Local channel types (prefix-based matching)
    if (channelName.startsWith('project-')) {
      return { type: 'project', federationScope: 'local' };
    }
    if (channelName.startsWith('tech-')) {
      return { type: 'technology', federationScope: 'local' };
    }
    if (channelName.startsWith('env-')) {
      return { type: 'environment', federationScope: 'local' };
    }

    // Global channels are well-known names (local scope — "global" is the channel type, not federation)
    const globalChannels = new Set([
      'general',
      'status',
      'alerts',
      'direct-messages',
      'global',
    ]);
    if (globalChannels.has(channelName)) {
      return { type: 'global', federationScope: 'local' };
    }

    // Default to project, local
    return { type: 'project', federationScope: 'local' };
  }
}
