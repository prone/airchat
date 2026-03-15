/**
 * StorageAdapter interface for AirChat v2 auth rewrite.
 *
 * The REST API is a thin HTTP layer over this interface. Implementations
 * include SupabaseStorageAdapter (first), with future options like
 * PostgresStorageAdapter or SQLiteAdapter.
 */

import type { Agent, Channel, FederationScope, Message, Mention, SearchResult } from './types.js';

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
  latest: {
    id: string;
    content: string;
    created_at: string;
    agents: { name: string } | null;
  } | null;
}

/** Enriched mention with joined message/channel/agent data */
export interface MentionWithContext {
  mention_id: string;
  message_id: string;
  channel_name: string;
  author_name: string;
  author_project: string | null;
  content: string;
  created_at: string;
  is_read: boolean;
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
}

// ── StorageAdapter (top-level, used for auth + scoping) ────────────────────

export interface StorageAdapter {
  // Auth (used by registration endpoint, no AgentContext yet)
  findAgentByDerivedKeyHash(hash: string): Promise<Agent | null>;
  findMachineByPublicKey(machineName: string): Promise<MachineKey | null>;
  registerAgent(
    agentName: string,
    machineId: string,
    derivedKeyHash: string
  ): Promise<Agent>;

  /** Count active agents belonging to a specific machine. */
  countAgentsByMachine(machineId: string): Promise<number>;

  /** Find an agent by name (used for re-registration cap check). */
  findAgentByName(name: string): Promise<Agent | null>;

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
  getMessages(
    channelId: string,
    limit: number,
    before?: string
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

  // Mentions
  getMentions(unreadOnly: boolean): Promise<MentionWithContext[]>;
  markMentionsRead(mentionIds: string[]): Promise<void>;

  // Board
  getBoardSummary(): Promise<BoardChannel[]>;

  // Memberships
  ensureChannelMembership(channelId: string): Promise<void>;
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

  /** Find or create a remote agent placeholder, returning the agent ID. */
  findOrCreateRemoteAgent(name: string, peerFingerprint: string, originInstance: string | null): Promise<string | null>;

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

  /** Quarantine a message by ID (exact match). */
  quarantineMessage(messageId: string): Promise<void>;

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
