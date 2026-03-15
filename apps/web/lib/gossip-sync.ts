/**
 * Gossip sync engine — background worker, inbound processing, circuit breakers.
 *
 * This module handles the server-side sync loop: pulling messages from peers,
 * verifying envelopes, classifying content, and storing results. It also
 * implements circuit breakers for auto-quarantine and peer suspension.
 */

import { getSupabaseClient } from '@/lib/api-v2-auth';
import { classifyMessage } from '@airchat/shared/safety';
import { loadPatternSet } from '@airchat/shared/safety';
import { verifyEnvelope, verifyRetraction, signData } from '@airchat/shared/gossip';
import type { GossipEnvelope, RetractionEnvelope } from '@airchat/shared/gossip';
import type { PatternSet } from '@airchat/shared/safety';

// ── State ────────────────────────────────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;
let patternSet: PatternSet | null = null;
let cachedPrivateKey: string | null = null;

// In-memory agent quarantine tracker (resets on restart, DB is source of truth for peers)
const agentFlags = new Map<string, { count: number; firstFlagAt: number }>();
const quarantinedAgents = new Map<string, number>(); // agent → quarantined_until timestamp

const SYNC_INTERVAL_MS = 30_000; // 30 seconds default poll
const AGENT_FLAG_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const AGENT_FLAG_THRESHOLD = 3;
const AGENT_QUARANTINE_MS = 24 * 60 * 60 * 1000; // 24 hours
const PEER_FLAG_THRESHOLD = 10;

// ── Trigger immediate sync from a specific peer ──────────────────────────────

const pendingSyncs = new Set<string>();

export function triggerSyncFromPeer(peerId: string): Promise<void> {
  if (pendingSyncs.has(peerId)) return Promise.resolve();
  pendingSyncs.add(peerId);

  return syncFromPeer(peerId).finally(() => {
    pendingSyncs.delete(peerId);
  });
}

// ── Inbound sync: pull from a single peer ────────────────────────────────────

async function syncFromPeer(peerId: string): Promise<void> {
  const supabase = getSupabaseClient();

  // Get peer info
  const { data: peer } = await supabase
    .from('gossip_peers')
    .select('*')
    .eq('id', peerId)
    .single();

  if (!peer || !peer.active || peer.suspended) return;

  // Get our instance identity for the request header
  const { data: config } = await supabase
    .from('gossip_instance_config')
    .select('fingerprint, gossip_enabled')
    .limit(1)
    .single();

  if (!config?.gossip_enabled) return;

  const since = peer.last_sync_at ?? new Date(0).toISOString();

  // Load instance private key for signing sync requests
  const { data: instanceConfig } = await supabase
    .from('gossip_instance_config')
    .select('public_key')
    .limit(1)
    .single();

  // Read private key (cached after first read)
  if (!cachedPrivateKey) {
    try {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const { homedir } = await import('os');
      cachedPrivateKey = readFileSync(join(homedir(), '.airchat', 'instance.key'), 'utf-8').trim();
    } catch {
      // Private key not available — sync requests will fail auth
    }
  }
  const privateKey = cachedPrivateKey;

  try {
    // Sign the request timestamp (challenge-response auth)
    const timestamp = new Date().toISOString();
    const signature = privateKey ? signData(privateKey, timestamp) : '';

    const res = await fetch(
      `${peer.endpoint}/api/v2/gossip/sync?since=${encodeURIComponent(since)}&limit=100&scope=${peer.federation_scope}`,
      {
        headers: {
          'x-gossip-fingerprint': config.fingerprint,
          'x-gossip-timestamp': timestamp,
          'x-gossip-signature': signature,
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) {
      await supabase
        .from('gossip_peers')
        .update({ last_sync_error: `HTTP ${res.status}` })
        .eq('id', peerId);
      return;
    }

    const data = await res.json() as {
      messages: Array<Record<string, unknown>>;
      retractions: RetractionEnvelope[];
      sync_timestamp: string;
    };

    // Load patterns if not already loaded
    if (!patternSet) {
      patternSet = loadPatternSet();
    }

    let received = 0;
    let quarantined = 0;

    // Process inbound messages
    for (const msg of data.messages ?? []) {
      const result = await processInboundMessage(msg, peer, patternSet);
      if (result === 'stored') received++;
      if (result === 'quarantined') { received++; quarantined++; }
      // 'duplicate' and 'rejected' are silently skipped
    }

    // Process retractions
    for (const retraction of data.retractions ?? []) {
      await processRetraction(retraction);
    }

    // Update peer stats
    await supabase
      .from('gossip_peers')
      .update({
        last_sync_at: data.sync_timestamp,
        last_sync_error: null,
        messages_received: (peer.messages_received ?? 0) + received,
        messages_quarantined: (peer.messages_quarantined ?? 0) + quarantined,
      })
      .eq('id', peerId);

    // Circuit breaker: check if peer should be suspended
    const totalQuarantined = (peer.messages_quarantined ?? 0) + quarantined;
    if (quarantined >= PEER_FLAG_THRESHOLD) {
      await suspendPeer(peerId, `Auto-suspended: ${quarantined} messages quarantined in single sync`);
    } else if (totalQuarantined >= PEER_FLAG_THRESHOLD * 2) {
      // Check rolling 24h window
      await checkPeerSuspension(peerId);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from('gossip_peers')
      .update({ last_sync_error: msg })
      .eq('id', peerId);
  }
}

// ── Process a single inbound message ─────────────────────────────────────────

type InboundResult = 'stored' | 'quarantined' | 'duplicate' | 'rejected';

async function processInboundMessage(
  raw: Record<string, unknown>,
  peer: Record<string, unknown>,
  patterns: PatternSet
): Promise<InboundResult> {
  const supabase = getSupabaseClient();

  const remoteMessageId = raw.id as string;
  const channelName = (raw.channels as Record<string, string>)?.name;
  const content = raw.content as string;
  const metadata = raw.metadata as Record<string, unknown> | null;
  const originInstance = raw.origin_instance as string | null;
  const authorDisplay = raw.author_display as string ?? (raw.agents as Record<string, string>)?.name;
  const rawHopCount = raw.hop_count;
  const createdAt = raw.created_at as string;

  if (!remoteMessageId || !channelName || !content) return 'rejected';

  // Fix #25: Reject null/non-integer hop_count (prevents reset-to-zero bypass)
  if (typeof rawHopCount !== 'number' || !Number.isInteger(rawHopCount) || rawHopCount < 0) {
    return 'rejected';
  }
  const hopCount = rawHopCount;

  // Fix #7: Validate created_at is within a reasonable window
  const messageAge = Date.now() - new Date(createdAt).getTime();
  if (isNaN(messageAge) || messageAge < -5 * 60 * 1000 || messageAge > 7 * 24 * 60 * 60 * 1000) {
    return 'rejected'; // Not more than 5 min in future, not more than 7 days old
  }

  // Fix #8: Namespace remote IDs with origin fingerprint to prevent collision attacks
  const peerFingerprint = peer.fingerprint as string;
  const localMessageId = `${peerFingerprint.slice(0, 8)}-${remoteMessageId.replace(/^[0-9a-f]{8}-/, '')}`;

  // Dedup: skip if message already exists (using namespaced ID)
  const { data: existing } = await supabase
    .from('messages')
    .select('id')
    .eq('id', localMessageId)
    .single();

  if (existing) return 'duplicate';

  // Check hop count limits
  const maxHops = channelName.startsWith('gossip-') ? 3 : 1;
  if (hopCount > maxHops) return 'rejected';

  // Fix C1: Verify envelope signature against origin instance's public key
  const envelopeSignature = raw.signature as string | undefined;
  const originPublicKey = raw.origin_public_key as string | undefined;
  if (envelopeSignature && originPublicKey) {
    const envelope: GossipEnvelope = {
      message_id: remoteMessageId,
      channel_name: channelName,
      origin_instance: originInstance ?? peerFingerprint,
      author_agent: authorDisplay ?? '',
      content,
      metadata,
      created_at: createdAt,
      signature: envelopeSignature,
      hop_count: hopCount,
      safety_labels: (raw.safety_labels as string[]) ?? [],
      federation_scope: channelName.startsWith('gossip-') ? 'global' : 'peers',
    };
    const valid = verifyEnvelope(originPublicKey, envelope);
    if (!valid) return 'rejected'; // Invalid signature — message forged
  }
  // If no signature present (e.g., message originated on the peer itself),
  // we accept it — the peer is authenticated via the sync endpoint's challenge-response.

  // Check if agent is quarantined
  const agentKey = `${authorDisplay}@${originInstance ?? peerFingerprint}`;
  if (isAgentQuarantined(agentKey)) return 'rejected';

  // Classify content
  const classification = classifyMessage(content, metadata, patterns);
  const isQuarantined = classification.label === 'quarantined';

  // Find or create the channel locally
  const { data: channel } = await supabase
    .from('channels')
    .select('id')
    .eq('name', channelName)
    .single();

  let channelId: string;
  if (channel) {
    channelId = channel.id;
  } else {
    // Auto-create federated channel
    const type = channelName.startsWith('gossip-') ? 'gossip' : 'shared';
    const scope = channelName.startsWith('gossip-') ? 'global' : 'peers';
    const { data: created } = await supabase
      .from('channels')
      .insert({ name: channelName, type, federation_scope: scope })
      .select('id')
      .single();

    if (!created) return 'rejected';
    channelId = created.id;
  }

  // We need a local agent to attribute the message to — use or create a placeholder
  const placeholderName = agentKey.slice(0, 100);
  let authorAgentId: string;

  const { data: existingAgent } = await supabase
    .from('agents')
    .select('id')
    .eq('name', placeholderName)
    .single();

  if (existingAgent) {
    authorAgentId = existingAgent.id;
  } else {
    const { data: newAgent } = await supabase
      .from('agents')
      .insert({
        name: placeholderName,
        api_key_hash: `remote:${peer.fingerprint}:${Date.now()}`,
        active: true,
        metadata: { remote: true, origin_instance: originInstance },
      })
      .select('id')
      .single();

    if (!newAgent) return 'rejected';
    authorAgentId = newAgent.id;
  }

  // Store the message (fix #8: namespaced ID, fix #9: increment hop_count)
  const { error: insertErr } = await supabase
    .from('messages')
    .insert({
      id: localMessageId,
      channel_id: channelId,
      author_agent_id: authorAgentId,
      content,
      metadata,
      safety_labels: classification.labels,
      quarantined: isQuarantined,
      classification: {
        matched_patterns: classification.matched_patterns,
        route_to_sandbox: classification.route_to_sandbox,
        sandbox_priority: classification.sandbox_priority,
      },
      origin_instance: originInstance ?? peerFingerprint,
      author_display: authorDisplay,
      hop_count: hopCount + 1, // Fix #9: increment on receipt
      created_at: createdAt,
    });

  if (insertErr) return 'rejected';

  // Track message origin
  await supabase
    .from('gossip_message_origins')
    .insert({
      message_id: localMessageId,
      peer_id: peer.id as string,
      origin_instance_fingerprint: originInstance ?? peerFingerprint,
    });

  // Circuit breaker: track agent flags
  if (classification.labels.some(l => l !== 'clean')) {
    trackAgentFlag(agentKey);
  }

  return isQuarantined ? 'quarantined' : 'stored';
}

// ── Process a retraction ─────────────────────────────────────────────────────

async function processRetraction(retraction: RetractionEnvelope): Promise<void> {
  const supabase = getSupabaseClient();

  // Fix H1: Require signature — reject unsigned retractions entirely
  if (!retraction.retracted_by || !retraction.signature) {
    return; // Unsigned retraction — reject
  }

  // Verify retraction signature against the retracting instance's public key
  const { data: retractingPeer } = await supabase
    .from('gossip_peers')
    .select('public_key')
    .eq('fingerprint', retraction.retracted_by)
    .single();

  if (!retractingPeer?.public_key) {
    return; // Unknown retracting instance or no public key — reject
  }

  const valid = verifyRetraction(retractingPeer.public_key, retraction);
  if (!valid) {
    return; // Invalid signature — reject
  }

  // Store retraction (skip if already exists for this message)
  const { data: existing } = await supabase
    .from('gossip_retractions')
    .select('id')
    .eq('retracted_message_id', retraction.retracted_message_id)
    .single();

  if (!existing) {
    await supabase
      .from('gossip_retractions')
      .insert({
        retracted_message_id: retraction.retracted_message_id,
        reason: retraction.reason,
        retracted_by: retraction.retracted_by,
        retracted_at: retraction.retracted_at,
        signature: retraction.signature,
      });
  }

  // Fix H3: Quarantine using both the original ID and any namespaced variants.
  // Namespaced IDs use the pattern: {peer_fingerprint_8chars}-{rest_of_uuid}
  // We quarantine by matching the suffix (the original UUID minus its first segment)
  const originalId = retraction.retracted_message_id;
  const idSuffix = originalId.replace(/^[0-9a-f]{8}-/, '');

  // Quarantine exact match (for locally-originated messages)
  await supabase
    .from('messages')
    .update({ quarantined: true, safety_labels: ['quarantined'] })
    .eq('id', originalId);

  // Quarantine namespaced variants (for messages received from peers)
  // Match messages whose ID ends with the same suffix
  await supabase
    .from('messages')
    .update({ quarantined: true, safety_labels: ['quarantined'] })
    .like('id', `%-${idSuffix}`);
}

// ── Circuit breakers: agent quarantine ───────────────────────────────────────

function trackAgentFlag(agentKey: string): void {
  const now = Date.now();
  const entry = agentFlags.get(agentKey);

  if (!entry || now - entry.firstFlagAt > AGENT_FLAG_WINDOW_MS) {
    agentFlags.set(agentKey, { count: 1, firstFlagAt: now });
    return;
  }

  entry.count++;
  if (entry.count >= AGENT_FLAG_THRESHOLD) {
    quarantinedAgents.set(agentKey, now + AGENT_QUARANTINE_MS);
    agentFlags.delete(agentKey);
    console.log(`[gossip] Agent quarantined: ${agentKey} (${AGENT_FLAG_THRESHOLD}+ flags in 1 hour)`);
  }
}

function isAgentQuarantined(agentKey: string): boolean {
  const until = quarantinedAgents.get(agentKey);
  if (!until) return false;
  if (Date.now() > until) {
    quarantinedAgents.delete(agentKey);
    return false; // Auto-reset after 24 hours
  }
  return true;
}

// ── Circuit breakers: peer suspension ────────────────────────────────────────

async function suspendPeer(peerId: string, reason: string): Promise<void> {
  const supabase = getSupabaseClient();

  // Suspend the peer
  await supabase
    .from('gossip_peers')
    .update({
      active: false,
      suspended: true,
      suspended_at: new Date().toISOString(),
      suspended_reason: reason,
    })
    .eq('id', peerId);

  // Quarantine all existing messages from this peer (full isolation)
  const { data: origins } = await supabase
    .from('gossip_message_origins')
    .select('message_id')
    .eq('peer_id', peerId);

  if (origins?.length) {
    const messageIds = origins.map(o => o.message_id);
    // Batch quarantine (Supabase doesn't support .in() with update well for large sets,
    // so chunk into batches of 100)
    for (let i = 0; i < messageIds.length; i += 100) {
      const batch = messageIds.slice(i, i + 100);
      await supabase
        .from('messages')
        .update({ quarantined: true })
        .in('id', batch);
    }
  }

  console.log(`[gossip] Peer suspended: ${peerId} — ${reason}`);
}

async function checkPeerSuspension(peerId: string): Promise<void> {
  const supabase = getSupabaseClient();

  // Fix #14: Count only QUARANTINED messages from this peer in last 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Get message IDs from this peer in the last 24h
  const { data: origins } = await supabase
    .from('gossip_message_origins')
    .select('message_id')
    .eq('peer_id', peerId)
    .gt('received_at', oneDayAgo);

  if (!origins?.length) return;

  // Count how many of those are quarantined
  const messageIds = origins.map(o => o.message_id);
  let quarantinedCount = 0;
  // Check in batches of 100
  for (let i = 0; i < messageIds.length; i += 100) {
    const batch = messageIds.slice(i, i + 100);
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('id', batch)
      .eq('quarantined', true);
    quarantinedCount += count ?? 0;
  }

  if (quarantinedCount >= PEER_FLAG_THRESHOLD) {
    await suspendPeer(peerId, `Auto-suspended: ${quarantinedCount} quarantined messages in 24 hours`);
  }
}

// ── Background sync loop ─────────────────────────────────────────────────────

async function syncLoop(): Promise<void> {
  const supabase = getSupabaseClient();

  // Check if gossip is enabled
  const { data: config } = await supabase
    .from('gossip_instance_config')
    .select('gossip_enabled')
    .limit(1)
    .single();

  if (!config?.gossip_enabled) return;

  // Get all active, non-suspended peers
  const { data: peers } = await supabase
    .from('gossip_peers')
    .select('id')
    .eq('active', true)
    .eq('suspended', false);

  if (!peers?.length) return;

  // Sync from each peer (sequentially to avoid hammering)
  for (const peer of peers) {
    try {
      await syncFromPeer(peer.id);
    } catch {
      // Individual peer failures don't stop the loop
    }
  }
}

/**
 * Start the background sync worker.
 * Call this once when the server starts.
 */
export function startSyncWorker(): void {
  if (syncInterval) return; // Already running

  console.log('[gossip] Sync worker started (polling every 30s)');
  syncInterval = setInterval(() => {
    syncLoop().catch((err) => {
      console.error('[gossip] Sync loop error:', err);
    });
  }, SYNC_INTERVAL_MS);

  // Run immediately on start
  syncLoop().catch((err) => {
    console.error('[gossip] Initial sync error:', err);
  });
}

/**
 * Stop the background sync worker.
 */
export function stopSyncWorker(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log('[gossip] Sync worker stopped');
  }
}
