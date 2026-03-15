import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { authenticateAgent, isAuthError, getSupabaseClient } from '@/lib/api-v2-auth';

// GET /api/v2/gossip/peers — List all peers with status (authenticated)
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('gossip_peers')
      .select('id, endpoint, fingerprint, display_name, peer_type, federation_scope, active, suspended, suspended_at, suspended_reason, is_default_supernode, last_sync_at, last_sync_error, messages_received, messages_quarantined, created_at')
      .order('created_at');

    if (error) {
      return errorResponse('Failed to fetch peers', 500);
    }

    return jsonResponse({ peers: data });
  } catch {
    return errorResponse('Failed to fetch peers', 500);
  }
}

// POST /api/v2/gossip/peers — Add a new peer (authenticated)
// Body: { endpoint, fingerprint, peer_type?, federation_scope?, display_name? }
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

  if (!endpoint?.trim()) {
    return errorResponse('Endpoint URL is required', 400);
  }
  if (!fingerprint?.trim() || fingerprint.length < 8) {
    return errorResponse('Valid fingerprint is required (min 8 hex chars)', 400);
  }

  // Validate endpoint is a URL
  try {
    new URL(endpoint);
  } catch {
    return errorResponse('Invalid endpoint URL', 400);
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
    const supabase = getSupabaseClient();

    // Verify remote instance identity by fetching their public key
    let remoteIdentity: { public_key: string; fingerprint: string; display_name?: string } | null = null;
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/v2/gossip/identity`);
      if (res.ok) {
        remoteIdentity = await res.json();
      }
    } catch {
      // Remote not reachable — store peer with fingerprint only, verify on first sync
    }

    // If we got a response, verify the fingerprint matches
    if (remoteIdentity && remoteIdentity.fingerprint !== fingerprint) {
      return errorResponse(
        `Fingerprint mismatch: expected ${fingerprint}, remote returned ${remoteIdentity.fingerprint}. This may indicate a MITM attack or wrong endpoint.`,
        409
      );
    }

    const { data, error } = await supabase
      .from('gossip_peers')
      .insert({
        endpoint: endpoint.replace(/\/$/, ''), // Normalize trailing slash
        fingerprint,
        public_key: remoteIdentity?.public_key ?? null,
        display_name: display_name ?? remoteIdentity?.display_name ?? null,
        peer_type: peerType,
        federation_scope: scope,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') { // Unique violation
        return errorResponse('Peer with this endpoint already exists', 409);
      }
      return errorResponse(`Failed to add peer: ${error.message}`, 500);
    }

    return jsonResponse({ peer: data }, 201);
  } catch {
    return errorResponse('Failed to add peer', 500);
  }
}

// DELETE /api/v2/gossip/peers — Remove a peer (authenticated)
// Body: { endpoint }
export async function DELETE(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  let body: { endpoint?: string; id?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!body.endpoint && !body.id) {
    return errorResponse('endpoint or id is required', 400);
  }

  try {
    const supabase = getSupabaseClient();
    let query = supabase.from('gossip_peers').delete();

    if (body.id) {
      query = query.eq('id', body.id);
    } else {
      query = query.eq('endpoint', body.endpoint!);
    }

    const { error } = await query;
    if (error) {
      return errorResponse(`Failed to remove peer: ${error.message}`, 500);
    }

    return jsonResponse({ removed: true });
  } catch {
    return errorResponse('Failed to remove peer', 500);
  }
}
