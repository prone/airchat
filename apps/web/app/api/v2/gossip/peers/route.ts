import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getGossipAdapter } from '@/lib/api-v2-auth';
import { requireInstanceAdmin, authenticateAgentOrAdmin } from '@/lib/instance-admin';
import { validatePeerEndpoint } from '@/lib/url-validation';
import { FINGERPRINT_RE } from '@/lib/gossip-auth';
import { fetchPeerKey, peerDisplayName } from '@/lib/peer-identity';

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

    // Fetch the remote's public key and check it against the fingerprint.
    // A peer that cannot be reached is still added, without a key; the sync
    // worker asks again before it first syncs with it.
    const key = await fetchPeerKey(endpoint, fingerprint);
    if (key.status === 'invalid') {
      return errorResponse('Remote instance returned an invalid public key', 409);
    }
    if (key.status === 'mismatch') {
      return errorResponse(
        `Fingerprint mismatch: expected ${fingerprint}, but the remote public key has fingerprint ${key.actualFingerprint}`,
        409
      );
    }
    const remote = key.status === 'verified' ? key : null;

    const peer = await gossip.addPeer({
      endpoint: endpoint.replace(/\/$/, ''),
      fingerprint,
      public_key: remote?.publicKey ?? null,
      display_name: peerDisplayName(display_name) ?? remote?.displayName ?? null,
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
