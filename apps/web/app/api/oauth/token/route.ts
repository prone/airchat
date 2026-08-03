/**
 * OAuth 2.1 token endpoint — exchanges an authorization code for an access
 * token.
 *
 * The issued token is a row in connector_tokens, the same store the CLI writes
 * to. That is deliberate: it already hashes the secret, carries scope, expiry,
 * revocation and last_used_at, and binds to a credential-less agent. A second
 * token store would duplicate all of it and the two would drift.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/lib/api-v2-auth';
import { checkIpRateLimit } from '@/lib/rate-limit';
import { CONNECTOR_TOKEN_PREFIX } from '@/lib/mcp-auth';
import {
  sha256,
  randomToken,
  verifyPkce,
  oauthError,
  ACCESS_TOKEN_TTL_DAYS,
} from '@/lib/oauth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  const limited = checkIpRateLimit(ip);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: 'temporarily_unavailable' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs || 1000) / 1000)) } },
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) return oauthError('invalid_request', 'Expected application/x-www-form-urlencoded');

  const grantType = String(form.get('grant_type') ?? '');
  if (grantType !== 'authorization_code') {
    return oauthError('unsupported_grant_type', 'Only authorization_code is supported');
  }

  const code = String(form.get('code') ?? '');
  const codeVerifier = String(form.get('code_verifier') ?? '');
  const redirectUri = String(form.get('redirect_uri') ?? '');
  const clientId = String(form.get('client_id') ?? '');

  if (!code || !codeVerifier || !redirectUri || !clientId) {
    return oauthError('invalid_request', 'code, code_verifier, redirect_uri and client_id are required');
  }

  const db = getSupabaseClient();

  const { data: stored } = await db
    .from('oauth_authorization_codes')
    .select('*')
    .eq('code_hash', sha256(code))
    .maybeSingle();

  // Unknown, already used and expired are all one answer. Distinguishing them
  // tells an attacker which guesses were closer.
  if (!stored) return oauthError('invalid_grant', 'Invalid authorization code');

  // Consume before any further checks. A code is single-use, and marking it
  // spent first means a replay racing the original still only succeeds once.
  const { data: consumed } = await db
    .from('oauth_authorization_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', stored.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();

  if (!consumed) return oauthError('invalid_grant', 'Authorization code already used');

  if (new Date(stored.expires_at) < new Date()) {
    return oauthError('invalid_grant', 'Authorization code expired');
  }
  if (stored.client_id !== clientId) {
    return oauthError('invalid_grant', 'Authorization code was not issued to this client');
  }
  if (stored.redirect_uri !== redirectUri) {
    // RFC 6749 §4.1.3: the redirect_uri must match the one in the authorization
    // request, or a code obtained for one destination could be redeemed for
    // another.
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
  }
  if (!verifyPkce(codeVerifier, stored.code_challenge)) {
    // The whole point of PKCE: an intercepted code is worthless without the
    // verifier, which never left the client that requested it.
    return oauthError('invalid_grant', 'PKCE verification failed');
  }

  const accessToken = CONNECTOR_TOKEN_PREFIX + randomToken(32);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_DAYS * 86_400_000);

  const { error } = await db.from('connector_tokens').insert({
    agent_id: stored.agent_id,
    token_hash: sha256(accessToken),
    name: `claude.ai connector (${stored.client_id})`,
    scope: stored.scope,
    client_id: stored.client_id,
    // RFC 8707 audience. /api/mcp validates it on every request, which is what
    // stops a token minted for another resource being replayed here.
    audience: stored.resource,
    granted_by_user_id: stored.user_id,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    console.error('[oauth] could not issue access token:', error.message);
    return oauthError('server_error', 'Could not issue access token', 500);
  }

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_DAYS * 86_400,
      scope: stored.scope,
    },
    // A token response must never be cached — by the client, or anything between.
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  );
}
