/**
 * Signing of requests between gossip peers.
 *
 * A peer proves who it is by signing each request with its instance key. The
 * signature (header `x-gossip-signature-v2`) covers:
 *
 *   method | path + query | recipient fingerprint | timestamp | sha256(body)
 *
 * Binding the recipient means a signature made for one instance is useless at
 * another; binding the path, query and body means it cannot be reused for a
 * different request to the same instance.
 *
 * Earlier versions signed only the timestamp (header `x-gossip-signature`).
 * Whoever received such a request could replay the same three values to any
 * other instance for five minutes and be accepted as the sender. Outgoing
 * requests still carry that signature next to the new one, so that peers which
 * have not upgraded keep accepting them; whether an instance still ACCEPTS it
 * is its own decision (see GOSSIP_ACCEPT_LEGACY_SIGNATURES in the web app's
 * lib/gossip-auth.ts).
 */

import crypto from 'node:crypto';
import { signData } from './instance-identity.js';

export const GOSSIP_FINGERPRINT_HEADER = 'x-gossip-fingerprint';
export const GOSSIP_TIMESTAMP_HEADER = 'x-gossip-timestamp';
export const GOSSIP_LEGACY_SIGNATURE_HEADER = 'x-gossip-signature';
export const GOSSIP_SIGNATURE_V2_HEADER = 'x-gossip-signature-v2';

const GOSSIP_PATH_MARKER = '/api/v2/gossip/';

/**
 * The path and query of a gossip request in the form both sides sign.
 *
 * Only the part of the path from `/api/v2/gossip/` on is used, so a reverse
 * proxy that serves the instance under a path prefix does not break
 * signatures. Query parameters are decoded, sorted and re-encoded so that two
 * URL libraries escaping the same value differently still agree.
 */
export function canonicalRequestTarget(url: URL): string {
  const at = url.pathname.lastIndexOf(GOSSIP_PATH_MARKER);
  const path = at >= 0 ? url.pathname.slice(at) : url.pathname;
  const params = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  );
  const query = new URLSearchParams(params).toString();
  return query ? `${path}?${query}` : path;
}

/** The exact text covered by a v2 request signature. */
export function buildRequestSignPayload(parts: {
  method: string;
  url: URL;
  recipientFingerprint: string;
  timestamp: string;
  body: string;
}): string {
  // A JSON array rather than a joined string, so no field can run into the next.
  return JSON.stringify([
    'airchat-gossip-request-v2',
    parts.method.toUpperCase(),
    canonicalRequestTarget(parts.url),
    parts.recipientFingerprint,
    parts.timestamp,
    crypto.createHash('sha256').update(parts.body, 'utf-8').digest('hex'),
  ]);
}

/**
 * Headers that authenticate an outgoing request to one specific peer.
 *
 * The old timestamp-only signature is left out unless asked for. It says
 * nothing about which request or which instance it was made for, so whoever
 * receives it could present it, for as long as the timestamp is fresh, to any
 * other instance that still accepts such signatures and knows the sender.
 * Send it only while a peer on an earlier version needs it.
 */
export function signPeerRequest(
  privateKey: string,
  request: {
    method: string;
    url: string;
    senderFingerprint: string;
    recipientFingerprint: string;
    /** The exact bytes that will be sent as the body, if any. */
    body?: string;
    /** Defaults to now. */
    timestamp?: string;
    /** Also send the timestamp-only signature, for a peer on an earlier version. */
    includeLegacySignature?: boolean;
  },
): Record<string, string> {
  const timestamp = request.timestamp ?? new Date().toISOString();
  const payload = buildRequestSignPayload({
    method: request.method,
    url: new URL(request.url),
    recipientFingerprint: request.recipientFingerprint,
    timestamp,
    body: request.body ?? '',
  });
  return {
    [GOSSIP_FINGERPRINT_HEADER]: request.senderFingerprint,
    [GOSSIP_TIMESTAMP_HEADER]: timestamp,
    ...(request.includeLegacySignature
      ? { [GOSSIP_LEGACY_SIGNATURE_HEADER]: signData(privateKey, timestamp) }
      : {}),
    [GOSSIP_SIGNATURE_V2_HEADER]: signData(privateKey, payload),
  };
}
