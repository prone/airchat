import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getGossipAdapter } from '@/lib/api-v2-auth';
import { requireInstanceAdmin, authenticateAgentOrAdmin } from '@/lib/instance-admin';
import { validatePeerEndpoint, fetchPeerUrl } from '@/lib/url-validation';
import { deriveFingerprint } from '@airchat/shared/gossip';
import { FINGERPRINT_RE, PUBLIC_KEY_RE } from '@/lib/gossip-auth';

// GET /api/v2/gossip/peers — List all peers (agent or instance admin)
export async function GET(request: NextRequest) {
  const auth = await authenticateAgentOrAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const gossip = getGossipAdapter();
    const peers = await gossip.listPeers();
    return jsonResponse({ peers });
  } catch {
    return errorResponse('Failed to fetch peers', 500);
  }
}

// POST /api/v2/gossip/peers — Add a new peer (instance admin only)
export async function POST(request: NextRequest) {
  const denied = await requireInstanceAdmin(request);
  if (denied) return denied;

  let body: {
    endpoint: string;
    fingerprint: string;
    peer_type?: string;
    federation_scope?: string;
    display_name?: string;
  };

  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { endpoint, peer_type, federation_scope, display_name } = body;

  if (typeof endpoint !== 'string' || !endpoint.trim()) return errorResponse('Endpoint URL is required', 400);
  // The full fingerprint is required. A shortened one would match many keys,
  // and the fingerprint is the only thing the operator vouches for here.
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim().toLowerCase() : '';
  if (!FINGERPRINT_RE.test(fingerprint)) {
    return errorResponse('Valid fingerprint is required (the full 16 hex characters)', 400);
  }

  try { new URL(endpoint); } catch { return errorResponse('Invalid endpoint URL', 400); }

  // SSRF protection: validate endpoint doesn't point to internal/private networks
  const urlCheck = await validatePeerEndpoint(endpoint);
  if (!urlCheck.valid) {
    return errorResponse(urlCheck.error || 'Invalid endpoint', 400);
  }

  const peerType = peer_type ?? 'instance';
  if (!['instance', 'supernode'].includes(peerType)) {
    return errorResponse('peer_type must be "instance" or "supernode"', 400);
  }

  const scope = federation_scope ?? 'global';
  if (!['peers', 'global'].includes(scope)) {
    return errorResponse('federation_scope must be "peers" or "global"', 400);
  }

  try {
    const gossip = getGossipAdapter();

    // Verify remote identity by fetching their public key
    let remoteIdentity: { public_key: string; fingerprint: string; display_name?: string } | null = null;
    try {
      const res = await fetchPeerUrl(
        `${endpoint.replace(/\/$/, '')}/api/v2/gossip/identity`,
        { timeoutMs: 10000 },
      );
      if (res.ok) {
        const json = await res.json();
        // Identity endpoint uses AirChat response wrapper — data is in .data
        remoteIdentity = json.data ?? json;
      }
    } catch { /* Remote not reachable — verify on first sync */ }

    // The fingerprint the remote reports about itself is just a string it
    // chose. What identifies it is its public key, so the fingerprint is
    // recomputed from the key it returned and compared with the one the
    // operator supplied. A key that does not hash to that fingerprint is not
    // stored.
    if (remoteIdentity) {
      const remoteKey: unknown = remoteIdentity.public_key;
      if (typeof remoteKey !== 'string' || !PUBLIC_KEY_RE.test(remoteKey)) {
        return errorResponse('Remote instance returned an invalid public key', 409);
      }
      if (deriveFingerprint(remoteKey) !== fingerprint) {
        return errorResponse(
          `Fingerprint mismatch: expected ${fingerprint}, but the remote public key has fingerprint ${deriveFingerprint(remoteKey)}`,
          409
        );
      }
    }

    const peer = await gossip.addPeer({
      endpoint: endpoint.replace(/\/$/, ''),
      fingerprint,
      public_key: remoteIdentity?.public_key ?? null,
      display_name: peerDisplayName(display_name) ?? peerDisplayName(remoteIdentity?.display_name),
      peer_type: peerType,
      federation_scope: scope,
    });

    return jsonResponse({ peer }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('DUPLICATE')) return errorResponse('Peer already exists', 409);
    return errorResponse('Failed to add peer', 500);
  }
}

/** A display name as text of bounded length, or null. The remote one is whatever the peer chose to send. */
function peerDisplayName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : null;
}

// DELETE /api/v2/gossip/peers — Remove a peer (instance admin only)
export async function DELETE(request: NextRequest) {
  const denied = await requireInstanceAdmin(request);
  if (denied) return denied;

  let body: { endpoint?: string; id?: string };
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body', 400); }

  if (!body.endpoint && !body.id) return errorResponse('endpoint or id is required', 400);

  try {
    const gossip = getGossipAdapter();
    if (body.id) {
      await gossip.removePeer(body.id);
    } else {
      await gossip.removePeerByEndpoint(body.endpoint!);
    }
    return jsonResponse({ removed: true });
  } catch {
    return errorResponse('Failed to remove peer', 500);
  }
}
