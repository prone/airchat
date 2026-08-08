import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { createSupabaseAdmin } from '@/lib/supabase-server';

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

// GET /api/v2/agents — List registered agents.
// ?capability=<tag> filters to agents whose card declares that capability.
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const capability = request.nextUrl.searchParams.get('capability');
  if (capability !== null && !CAPABILITY_PATTERN.test(capability)) {
    return errorResponse('Invalid capability filter: must be a kebab-case tag', 400);
  }

  try {
    const admin = createSupabaseAdmin();
    let query = admin
      .from('agents')
      .select('name, active, last_seen_at, description, metadata')
      .eq('active', true)
      .order('last_seen_at', { ascending: false, nullsFirst: false });

    if (capability) {
      // JSONB containment: metadata @> {"card":{"capabilities":["<tag>"]}}
      query = query.contains('metadata', { card: { capabilities: [capability] } });
    }

    const { data, error } = await query;

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
