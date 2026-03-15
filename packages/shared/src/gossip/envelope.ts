/**
 * Gossip envelope — the wire format for messages between instances.
 *
 * When messages transit between instances (via sync), they are wrapped
 * in a signed envelope. The signature covers all fields except hop_count
 * and safety_labels (which are modified in transit by supernodes).
 */

import { signData, verifySignature } from './instance-identity.js';

export interface GossipEnvelope {
  message_id: string;
  channel_name: string;
  origin_instance: string;      // Public key fingerprint of originating instance
  author_agent: string;         // e.g., "build-bot@a7f3b2c1"
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  signature: string;            // Ed25519 by origin instance key
  hop_count: number;
  safety_labels: string[];
  federation_scope: 'peers' | 'global';
}

export interface RetractionEnvelope {
  retracted_message_id: string;
  reason: string;
  retracted_by: string;         // Fingerprint of retracting instance
  retracted_at: string;
  signature: string;
}

/**
 * Build the canonical string for signing a gossip envelope.
 * Excludes hop_count and safety_labels (modified in transit).
 */
function buildEnvelopeSignPayload(envelope: Omit<GossipEnvelope, 'signature' | 'hop_count' | 'safety_labels'>): string {
  return JSON.stringify([
    envelope.message_id,
    envelope.channel_name,
    envelope.origin_instance,
    envelope.author_agent,
    envelope.content,
    envelope.metadata ? JSON.stringify(envelope.metadata) : '',
    envelope.created_at,
    envelope.federation_scope,
  ]);
}

/**
 * Sign a gossip envelope with the instance private key.
 */
export function signEnvelope(
  privateKeyHex: string,
  envelope: Omit<GossipEnvelope, 'signature'>
): GossipEnvelope {
  const payload = buildEnvelopeSignPayload(envelope);
  const signature = signData(privateKeyHex, payload);
  return { ...envelope, signature };
}

/**
 * Verify a gossip envelope signature against the origin instance's public key.
 */
export function verifyEnvelope(
  originPublicKeyHex: string,
  envelope: GossipEnvelope
): boolean {
  const payload = buildEnvelopeSignPayload(envelope);
  return verifySignature(originPublicKeyHex, payload, envelope.signature);
}

/**
 * Build the canonical string for signing a retraction envelope.
 */
function buildRetractionSignPayload(retraction: Omit<RetractionEnvelope, 'signature'>): string {
  return JSON.stringify([
    retraction.retracted_message_id,
    retraction.reason,
    retraction.retracted_by,
    retraction.retracted_at,
  ]);
}

/**
 * Sign a retraction envelope.
 */
export function signRetraction(
  privateKeyHex: string,
  retraction: Omit<RetractionEnvelope, 'signature'>
): RetractionEnvelope {
  const payload = buildRetractionSignPayload(retraction);
  const signature = signData(privateKeyHex, payload);
  return { ...retraction, signature };
}

/**
 * Verify a retraction envelope signature.
 */
export function verifyRetraction(
  publicKeyHex: string,
  retraction: RetractionEnvelope
): boolean {
  const payload = buildRetractionSignPayload(retraction);
  return verifySignature(publicKeyHex, payload, retraction.signature);
}
