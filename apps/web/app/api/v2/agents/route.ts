import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { createSupabaseAdmin } from '@/lib/supabase-server';

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

/**
 * Windows accepted by `?active_within=`, in milliseconds.
 *
 * `active` on an agent row means "not deactivated", which is not the same
 * question as "is anyone there". It stays true from registration until someone
 * turns it off, so an unfiltered list answers "every agent that ever existed
 * and was not retired" — 70 rows here, of which 2 had been seen in the previous
 * quarter of an hour. A picker built on that shows mostly ghosts.
 *
 * `last_seen_at` is the honest signal. It is a proxy, not presence: it records
 * the last authenticated request, so an agent sitting idle at a prompt looks
 * offline until its next call. For "who is actually working right now" that is
 * the correct bias — it reports agents doing something, not agents merely open.
 */
const ACTIVE_WITHIN_MS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

// GET /api/v2/agents — List registered agents.
//   ?capability=<tag>                agents whose card declares that capability
//   ?active_within=15m|1h|6h|1d|7d   only agents seen within that window
// The two compose: "who can do image-gen AND has been around in the last hour"
// is the routing question both filters exist to answer.
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const capability = request.nextUrl.searchParams.get('capability');
  if (capability !== null && !CAPABILITY_PATTERN.test(capability)) {
    return errorResponse('Invalid capability filter: must be a kebab-case tag', 400);
  }

  // An unrecognised window is a 400 rather than being ignored: silently
  // returning every agent while the caller believed it asked for the live
  // ones is the failure this parameter exists to prevent.
  const activeWithin = request.nextUrl.searchParams.get('active_within');
  if (activeWithin && !(activeWithin in ACTIVE_WITHIN_MS)) {
    return errorResponse(
      `active_within must be one of: ${Object.keys(ACTIVE_WITHIN_MS).join(', ')}`,
      400,
    );
  }

  try {
    const admin = createSupabaseAdmin();
    let query = admin
      .from('agents')
      .select('name, active, last_seen_at, description, metadata')
      .eq('active', true);

    if (capability) {
      // JSONB containment: metadata @> {"card":{"capabilities":["<tag>"]}}
      query = query.contains('metadata', { card: { capabilities: [capability] } });
    }

    if (activeWithin) {
      const since = new Date(Date.now() - ACTIVE_WITHIN_MS[activeWithin]).toISOString();
      // Rows with a null last_seen_at have never made a request, so they are
      // excluded by the comparison rather than needing a separate clause.
      query = query.gte('last_seen_at', since);
    }

    const { data, error } = await query
      .order('last_seen_at', { ascending: false, nullsFirst: false });

    if (error) {
      return errorResponse('Failed to fetch agents', 500);
    }

    return jsonResponse({
      agents: (data || []).map(a => ({
        name: a.name,
        active: a.active,
        last_seen_at: a.last_seen_at,
        description: a.description,
        card: (a.metadata as Record<string, unknown> | null)?.card ?? null,
      })),
    });
  } catch {
    return errorResponse('Failed to fetch agents', 500);
  }
}
