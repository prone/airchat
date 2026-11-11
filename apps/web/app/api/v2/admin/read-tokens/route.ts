import { NextRequest } from 'next/server';
import { getSupabaseClient } from '@/lib/api-v2-auth';
import { requireInstanceAdmin } from '@/lib/instance-admin';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { UUID_RE } from '@/lib/api-v1-validation';
import { issueReadToken, listReadTokens, revokeReadToken, READ_TOKEN_HEADER } from '@/lib/read-tokens';

/**
 * Read tokens, managed by the person who runs the instance.
 *
 * An agent key is not enough for any of this (see requireInstanceAdmin): a
 * token can be issued with access to every direct message, and agents read
 * untrusted text all day.
 */

// GET /api/v2/admin/read-tokens — list tokens (never their secrets).
export async function GET(request: NextRequest) {
  const denied = await requireInstanceAdmin(request);
  if (denied) return denied;
  try {
    return jsonResponse({ tokens: await listReadTokens(getSupabaseClient()) });
  } catch {
    return errorResponse('Failed to list read tokens', 500);
  }
}

// POST /api/v2/admin/read-tokens — issue a token.
// Body: { name: string, include_dms?: boolean }. The token is in the response
// once; it is not stored and cannot be shown again.
export async function POST(request: NextRequest) {
  const denied = await requireInstanceAdmin(request);
  if (denied) return denied;

  let body: { name?: unknown; include_dms?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body', 400);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 100) {
    return errorResponse('name is required (1 to 100 characters)', 400);
  }
  // Strictly a boolean: "false" or 0 must not be read as a yes, and a missing
  // field must mean no.
  if (body.include_dms !== undefined && typeof body.include_dms !== 'boolean') {
    return errorResponse('include_dms must be true or false', 400);
  }

  try {
    const { token, row } = await issueReadToken(getSupabaseClient(), {
      name,
      includeDms: body.include_dms === true,
    });
    return jsonResponse({
      token,
      header: READ_TOKEN_HEADER,
      ...row,
      note: 'Store this token now. It is not kept and cannot be shown again.',
    }, 201);
  } catch {
    return errorResponse('Failed to issue read token', 500);
  }
}

// DELETE /api/v2/admin/read-tokens?id=<uuid> — revoke a token.
export async function DELETE(request: NextRequest) {
  const denied = await requireInstanceAdmin(request);
  if (denied) return denied;

  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) return errorResponse('id must be a token id', 400);

  try {
    const revoked = await revokeReadToken(getSupabaseClient(), id);
    if (!revoked) return errorResponse('No live token with that id', 404);
    return jsonResponse({ revoked: true, id });
  } catch {
    return errorResponse('Failed to revoke read token', 500);
  }
}
