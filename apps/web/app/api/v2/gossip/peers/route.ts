import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { authenticateAgent, isAuthError, getGossipAdapter } from '@/lib/api-v2-auth';

// GET /api/v2/gossip/peers — List all peers (authenticated)
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  try {
    const gossip = getGossipAdapter();
    const peers = await gossip.listPeers();
    return jsonResponse({ peers });
  } catch {
    return errorResponse('Failed to fetch peers', 500);
  }
}

// POST /api/v2/gossip/peers — Add a new peer (authenticated)
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

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

  const { endpoint, fingerprint, peer_type, federation_scope, display_name } = body;

  if (!endpoint?.trim()) return errorResponse('Endpoint URL is required', 400);
  if (!fingerprint?.trim() || fingerprint.length < 8) {
    return errorResponse('Valid fingerprint is required (min 8 hex chars)', 400);
  }

  try { new URL(endpoint); } catch { return errorResponse('Invalid endpoint URL', 400); }

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
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/v2/gossip/identity`);
      if (res.ok) remoteIdentity = await res.json();
    } catch { /* Remote not reachable — verify on first sync */ }

    if (remoteIdentity && remoteIdentity.fingerprint !== fingerprint) {
      return errorResponse(
        `Fingerprint mismatch: expected ${fingerprint}, remote returned ${remoteIdentity.fingerprint}`,
        409
      );
    }

    const peer = await gossip.addPeer({
      endpoint: endpoint.replace(/\/$/, ''),
      fingerprint,
      public_key: remoteIdentity?.public_key ?? null,
      display_name: display_name ?? remoteIdentity?.display_name ?? null,
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

// DELETE /api/v2/gossip/peers — Remove a peer (authenticated)
export async function DELETE(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

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
