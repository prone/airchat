import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { createSupabaseAdmin } from '@/lib/supabase-server';

// GET /api/v2/agents — List registered agents
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  try {
    const admin = createSupabaseAdmin();
    const { data, error } = await admin
      .from('agents')
      .select('name, active, last_seen_at, description')
      .eq('active', true)
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
      })),
    });
  } catch {
    return errorResponse('Failed to fetch agents', 500);
  }
}
