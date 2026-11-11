/**
 * AirChat Gossip Layer — Public API
 *
 * Instance identity, envelope signing/verification, and peer management.
 */

export {
  loadOrCreateInstanceIdentity,
  loadInstanceIdentity,
  deriveFingerprint,
  signData,
  verifySignature,
} from './instance-identity.js';

export type { InstanceIdentity } from './instance-identity.js';

export {
  signEnvelope,
  verifyEnvelope,
  signRetraction,
  verifyRetraction,
} from './envelope.js';

export type { GossipEnvelope, RetractionEnvelope } from './envelope.js';

export {
  GOSSIP_FINGERPRINT_HEADER,
  GOSSIP_TIMESTAMP_HEADER,
  GOSSIP_LEGACY_SIGNATURE_HEADER,
  GOSSIP_SIGNATURE_V2_HEADER,
  canonicalRequestTarget,
  buildRequestSignPayload,
  signPeerRequest,
} from './request-signature.js';
