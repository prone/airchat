/**
 * Gossip sync engine — background worker, inbound processing, circuit breakers.
 *
 * Uses GossipStorageAdapter for all DB operations (no direct Supabase calls).
 */

import { getGossipAdapter } from '@/lib/api-v2-auth';
import { classifyMessage } from '@airchat/shared/safety';
import { loadPatternSet } from '@airchat/shared/safety';
import { verifyEnvelope, verifyRetraction, signData } from '@airchat/shared/gossip';
import type { GossipEnvelope, RetractionEnvelope } from '@airchat/shared/gossip';
import type { PatternSet } from '@airchat/shared/safety';
import type { GossipStorageAdapter, GossipPeer } from '@airchat/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── State ────────────────────────────────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;
let patternSet: PatternSet | null = null;
let cachedPrivateKey: string | null = null;

// In-memory agent quarantine tracker
const agentFlags = new Map<string, { count: number; firstFlagAt: number }>();
const quarantinedAgents = new Map<string, number>();

const SYNC_INTERVAL_MS = 30_000;
const AGENT_FLAG_WINDOW_MS = 60 * 60 * 1000;
const AGENT_FLAG_THRESHOLD = 3;
const AGENT_QUARANTINE_MS = 24 * 60 * 60 * 1000;
const PEER_FLAG_THRESHOLD = 10;

// ── Trigger immediate sync ──────────────────────────────────────────────────

const pendingSyncs = new Set<string>();

export function triggerSyncFromPeer(peerId: string): Promise<void> {
  if (pendingSyncs.has(peerId)) return Promise.resolve();
  pendingSyncs.add(peerId);
  return syncFromPeer(peerId).finally(() => pendingSyncs.delete(peerId));
}

// ── Private key loading (cached) ─────────────────────────────────────────────

async function getPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey) return cachedPrivateKey;
  try {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    cachedPrivateKey = readFileSync(join(homedir(), '.airchat', 'instance.key'), 'utf-8').trim();
  } catch { /* not available */ }
  return cachedPrivateKey;
}

// ── Sync from a single peer ─────────────────────────────────────────────────

async function syncFromPeer(peerId: string): Promise<void> {
  const gossip = getGossipAdapter();

  const peer = await gossip.getPeerById(peerId);
  if (!peer || !peer.active || peer.suspended) return;

  const config = await gossip.getInstanceConfig();
  if (!config?.gossip_enabled) return;

  const since = peer.last_sync_at ?? new Date(0).toISOString();
  const privateKey = await getPrivateKey();

  // M10: Cannot authenticate without a private key — skip this peer
  if (!privateKey) {
    await gossip.updatePeer(peerId, { last_sync_error: 'Instance private key not found' } as Partial<GossipPeer>);
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    const signature = signData(privateKey, timestamp);

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
      await gossip.updatePeer(peerId, { last_sync_error: `HTTP ${res.status}` } as Partial<GossipPeer>);
      return;
    }

    const data = await res.json() as {
      messages: Array<Record<string, unknown>>;
      retractions: RetractionEnvelope[];
      sync_timestamp: string;
    };

    if (!patternSet) patternSet = loadPatternSet();

    let received = 0;
    let quarantined = 0;

    for (const msg of data.messages ?? []) {
      const result = await processInboundMessage(msg, peer, gossip, patternSet);
      if (result === 'stored') received++;
      if (result === 'quarantined') { received++; quarantined++; }
    }

    for (const retraction of data.retractions ?? []) {
      await processRetraction(retraction, gossip);
    }

    await gossip.updatePeer(peerId, {
      last_sync_at: data.sync_timestamp,
      last_sync_error: null,
      messages_received: (peer.messages_received ?? 0) + received,
      messages_quarantined: (peer.messages_quarantined ?? 0) + quarantined,
    } as Partial<GossipPeer>);

    // Circuit breaker: check peer suspension
    if (quarantined >= PEER_FLAG_THRESHOLD) {
      await suspendPeer(gossip, peerId, `Auto-suspended: ${quarantined} messages quarantined in single sync`);
    } else if ((peer.messages_quarantined ?? 0) + quarantined >= PEER_FLAG_THRESHOLD * 2) {
      await checkPeerSuspension(gossip, peerId);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await gossip.updatePeer(peerId, { last_sync_error: msg } as Partial<GossipPeer>);
  }
}

// ── Process inbound message ─────────────────────────────────────────────────

type InboundResult = 'stored' | 'quarantined' | 'duplicate' | 'rejected';

async function processInboundMessage(
  raw: Record<string, unknown>,
  peer: GossipPeer,
  gossip: GossipStorageAdapter,
  patterns: PatternSet
): Promise<InboundResult> {
  const remoteMessageId = raw.id as string;
  const channelName = (raw.channels as Record<string, string>)?.name;
  const content = raw.content as string;
  const metadata = raw.metadata as Record<string, unknown> | null;
  const originInstance = raw.origin_instance as string | null;
  const authorDisplay = raw.author_display as string ?? (raw.agents as Record<string, string>)?.name;
  const rawHopCount = raw.hop_count;
  const createdAt = raw.created_at as string;

  if (!remoteMessageId || !channelName || !content) return 'rejected';

  // Validate hop_count
  if (typeof rawHopCount !== 'number' || !Number.isInteger(rawHopCount) || rawHopCount < 0) {
    return 'rejected';
  }

  // Validate timestamp
  const messageAge = Date.now() - new Date(createdAt).getTime();
  if (isNaN(messageAge) || messageAge < -5 * 60 * 1000 || messageAge > 7 * 24 * 60 * 60 * 1000) {
    return 'rejected';
  }

  // Namespace remote ID
  const localMessageId = `${peer.fingerprint.slice(0, 8)}-${remoteMessageId.replace(/^[0-9a-f]{8}-/, '')}`;

  // Dedup
  if (await gossip.messageExists(localMessageId)) return 'duplicate';

  // Hop limit
  const maxHops = channelName.startsWith('gossip-') ? 3 : 1;
  if (rawHopCount > maxHops) return 'rejected';

  // Verify envelope signature if present
  const envelopeSignature = raw.signature as string | undefined;
  const originPublicKey = raw.origin_public_key as string | undefined;
  if (envelopeSignature && originPublicKey) {
    const envelope: GossipEnvelope = {
      message_id: remoteMessageId,
      channel_name: channelName,
      origin_instance: originInstance ?? peer.fingerprint,
      author_agent: authorDisplay ?? '',
      content,
      metadata,
      created_at: createdAt,
      signature: envelopeSignature,
      hop_count: rawHopCount,
      safety_labels: (raw.safety_labels as string[]) ?? [],
      federation_scope: channelName.startsWith('gossip-') ? 'global' : 'peers',
    };
    if (!verifyEnvelope(originPublicKey, envelope)) return 'rejected';
  }

  // Agent quarantine check
  const agentKey = `${authorDisplay}@${originInstance ?? peer.fingerprint}`;
  if (isAgentQuarantined(agentKey)) return 'rejected';

  // Classify
  const classification = classifyMessage(content, metadata, patterns);
  const isQuarantined = classification.label === 'quarantined';

  // Find or create channel
  const type = channelName.startsWith('gossip-') ? 'gossip' : 'shared';
  const scope = channelName.startsWith('gossip-') ? 'global' : 'peers';
  const channelId = await gossip.findOrCreateChannelId(channelName, type, scope);
  if (!channelId) return 'rejected';

  // Find or create remote agent
  const agentId = await gossip.findOrCreateRemoteAgent(
    agentKey.slice(0, 100),
    peer.fingerprint,
    originInstance
  );
  if (!agentId) return 'rejected';

  // Store
  const stored = await gossip.insertFederatedMessage({
    id: localMessageId,
    channel_id: channelId,
    author_agent_id: agentId,
    content,
    metadata,
    safety_labels: classification.labels,
    quarantined: isQuarantined,
    classification: {
      matched_patterns: classification.matched_patterns,
      route_to_sandbox: classification.route_to_sandbox,
      sandbox_priority: classification.sandbox_priority,
    },
    origin_instance: originInstance ?? peer.fingerprint,
    author_display: authorDisplay,
    hop_count: rawHopCount + 1,
    created_at: createdAt,
  });

  if (!stored) return 'rejected';

  await gossip.trackMessageOrigin(localMessageId, peer.id, originInstance ?? peer.fingerprint);

  // Only track flags for labels indicating actual safety concerns
  const safetyLabels = new Set(['contains-instructions', 'requests-data', 'references-tools', 'high-entropy', 'quarantined']);
  if (classification.labels.some(l => safetyLabels.has(l))) {
    trackAgentFlag(agentKey);
  }

  return isQuarantined ? 'quarantined' : 'stored';
}

// ── Process retraction ──────────────────────────────────────────────────────

async function processRetraction(retraction: RetractionEnvelope, gossip: GossipStorageAdapter): Promise<void> {
  if (!retraction.retracted_by || !retraction.signature) return;

  // H5: Validate retracted_message_id is a valid UUID
  if (!UUID_RE.test(retraction.retracted_message_id)) return;

  const peer = await gossip.getPeerByFingerprint(retraction.retracted_by);
  if (!peer?.public_key) return;

  if (!verifyRetraction(peer.public_key, retraction)) return;

  await gossip.storeRetraction({
    retracted_message_id: retraction.retracted_message_id,
    reason: retraction.reason,
    retracted_by: retraction.retracted_by,
    retracted_at: retraction.retracted_at,
    signature: retraction.signature,
  });

  // Quarantine using both original ID and namespaced variants
  // H2: UUID is validated above, so suffix is safe (no LIKE wildcards possible in a valid UUID)
  const idSuffix = retraction.retracted_message_id.replace(/^[0-9a-f]{8}-/, '');
  await gossip.quarantineMessage(retraction.retracted_message_id);
  await gossip.quarantineMessagesBySuffix(idSuffix);
}

// ── Agent circuit breakers ──────────────────────────────────────────────────

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
  }
}

function isAgentQuarantined(agentKey: string): boolean {
  const until = quarantinedAgents.get(agentKey);
  if (!until) return false;
  if (Date.now() > until) { quarantinedAgents.delete(agentKey); return false; }
  return true;
}

// ── Peer circuit breakers ───────────────────────────────────────────────────

async function suspendPeer(gossip: GossipStorageAdapter, peerId: string, reason: string): Promise<void> {
  await gossip.suspendPeer(peerId, reason);
  await gossip.quarantineAllFromPeer(peerId);
  console.log(`[gossip] Peer suspended: ${peerId} — ${reason}`);
}

async function checkPeerSuspension(gossip: GossipStorageAdapter, peerId: string): Promise<void> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const messageIds = await gossip.getMessageIdsFromPeer(peerId, oneDayAgo);
  if (!messageIds.length) return;

  const quarantinedCount = await gossip.countQuarantinedInIds(messageIds);
  if (quarantinedCount >= PEER_FLAG_THRESHOLD) {
    await suspendPeer(gossip, peerId, `Auto-suspended: ${quarantinedCount} quarantined messages in 24 hours`);
  }
}

// ── Background sync loop ────────────────────────────────────────────────────

async function syncLoop(): Promise<void> {
  const gossip = getGossipAdapter();
  const config = await gossip.getInstanceConfig();
  if (!config?.gossip_enabled) return;

  const peers = await gossip.listPeers();
  const activePeers = peers.filter((p: { active: boolean; suspended: boolean }) => p.active && !p.suspended);

  for (const peer of activePeers) {
    try { await syncFromPeer(peer.id); } catch { /* individual failures don't stop loop */ }
  }
}

export function startSyncWorker(): void {
  if (syncInterval) return;
  console.log('[gossip] Sync worker started (polling every 30s)');
  syncInterval = setInterval(() => { syncLoop().catch(console.error); }, SYNC_INTERVAL_MS);
  syncLoop().catch(console.error);
}

export function stopSyncWorker(): void {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}
