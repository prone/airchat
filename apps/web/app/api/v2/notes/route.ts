import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { AGENT_NAME_RE } from '@/lib/api-v1-validation';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 100_000;
const MAX_PROPERTIES_BYTES = 8192;

/** Map adapter error conventions to HTTP responses. */
function noteErrorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : 'Unknown error';
  if (message.startsWith('CONFLICT:')) return errorResponse(message, 409);
  if (message.startsWith('PROTECTED:')) return errorResponse(message, 403);
  if (message.startsWith('NOT_FOUND:')) return errorResponse(message, 404);
  return null;
}

// GET /api/v2/notes?slug=deploy-runbook&channel=project-airchat[&revision=3]
// GET /api/v2/notes?list=true[&channel=...][&q=...][&limit=50][&include_stubs=true]
// GET /api/v2/notes?query=true[&channel=...][&properties={"status":"unresolved"}][&updated_since=ISO][&limit=50]
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const params = request.nextUrl.searchParams;
  const channel = params.get('channel');
  if (channel && !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Invalid channel name', 400);
  }

  const adapter = getStorageAdapter();
  const scoped = adapter.forAgent(auth);

  // Structured property query mode (Phase 2)
  if (params.get('query') === 'true') {
    let properties: Record<string, unknown> | undefined;
    const propsParam = params.get('properties');
    if (propsParam) {
      if (propsParam.length > 2048) {
        return errorResponse('properties too large (max 2048 chars)', 400);
      }
      try {
        const parsed = JSON.parse(propsParam);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        properties = parsed;
      } catch {
        return errorResponse('Invalid properties (expected a JSON object)', 400);
      }
    }
    const updatedSince = params.get('updated_since') || undefined;
    if (updatedSince && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(updatedSince)) {
      return errorResponse('Invalid updated_since (expected ISO 8601)', 400);
    }
    const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 200);
    try {
      const notes = await scoped.queryNotes({
        channelName: channel ?? undefined,
        properties,
        updatedSince,
        limit,
      });
      return jsonResponse({ notes });
    } catch (e) {
      return noteErrorResponse(e) ?? errorResponse('Failed to query notes', 500);
    }
  }

  // List mode
  if (params.get('list') === 'true') {
    const query = params.get('q') || undefined;
    if (query && query.length > 500) {
      return errorResponse('Query too long (max 500 chars)', 400);
    }
    const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 200);
    try {
      const notes = await scoped.listNotes({
        channelName: channel ?? undefined,
        query,
        limit,
        includeStubs: params.get('include_stubs') === 'true',
      });
      return jsonResponse({ notes });
    } catch (e) {
      return noteErrorResponse(e) ?? errorResponse('Failed to list notes', 500);
    }
  }

  // Read mode
  const slug = params.get('slug');
  if (!slug || !SLUG_RE.test(slug)) {
    return errorResponse('Valid slug required (lowercase alphanumeric with hyphens)', 400);
  }
  const revisionParam = params.get('revision');
  const revision = revisionParam ? parseInt(revisionParam, 10) : undefined;
  if (revisionParam && (!Number.isInteger(revision) || revision! < 1)) {
    return errorResponse('Invalid revision (expected positive integer)', 400);
  }

  try {
    const result = await scoped.getNote(channel, slug, revision);
    if (!result) return errorResponse('Note not found', 404);

    const revisions = await scoped.getNoteRevisions(channel, slug, 10);
    return jsonResponse({ ...result, recent_revisions: revisions });
  } catch (e) {
    return noteErrorResponse(e) ?? errorResponse('Failed to read note', 500);
  }
}

// POST /api/v2/notes — Create or update (upsert) a note
// Body: { channel, slug, title, body_md, properties?, protect?, expected_revision? }
export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'write');
  if (rateLimit) return rateLimit;

  let body: {
    channel?: string | null;
    slug: string;
    title: string;
    body_md: string;
    properties?: Record<string, unknown>;
    protect?: boolean;
    expected_revision?: number;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { channel, slug, title, body_md, properties, protect, expected_revision } = body;

  if (!slug || !SLUG_RE.test(slug)) {
    return errorResponse('Valid slug required (lowercase alphanumeric with hyphens, max 200 chars)', 400);
  }
  if (channel && !AGENT_NAME_RE.test(channel)) {
    return errorResponse('Invalid channel name', 400);
  }
  if (channel && (channel.startsWith('gossip-') || channel.startsWith('shared-'))) {
    return errorResponse('Notes are not supported on federated channels (Phase 1 is local-only)', 400);
  }
  if (!title?.trim() || title.length > MAX_TITLE_LENGTH) {
    return errorResponse(`Title required (max ${MAX_TITLE_LENGTH} chars)`, 400);
  }
  if (typeof body_md !== 'string' || body_md.length > MAX_BODY_LENGTH) {
    return errorResponse(`body_md required (max ${MAX_BODY_LENGTH} chars)`, 400);
  }
  if (properties && JSON.stringify(properties).length > MAX_PROPERTIES_BYTES) {
    return errorResponse(`Properties too large (max ${MAX_PROPERTIES_BYTES} bytes)`, 400);
  }
  if (expected_revision !== undefined && (!Number.isInteger(expected_revision) || expected_revision < 1)) {
    return errorResponse('Invalid expected_revision (expected positive integer)', 400);
  }

  try {
    const adapter = getStorageAdapter();
    const scoped = adapter.forAgent(auth);
    const note = await scoped.writeNote({
      channelName: channel ?? null,
      slug,
      title: title.trim(),
      bodyMd: body_md,
      properties,
      protect,
      expectedRevision: expected_revision,
    });
    return jsonResponse({ note });
  } catch (e) {
    return noteErrorResponse(e) ?? errorResponse('Failed to write note', 500);
  }
}
