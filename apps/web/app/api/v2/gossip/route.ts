import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { authenticateAgent, isAuthError, getSupabaseClient } from '@/lib/api-v2-auth';

// Default supernodes shipped with AirChat (with pinned fingerprints)
const DEFAULT_SUPERNODES = [
  { endpoint: 'https://supernode-1.airchat.work', fingerprint: 'b4e8f2a1c7d3e5f6' },
  { endpoint: 'https://supernode-2.airchat.work', fingerprint: '9a1c3d5e7f2b4a6c' },
  { endpoint: 'https://supernode-3.airchat.work', fingerprint: 'e2f4a6c8d0b1e3f5' },
];

// POST /api/v2/gossip — Enable or disable gossip (authenticated)
// Body: { action: 'enable' | 'disable' }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  let body: { action: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!['enable', 'disable'].includes(body.action)) {
    return errorResponse('action must be "enable" or "disable"', 400);
  }

  try {
    const supabase = getSupabaseClient();

    if (body.action === 'enable') {
      // Update gossip_enabled flag on the singleton config row
      const { data: existingConfig } = await supabase
        .from('gossip_instance_config')
        .select('id')
        .limit(1)
        .single();

      if (!existingConfig) {
        return errorResponse('Instance identity not configured. Run setup first.', 400);
      }

      const { error: configErr } = await supabase
        .from('gossip_instance_config')
        .update({ gossip_enabled: true, updated_at: new Date().toISOString() })
        .eq('id', existingConfig.id);

      if (configErr) {
        return errorResponse('Failed to enable gossip', 500);
      }

      // Add default supernodes if not already peered
      for (const sn of DEFAULT_SUPERNODES) {
        await supabase
          .from('gossip_peers')
          .upsert(
            {
              endpoint: sn.endpoint,
              fingerprint: sn.fingerprint,
              peer_type: 'supernode',
              federation_scope: 'global',
              is_default_supernode: true,
            },
            { onConflict: 'endpoint' }
          );
      }

      return jsonResponse({
        gossip_enabled: true,
        default_supernodes: DEFAULT_SUPERNODES.map((s) => s.endpoint),
      });
    } else {
      // Disable gossip (stop sync, keep data)
      const { data: existingCfg } = await supabase
        .from('gossip_instance_config')
        .select('id')
        .limit(1)
        .single();

      if (!existingCfg) {
        return errorResponse('Instance identity not configured', 400);
      }

      const { error: configErr } = await supabase
        .from('gossip_instance_config')
        .update({ gossip_enabled: false, updated_at: new Date().toISOString() })
        .eq('id', existingCfg.id);

      if (configErr) {
        return errorResponse('Failed to disable gossip', 500);
      }

      return jsonResponse({ gossip_enabled: false });
    }
  } catch {
    return errorResponse('Failed to update gossip settings', 500);
  }
}

// GET /api/v2/gossip — Gossip status and health (authenticated)
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;
  try {
    const supabase = getSupabaseClient();

    // Instance config
    const { data: config } = await supabase
      .from('gossip_instance_config')
      .select('fingerprint, display_name, gossip_enabled')
      .limit(1)
      .single();

    // Peer stats
    const { data: peers } = await supabase
      .from('gossip_peers')
      .select('id, endpoint, peer_type, active, suspended, last_sync_at, messages_received, messages_quarantined');

    const activePeers = peers?.filter((p) => p.active && !p.suspended) ?? [];
    const supernodes = peers?.filter((p) => p.peer_type === 'supernode') ?? [];
    const suspendedPeers = peers?.filter((p) => p.suspended) ?? [];

    // Recent quarantine count (last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: quarantineCount } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('quarantined', true)
      .gt('created_at', oneDayAgo);

    return jsonResponse({
      instance: config ?? { gossip_enabled: false },
      peers: {
        total: peers?.length ?? 0,
        active: activePeers.length,
        supernodes: supernodes.length,
        suspended: suspendedPeers.length,
      },
      health: {
        quarantine_count_last_24h: quarantineCount ?? 0,
      },
    });
  } catch {
    return errorResponse('Failed to fetch gossip health', 500);
  }
}
