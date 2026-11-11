/**
 * SupabaseGossipAdapter — implements GossipStorageAdapter using Supabase.
 *
 * All gossip-layer database operations go through this adapter.
 * The REST API routes and sync engine should use this interface,
 * not call Supabase directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  GossipStorageAdapter,
  GossipInstanceConfig,
  GossipPeer,
  GossipRetraction,
  QuarantinedMessage,
} from './storage.js';
import type { FederationScope } from './types.js';

/**
 * Escape a value for safe interpolation into a Postgres LIKE pattern.
 *
 * The backslash must be escaped FIRST. Escaping `%` and `_` before `\` would
 * double-escape the backslashes this function just introduced, and a literal
 * backslash in the input would otherwise escape whatever character follows it
 * and break out of the intended pattern.
 *
 * Callers currently pass UUID-derived values, which contain none of these
 * characters -- this is hardening so the guarantee lives with the query rather
 * than depending on every caller validating first.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Longest author name accepted from another instance. */
export const MAX_REMOTE_AUTHOR_LENGTH = 60;
const REMOTE_AUTHOR_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]*$/;
const INSTANCE_FINGERPRINT_RE = /^[0-9a-f]{16}$/;
/** Characters of the author kept in the local agent name, before the origin suffix. */
const REMOTE_AUTHOR_SLUG_LENGTH = 40;

/**
 * The local agent name used for an author on another instance, or null when
 * the author or origin is not acceptable.
 *
 * The name is `<author>-at-<origin fingerprint>`. The author part is cut to a
 * fixed length BEFORE the origin is appended, so the origin always survives:
 * a long author name cannot push it off the end and end up with a name that
 * belongs to a different instance, or to an agent on this one. The same value
 * is used as the key for agent quarantine, so two spellings that map to one
 * agent also share one quarantine.
 */
export function remoteAgentName(author: unknown, originFingerprint: unknown): string | null {
  if (typeof author !== 'string' || author.length > MAX_REMOTE_AUTHOR_LENGTH || !REMOTE_AUTHOR_RE.test(author)) {
    return null;
  }
  if (typeof originFingerprint !== 'string' || !INSTANCE_FINGERPRINT_RE.test(originFingerprint)) {
    return null;
  }
  // Agent names allow only lowercase letters, digits and hyphens.
  const slug = author
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, REMOTE_AUTHOR_SLUG_LENGTH)
    .replace(/-$/, '');
  return `${slug}-at-${originFingerprint}`;
}

/**
 * Metadata keys that only this server may set on a message, because readers
 * act on them: `source` and `user_email` mark a message as written by a
 * person (the dashboard shows a "human" badge), and `files` points at objects
 * in this instance's storage bucket.
 */
export const RESERVED_FEDERATED_METADATA_KEYS = ['source', 'user_email', 'files'] as const;

/**
 * Remove server-assigned keys from metadata that arrived from another
 * instance. A peer's claim that its message came from "the dashboard" or
 * carries one of our files is not something this instance can vouch for.
 */
export function stripReservedFederatedMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const reserved = new Set<string>(RESERVED_FEDERATED_METADATA_KEYS);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !reserved.has(key)));
}

export class SupabaseGossipAdapter implements GossipStorageAdapter {
  constructor(private readonly client: SupabaseClient) {}

  // ── Instance Config ─────────────────────────────────────────────────────

  async getInstanceConfig(): Promise<GossipInstanceConfig | null> {
    const { data, error } = await this.client
      .from('gossip_instance_config')
      .select('id, public_key, fingerprint, display_name, domain, gossip_enabled')
      .limit(1)
      .maybeSingle();
    // "No row" means the instance has no identity yet (null). A failed query
    // is something else: reporting it as "not configured" made an outage look
    // like gossip being switched off, so the sync loop recorded a success and
    // never backed off.
    if (error) throw new Error(`Failed to read gossip instance config: ${error.message}`);
    return (data as GossipInstanceConfig | null) ?? null;
  }

  async updateInstanceConfig(updates: Partial<Pick<GossipInstanceConfig, 'gossip_enabled' | 'display_name' | 'domain'>>): Promise<void> {
    const config = await this.getInstanceConfig();
    if (!config) throw new Error('Instance identity not configured');
    const { error } = await this.client
      .from('gossip_instance_config')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', config.id);
    if (error) throw new Error(`Failed to update config: ${error.message}`);
  }

  // ── Peers ───────────────────────────────────────────────────────────────

  async listPeers(): Promise<GossipPeer[]> {
    const { data, error } = await this.client
      .from('gossip_peers')
      .select('*')
      .order('created_at');
    if (error) throw new Error(`Failed to list peers: ${error.message}`);
    return (data ?? []) as GossipPeer[];
  }

  async getPeerByFingerprint(fingerprint: string): Promise<GossipPeer | null> {
    const { data, error } = await this.client
      .from('gossip_peers')
      .select('*')
      .eq('fingerprint', fingerprint)
      .single();
    if (error || !data) return null;
    return data as GossipPeer;
  }

  async getPeerById(id: string): Promise<GossipPeer | null> {
    const { data, error } = await this.client
      .from('gossip_peers')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) return null;
    return data as GossipPeer;
  }

  async addPeer(peer: {
    endpoint: string;
    fingerprint: string;
    public_key?: string | null;
    display_name?: string | null;
    peer_type?: string;
    federation_scope?: string;
    is_default_supernode?: boolean;
  }): Promise<GossipPeer> {
    const { data, error } = await this.client
      .from('gossip_peers')
      .insert({
        endpoint: peer.endpoint,
        fingerprint: peer.fingerprint,
        public_key: peer.public_key ?? null,
        display_name: peer.display_name ?? null,
        peer_type: peer.peer_type ?? 'instance',
        federation_scope: peer.federation_scope ?? 'global',
        is_default_supernode: peer.is_default_supernode ?? false,
      })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') throw new Error('DUPLICATE: Peer already exists');
      throw new Error(`Failed to add peer: ${error.message}`);
    }
    return data as GossipPeer;
  }

  async updatePeer(id: string, updates: Partial<GossipPeer>): Promise<void> {
    // Strip immutable fields to prevent PK corruption
    const { id: _id, created_at: _ca, ...safeUpdates } = updates as Record<string, unknown>;
    const { error } = await this.client
      .from('gossip_peers')
      .update(safeUpdates)
      .eq('id', id);
    if (error) throw new Error(`Failed to update peer: ${error.message}`);
  }

  async removePeer(id: string): Promise<void> {
    const { error } = await this.client.from('gossip_peers').delete().eq('id', id);
    if (error) throw new Error(`Failed to remove peer: ${error.message}`);
  }

  async removePeerByEndpoint(endpoint: string): Promise<void> {
    const { error } = await this.client.from('gossip_peers').delete().eq('endpoint', endpoint);
    if (error) throw new Error(`Failed to remove peer: ${error.message}`);
  }

  async upsertPeerByEndpoint(peer: {
    endpoint: string;
    fingerprint: string;
    peer_type: string;
    federation_scope: string;
    is_default_supernode: boolean;
  }): Promise<void> {
    const { error } = await this.client
      .from('gossip_peers')
      .upsert(peer, { onConflict: 'endpoint' });
    if (error) throw new Error(`Failed to upsert peer: ${error.message}`);
  }

  // ── Sync Queries ────────────────────────────────────────────────────────

  async getFederatedMessages(opts: {
    since: string;
    limit: number;
    scopeFilter: string[];
  }): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from('messages')
      .select(`
        id, channel_id, author_agent_id, content, metadata,
        safety_labels, quarantined, origin_instance, author_display, hop_count,
        created_at,
        channels!inner(name, federation_scope),
        agents:author_agent_id(name)
      `)
      .in('channels.federation_scope', opts.scopeFilter)
      .gt('created_at', opts.since)
      .eq('quarantined', false)
      .order('created_at', { ascending: true })
      .limit(opts.limit * 2); // Over-fetch for post-filtering
    if (error) throw new Error(`Sync query failed: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  }

  async getRetractionsSince(since: string, limit: number): Promise<GossipRetraction[]> {
    const { data, error } = await this.client
      .from('gossip_retractions')
      .select('retracted_message_id, reason, retracted_by, retracted_at, signature')
      .gt('retracted_at', since)
      .order('retracted_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Retraction query failed: ${error.message}`);
    return (data ?? []) as GossipRetraction[];
  }

  // ── Inbound Message Processing ──────────────────────────────────────────

  async messageExists(id: string): Promise<boolean> {
    const { data } = await this.client
      .from('messages')
      .select('id')
      .eq('id', id)
      .single();
    return !!data;
  }

  async findOrCreateChannelId(name: string, type: string, scope: FederationScope): Promise<string | null> {
    // Try find first (common path)
    const { data: existing } = await this.client
      .from('channels')
      .select('id')
      .eq('name', name)
      .single();
    if (existing) return existing.id;

    // Insert with conflict handling for race conditions
    const { data: created, error } = await this.client
      .from('channels')
      .insert({ name, type, federation_scope: scope })
      .select('id')
      .single();

    if (error) {
      // Race: another request created it — retry the find
      const { data: raced } = await this.client
        .from('channels')
        .select('id')
        .eq('name', name)
        .single();
      return raced?.id ?? null;
    }
    return created?.id ?? null;
  }

  async findOrCreateRemoteAgent(author: string, peerFingerprint: string, originInstance: string | null): Promise<string | null> {
    const origin = originInstance ?? peerFingerprint;
    const name = remoteAgentName(author, origin);
    if (!name) return null;

    // An existing row is only reused when it is the placeholder for this same
    // remote author. Agents registered on this instance can legitimately have
    // any name, including one shaped like a remote name; resolving to such a
    // row would let another instance post as a local agent, so the message is
    // refused instead.
    const usable = (row: { id: string; metadata: unknown } | null): string | null => {
      const meta = (row?.metadata ?? null) as Record<string, unknown> | null;
      return row && meta?.remote === true && meta.origin_instance === origin ? row.id : null;
    };

    const { data: existing } = await this.client
      .from('agents')
      .select('id, metadata')
      .eq('name', name)
      .maybeSingle();
    if (existing) return usable(existing);

    // Insert with conflict handling for race conditions
    const { data: created, error } = await this.client
      .from('agents')
      .insert({
        name,
        api_key_hash: `remote:${peerFingerprint}:${Date.now()}`,
        active: true,
        metadata: { remote: true, origin_instance: origin, original_name: author },
      })
      .select('id')
      .single();

    if (error) {
      // Race: another request created it — retry the find
      const { data: raced } = await this.client
        .from('agents')
        .select('id, metadata')
        .eq('name', name)
        .maybeSingle();
      return usable(raced ?? null);
    }
    return created?.id ?? null;
  }

  async insertFederatedMessage(msg: {
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
  }): Promise<boolean> {
    const { error } = await this.client
      .from('messages')
      .insert({ ...msg, metadata: stripReservedFederatedMetadata(msg.metadata) });
    return !error;
  }

  async trackMessageOrigin(messageId: string, peerId: string, originFingerprint: string): Promise<void> {
    await this.client.from('gossip_message_origins').insert({
      message_id: messageId,
      peer_id: peerId,
      origin_instance_fingerprint: originFingerprint,
    });
  }

  // ── Retractions ─────────────────────────────────────────────────────────

  async storeRetraction(retraction: GossipRetraction): Promise<void> {
    // Insert and ignore unique constraint violation (safe against race conditions)
    const { error } = await this.client.from('gossip_retractions').insert({
      retracted_message_id: retraction.retracted_message_id,
      reason: retraction.reason,
      retracted_by: retraction.retracted_by,
      retracted_at: retraction.retracted_at,
      signature: retraction.signature,
    });
    // Ignore duplicate key errors (23505) — retraction already stored
    if (error && error.code !== '23505') {
      throw new Error(`Failed to store retraction: ${error.message}`);
    }
  }

  async updateMessageLabels(messageId: string, labels: string[], quarantine: boolean, classification: Record<string, unknown>): Promise<void> {
    // Only escalate quarantine — never set quarantined from true to false.
    // If quarantine=true, set it. If quarantine=false, leave the existing value unchanged.
    if (quarantine) {
      await this.client
        .from('messages')
        .update({ safety_labels: labels, quarantined: true, classification })
        .eq('id', messageId);
    } else {
      // Only update labels and classification, preserve existing quarantine state
      await this.client
        .from('messages')
        .update({ safety_labels: labels, classification })
        .eq('id', messageId);
    }
  }

  async quarantineMessage(messageId: string): Promise<void> {
    // Append 'quarantined' to existing labels instead of overwriting
    // First get existing labels, then merge
    const { data: existing } = await this.client
      .from('messages')
      .select('safety_labels')
      .eq('id', messageId)
      .single();

    const currentLabels = (existing?.safety_labels as string[]) ?? [];
    const mergedLabels = [...new Set([...currentLabels, 'quarantined'])];

    await this.client
      .from('messages')
      .update({ quarantined: true, safety_labels: mergedLabels })
      .eq('id', messageId);
  }

  async getMessageOrigins(messageIds: string[]): Promise<Array<{ message_id: string; origin_instance_fingerprint: string; peer_id: string | null }>> {
    if (messageIds.length === 0) return [];
    const { data, error } = await this.client
      .from('gossip_message_origins')
      .select('message_id, origin_instance_fingerprint, peer_id')
      .in('message_id', messageIds);
    if (error) throw new Error(`Failed to read message origins: ${error.message}`);
    return (data ?? []) as Array<{ message_id: string; origin_instance_fingerprint: string; peer_id: string | null }>;
  }

  async quarantineFederatedMessage(messageId: string): Promise<boolean> {
    const { data: existing } = await this.client
      .from('messages')
      .select('safety_labels, origin_instance')
      .eq('id', messageId)
      .maybeSingle();
    // A message written on this instance has no origin_instance. Those are
    // never quarantined on another instance's say-so.
    if (!existing || existing.origin_instance == null) return false;

    const currentLabels = (existing.safety_labels as string[]) ?? [];
    const mergedLabels = [...new Set([...currentLabels, 'quarantined'])];

    const { data: updated, error } = await this.client
      .from('messages')
      .update({ quarantined: true, safety_labels: mergedLabels })
      .eq('id', messageId)
      // Repeated in the write itself so the guarantee does not depend on the
      // read above.
      .not('origin_instance', 'is', null)
      .select('id');
    if (error) throw new Error(`Failed to quarantine message: ${error.message}`);
    return (updated?.length ?? 0) > 0;
  }

  async quarantineMessagesBySuffix(idSuffix: string): Promise<void> {
    // For suffix-based quarantine, we can't easily merge per-message,
    // so we set quarantined=true but leave existing labels intact
    await this.client
      .from('messages')
      .update({ quarantined: true })
      .like('id', `%-${escapeLikePattern(idSuffix)}`);
  }

  // ── Quarantine Admin ────────────────────────────────────────────────────

  async listQuarantinedMessages(limit: number, offset: number): Promise<{ messages: QuarantinedMessage[]; total: number }> {
    const { data, error, count } = await this.client
      .from('messages')
      .select(`
        id, content, metadata, safety_labels, classification,
        origin_instance, author_display, hop_count, created_at,
        channels!inner(name, type, federation_scope),
        agents:author_agent_id(name)
      `, { count: 'exact' })
      .eq('quarantined', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Failed to list quarantined: ${error.message}`);

    const messages = (data ?? []).map((row: Record<string, unknown>) => {
      const ch = row.channels as Record<string, string>;
      const agent = row.agents as Record<string, string> | null;
      return {
        id: row.id as string,
        content: row.content as string,
        metadata: row.metadata as Record<string, unknown> | null,
        safety_labels: row.safety_labels as string[],
        classification: row.classification as Record<string, unknown> | null,
        origin_instance: row.origin_instance as string | null,
        author_display: row.author_display as string | null,
        hop_count: row.hop_count as number | null,
        created_at: row.created_at as string,
        channel_name: ch?.name ?? '',
        channel_type: ch?.type ?? '',
        author_name: agent?.name ?? null,
      };
    });

    return { messages, total: count ?? 0 };
  }

  async approveMessages(messageIds: string[]): Promise<number> {
    // Clear the quarantined label from safety_labels when approving
    const { data, error } = await this.client
      .from('messages')
      .update({ quarantined: false, safety_labels: [] })
      .in('id', messageIds)
      .eq('quarantined', true)
      .select('id');
    if (error) throw new Error(`Failed to approve: ${error.message}`);
    return data?.length ?? 0;
  }

  async deleteQuarantinedMessages(messageIds: string[]): Promise<number> {
    const { data, error } = await this.client
      .from('messages')
      .delete()
      .in('id', messageIds)
      .eq('quarantined', true)
      .select('id');
    if (error) throw new Error(`Failed to delete: ${error.message}`);
    return data?.length ?? 0;
  }

  // ── Circuit Breakers ────────────────────────────────────────────────────

  async suspendPeer(peerId: string, reason: string): Promise<void> {
    await this.client
      .from('gossip_peers')
      .update({
        active: false,
        suspended: true,
        suspended_at: new Date().toISOString(),
        suspended_reason: reason,
      })
      .eq('id', peerId);
  }

  async getMessageIdsFromPeer(peerId: string, since: string): Promise<string[]> {
    const { data } = await this.client
      .from('gossip_message_origins')
      .select('message_id')
      .eq('peer_id', peerId)
      .gt('received_at', since);
    return (data ?? []).map((row) => row.message_id);
  }

  async countQuarantinedInIds(messageIds: string[]): Promise<number> {
    let total = 0;
    for (let i = 0; i < messageIds.length; i += 100) {
      const batch = messageIds.slice(i, i + 100);
      const { count } = await this.client
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .in('id', batch)
        .eq('quarantined', true);
      total += count ?? 0;
    }
    return total;
  }

  async quarantineAllFromPeer(peerId: string): Promise<void> {
    const { data: origins } = await this.client
      .from('gossip_message_origins')
      .select('message_id')
      .eq('peer_id', peerId);

    if (!origins?.length) return;
    const ids = origins.map((o) => o.message_id);
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      await this.client
        .from('messages')
        .update({ quarantined: true })
        .in('id', batch);
    }
  }

  // ── Agent Quarantine Persistence ──────────────────────────────────────

  async isAgentQuarantined(agentKey: string): Promise<boolean> {
    const { data } = await this.client
      .from('gossip_agent_quarantines')
      .select('quarantined_until')
      .eq('agent_key', agentKey)
      .single();
    if (!data) return false;
    return new Date(data.quarantined_until).getTime() > Date.now();
  }

  async quarantineAgent(agentKey: string, until: string): Promise<void> {
    await this.client
      .from('gossip_agent_quarantines')
      .upsert(
        { agent_key: agentKey, quarantined_until: until, reason: 'Circuit breaker: repeated safety flags' },
        { onConflict: 'agent_key' }
      );
  }

  async clearExpiredAgentQuarantines(): Promise<void> {
    await this.client
      .from('gossip_agent_quarantines')
      .delete()
      .lt('quarantined_until', new Date().toISOString());
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async countRecentQuarantined(sinceMs: number): Promise<number> {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const { count } = await this.client
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('quarantined', true)
      .gt('created_at', since);
    return count ?? 0;
  }
}
