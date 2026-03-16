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

// ── Guardrails sidecar config ────────────────────────────────────────────────

const GUARDRAILS_URL = process.env.GUARDRAILS_URL ?? null; // e.g., 'http://127.0.0.1:8484'
const GUARDRAILS_SECRET = process.env.GUARDRAILS_SECRET ?? ''; // shared secret for sidecar auth

interface GuardrailsResult {
  labels: string[];
  details: Record<string, { passed: boolean; error?: string }>;
  quarantine: boolean;
  latency_ms: number;
}

/**
 * Phase 2 async classification via Guardrails sidecar.
 * Catches general content safety (toxicity, PII, profanity, secrets)
 * that our heuristic patterns don't cover.
 * Returns null if sidecar is unavailable or disabled.
 */
async function classifyWithGuardrails(
  content: string,
  metadata: Record<string, unknown> | null
): Promise<GuardrailsResult | null> {
  if (!GUARDRAILS_URL) return null;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (GUARDRAILS_SECRET) {
      headers['Authorization'] = `Bearer ${GUARDRAILS_SECRET}`;
    }
    const res = await fetch(`${GUARDRAILS_URL}/classify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content, metadata }),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });
    if (!res.ok) return null;
    return await res.json() as GuardrailsResult;
  } catch {
    return null; // Sidecar down — degrade gracefully
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;
let patternSet: PatternSet | null = null;
let cachedPrivateKey: string | null = null;

// In-memory agent flag counter (tracking window only — quarantine state persisted to DB)
const agentFlags = new Map<string, { count: number; firstFlagAt: number }>();

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
  // Prefer env var (for containerized deployments like Railway)
  if (process.env.INSTANCE_PRIVATE_KEY) {
    cachedPrivateKey = process.env.INSTANCE_PRIVATE_KEY.trim();
    return cachedPrivateKey;
  }
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

    const raw = await res.json();
    // Unwrap AirChat response envelope if present
    const data = (raw.data ?? raw) as {
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

    if (received > 0 || quarantined > 0) {
      console.log(`[gossip] Sync from ${peer.display_name || peer.fingerprint}: ${received} stored, ${quarantined} quarantined`);
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

  // Fix #56: Validate remoteMessageId is a UUID
  if (!UUID_RE.test(remoteMessageId)) return 'rejected';

  // Fix #52: Validate content and metadata size on inbound federated messages
  const maxContent = channelName.startsWith('gossip-') ? 500 : 2000;
  if (content.length > maxContent) return 'rejected';
  if (metadata && JSON.stringify(metadata).length > 1024) return 'rejected';

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

  // Red team #1: Envelope signatures are MANDATORY. Reject unsigned messages.
  const envelopeSignature = raw.signature as string | undefined;
  const originPublicKey = raw.origin_public_key as string | undefined;
  if (!envelopeSignature || !originPublicKey) {
    return 'rejected'; // No signature = no trust
  }
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

  // Agent quarantine check (persistent — survives restarts)
  const agentKey = `${authorDisplay}@${originInstance ?? peer.fingerprint}`;
  if (await gossip.isAgentQuarantined(agentKey)) return 'rejected';

  // Red team #8: Enforce channel namespace — federated messages can ONLY target
  // gossip-* or shared-* channels. Reject any attempt to inject into local channels.
  if (!channelName.startsWith('gossip-') && !channelName.startsWith('shared-')) {
    return 'rejected';
  }

  // Classify
  const classification = classifyMessage(content, metadata, patterns);
  const isQuarantined = classification.label === 'quarantined';

  // Find or create channel (only federated types reach here)
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
  const safetyConcernLabels = new Set(['contains-instructions', 'requests-data', 'references-tools', 'high-entropy', 'quarantined']);
  if (classification.labels.some(l => safetyConcernLabels.has(l))) {
    await trackAgentFlag(agentKey, gossip);
  }

  // Phase 2: Async Guardrails classification (runs after message is stored)
  // Does not block the sync — enhances labels post-hoc
  // Fix #48: Flag tracking is skipped here if already tracked in Phase 1 above
  // Fix #49: updateMessageLabels only escalates quarantine, never de-escalates
  const alreadyFlagged = classification.labels.some(l => safetyConcernLabels.has(l));

  if (GUARDRAILS_URL && !isQuarantined) {
    classifyWithGuardrails(content, metadata).then(async (grResult) => {
      if (!grResult || grResult.labels.length === 0 || (grResult.labels.length === 1 && grResult.labels[0] === 'clean')) {
        return;
      }

      // Merge labels (append only)
      const newLabels = grResult.labels.filter(l => l !== 'clean');
      const mergedLabels = [...new Set([...classification.labels, ...newLabels])];

      // Only ESCALATE quarantine — never de-escalate (fix #49)
      const escalateQuarantine = grResult.quarantine; // true = escalate, false = leave as-is

      await gossip.updateMessageLabels(localMessageId, mergedLabels, escalateQuarantine, {
        matched_patterns: classification.matched_patterns,
        route_to_sandbox: classification.route_to_sandbox,
        sandbox_priority: classification.sandbox_priority,
        guardrails: grResult.details,
        guardrails_latency_ms: grResult.latency_ms,
      });

      // Fix #48: Only track flag if Phase 1 didn't already track one for this message
      if (!alreadyFlagged) {
        const grSafety = new Set(['toxic', 'profanity', 'contains-pii', 'contains-secrets']);
        if (newLabels.some(l => grSafety.has(l))) {
          await trackAgentFlag(agentKey, gossip);
        }
      }
    }).catch(() => {
      // Guardrails failure doesn't affect message processing
    });
  }

  return isQuarantined ? 'quarantined' : 'stored';
}

// ── Process retraction ──────────────────────────────────────────────────────

async function processRetraction(retraction: RetractionEnvelope, gossip: GossipStorageAdapter): Promise<void> {
  if (!retraction.retracted_by || !retraction.signature) return;
  if (!UUID_RE.test(retraction.retracted_message_id)) return;

  // Verify signature
  const retractingPeer = await gossip.getPeerByFingerprint(retraction.retracted_by);
  if (!retractingPeer?.public_key) return;
  if (!verifyRetraction(retractingPeer.public_key, retraction)) return;

  // Red team #5: Only accept retractions from supernodes or the message's origin.
  // Regular peers can only retract messages they originated.
  // Supernodes can retract any message (they are trusted relay infrastructure).
  if (retractingPeer.peer_type !== 'supernode') {
    // Check if the retracted message originated from this peer
    const idSuffix = retraction.retracted_message_id.replace(/^[0-9a-f]{8}-/, '');
    const localId = `${retractingPeer.fingerprint.slice(0, 8)}-${idSuffix}`;
    const exists = await gossip.messageExists(localId);
    if (!exists) return; // Peer trying to retract a message it didn't originate — reject
  }

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

// ── Agent circuit breakers (flag counter in-memory, quarantine persisted to DB) ──

async function trackAgentFlag(agentKey: string, gossip: GossipStorageAdapter): Promise<void> {
  const now = Date.now();
  const entry = agentFlags.get(agentKey);
  if (!entry || now - entry.firstFlagAt > AGENT_FLAG_WINDOW_MS) {
    agentFlags.set(agentKey, { count: 1, firstFlagAt: now });
    return;
  }
  entry.count++;
  if (entry.count >= AGENT_FLAG_THRESHOLD) {
    const until = new Date(now + AGENT_QUARANTINE_MS).toISOString();
    await gossip.quarantineAgent(agentKey, until);
    agentFlags.delete(agentKey);
    console.log(`[gossip] Agent quarantined: ${agentKey} (${AGENT_FLAG_THRESHOLD}+ flags in 1 hour, until ${until})`);
  }
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

  // Periodic cleanup of expired agent quarantines
  await gossip.clearExpiredAgentQuarantines();

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

/**
 * Lazily start the sync worker if gossip is enabled.
 * Safe to call from any route — only starts once.
 */
export async function ensureSyncWorker(): Promise<void> {
  if (syncInterval) return;
  try {
    const gossip = getGossipAdapter();
    const config = await gossip.getInstanceConfig();
    if (config?.gossip_enabled) {
      startSyncWorker();
    }
  } catch { /* not ready yet */ }
}

export function stopSyncWorker(): void {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}
