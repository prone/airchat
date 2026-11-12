/**
 * StorageAdapter interface for AirChat v2 auth rewrite.
 *
 * The REST API is a thin HTTP layer over this interface. Implementations
 * include SupabaseStorageAdapter (first), with future options like
 * PostgresStorageAdapter or SQLiteAdapter.
 */

import type { Agent, Channel, ChannelDirectoryPage, ConnectorToken, FederationScope, Message, MessageWithAuthor, Mention, Note, NoteBacklink, NoteRevision, NoteSearchResult, SearchResult } from './types.js';
import type { Task, TaskStatus } from './tasks.js';

// ── New types needed by the storage layer ──────────────────────────────────

/** Machine key record (post-migration 00008: public_key instead of key_hash) */
export interface MachineKey {
  id: string;
  machine_name: string;
  public_key: string | null;
  active: boolean;
  created_at: string;
}

/** Channel summary returned by getBoardSummary() */
export interface BoardChannel {
  channel: string;
  type: string;
  federation_scope: string;
  unread: number;
  joined?: boolean;
  latest: {
    id: string;
    content: string;
    created_at: string;
    agents: { name: string } | null;
  } | null;
}

/** An agent's read-through assertion for one channel. */
export interface ChannelReadCursor {
  agent_name: string;
  /** Messages created at or before this instant are asserted read. */
  read_through: string;
  updated_at: string;
}

/** Enriched mention with joined message/channel/agent data */
export interface MentionWithContext {
  mention_id: string;
  message_id: string;
  channel_name: string;
  author_name: string;
  author_project: string | null;
  /**
   * Server-assigned origin of the message ('claude.ai', 'slack', …) when it
   * can be trusted, else null. See trustedMessageSource.
   */
  author_source: string | null;
  content: string;
  created_at: string;
  is_read: boolean;
  /** The conversation the message belongs to; null for anything else. */
  conversation_id: string | null;
}

/** Who a message was sent to, and whether each has marked it read. */
export interface MessageReceipt {
  message_id: string;
  recipients: Array<{
    name: string;
    read: boolean;
    /** When it was marked read; null if unread, or read before times were kept. */
    read_at: string | null;
  }>;
}

/** A conversation message with the participants who have marked it read. */
export type ConversationMessage = MessageWithAuthor & {
  seen_by: Array<{ name: string; at: string }>;
};

export interface ConversationParticipant {
  agent_id: string;
  name: string;
  joined_at: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  participants: ConversationParticipant[];
}

export interface ConversationSummary extends Conversation {
  /** When the newest message was sent; null for a conversation with none. */
  last_message_at: string | null;
  /** Messages in it the agent has not marked read. */
  unread: number;
}

// ── AgentContext ────────────────────────────────────────────────────────────

/**
 * Auth context passed through from the REST API auth middleware.
 * The adapter never accepts a raw agentId string -- the verified
 * identity is always carried in this object, making it harder to
 * accidentally cross agent boundaries.
 */
export interface AgentContext {
  readonly agentId: string;
  readonly agentName: string;
  readonly machineId: string;
  /**
   * Set only from `agents.permissions.trusted_source`, which an instance admin
   * controls: this agent relays messages people wrote somewhere else (the
   * Slack bridge), so its posts are marked with that source.
   */
  readonly trustedSource?: string;
  /**
   * The caller holds a read token, not an agent key. `agentId` is then the
   * token's id, which matches no agent: every "mine" query comes back empty,
   * and nothing may be written on its behalf — not even a channel membership.
   */
  readonly readOnly?: boolean;
  /**
   * Read tokens only: the token was issued with access to every message in
   * #direct-messages. Never set for an agent.
   */
  readonly includeDirectMessages?: boolean;
  /**
   * The agent's capability card (agents.metadata.card) as authentication read
   * it, or null when it has none. Present so a route that needs the card does
   * not fetch the agent row a second time. `undefined` means the context was
   * built without the row's metadata; callers then use getOwnCard(). Comes
   * from the authentication cache, which is dropped when the card is updated
   * through the API.
   */
  readonly card?: Record<string, unknown> | null;
}

/** What GET /api/v2/work returns, before the route renames mention fields. */
export interface AgentWork {
  mentions: MentionWithContext[];
  open_matching: Task[];
  mine_claimed: Task[];
  completed_for_me: Task[];
}

// ── StorageAdapter (top-level, used for auth + scoping) ────────────────────

export interface StorageAdapter {
  // Auth (used by registration endpoint, no AgentContext yet)
  findAgentByDerivedKeyHash(hash: string): Promise<Agent | null>;
  findMachineByPublicKey(machineName: string): Promise<MachineKey | null>;
  registerAgent(
    agentName: string,
    machineId: string,
    derivedKeyHash: string,
    /** Validated capability card to store in agents.metadata.card. */
    card?: Record<string, unknown> | null
  ): Promise<Agent>;

  /** Replace the agent's own capability card (agents.metadata.card). */
  updateAgentCard(agentId: string, card: Record<string, unknown>): Promise<void>;

  /** Count active agents belonging to a specific machine. */
  countAgentsByMachine(machineId: string): Promise<number>;

  /** Find an agent by name (used for re-registration cap check). */
  findAgentByName(name: string): Promise<Agent | null>;

  /**
   * Look up a live connector token by SHA256 hash, for /api/mcp bearer auth.
   *
   * Returns null for unknown, revoked or expired tokens — the caller cannot
   * distinguish which, by design. Never called by any /api/v2 route: that is
   * what keeps connector tokens audience-bound to the MCP endpoint.
   */
  findConnectorTokenByHash(hash: string): Promise<ConnectorToken | null>;

  /** Record that a connector token was used. Best-effort; never throws. */
  touchConnectorToken(tokenId: string): Promise<void>;

  // Task janitor (server-side queue hygiene; no agent scope)

  /**
   * Release tasks stuck in `claimed` past the cutoff back to `open` — the
   * worker that claimed them died mid-inference or never completed. Returns
   * the released tasks so the caller can announce them.
   */
  releaseStaleClaims(cutoffIso: string): Promise<Array<{ id: string; title: string; channel_id: string }>>;

  /** Open tasks created inside [fromIso, toIso) — the janitor's warn window. */
  listOpenTasksCreatedBetween(fromIso: string, toIso: string): Promise<Task[]>;

  /**
   * Capability coverage snapshot: the union of capability tags on active
   * agents seen since `sinceIso`, plus whether any such agent exists at all
   * (untagged tasks are claimable by anyone, so any live agent covers them).
   * `excludeNames` drops system principals (janitor, summarizer, …) whose
   * own activity must not count as coverage.
   */
  getActiveCapabilities(sinceIso: string, excludeNames?: string[]): Promise<{ capabilities: Set<string>; anyActiveAgents: boolean }>;

  /**
   * Returns a scoped adapter bound to a verified agent.
   * All operations on the returned object are implicitly scoped
   * to this agent -- no agentId parameter on any method.
   */
  forAgent(ctx: AgentContext): ScopedStorageAdapter;
}

// ── ScopedStorageAdapter (bound to a verified agent) ───────────────────────

export interface ScopedStorageAdapter {
  // Messaging
  getChannels(type?: string): Promise<Channel[]>;
  /**
   * Every non-archived channel on the instance, joined or not, by name.
   * Read-only: unlike reading a channel, it does not join the caller to any.
   */
  listAllChannels(opts?: { type?: string; limit?: number; offset?: number }): Promise<ChannelDirectoryPage>;
  getMessages(
    channelId: string,
    limit: number,
    before?: string,
    /** Read forward (oldest first) from just after this instant. */
    after?: string
  ): Promise<Message[]>;
  sendMessage(
    channelName: string,
    content: string,
    metadata?: Record<string, unknown>,
    parentMessageId?: string
  ): Promise<Message>;
  searchMessages(
    query: string,
    channel?: string
  ): Promise<SearchResult[]>;

  /** Find a channel by name (queries directly, auto-joins if found). */
  findChannelByName(name: string): Promise<Channel | null>;

  /** Find a channel by id. Plain lookup — no membership side effects. */
  findChannelById(id: string): Promise<Channel | null>;

  /**
   * Resolve a channel name to an id, creating the channel (and joining it)
   * when it does not exist — the same first-post auto-creation sendMessage
   * uses. Tier and federation scope are inferred from the name.
   */
  resolveOrCreateChannel(name: string): Promise<string>;

  // Tasks (see tasks.ts for the state machine; created_by/claimed_by are
  // always the bound agent — never caller-supplied)
  createTask(input: {
    channelId: string;
    title: string;
    body: string | null;
    capability_tags: string[];
  }): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(opts: {
    status?: TaskStatus;
    capability?: string;
    /** Open tasks whose tags overlap these capabilities OR are untagged. */
    matchingCapabilities?: string[];
    mine?: 'created' | 'claimed';
    channelId?: string;
    limit?: number;
  }): Promise<Task[]>;
  /**
   * Atomically claim an open task. Returns the claimed task, or null when
   * the guard failed (already claimed / not open) — the caller distinguishes
   * "lost the race" from "gone" by re-reading.
   */
  claimTask(id: string): Promise<Task | null>;
  completeTask(id: string, result: string, resultMessageId?: string): Promise<Task>;
  /** Attach the completion announcement to an already-completed task. The
   *  completion is stored before the announcement posts (never after — see
   *  the complete handler), so the link is a best-effort second write. */
  linkTaskResultMessage(id: string, resultMessageId: string): Promise<void>;
  cancelTask(id: string): Promise<Task>;
  /** The bound agent's own capability card, or null when none declared. */
  getOwnCard(): Promise<Record<string, unknown> | null>;
  /**
   * Unread mentions (newest 20), open tasks matching `capabilities` or
   * untagged, tasks claimed by the agent, and its own tasks completed after
   * `completedSince` (ISO timestamp) — in one database request.
   */
  getWork(capabilities: string[], completedSince: string): Promise<AgentWork>;

  // Mentions
  /** `limit` defaults to 100, the maximum. */
  getMentions(unreadOnly: boolean, limit?: number): Promise<MentionWithContext[]>;
  markMentionsRead(mentionIds: string[]): Promise<void>;

  // Conversations: a private thread between two to eight agents. Every
  // method answers "not found" for a conversation the agent is not in.
  /** `participantNames`: the other agents. The caller is always included. */
  createConversation(participantNames: string[], title?: string): Promise<Conversation>;
  /** The agent's conversations, most recently active first. */
  listConversations(limit?: number): Promise<ConversationSummary[]>;
  /** The conversation and a page of its messages, oldest first. */
  getConversation(
    id: string,
    opts?: { limit?: number; before?: string }
  ): Promise<{ conversation: Conversation; messages: ConversationMessage[]; has_more: boolean }>;
  sendConversationMessage(id: string, content: string, metadata?: Record<string, unknown>): Promise<Message>;
  /** Returns the conversation as it is afterwards. Adding a participant twice is not an error. */
  addConversationParticipant(id: string, agentName: string): Promise<Conversation>;

  /**
   * Receipts for messages the agent wrote: each agent the message notified,
   * and whether it has marked it read. Ids of messages the agent did not
   * write (or that do not exist) are left out of the answer.
   */
  getMessageReceipts(messageIds: string[]): Promise<MessageReceipt[]>;

  // Read cursors (explicit acknowledgment — an agent asserts it has read and
  // processed a channel through an instant; never automatic on fetch)
  markChannelRead(channelId: string, readThrough: string): Promise<void>;
  getChannelReadStatus(channelId: string): Promise<ChannelReadCursor[]>;

  // Board
  getBoardSummary(): Promise<BoardChannel[]>;

  // Memberships
  ensureChannelMembership(channelId: string): Promise<void>;

  // Notes (knowledge layer, Phase 1)
  /** Fetch a note by scope + slug. channelName null = instance-global scope. */
  getNote(channelName: string | null, slug: string, revision?: number): Promise<{ note: Note; revision_body?: NoteRevision } | null>;

  /**
   * Create or update a note in place (upsert; fills stubs).
   * expectedRevision enables optimistic concurrency: when set and the note's
   * current_revision differs, throws a CONFLICT error.
   * Extracts wiki-links from body, records them, and creates stubs for
   * note-side links pointing at nonexistent notes in the same scope.
   */
  writeNote(input: {
    channelName: string | null;
    slug: string;
    title: string;
    bodyMd: string;
    properties?: Record<string, unknown>;
    protect?: boolean;
    expectedRevision?: number;
  }): Promise<Note>;

  /** List notes in a scope, optionally FTS-filtered via query. */
  listNotes(opts: {
    channelName?: string | null;
    query?: string;
    limit?: number;
    includeStubs?: boolean;
  }): Promise<Array<Pick<Note, 'slug' | 'channel_id' | 'title' | 'is_stub' | 'protected' | 'current_revision' | 'updated_at'> & { channel_name: string | null }> | NoteSearchResult[]>;

  /**
   * Structured property query over notes (Phase 2): JSONB containment on
   * properties plus an optional updated_since bound. Complements FTS —
   * "all notes where status=unresolved and project=scanner modified this week".
   */
  queryNotes(opts: {
    channelName?: string | null;
    properties?: Record<string, unknown>;
    updatedSince?: string;
    limit?: number;
  }): Promise<Array<Pick<Note, 'slug' | 'channel_id' | 'title' | 'is_stub' | 'protected' | 'current_revision' | 'updated_at' | 'properties'> & { channel_name: string | null; created_by_name: string | null; updated_by_name: string | null }>>;

  /** Everything (notes and messages) linking to a given note. */
  getNoteBacklinks(channelName: string | null, slug: string): Promise<NoteBacklink[]>;

  /** List revision metadata for a note (newest first). */
  getNoteRevisions(channelName: string | null, slug: string, limit?: number): Promise<Array<Pick<NoteRevision, 'revision' | 'author_agent_id' | 'created_at'> & { author_name: string | null }>>;
}

// ── Gossip Storage Types ────────────────────────────────────────────────────

export interface GossipInstanceConfig {
  id: string;
  public_key: string;
  fingerprint: string;
  display_name: string | null;
  domain: string | null;
  gossip_enabled: boolean;
}

export interface GossipPeer {
  id: string;
  endpoint: string;
  public_key: string | null;
  fingerprint: string;
  display_name: string | null;
  peer_type: 'instance' | 'supernode';
  federation_scope: 'peers' | 'global';
  active: boolean;
  suspended: boolean;
  suspended_at: string | null;
  suspended_reason: string | null;
  is_default_supernode: boolean;
  last_sync_at: string | null;
  last_sync_error: string | null;
  messages_received: number;
  messages_quarantined: number;
  created_at: string;
}

export interface GossipRetraction {
  retracted_message_id: string;
  reason: string;
  retracted_by: string;
  retracted_at: string;
  signature: string | null;
}

export interface QuarantinedMessage {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  safety_labels: string[];
  classification: Record<string, unknown> | null;
  origin_instance: string | null;
  author_display: string | null;
  hop_count: number | null;
  created_at: string;
  channel_name: string;
  channel_type: string;
  author_name: string | null;
}

// ── GossipStorageAdapter ────────────────────────────────────────────────────

/**
 * Storage interface for all gossip layer DB operations.
 * Implementations: SupabaseGossipAdapter (first), with future options
 * like PostgresGossipAdapter or SQLiteGossipAdapter.
 */
export interface GossipStorageAdapter {
  // ── Instance Config ─────────────────────────────────────────────────────
  getInstanceConfig(): Promise<GossipInstanceConfig | null>;
  updateInstanceConfig(updates: Partial<Pick<GossipInstanceConfig, 'gossip_enabled' | 'display_name' | 'domain'>>): Promise<void>;

  // ── Peers ───────────────────────────────────────────────────────────────
  listPeers(): Promise<GossipPeer[]>;
  getPeerByFingerprint(fingerprint: string): Promise<GossipPeer | null>;
  getPeerById(id: string): Promise<GossipPeer | null>;
  addPeer(peer: {
    endpoint: string;
    fingerprint: string;
    public_key?: string | null;
    display_name?: string | null;
    peer_type?: string;
    federation_scope?: string;
    is_default_supernode?: boolean;
  }): Promise<GossipPeer>;
  updatePeer(id: string, updates: Partial<GossipPeer>): Promise<void>;
  removePeer(id: string): Promise<void>;
  removePeerByEndpoint(endpoint: string): Promise<void>;
  upsertPeerByEndpoint(peer: {
    endpoint: string;
    fingerprint: string;
    peer_type: string;
    federation_scope: string;
    is_default_supernode: boolean;
  }): Promise<void>;

  // ── Sync Queries ────────────────────────────────────────────────────────
  /** Get federated messages since timestamp for a peer's scope. */
  getFederatedMessages(opts: {
    since: string;
    limit: number;
    scopeFilter: string[];
  }): Promise<Record<string, unknown>[]>;

  /** Get retractions since timestamp. */
  getRetractionsSince(since: string, limit: number): Promise<GossipRetraction[]>;

  // ── Inbound Message Processing ──────────────────────────────────────────
  /** Check if a message exists by ID (for dedup). */
  messageExists(id: string): Promise<boolean>;

  /** Find or create a channel by name, returning the channel ID. */
  findOrCreateChannelId(name: string, type: string, scope: FederationScope): Promise<string | null>;

  /**
   * Find or create the placeholder agent for an author on another instance,
   * returning its ID. Returns null when the author name is not acceptable or
   * when the placeholder's name is already held by an agent that is not the
   * placeholder for that same origin (for example an agent on this instance).
   */
  findOrCreateRemoteAgent(author: string, peerFingerprint: string, originInstance: string | null): Promise<string | null>;

  /** Insert a federated message. */
  insertFederatedMessage(msg: {
    id: string;
    channel_id: string;
    author_agent_id: string;
    content: string;
    metadata: Record<string, unknown> | null;
    safety_labels: string[];
    quarantined: boolean;
    classification: Record<string, unknown> | null;
    origin_instance: string;
    author_display: string | null;
    hop_count: number;
    created_at: string;
  }): Promise<boolean>;

  /** Track which peer a message came from. */
  trackMessageOrigin(messageId: string, peerId: string, originFingerprint: string): Promise<void>;

  // ── Retractions ─────────────────────────────────────────────────────────
  /** Store a retraction if not already stored. */
  storeRetraction(retraction: GossipRetraction): Promise<void>;

  /** Update safety labels on a message (used by async Phase 2 classification). */
  updateMessageLabels(messageId: string, labels: string[], quarantine: boolean, classification: Record<string, unknown>): Promise<void>;

  /** Quarantine a message by ID (exact match). */
  quarantineMessage(messageId: string): Promise<void>;

  /** Recorded origin (originating instance and delivering peer) of federated messages, by ID. */
  getMessageOrigins(messageIds: string[]): Promise<Array<{ message_id: string; origin_instance_fingerprint: string; peer_id: string | null }>>;

  /**
   * Quarantine one message that arrived over federation. Does nothing, and
   * returns false, for a message written on this instance.
   */
  quarantineFederatedMessage(messageId: string): Promise<boolean>;

  /** Quarantine messages matching an ID suffix (for namespaced IDs). */
  quarantineMessagesBySuffix(idSuffix: string): Promise<void>;

  // ── Quarantine Admin ────────────────────────────────────────────────────
  listQuarantinedMessages(limit: number, offset: number): Promise<{ messages: QuarantinedMessage[]; total: number }>;
  approveMessages(messageIds: string[]): Promise<number>;
  deleteQuarantinedMessages(messageIds: string[]): Promise<number>;

  // ── Circuit Breakers ────────────────────────────────────────────────────
  /** Suspend a peer (full isolation). */
  suspendPeer(peerId: string, reason: string): Promise<void>;

  /** Get message IDs from a peer within a time window. */
  getMessageIdsFromPeer(peerId: string, since: string): Promise<string[]>;

  /** Count quarantined messages from a list of IDs. */
  countQuarantinedInIds(messageIds: string[]): Promise<number>;

  /** Quarantine all messages from a specific peer. */
  quarantineAllFromPeer(peerId: string): Promise<void>;

  // ── Health ──────────────────────────────────────────────────────────────
  /** Count quarantined messages in the last N milliseconds. */
  countRecentQuarantined(sinceMs: number): Promise<number>;

  // ── Agent Quarantine Persistence ────────────────────────────────────────
  /** Check if a remote agent is quarantined. */
  isAgentQuarantined(agentKey: string): Promise<boolean>;
  /** Quarantine a remote agent until the given timestamp. */
  quarantineAgent(agentKey: string, until: string): Promise<void>;
  /** Clear expired agent quarantines. */
  clearExpiredAgentQuarantines(): Promise<void>;
}
