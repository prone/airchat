import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { getGossipAdapter } from '@/lib/api-v2-auth';
import { checkIpRateLimit } from '@/lib/rate-limit';

// GET /api/v2/gossip/identity — Return this instance's public identity
// Public endpoint (no auth) but rate-limited by IP.
export async function GET(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = (forwarded ? forwarded.split(',')[0].trim() : null) ?? request.headers.get('x-real-ip') ?? 'unknown';
  const rateLimit = checkIpRateLimit(ip);
  if (!rateLimit.allowed) {
    return errorResponse('Rate limit exceeded', 429);
  }

  try {
    const gossip = getGossipAdapter();
    const config = await gossip.getInstanceConfig();

    if (!config) {
      return errorResponse('Instance identity not configured. Run setup first.', 404);
    }

    return jsonResponse({
      public_key: config.public_key,
      fingerprint: config.fingerprint,
      display_name: config.display_name,
      domain: config.domain,
      gossip_enabled: config.gossip_enabled,
    });
  } catch {
    return errorResponse('Failed to fetch instance identity', 500);
  }
}
