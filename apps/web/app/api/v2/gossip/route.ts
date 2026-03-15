import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { authenticateAgent, isAuthError, getGossipAdapter } from '@/lib/api-v2-auth';

// Default supernodes shipped with AirChat (with pinned fingerprints)
const DEFAULT_SUPERNODES = [
  { endpoint: 'https://supernode-1.airchat.work', fingerprint: 'b4e8f2a1c7d3e5f6' },
  { endpoint: 'https://supernode-2.airchat.work', fingerprint: '9a1c3d5e7f2b4a6c' },
  { endpoint: 'https://supernode-3.airchat.work', fingerprint: 'e2f4a6c8d0b1e3f5' },
];

// POST /api/v2/gossip — Enable or disable gossip (authenticated)
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  let body: { action: string };
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body', 400); }

  if (!['enable', 'disable'].includes(body.action)) {
    return errorResponse('action must be "enable" or "disable"', 400);
  }

  try {
    const gossip = getGossipAdapter();

    if (body.action === 'enable') {
      const config = await gossip.getInstanceConfig();
      if (!config) return errorResponse('Instance identity not configured. Run setup first.', 400);

      await gossip.updateInstanceConfig({ gossip_enabled: true });

      // Add default supernodes
      for (const sn of DEFAULT_SUPERNODES) {
        await gossip.upsertPeerByEndpoint({
          endpoint: sn.endpoint,
          fingerprint: sn.fingerprint,
          peer_type: 'supernode',
          federation_scope: 'global',
          is_default_supernode: true,
        });
      }

      return jsonResponse({
        gossip_enabled: true,
        default_supernodes: DEFAULT_SUPERNODES.map((s) => s.endpoint),
      });
    } else {
      await gossip.updateInstanceConfig({ gossip_enabled: false });
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
    const gossip = getGossipAdapter();
    const config = await gossip.getInstanceConfig();
    const peers = await gossip.listPeers();

    const activePeers = peers.filter((p: { active: boolean; suspended: boolean }) => p.active && !p.suspended);
    const supernodes = peers.filter((p: { peer_type: string }) => p.peer_type === 'supernode');
    const suspendedPeers = peers.filter((p: { suspended: boolean }) => p.suspended);

    const quarantineCount = await gossip.countRecentQuarantined(24 * 60 * 60 * 1000);

    return jsonResponse({
      instance: config ?? { gossip_enabled: false },
      peers: {
        total: peers.length,
        active: activePeers.length,
        supernodes: supernodes.length,
        suspended: suspendedPeers.length,
      },
      health: { quarantine_count_last_24h: quarantineCount },
    });
  } catch {
    return errorResponse('Failed to fetch gossip health', 500);
  }
}
