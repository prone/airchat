import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getSupabaseClient } from '@/lib/api-v2-auth';
import { checkIpRateLimit } from '@/lib/rate-limit';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=60',
};

// OPTIONS — CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/v2/gossip/stats — Public network stats (no auth, rate-limited)
export async function GET(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = (forwarded ? forwarded.split(',')[0].trim() : null) ?? request.headers.get('x-real-ip') ?? 'unknown';
  const rateLimit = checkIpRateLimit(ip);
  if (!rateLimit.allowed) {
    return errorResponse('Rate limit exceeded', 429);
  }

  try {
    const supabase = getSupabaseClient();

    const [
      gossipMessagesResult,
      globalChannelsResult,
      peersResult,
      federatedAgentsResult,
      messages24hResult,
      instanceConfigResult,
    ] = await Promise.all([
      // Total gossip messages (on gossip-* and shared-* channels)
      supabase
        .from('messages')
        .select('id, channels!inner(federation_scope)', { count: 'exact', head: true })
        .in('channels.federation_scope', ['global', 'peers']),

      // Total global channels
      supabase
        .from('channels')
        .select('id', { count: 'exact', head: true })
        .eq('federation_scope', 'global'),

      // Connected peers
      supabase
        .from('gossip_peers')
        .select('id', { count: 'exact', head: true })
        .eq('active', true)
        .eq('suspended', false),

      // Federated agents (remote agents created by sync)
      supabase
        .from('agents')
        .select('id', { count: 'exact', head: true })
        .eq('metadata->>remote', 'true'),

      // Messages in last 24h on federated channels
      supabase
        .from('messages')
        .select('id, channels!inner(federation_scope)', { count: 'exact', head: true })
        .in('channels.federation_scope', ['global', 'peers'])
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),

      // Instance config
      supabase
        .from('gossip_instance_config')
        .select('gossip_enabled, created_at, display_name, fingerprint')
        .limit(1)
        .single(),
    ]);

    const response = jsonResponse({
      total_gossip_messages: gossipMessagesResult.count ?? 0,
      total_global_channels: globalChannelsResult.count ?? 0,
      total_connected_peers: peersResult.count ?? 0,
      total_federated_agents: federatedAgentsResult.count ?? 0,
      messages_last_24h: messages24hResult.count ?? 0,
      gossip_enabled: instanceConfigResult.data?.gossip_enabled ?? false,
      gossip_enabled_since: instanceConfigResult.data?.created_at ?? null,
      instance_name: instanceConfigResult.data?.display_name ?? null,
      generated_at: new Date().toISOString(),
    });

    // Add CORS and cache headers
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  } catch {
    return errorResponse('Failed to fetch stats', 500);
  }
}
