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

export class SupabaseGossipAdapter implements GossipStorageAdapter {
  constructor(private readonly client: SupabaseClient) {}

  // ── Instance Config ─────────────────────────────────────────────────────

  async getInstanceConfig(): Promise<GossipInstanceConfig | null> {
    const { data, error } = await this.client
      .from('gossip_instance_config')
      .select('id, public_key, fingerprint, display_name, domain, gossip_enabled')
      .limit(1)
      .single();
    if (error || !data) return null;
    return data as GossipInstanceConfig;
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

  async findOrCreateRemoteAgent(name: string, peerFingerprint: string, originInstance: string | null): Promise<string | null> {
    const { data: existing } = await this.client
      .from('agents')
      .select('id')
      .eq('name', name)
      .single();
    if (existing) return existing.id;

    // Insert with conflict handling for race conditions
    const { data: created, error } = await this.client
      .from('agents')
      .insert({
        name,
        api_key_hash: `remote:${peerFingerprint}:${Date.now()}`,
        active: true,
        metadata: { remote: true, origin_instance: originInstance },
      })
      .select('id')
      .single();

    if (error) {
      // Race: another request created it — retry the find
      const { data: raced } = await this.client
        .from('agents')
        .select('id')
        .eq('name', name)
        .single();
      return raced?.id ?? null;
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
    const { error } = await this.client.from('messages').insert(msg);
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

  async quarantineMessage(messageId: string): Promise<void> {
    await this.client
      .from('messages')
      .update({ quarantined: true, safety_labels: ['quarantined'] })
      .eq('id', messageId);
  }

  async quarantineMessagesBySuffix(idSuffix: string): Promise<void> {
    await this.client
      .from('messages')
      .update({ quarantined: true, safety_labels: ['quarantined'] })
      .like('id', `%-${idSuffix}`);
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
    const { data, error } = await this.client
      .from('messages')
      .update({ quarantined: false })
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
