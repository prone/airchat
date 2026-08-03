/**
 * RFC 7591 Dynamic Client Registration.
 *
 * The MCP spec lists this as SHOULD. For us it is effectively MUST: during the
 * spike claude.ai issued `POST /register` unprompted after reading the
 * discovery documents, and failed when it 404'd.
 *
 * This is the only publicly writable endpoint in the application — a client
 * that has never seen this server must obtain an id before any user is
 * involved, so it cannot be authenticated. That makes it an abuse surface, and
 * it is treated as one: rate limited per IP, bounded field sizes, a hard cap on
 * redirect URIs, and no secret issued to public clients.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/lib/api-v2-auth';
import { checkIpRateLimit } from '@/lib/rate-limit';
import {
  randomToken,
  sha256,
  oauthError,
  isSecureRedirectUri,
} from '@/lib/oauth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REDIRECT_URIS = 5;
const MAX_NAME_LENGTH = 200;

export async function POST(request: NextRequest) {
  // Unauthenticated and public, so the IP limit is the only thing standing
  // between this and unbounded row creation.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  const limited = checkIpRateLimit(ip);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: 'temporarily_unavailable', error_description: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs || 1000) / 1000)) } },
    );
  }

  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = await request.json();
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be JSON');
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError('invalid_redirect_uri', 'redirect_uris is required and must be a non-empty array');
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return oauthError('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect URIs`);
  }
  if (!redirectUris.every((u) => typeof u === 'string' && isSecureRedirectUri(u))) {
    // OAuth 2.1 §1.5: HTTPS, or loopback for native clients. A code delivered
    // over plain HTTP to a remote host is a code an observer keeps.
    return oauthError(
      'invalid_redirect_uri',
      'Each redirect URI must be https, or http on localhost, and must not contain a fragment',
    );
  }

  const clientName = typeof body.client_name === 'string'
    ? body.client_name.slice(0, MAX_NAME_LENGTH)
    : null;

  const clientId = `acl_${randomToken(16)}`;

  // No client secret. claude.ai is a public client: it runs where a secret
  // cannot be kept, so issuing one would be security theatre. PKCE is what
  // actually binds the code to the requester, and it is mandatory here.
  const { error } = await getSupabaseClient().from('oauth_clients').insert({
    client_id: clientId,
    client_secret_hash: null,
    client_name: clientName,
    redirect_uris: redirectUris,
  });

  if (error) {
    console.error('[oauth] client registration failed:', error.message);
    return oauthError('server_error', 'Could not register client', 500);
  }

  // RFC 7591 §3.2.1: 201 with the registered metadata echoed back.
  return NextResponse.json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    { status: 201 },
  );
}
