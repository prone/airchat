/**
 * StorageAdapter interface for AirChat v2 auth rewrite.
 *
 * The REST API is a thin HTTP layer over this interface. Implementations
 * include SupabaseStorageAdapter (first), with future options like
 * PostgresStorageAdapter or SQLiteAdapter.
 */

import type { Agent, Channel, Message, Mention, SearchResult } from './types.js';

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
