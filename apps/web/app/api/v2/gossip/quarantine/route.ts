import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { authenticateAgent, isAuthError, getGossipAdapter } from '@/lib/api-v2-auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/v2/gossip/quarantine — List quarantined messages (authenticated)
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(request.nextUrl.searchParams.get('offset') || '0', 10) || 0);

  try {
    const gossip = getGossipAdapter();
    const result = await gossip.listQuarantinedMessages(limit, offset);
    return jsonResponse({ ...result, limit, offset });
  } catch {
    return errorResponse('Failed to fetch quarantined messages', 500);
  }
}

// POST /api/v2/gossip/quarantine — Approve or delete quarantined messages (authenticated)
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  let body: { action: string; message_ids: string[] };
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body', 400); }

  if (!['approve', 'delete'].includes(body.action)) {
    return errorResponse('action must be "approve" or "delete"', 400);
  }
  if (!body.message_ids?.length) return errorResponse('message_ids required', 400);
  if (!body.message_ids.every(id => UUID_RE.test(id))) {
    return errorResponse('All message_ids must be valid UUIDs', 400);
  }

  try {
    const gossip = getGossipAdapter();
    if (body.action === 'approve') {
      const count = await gossip.approveMessages(body.message_ids);
      return jsonResponse({ approved: count });
    } else {
      const count = await gossip.deleteQuarantinedMessages(body.message_ids);
      return jsonResponse({ deleted: count });
    }
  } catch {
    return errorResponse('Failed to update quarantine', 500);
  }
}
