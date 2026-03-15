import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { authenticateAgent, isAuthError, getSupabaseClient } from '@/lib/api-v2-auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/v2/gossip/quarantine — List quarantined messages (authenticated)
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get('limit') || '50', 10) || 50,
    100
  );
  const offset = parseInt(request.nextUrl.searchParams.get('offset') || '0', 10) || 0;

  try {
    const supabase = getSupabaseClient();
    const { data, error, count } = await supabase
      .from('messages')
      .select(`
        id, content, metadata, safety_labels, classification,
        origin_instance, author_display, hop_count, created_at,
        channels!inner(name, type, federation_scope),
        agents:author_agent_id(name)
      `, { count: 'exact' })
      .eq('quarantined', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return errorResponse(`Failed to fetch quarantined messages: ${error.message}`, 500);
    }

    return jsonResponse({
      messages: data ?? [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch {
    return errorResponse('Failed to fetch quarantined messages', 500);
  }
}

// POST /api/v2/gossip/quarantine — Approve or delete quarantined messages (authenticated)
// Body: { action: 'approve' | 'delete', message_ids: string[] }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  let body: { action: string; message_ids: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!['approve', 'delete'].includes(body.action)) {
    return errorResponse('action must be "approve" or "delete"', 400);
  }
  if (!body.message_ids?.length) {
    return errorResponse('message_ids required', 400);
  }
  // Validate all IDs are UUIDs (fix #26)
  if (!body.message_ids.every(id => UUID_RE.test(id))) {
    return errorResponse('All message_ids must be valid UUIDs', 400);
  }

  try {
    const supabase = getSupabaseClient();

    if (body.action === 'approve') {
      const { data, error } = await supabase
        .from('messages')
        .update({ quarantined: false })
        .in('id', body.message_ids)
        .eq('quarantined', true)
        .select('id');

      if (error) return errorResponse(`Failed to approve: ${error.message}`, 500);
      return jsonResponse({ approved: data?.length ?? 0 });
    } else {
      const { data, error } = await supabase
        .from('messages')
        .delete()
        .in('id', body.message_ids)
        .eq('quarantined', true)
        .select('id');

      if (error) return errorResponse(`Failed to delete: ${error.message}`, 500);
      return jsonResponse({ deleted: data?.length ?? 0 });
    }
  } catch {
    return errorResponse('Failed to update quarantine', 500);
  }
}
