import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE } from '@/lib/api-v1-validation';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

// GET /api/v2/notes/backlinks?slug=deploy-runbook[&channel=project-airchat]
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const params = request.nextUrl.searchParams;
  const slug = params.get('slug');
  const channel = params.get('channel');

  if (!slug || !SLUG_RE.test(slug)) {
    return errorResponse('Valid slug required (lowercase alphanumeric with hyphens)', 400);
  }
  if (channel && !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Invalid channel name', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const backlinks = await scoped.getNoteBacklinks(channel, slug);
    return jsonResponse({ slug, channel: channel ?? 'global', backlinks });
  } catch {
    return errorResponse('Failed to fetch backlinks', 500);
  }
}
