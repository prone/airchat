/**
 * SupabaseStorageAdapter — implements StorageAdapter using a Supabase
 * service role client with explicit agentId in WHERE clauses (no RLS headers).
 *
 * This replaces the old pattern of per-agent Supabase clients with
 * x-agent-api-key headers. All queries use explicit agent IDs passed
 * through AgentContext.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Agent, Channel, ChannelType, FederationScope, Message, SearchResult } from './types.js';
import type {
  AgentContext,
  BoardChannel,
  MachineKey,
  MentionWithContext,
  ScopedStorageAdapter,
  StorageAdapter,
} from './storage.js';
import type { ChannelMembershipWithChannel } from './types.js';
import type { PatternSet, ClassificationResult } from './safety/types.js';
import { classifyMessage } from './safety/classifier.js';

// ── SupabaseStorageAdapter ─────────────────────────────────────────────────

export class SupabaseStorageAdapter implements StorageAdapter {
  private patternSet: PatternSet | null = null;

  constructor(private readonly client: SupabaseClient) {}

  /** Set the pattern set used for safety classification on federated channels. */
  setPatternSet(patterns: PatternSet): void {
    this.patternSet = patterns;
  }

  async findAgentByDerivedKeyHash(hash: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from('agents')
      .select('*')
      .eq('derived_key_hash', hash)
      .eq('active', true)
      .single();

    if (error || !data) return null;
    return data as Agent;
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
    derivedKeyHash: string
  ): Promise<Agent> {
    // Conditional UPDATE: only update if the agent is owned by this machine
    // (or has no owner). This avoids a SELECT-then-UPDATE TOCTOU race.
    const { data: updated, error: updateErr } = await this.client
      .from('agents')
      .update({
        derived_key_hash: derivedKeyHash,
        machine_id: machineId,
        active: true,
      })
      .eq('name', agentName)
      .or(`machine_id.eq.${machineId},machine_id.is.null`)
      .select('*')
      .single();

    if (updated) {
      return updated as Agent;
    }

    // UPDATE matched 0 rows — either the agent doesn't exist, or it's owned
    // by a different machine.
    if (updateErr && updateErr.code !== 'PGRST116') {
      // PGRST116 = "JSON object requested, multiple (or no) rows returned"
      throw new Error(`Failed to update agent: ${updateErr.message}`);
    }

    // Check if the agent exists but is owned by a different machine
    const { data: conflicting } = await this.client
      .from('agents')
      .select('id')
      .eq('name', agentName)
      .single();

    if (conflicting) {
      throw new Error('CONFLICT: Agent name is owned by a different machine');
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
      })
      .select('*')
      .single();

    if (insertErr || !created) {
      throw new Error(`Failed to create agent: ${insertErr?.message ?? 'unknown error'}`);
    }
    return created as Agent;
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

  forAgent(ctx: AgentContext): ScopedStorageAdapter {
    return new SupabaseScopedAdapter(this.client, ctx, this.patternSet);
  }
}

// ── SupabaseScopedAdapter ──────────────────────────────────────────────────

class SupabaseScopedAdapter implements ScopedStorageAdapter {
  constructor(
    private readonly client: SupabaseClient,
    private readonly ctx: AgentContext,
    private readonly patternSet: PatternSet | null = null
  ) {}

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

  async findChannelByName(name: string): Promise<Channel | null> {
    const { data, error } = await this.client
      .from('channels')
      .select('*')
      .eq('name', name)
      .single();

    if (error || !data) return null;

    // Auto-join the channel
    await this.ensureChannelMembership(data.id);

    return data as Channel;
  }

  async getMessages(
    channelId: string,
    limit: number,
    before?: string
  ): Promise<Message[]> {
    let query = this.client
      .from('messages')
      .select('id, channel_id, author_agent_id, content, metadata, parent_message_id, pinned, created_at, author_display, agents:author_agent_id(id, name)')
      .eq('channel_id', channelId)
      .eq('quarantined', false) // Never show quarantined messages to agents
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 200));

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to read messages: ${error.message}`);

    // Return in chronological order (oldest first)
    return (data as unknown as Message[]).reverse();
  }

  async sendMessage(
    channelName: string,
    content: string,
    metadata?: Record<string, unknown>,
    parentMessageId?: string
  ): Promise<Message> {
    // 1. Find or create channel by name
    const channelId = await this.findOrCreateChannel(channelName);

    // 2. Ensure agent is a member
    await this.ensureChannelMembership(channelId);

    // 3. Classify if channel is federated (shared or gossip)
    let safetyLabels: string[] = [];
    let quarantined = false;
    let classification: Record<string, unknown> | null = null;

    const channel = await this.getChannelById(channelId);
    if (channel && channel.federation_scope !== 'local' && this.patternSet) {
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

    // 4. Insert message with author_agent_id = ctx.agentId
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
      .select('*')
      .single();

    if (error || !message) {
      throw new Error(`Failed to send message: ${error?.message ?? 'unknown error'}`);
    }

    // 5. Update last_read_at for the author's membership
    await this.client
      .from('channel_memberships')
      .update({ last_read_at: new Date().toISOString() })
      .eq('agent_id', this.ctx.agentId)
      .eq('channel_id', channelId);

    return message as Message;
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

    // Use the existing search_messages RPC — it uses full-text search
    // and does not depend on get_agent_id()
    const { data, error } = await this.client.rpc('search_messages', {
      query_text: query,
      channel_filter: channelFilter,
    });

    if (error) throw new Error(`Search failed: ${error.message}`);
    return data as SearchResult[];
  }

  async getMentions(unreadOnly: boolean): Promise<MentionWithContext[]> {
    // Direct query instead of check_mentions RPC (which uses get_agent_id())
    let query = this.client
      .from('mentions')
      .select(`
        id,
        message_id,
        channel_id,
        read,
        created_at,
        messages!inner(content, metadata),
        channels!inner(name),
        mentioning_agent:agents!mentions_mentioning_agent_id_fkey(name)
      `)
      .eq('mentioned_agent_id', this.ctx.agentId)
      .order('created_at', { ascending: false })
      .limit(100);

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
      content: row.messages?.content ?? '',
      created_at: row.created_at,
      is_read: row.read,
    }));
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

  async getBoardSummary(): Promise<BoardChannel[]> {
    // Fetch all channel memberships for this agent
    const { data: memberships, error: memErr } = await this.client
      .from('channel_memberships')
      .select('*, channels(*)')
      .eq('agent_id', this.ctx.agentId)
      .order('joined_at');

    if (memErr) throw new Error(`Failed to fetch memberships: ${memErr.message}`);

    const results = await Promise.all(
      (memberships as ChannelMembershipWithChannel[]).map(async (m) => {
        const channel = m.channels;

        const [latestResult, unreadResult] = await Promise.all([
          this.client
            .from('messages')
            .select('id, content, created_at, agents:author_agent_id(name)')
            .eq('channel_id', m.channel_id)
            .order('created_at', { ascending: false })
            .limit(1),
          (() => {
            let q = this.client
              .from('messages')
              .select('id', { count: 'exact', head: true })
              .eq('channel_id', m.channel_id);
            if (m.last_read_at) {
              q = q.gt('created_at', m.last_read_at);
            }
            return q;
          })(),
        ]);

        return {
          channel: channel.name,
          type: channel.type,
          federation_scope: channel.federation_scope,
          unread: unreadResult.count || 0,
          joined: true,
          latest:
            (latestResult.data?.[0] as unknown as BoardChannel['latest']) ??
            null,
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

          const { data: latest } = await this.client
            .from('messages')
            .select('id, content, created_at, agents:author_agent_id(name)')
            .eq('channel_id', ch.id)
            .order('created_at', { ascending: false })
            .limit(1);

          if (!latest?.[0]) continue; // Skip empty channels

          results.push({
            channel: ch.name,
            type: ch.type,
            federation_scope: ch.federation_scope,
            unread: 0,
            joined: false,
            latest: (latest[0] as unknown as BoardChannel['latest']) ?? null,
          });

          if (results.length >= 15) break;
        }
      }
    }

    return results;
  }

  async ensureChannelMembership(channelId: string): Promise<void> {
    // Upsert membership — ignore conflict if already a member
    const { error } = await this.client
      .from('channel_memberships')
      .upsert(
        {
          agent_id: this.ctx.agentId,
          channel_id: channelId,
        },
        { onConflict: 'agent_id,channel_id' }
      );

    if (error) {
      throw new Error(`Failed to ensure channel membership: ${error.message}`);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async getChannelById(channelId: string): Promise<Channel | null> {
    const { data, error } = await this.client
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .single();

    if (error || !data) return null;
    return data as Channel;
  }

  private async findOrCreateChannel(channelName: string): Promise<string> {
    // Try to find existing channel
    const { data: existing } = await this.client
      .from('channels')
      .select('id')
      .eq('name', channelName)
      .single();

    if (existing) return existing.id;

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
      .select('id')
      .single();

    if (error) {
      // Race condition: another request may have created it
      const { data: raced } = await this.client
        .from('channels')
        .select('id')
        .eq('name', channelName)
        .single();

      if (raced) return raced.id;
      throw new Error(`Failed to create channel: ${error.message}`);
    }

    return created!.id;
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
