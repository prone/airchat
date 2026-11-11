/**
 * Gossip sync engine — background worker, inbound processing, circuit breakers.
 *
 * Uses GossipStorageAdapter for all DB operations (no direct Supabase calls).
 */

import { getGossipAdapter } from '@/lib/api-v2-auth';
import { fetchPeerUrl } from '@/lib/url-validation';
import { fetchPeerKey } from '@/lib/peer-identity';
import { stripHtmlTags, sanitizeForLog } from '@/lib/sanitize';
import { signPeerRequest, FINGERPRINT_RE, PUBLIC_KEY_RE } from '@/lib/gossip-auth';
import { classifyMessage } from '@airchat/shared/safety';
import { loadPatternSet } from '@airchat/shared/safety';
import { verifyEnvelope, verifyRetraction, signEnvelope, deriveFingerprint } from '@airchat/shared/gossip';
import type { GossipEnvelope, RetractionEnvelope } from '@airchat/shared/gossip';
import { remoteAgentName, stripReservedFederatedMetadata } from '@airchat/shared/supabase-gossip-adapter';
import type { PatternSet } from '@airchat/shared/safety';
import type { GossipStorageAdapter, GossipPeer, GossipInstanceConfig } from '@airchat/shared';
import { Backoff, describeFailure, formatDelay } from '@airchat/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Channel names follow the same rule as agent names: lowercase, digits, hyphens. */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;
/** Most messages and retractions taken from one sync response (we ask for 100). */
const MAX_ITEMS_PER_SYNC = 100;
const MAX_RETRACTION_REASON_LENGTH = 500;

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
/** True while a sync pass is in progress, so a slow pass is never overlapped by the next tick. */
let syncLoopRunning = false;
let patternSet: PatternSet | null = null;
let cachedPrivateKey: string | null = null;

// In-memory agent flag counter (tracking window only — quarantine state persisted to DB)
const agentFlags = new Map<string, { count: number; firstFlagAt: number }>();

// Pull sync is a backstop — peers push new messages immediately (see
// pushMessageToSupernodes / the push route), so a long interval costs little
// latency. Writes per tick are minimized to protect the disk IO budget on
// small database instances: peer rows are only updated when something
// actually changed (or on the heartbeat interval), and quarantine cleanup
// runs on its own much slower cadence.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** After a failed loop (config/peer list unreadable): 5m doubling to 30m. */
const SYNC_BACKOFF_MAX_MS = 30 * 60 * 1000;
const syncBackoff = new Backoff({ baseMs: SYNC_INTERVAL_MS, maxMs: SYNC_BACKOFF_MAX_MS });
const SYNC_HEARTBEAT_MS = 10 * 60 * 1000;
const QUARANTINE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CONFIG_CACHE_TTL_MS = 60_000;
const AGENT_FLAG_WINDOW_MS = 60 * 60 * 1000;
const AGENT_FLAG_THRESHOLD = 3;
const AGENT_QUARANTINE_MS = 24 * 60 * 60 * 1000;
const PEER_FLAG_THRESHOLD = 10;

let lastQuarantineCleanupAt = 0;

// ── Instance config cache ───────────────────────────────────────────────────

let configCache: { value: GossipInstanceConfig | null; fetchedAt: number } | null = null;

async function getCachedInstanceConfig(gossip: GossipStorageAdapter): Promise<GossipInstanceConfig | null> {
  if (configCache && Date.now() - configCache.fetchedAt < CONFIG_CACHE_TTL_MS) {
    return configCache.value;
  }
  const value = await gossip.getInstanceConfig();
  configCache = { value, fetchedAt: Date.now() };
  return value;
}

// ── Trigger immediate sync ──────────────────────────────────────────────────

const pendingSyncs = new Set<string>();

export function triggerSyncFromPeer(peerId: string): Promise<void> {
  if (pendingSyncs.has(peerId)) return Promise.resolve();
  pendingSyncs.add(peerId);
  return (async () => {
    const peer = await getGossipAdapter().getPeerById(peerId);
    if (peer) await syncFromPeer(peer);
  })().finally(() => pendingSyncs.delete(peerId));
}

// ── Private key loading (cached) ─────────────────────────────────────────────

export async function getPrivateKey(): Promise<string | null> {
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

/** Write last_sync_error only when it changed — an unreachable peer must not
 *  generate a WAL write every tick for the same repeated error. */
async function recordSyncError(gossip: GossipStorageAdapter, peer: GossipPeer, error: string): Promise<void> {
  if (peer.last_sync_error === error) return;
  await gossip.updatePeer(peer.id, { last_sync_error: error } as Partial<GossipPeer>);
}

async function syncFromPeer(peer: GossipPeer): Promise<void> {
  if (!peer.active || peer.suspended) return;

  const gossip = getGossipAdapter();
  const config = await getCachedInstanceConfig(gossip);
  if (!config?.gossip_enabled) return;

  const since = peer.last_sync_at ?? new Date(0).toISOString();
  const privateKey = await getPrivateKey();

  // Requests to a peer are signed with the instance key; without it there is
  // nothing to authenticate with, so this peer is skipped.
  if (!privateKey) {
    await recordSyncError(gossip, peer, 'Instance private key not found');
    return;
  }

  try {
    const requestedAt = new Date().toISOString();
    const url = `${peer.endpoint}/api/v2/gossip/sync?since=${encodeURIComponent(since)}&limit=${MAX_ITEMS_PER_SYNC}&scope=${peer.federation_scope}`;

    const res = await fetchPeerUrl(url, {
      headers: signPeerRequest(privateKey, {
        method: 'GET',
        url,
        senderFingerprint: config.fingerprint,
        recipientFingerprint: peer.fingerprint,
        timestamp: requestedAt,
      }),
      timeoutMs: 15000,
    });

    if (!res.ok) {
      await recordSyncError(gossip, peer, `HTTP ${res.status}`);
      return;
    }

    // Everything in the response is chosen by the peer, so nothing about its
    // shape is assumed: wrong types become empty lists, and oversized lists
    // are cut to what was asked for.
    const raw = (await res.json()) as Record<string, unknown> | null;
    // Unwrap AirChat response envelope if present
    const unwrapped = (raw && typeof raw === 'object' ? (raw.data ?? raw) : null) as Record<string, unknown> | null;
    const asList = (value: unknown): unknown[] =>
      Array.isArray(value) ? value.slice(0, MAX_ITEMS_PER_SYNC) : [];
    const syncTimestamp = unwrapped?.sync_timestamp;
    const syncTimestampMs = typeof syncTimestamp === 'string' ? new Date(syncTimestamp).getTime() : NaN;
    const data = {
      messages: asList(unwrapped?.messages) as Array<Record<string, unknown>>,
      retractions: asList(unwrapped?.retractions),
      // The cursor for the next sync. A missing, unreadable or future value
      // falls back to when this request was sent, which can only cause a
      // re-read, never a gap.
      sync_timestamp:
        !isNaN(syncTimestampMs) && syncTimestampMs <= Date.now() + 5 * 60 * 1000
          ? (syncTimestamp as string)
          : requestedAt,
    };

    const { stored: received, quarantined } = await processInboundMessages(data.messages, peer, gossip);

    if (received > 0 || quarantined > 0) {
      console.log(`[gossip] Sync from ${sanitizeForLog(peer.display_name || peer.fingerprint)}: ${received} stored, ${quarantined} quarantined`);
    }

    await processRetractions(data.retractions, gossip);

    // Skip the peer-row write on quiet syncs: only write when something
    // arrived, when a previous error needs clearing, or when the sync cursor
    // is stale enough to warrant a heartbeat. An idle empty sync stays
    // correct without advancing the cursor — the peer just re-answers a
    // slightly wider (still empty) window next tick.
    const gotTraffic = received > 0 || quarantined > 0 || data.retractions.length > 0;
    const lastSyncMs = peer.last_sync_at ? new Date(peer.last_sync_at).getTime() : 0;
    const heartbeatDue = Date.now() - lastSyncMs >= SYNC_HEARTBEAT_MS;
    if (gotTraffic || peer.last_sync_error != null || heartbeatDue) {
      await gossip.updatePeer(peer.id, {
        last_sync_at: data.sync_timestamp,
        last_sync_error: null,
        messages_received: (peer.messages_received ?? 0) + received,
        messages_quarantined: (peer.messages_quarantined ?? 0) + quarantined,
      } as Partial<GossipPeer>);
    }

    // Circuit breaker: check peer suspension
    if (quarantined >= PEER_FLAG_THRESHOLD) {
      await suspendPeer(gossip, peer.id, `Auto-suspended: ${quarantined} messages quarantined in single sync`);
    } else if ((peer.messages_quarantined ?? 0) + quarantined >= PEER_FLAG_THRESHOLD * 2) {
      await checkPeerSuspension(gossip, peer.id);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordSyncError(gossip, peer, msg);
  }
}

// ── Process inbound message ─────────────────────────────────────────────────

type InboundResult = 'stored' | 'quarantined' | 'duplicate' | 'rejected';

/**
 * Whether a peer is allowed to exchange messages for a channel with us.
 *
 * shared-* channels are for direct peers only: instances the operator
 * registered with federation_scope 'peers'. Everything else federates
 * gossip-* channels and nothing more.
 */
export function peerMayCarryChannel(peer: Pick<GossipPeer, 'federation_scope'>, channelName: string): boolean {
  if (channelName.startsWith('gossip-')) return true;
  if (channelName.startsWith('shared-')) return peer.federation_scope === 'peers';
  return false;
}

async function processInboundMessage(
  raw: Record<string, unknown>,
  peer: GossipPeer,
  gossip: GossipStorageAdapter,
  patterns: PatternSet
): Promise<InboundResult> {
  // Every field below was chosen by another instance. Types are checked before
  // anything is used, so a wrong type rejects this one message rather than
  // throwing halfway through.
  if (!raw || typeof raw !== 'object') return 'rejected';

  const remoteMessageId = raw.id;
  const channelName = (raw.channels as { name?: unknown } | null | undefined)?.name;
  const rawContent = raw.content;
  const createdAt = raw.created_at;
  const rawHopCount = raw.hop_count;
  if (
    typeof remoteMessageId !== 'string' ||
    typeof channelName !== 'string' ||
    typeof rawContent !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return 'rejected';
  }

  const rawMetadata = raw.metadata ?? null;
  if (rawMetadata !== null && (typeof rawMetadata !== 'object' || Array.isArray(rawMetadata))) {
    return 'rejected';
  }
  const metadata = rawMetadata as Record<string, unknown> | null;

  // The message id must be a UUID: it becomes part of a local primary key.
  if (!UUID_RE.test(remoteMessageId)) return 'rejected';

  // Federated messages can only land in gossip-* or shared-* channels, never
  // in a channel local to this instance, and shared-* only from a peer
  // registered for shared channels.
  if (!CHANNEL_NAME_RE.test(channelName) || !peerMayCarryChannel(peer, channelName)) {
    return 'rejected';
  }

  // Defense-in-depth: strip HTML tags from federated content to prevent stored XSS
  const content = stripHtmlTags(rawContent);
  if (!content) return 'rejected';

  // Federated channels have tighter size limits than local ones.
  const maxContent = channelName.startsWith('gossip-') ? 500 : 2000;
  if (content.length > maxContent) return 'rejected';
  if (metadata && JSON.stringify(metadata).length > 1024) return 'rejected';

  // Validate hop_count
  if (typeof rawHopCount !== 'number' || !Number.isInteger(rawHopCount) || rawHopCount < 0) {
    return 'rejected';
  }
  const maxHops = channelName.startsWith('gossip-') ? 3 : 1;
  if (rawHopCount > maxHops) return 'rejected';

  // Validate timestamp
  const messageAge = Date.now() - new Date(createdAt).getTime();
  if (isNaN(messageAge) || messageAge < -5 * 60 * 1000 || messageAge > 7 * 24 * 60 * 60 * 1000) {
    return 'rejected';
  }

  // The instance the message claims to come from. Absent means "the peer
  // that delivered it".
  const originInstance = raw.origin_instance ?? peer.fingerprint;
  if (typeof originInstance !== 'string' || !FINGERPRINT_RE.test(originInstance)) return 'rejected';

  // The author as the origin named it. It is checked for length and
  // characters, and turned into the local agent name it will be stored under
  // (which always ends in the origin's fingerprint).
  const authorDisplay = raw.author_display ?? (raw.agents as { name?: unknown } | null | undefined)?.name;
  const agentName = remoteAgentName(authorDisplay, originInstance);
  if (typeof authorDisplay !== 'string' || !agentName) return 'rejected';

  // Every message must carry a signature by its origin instance.
  const envelopeSignature = raw.signature;
  const originPublicKey = raw.origin_public_key;
  if (
    typeof envelopeSignature !== 'string' ||
    typeof originPublicKey !== 'string' ||
    !PUBLIC_KEY_RE.test(originPublicKey)
  ) {
    return 'rejected'; // No signature = no trust
  }

  // The public key travels inside the message, so on its own a valid
  // signature proves nothing: anyone can sign with a key they just made. What
  // ties it down is that an instance's fingerprint is derived from its key.
  // The key must therefore hash to the origin the message claims.
  if (deriveFingerprint(originPublicKey) !== originInstance) return 'rejected';
  // A message that has not been relayed (hop 0) was written on the instance
  // that is handing it to us, so its origin must be that peer.
  if (rawHopCount === 0 && originInstance !== peer.fingerprint) return 'rejected';
  // And when the origin is the delivering peer, the key must be the one we
  // already hold for it, not merely one with the same short fingerprint.
  if (originInstance === peer.fingerprint && peer.public_key && originPublicKey !== peer.public_key) {
    return 'rejected';
  }

  const envelope: GossipEnvelope = {
    message_id: remoteMessageId,
    channel_name: channelName,
    origin_instance: originInstance,
    author_agent: authorDisplay,
    content,
    metadata,
    created_at: createdAt,
    signature: envelopeSignature,
    hop_count: rawHopCount,
    safety_labels: [],
    federation_scope: channelName.startsWith('gossip-') ? 'global' : 'peers',
  };
  let signatureValid = false;
  try {
    signatureValid = verifyEnvelope(originPublicKey, envelope);
  } catch { /* malformed key or signature */ }
  if (!signatureValid) return 'rejected';

  // Namespace remote ID
  const idSuffix = remoteMessageId.toLowerCase().replace(/^[0-9a-f]{8}-/, '');
  const localMessageId = `${peer.fingerprint.slice(0, 8)}-${idSuffix}`;

  // Dedup: check both namespaced ID and origin-based dedup
  if (await gossip.messageExists(localMessageId)) return 'duplicate';
  // Cross-peer dedup: reject if same origin message was already received from another peer
  const originLocalId = `${originInstance.slice(0, 8)}-${idSuffix}`;
  if (originLocalId !== localMessageId && await gossip.messageExists(originLocalId)) return 'duplicate';

  // Agent quarantine check (persistent — survives restarts). Keyed on the
  // stored agent name rather than the raw author string, so spelling variants
  // that resolve to the same agent cannot step around a quarantine.
  const agentKey = agentName;
  if (await gossip.isAgentQuarantined(agentKey)) return 'rejected';

  // Classify what the peer actually sent, including metadata we will not keep.
  const classification = classifyMessage(content, metadata, patterns);
  const isQuarantined = classification.label === 'quarantined';

  // Find or create channel (only federated types reach here)
  const type = channelName.startsWith('gossip-') ? 'gossip' : 'shared';
  const scope = channelName.startsWith('gossip-') ? 'global' : 'peers';
  const channelId = await gossip.findOrCreateChannelId(channelName, type, scope);
  if (!channelId) return 'rejected';

  // Find or create the placeholder agent for this remote author. Returns
  // nothing if that name is held by an agent that is not this remote author
  // (for instance an agent on this instance), in which case the message is
  // refused rather than attributed to someone else.
  const agentId = await gossip.findOrCreateRemoteAgent(authorDisplay, peer.fingerprint, originInstance);
  if (!agentId) return 'rejected';

  // Store. Keys that only this server may assign (`source`, `user_email`,
  // `files`) are dropped: readers treat them as verified facts, e.g. the
  // dashboard marks a message with source 'dashboard' as written by a person.
  const storedMetadata = stripReservedFederatedMetadata(metadata);
  const stored = await gossip.insertFederatedMessage({
    id: localMessageId,
    channel_id: channelId,
    author_agent_id: agentId,
    content,
    metadata: storedMetadata,
    safety_labels: classification.labels,
    quarantined: isQuarantined,
    classification: {
      matched_patterns: classification.matched_patterns,
      route_to_sandbox: classification.route_to_sandbox,
      sandbox_priority: classification.sandbox_priority,
    },
    origin_instance: originInstance,
    author_display: authorDisplay,
    hop_count: rawHopCount + 1,
    created_at: createdAt,
  });

  if (!stored) return 'rejected';

  await gossip.trackMessageOrigin(localMessageId, peer.id, originInstance);

  // Only track flags for labels indicating actual safety concerns
  const safetyConcernLabels = new Set(['contains-instructions', 'requests-data', 'references-tools', 'high-entropy', 'quarantined']);
  const alreadyFlagged = classification.labels.some(l => safetyConcernLabels.has(l));
  if (alreadyFlagged) {
    await trackAgentFlag(agentKey, gossip);
  }

  // Phase 2: Async Guardrails classification (runs after message is stored)
  // Does not block the sync — enhances labels post-hoc. A message counts
  // against its author at most once, so a flag recorded above is not recorded
  // again here.
  if (GUARDRAILS_URL && !isQuarantined) {
    classifyWithGuardrails(content, metadata).then(async (grResult) => {
      if (!grResult || grResult.labels.length === 0 || (grResult.labels.length === 1 && grResult.labels[0] === 'clean')) {
        return;
      }

      // Merge labels (append only)
      const newLabels = grResult.labels.filter(l => l !== 'clean');
      const mergedLabels = [...new Set([...classification.labels, ...newLabels])];

      // The second pass can add a quarantine but never lift one.
      const escalateQuarantine = grResult.quarantine; // true = escalate, false = leave as-is

      await gossip.updateMessageLabels(localMessageId, mergedLabels, escalateQuarantine, {
        matched_patterns: classification.matched_patterns,
        route_to_sandbox: classification.route_to_sandbox,
        sandbox_priority: classification.sandbox_priority,
        guardrails: grResult.details,
        guardrails_latency_ms: grResult.latency_ms,
      });

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

// ── Process retractions ─────────────────────────────────────────────────────

/**
 * Apply retractions received from a peer. Exported for tests.
 *
 * A retraction names a message by the id it had on its origin instance. The
 * same message is stored here under a different id — the first block replaced
 * by the first 8 characters of the delivering peer's fingerprint — so the
 * candidates are that id under each known peer's prefix.
 *
 * Whether the retraction is honoured is decided per stored row, from the
 * origin recorded when that row arrived:
 *  - an instance may retract messages it originated;
 *  - a supernode may retract any message that arrived over federation;
 *  - a message written on this instance has no recorded origin and is never
 *    quarantined by a retraction, whoever sends it.
 */
export async function processRetractions(retractions: unknown[], gossip: GossipStorageAdapter): Promise<void> {
  let peers: GossipPeer[] | null = null;
  for (const raw of retractions.slice(0, MAX_ITEMS_PER_SYNC)) {
    try {
      const retraction = parseRetraction(raw);
      if (!retraction) continue;
      peers ??= await gossip.listPeers();
      await processRetraction(retraction, peers, gossip);
    } catch {
      // One bad retraction must not stop the rest.
    }
  }
}

function parseRetraction(raw: unknown): RetractionEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.retracted_message_id !== 'string' || !UUID_RE.test(r.retracted_message_id) ||
    typeof r.retracted_by !== 'string' || !FINGERPRINT_RE.test(r.retracted_by) ||
    typeof r.reason !== 'string' || r.reason.length > MAX_RETRACTION_REASON_LENGTH ||
    typeof r.retracted_at !== 'string' || isNaN(new Date(r.retracted_at).getTime()) ||
    typeof r.signature !== 'string' || !r.signature
  ) {
    return null;
  }
  return {
    retracted_message_id: r.retracted_message_id,
    retracted_by: r.retracted_by,
    reason: r.reason,
    retracted_at: r.retracted_at,
    signature: r.signature,
  };
}

async function processRetraction(
  retraction: RetractionEnvelope,
  peers: GossipPeer[],
  gossip: GossipStorageAdapter,
): Promise<void> {
  // The retraction must be signed by a peer we know and still trust.
  const retractingPeer = peers.find((p) => p.fingerprint === retraction.retracted_by);
  if (!retractingPeer?.public_key || !retractingPeer.active || retractingPeer.suspended) return;
  if (!verifyRetraction(retractingPeer.public_key, retraction)) return;

  const retractedId = retraction.retracted_message_id.toLowerCase();
  const idSuffix = retractedId.replace(/^[0-9a-f]{8}-/, '');
  const candidateIds = [...new Set([
    retractedId,
    ...peers.map((p) => `${p.fingerprint.slice(0, 8)}-${idSuffix}`),
  ])].filter((id) => UUID_RE.test(id));

  // Only rows with a recorded origin come back, which already excludes
  // messages written on this instance.
  const origins = await gossip.getMessageOrigins(candidateIds);
  const targets = origins.filter(
    (o) =>
      retractingPeer.peer_type === 'supernode' ||
      o.origin_instance_fingerprint === retractingPeer.fingerprint,
  );
  if (targets.length === 0) return;

  await gossip.storeRetraction({
    retracted_message_id: retraction.retracted_message_id,
    reason: retraction.reason,
    retracted_by: retraction.retracted_by,
    retracted_at: retraction.retracted_at,
    signature: retraction.signature,
  });

  for (const target of targets) {
    await gossip.quarantineFederatedMessage(target.message_id);
  }
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
    console.log(`[gossip] Agent quarantined: ${sanitizeForLog(agentKey)} (${AGENT_FLAG_THRESHOLD}+ flags in 1 hour, until ${until})`);
  }
}

// ── Peer circuit breakers ───────────────────────────────────────────────────

async function suspendPeer(gossip: GossipStorageAdapter, peerId: string, reason: string): Promise<void> {
  await gossip.suspendPeer(peerId, reason);
  await gossip.quarantineAllFromPeer(peerId);
  console.log(`[gossip] Peer suspended: ${sanitizeForLog(peerId)} — ${sanitizeForLog(reason)}`);
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

/** syncLoop with backoff: a loop that cannot read its own config or peer list
 *  (the database is the usual reason) waits longer before trying again. */
async function guardedSyncLoop(): Promise<void> {
  // setInterval fires on schedule whether or not the previous pass finished.
  // A pass that outlasts the interval (slow peers, a struggling database)
  // would otherwise run alongside the next one and fetch the same messages.
  if (syncLoopRunning) return;
  if (syncBackoff.shouldSkip()) return;
  syncLoopRunning = true;
  try {
    await syncLoop();
    const recovered = syncBackoff.success();
    if (recovered) console.log(`[gossip] sync loop recovered after ${recovered} failure(s)`);
  } catch (err) {
    const { delayMs, attempts, changed } = syncBackoff.failure();
    if (changed) console.error(`[gossip] sync loop failed (${describeFailure(err)}); backing off ${formatDelay(delayMs)} after ${attempts} failure(s)`);
  } finally {
    syncLoopRunning = false;
  }
}

// ── Peer key exchange ───────────────────────────────────────────────────────

// How often a peer that has no stored key is asked for it again.
const PEER_KEY_RETRY_MS = 10 * 60 * 1000;
const peerKeyAskedAt = new Map<string, number>();

/**
 * Make sure we hold the peer's public key before syncing with it.
 *
 * A peer can be stored without one: the default supernode is added by
 * fingerprint alone, and so is any peer that was unreachable when it was
 * added. Without the key nothing the peer sends to us can be authenticated,
 * and its messages are not tied to one key. So the key is fetched here,
 * checked against the stored fingerprint, and saved. Until that succeeds the
 * peer is skipped.
 *
 * Mutates `peer` so the sync that follows sees the key.
 */
async function ensurePeerKey(peer: GossipPeer, gossip: GossipStorageAdapter): Promise<boolean> {
  if (peer.public_key) return true;

  const now = Date.now();
  if (now - (peerKeyAskedAt.get(peer.id) ?? 0) < PEER_KEY_RETRY_MS) return false;
  peerKeyAskedAt.set(peer.id, now);

  const key = await fetchPeerKey(peer.endpoint, peer.fingerprint);
  if (key.status !== 'verified') {
    const why = key.status === 'mismatch'
      ? `its key has fingerprint ${key.actualFingerprint}, not the ${peer.fingerprint} it was added with`
      : key.status === 'invalid' ? 'it returned no valid public key' : 'it could not be reached';
    console.error(`[gossip] not syncing with ${sanitizeForLog(peer.endpoint)}: ${why}`);
    return false;
  }
  await gossip.updatePeer(peer.id, { public_key: key.publicKey });
  peer.public_key = key.publicKey;
  peerKeyAskedAt.delete(peer.id);
  return true;
}

/** Test hook: forget when peers were last asked for their key. */
export function resetPeerKeyRetries(): void {
  peerKeyAskedAt.clear();
}

async function syncLoop(): Promise<void> {
  const gossip = getGossipAdapter();
  const config = await getCachedInstanceConfig(gossip);
  if (!config?.gossip_enabled) return;

  // Periodic cleanup of expired agent quarantines — hourly, not every tick
  if (Date.now() - lastQuarantineCleanupAt >= QUARANTINE_CLEANUP_INTERVAL_MS) {
    lastQuarantineCleanupAt = Date.now();
    await gossip.clearExpiredAgentQuarantines();
  }

  const peers = await gossip.listPeers();
  const activePeers = peers.filter((p: { active: boolean; suspended: boolean }) => p.active && !p.suspended);

  let failed = 0;
  let lastError: unknown = null;
  for (const peer of activePeers) {
    try {
      if (!(await ensurePeerKey(peer, gossip))) continue;
      await syncFromPeer(peer);
    } catch (err) { failed++; lastError = err; /* keep going */ }
  }
  // One bad peer must not slow the others down. Every peer failing is the
  // signature of a problem on our side (usually the database), so back off.
  if (activePeers.length > 0 && failed === activePeers.length) {
    throw lastError instanceof Error ? lastError : new Error('every peer sync failed');
  }
}

// ── Process inbound messages (shared between pull-sync and push) ─────────────

/**
 * Process an array of inbound messages from a peer.
 * Used by both the pull-sync loop and the push endpoint.
 */
export async function processInboundMessages(
  messages: Array<Record<string, unknown>>,
  peer: GossipPeer,
  gossip: GossipStorageAdapter
): Promise<{ stored: number; quarantined: number }> {
  if (!patternSet) patternSet = loadPatternSet();

  let stored = 0;
  let quarantined = 0;

  for (const msg of messages) {
    // Each message stands alone: one that is malformed, or that fails while
    // being stored, is dropped without taking the rest of the batch with it.
    let result: InboundResult;
    try {
      result = await processInboundMessage(msg, peer, gossip, patternSet);
    } catch {
      result = 'rejected';
    }
    if (result === 'stored') stored++;
    if (result === 'quarantined') { stored++; quarantined++; }
  }

  return { stored, quarantined };
}

// ── Outbound classification ─────────────────────────────────────────────────

/**
 * Run the safety classifier over a message written on this instance before it
 * leaves for other instances.
 *
 * Local posts to gossip-* and shared-* channels are classified when they are
 * written. This checks again on the way out, with the pattern set as it is
 * now, so a message stored before a pattern was added still does not leave.
 * A message the classifier would quarantine is not sent out.
 */
export function classifyOutbound(
  content: string,
  metadata: Record<string, unknown> | null,
): { labels: string[]; quarantined: boolean } {
  if (!patternSet) patternSet = loadPatternSet();
  const result = classifyMessage(content, metadata, patternSet);
  return { labels: result.labels, quarantined: result.label === 'quarantined' };
}

// ── Outbound push to supernodes ──────────────────────────────────────────────

/**
 * Push a newly posted message to the active supernode peers allowed to carry
 * its channel. Called after a message is posted to a gossip-* or shared-*
 * channel. Runs async (fire-and-forget) — does not block the message POST
 * response.
 */
export async function pushMessageToSupernodes(message: {
  id: string;
  content: string;
  channel_name: string;
  author_name: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}): Promise<void> {
  const gossip = getGossipAdapter();
  const config = await getCachedInstanceConfig(gossip);
  if (!config?.gossip_enabled) return;

  const privateKey = await getPrivateKey();
  if (!privateKey) return;

  const peers = await gossip.listPeers();
  // gossip-* goes to every supernode. shared-* is for direct peers only, so
  // it goes only to supernodes registered with federation_scope 'peers'.
  const supernodes = peers.filter(
    (p: GossipPeer) =>
      p.peer_type === 'supernode' && p.active && !p.suspended &&
      peerMayCarryChannel(p, message.channel_name)
  );
  if (supernodes.length === 0) return;

  const outbound = classifyOutbound(message.content, message.metadata);
  if (outbound.quarantined) {
    console.log(`[gossip] Not pushing message ${sanitizeForLog(message.id)}: flagged by the safety classifier`);
    return;
  }

  // Build and sign the envelope. Server-assigned metadata (who posted from the
  // dashboard, their email, stored file paths) describes this instance's users
  // and storage and is not sent to other instances.
  const envelope = signEnvelope(privateKey, {
    message_id: message.id,
    channel_name: message.channel_name,
    origin_instance: config.fingerprint,
    author_agent: message.author_name,
    content: message.content,
    metadata: stripReservedFederatedMetadata(message.metadata),
    created_at: message.created_at,
    hop_count: 0,
    safety_labels: outbound.labels,
    federation_scope: message.channel_name.startsWith('gossip-') ? 'global' : 'peers',
  });
  const body = JSON.stringify({ messages: [{ ...envelope, origin_public_key: config.public_key }] });

  // Push to each supernode in parallel. Each request is signed for that one
  // recipient, so what one supernode receives cannot be replayed to another.
  await Promise.allSettled(supernodes.map(async (peer: GossipPeer) => {
    try {
      const url = `${peer.endpoint}/api/v2/gossip/push`;
      const res = await fetchPeerUrl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signPeerRequest(privateKey, {
            method: 'POST',
            url,
            senderFingerprint: config.fingerprint,
            recipientFingerprint: peer.fingerprint,
            body,
          }),
        },
        body,
        timeoutMs: 10000,
      });
      if (!res.ok) {
        console.log(`[gossip] Push to ${sanitizeForLog(peer.display_name || peer.fingerprint)}: HTTP ${res.status}`);
      }
    } catch {
      // Push failures are non-fatal
    }
  }));
}

export function startSyncWorker(): void {
  if (syncInterval) return;
  // Drop any cached config — an explicit start (e.g. gossip just enabled via
  // the API) must not be no-oped by a stale cached gossip_enabled=false.
  configCache = null;
  // An explicit start also clears any backoff left from earlier failures;
  // otherwise the first sync after "enable" could be skipped for half an hour.
  syncBackoff.success();
  console.log(`[gossip] Sync worker started (polling every ${SYNC_INTERVAL_MS / 1000}s)`);
  syncInterval = setInterval(() => { void guardedSyncLoop(); }, SYNC_INTERVAL_MS);
  void guardedSyncLoop();
}

/**
 * Lazily start the sync worker if gossip is enabled.
 * Safe to call from any route — only starts once.
 */
export async function ensureSyncWorker(): Promise<void> {
  if (syncInterval) return;
  try {
    const gossip = getGossipAdapter();
    const config = await getCachedInstanceConfig(gossip);
    if (config?.gossip_enabled) {
      startSyncWorker();
    }
  } catch { /* not ready yet */ }
}

export function stopSyncWorker(): void {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}
