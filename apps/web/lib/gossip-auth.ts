/**
 * Authentication of incoming requests from gossip peers.
 *
 * A peer signs each request with its instance key; what the signature covers
 * and why is described in @airchat/shared/gossip (request-signature.ts). In
 * short: method, path and query, the RECIPIENT's fingerprint, a timestamp and
 * a hash of the body. This module is the receiving side. It rebuilds the
 * signed text with this instance's own fingerprint as the recipient, so a
 * request that was signed for any other instance fails verification.
 *
 * Compatibility with older instances
 * ----------------------------------
 * Earlier versions signed only the timestamp (header `x-gossip-signature`).
 * Whoever received such a request could replay the same three values to any
 * other instance for five minutes and be accepted as the sender.
 *
 *  - Outgoing requests carry BOTH signatures, so peers that have not upgraded
 *    still accept them.
 *  - Incoming requests are verified against the new signature whenever it is
 *    present. A request carrying only the old signature is refused unless the
 *    operator sets the environment variable
 *    `GOSSIP_ACCEPT_LEGACY_SIGNATURES=true` (default: refused). Set it only
 *    while peers you depend on are still running the old code, and unset it
 *    once they have upgraded: while it is on, the replay described above
 *    works against this instance.
 */

import type { NextRequest, NextResponse } from 'next/server';
import {
  verifySignature,
  buildRequestSignPayload,
  GOSSIP_FINGERPRINT_HEADER as FINGERPRINT_HEADER,
  GOSSIP_TIMESTAMP_HEADER as TIMESTAMP_HEADER,
  GOSSIP_LEGACY_SIGNATURE_HEADER as LEGACY_SIGNATURE_HEADER,
  GOSSIP_SIGNATURE_V2_HEADER as SIGNATURE_V2_HEADER,
} from '@airchat/shared/gossip';
import type { GossipInstanceConfig, GossipPeer, GossipStorageAdapter } from '@airchat/shared';
import { errorResponse } from '@/lib/api-v1-response';
import { getGossipAdapter } from '@/lib/api-v2-auth';
import { checkIpRateLimit, checkRateLimit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { checkGossipNonce } from '@/lib/gossip-nonce';

export { signPeerRequest, buildRequestSignPayload, canonicalRequestTarget } from '@airchat/shared/gossip';

/** An instance fingerprint: the first 16 hex characters of sha256(public key). */
export const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
/** An Ed25519 public key as lowercase or uppercase hex. */
export const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;
// An Ed25519 signature is 64 bytes, 88 characters of base64. The cap leaves
// room for encoding variations without accepting arbitrarily long headers.
const SIGNATURE_RE = /^[A-Za-z0-9+/=_-]{16,128}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const REQUEST_WINDOW_MS = 5 * 60 * 1000;

/** Whether requests signed only with the old timestamp signature are accepted. */
export function legacySignaturesAccepted(): boolean {
  return process.env.GOSSIP_ACCEPT_LEGACY_SIGNATURES === 'true';
}

/** Read a request body as text, giving up once it exceeds `maxBytes`. */
async function readBodyCapped(request: NextRequest, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function safeVerify(publicKey: string, data: string, signature: string): boolean {
  try {
    return verifySignature(publicKey, data, signature);
  } catch {
    // A malformed key or signature is simply not a valid signature.
    return false;
  }
}

export interface AuthenticatedPeerRequest {
  peer: GossipPeer;
  config: GossipInstanceConfig;
  gossip: GossipStorageAdapter;
  /** The raw request body ('' when `readBody` was not requested). */
  body: string;
}

/**
 * Authenticate an incoming peer request. Returns the peer on success, or the
 * error response to send.
 *
 * Order matters here:
 *  1. Per-IP rate limit and header checks happen before any database work, so
 *     unauthenticated callers cannot use these routes to load the database.
 *  2. The per-peer rate limit and the replay record are applied only after the
 *     signature verifies. Both are keyed on the peer's fingerprint, which is
 *     public: applied earlier, anyone could exhaust a real peer's allowance or
 *     pre-register its next request as "already seen".
 */
export async function authenticatePeerRequest(
  request: NextRequest,
  opts: {
    /** Names the per-peer rate limit bucket, e.g. 'gossip-push'. */
    bucket: string;
    maxPerMinute: number;
    /** Read the body (needed whenever the route has one: it is part of the signature). */
    readBody?: boolean;
    maxBodyBytes?: number;
    /**
     * Also accept fingerprint, timestamp and legacy signature as fields of a
     * JSON body. Only the notify route used that shape.
     */
    legacyCredentialsInBody?: boolean;
  },
): Promise<AuthenticatedPeerRequest | NextResponse> {
  const ipLimit = checkIpRateLimit(clientIp(request));
  if (!ipLimit.allowed) return errorResponse('Rate limit exceeded', 429);

  let body = '';
  if (opts.readBody) {
    const read = await readBodyCapped(request, opts.maxBodyBytes ?? 256 * 1024);
    if (read === null) return errorResponse('Request body too large', 413);
    body = read;
  }

  let fingerprint = request.headers.get(FINGERPRINT_HEADER);
  let timestamp = request.headers.get(TIMESTAMP_HEADER);
  let legacySignature = request.headers.get(LEGACY_SIGNATURE_HEADER);
  const signatureV2 = request.headers.get(SIGNATURE_V2_HEADER);

  if (opts.legacyCredentialsInBody && (!fingerprint || !timestamp)) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed.fingerprint === 'string') fingerprint ??= parsed.fingerprint;
      if (typeof parsed.timestamp === 'string') timestamp ??= parsed.timestamp;
      if (typeof parsed.signature === 'string') legacySignature ??= parsed.signature;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
  }

  if (!fingerprint || !timestamp || (!signatureV2 && !legacySignature)) {
    return errorResponse(
      `${FINGERPRINT_HEADER}, ${TIMESTAMP_HEADER} and ${SIGNATURE_V2_HEADER} headers required`,
      401,
    );
  }
  if (!FINGERPRINT_RE.test(fingerprint) || !TIMESTAMP_RE.test(timestamp)) {
    return errorResponse('Malformed gossip authentication headers', 401);
  }
  const signature = signatureV2 ?? legacySignature!;
  if (!SIGNATURE_RE.test(signature)) {
    return errorResponse('Malformed gossip authentication headers', 401);
  }

  const requestAge = Date.now() - new Date(timestamp).getTime();
  if (isNaN(requestAge) || Math.abs(requestAge) > REQUEST_WINDOW_MS) {
    return errorResponse('Request timestamp too old or invalid', 401);
  }

  if (!signatureV2 && !legacySignaturesAccepted()) {
    return errorResponse(
      `Timestamp-only signatures are no longer accepted; send ${SIGNATURE_V2_HEADER} (upgrade the sending instance)`,
      401,
    );
  }

  const gossip = getGossipAdapter();

  const peer = await gossip.getPeerByFingerprint(fingerprint);
  if (!peer) return errorResponse('Unknown peer', 403);
  if (!peer.active || peer.suspended) return errorResponse('Peer is suspended', 403);
  if (!peer.public_key) return errorResponse('Peer public key not yet exchanged', 403);

  const config = await gossip.getInstanceConfig();
  if (!config) return errorResponse('Gossip is disabled on this instance', 503);

  const verified = signatureV2
    ? safeVerify(
        peer.public_key,
        buildRequestSignPayload({
          method: request.method,
          url: request.nextUrl,
          recipientFingerprint: config.fingerprint,
          timestamp,
          body,
        }),
        signatureV2,
      )
    : safeVerify(peer.public_key, timestamp, legacySignature!);
  if (!verified) return errorResponse('Invalid signature', 403);

  const peerLimit = checkRateLimit(`${opts.bucket}:${fingerprint}`, 60_000, opts.maxPerMinute);
  if (!peerLimit.allowed) return errorResponse('Rate limit exceeded', 429);

  // A v2 signature is unique to one request (it covers path and body), so it
  // is the replay marker. A legacy signature covers only the timestamp, so the
  // timestamp is all there is to remember.
  if (checkGossipNonce(fingerprint, signatureV2 ? `v2:${signatureV2}` : `legacy:${timestamp}`)) {
    return errorResponse('Duplicate request', 401);
  }

  if (!config.gossip_enabled) return errorResponse('Gossip is disabled on this instance', 503);

  return { peer, config, gossip, body };
}
