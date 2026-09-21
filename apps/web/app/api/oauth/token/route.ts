/**
 * OAuth 2.1 token endpoint.
 *
 * Two grants:
 *
 *   authorization_code — exchanges a consent code for an access token AND a
 *   refresh token.
 *   refresh_token      — rotates a refresh token into a new access token and a
 *   new refresh token (OAuth 7).
 *
 * The issued access token is a row in connector_tokens, the same store the CLI
 * writes to. That is deliberate: it already hashes the secret, carries scope,
 * expiry, revocation and last_used_at, and binds to a credential-less agent. A
 * second access-token store would duplicate all of it and the two would drift.
 *
 * Refresh tokens live in their own table (oauth_refresh_tokens). They are a
 * different credential with a different lifetime, and keeping them apart makes
 * it structural that one is never accepted where the other is expected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from '@/lib/api-v2-auth';
import { checkIpRateLimit } from '@/lib/rate-limit';
import { CONNECTOR_TOKEN_PREFIX } from '@/lib/mcp-auth';
import { canonicalResourceUri } from '@/lib/oauth-metadata';
import {
  sha256,
  randomToken,
  verifyPkce,
  oauthError,
  grantedScopeString,
  ACCESS_TOKEN_TTL_DAYS,
  REFRESH_TOKEN_TTL_DAYS,
  REFRESH_TOKEN_PREFIX,
  type OAuthScope,
} from '@/lib/oauth-server';
import { clientIp } from '@/lib/client-ip';
import { withOAuthCors, oauthPreflight } from '@/lib/mcp-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Preflight, so a browser-based client can exchange its code cross-origin. */
export function OPTIONS() {
  return oauthPreflight();
}

/**
 * Wrapped once rather than at every return. The `cache-control: no-store` on
 * the success path is set inside and survives, since this only adds headers.
 */
export async function POST(request: NextRequest) {
  return withOAuthCors(await handleToken(request));
}

/** Everything a grant needs to mint a token pair, whichever grant produced it. */
interface GrantContext {
  agentId: string;
  userId: string;
  clientId: string;
  scope: OAuthScope;
  audience: string;
  /** Shared by every rotation descending from one consent. */
  familyId: string;
}

type Db = ReturnType<typeof getSupabaseClient>;

async function handleToken(request: NextRequest): Promise<Response> {
  const limited = checkIpRateLimit(clientIp(request));
  if (!limited.allowed) {
    return NextResponse.json(
      { error: 'temporarily_unavailable' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs || 1000) / 1000)) } },
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) return oauthError('invalid_request', 'Expected application/x-www-form-urlencoded');

  const grantType = String(form.get('grant_type') ?? '');
  if (grantType === 'authorization_code') return handleAuthorizationCode(request, form);
  if (grantType === 'refresh_token') return handleRefreshToken(request, form);
  return oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
}

// ── authorization_code ──────────────────────────────────────────────────────

async function handleAuthorizationCode(request: NextRequest, form: FormData): Promise<Response> {
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

  return issueTokenPair(db, {
    agentId: stored.agent_id,
    userId: stored.user_id,
    clientId: stored.client_id,
    scope: stored.scope === 'read-write' ? 'read-write' : 'read',
    // RFC 8707 audience. /api/mcp validates it on every request, which is what
    // stops a token minted for another resource being replayed here.
    //
    // `resource` is optional in the authorization request, so it can be null.
    // Storing that null would make the token skip audience validation entirely
    // (mcp-auth treats a null audience as CLI-issued, where the binding is
    // structural instead). An OAuth-issued token has no such structural
    // binding, so it must always name an audience — default it to this server
    // rather than letting a client opt out by omitting one parameter.
    audience: stored.resource ?? canonicalResourceUri(request),
    // A fresh consent starts a fresh family.
    familyId: randomUUID(),
  });
}

// ── refresh_token ───────────────────────────────────────────────────────────

async function handleRefreshToken(request: NextRequest, form: FormData): Promise<Response> {
  const presented = String(form.get('refresh_token') ?? '');
  const clientId = String(form.get('client_id') ?? '');
  if (!presented || !clientId) {
    // OAuth 2.1 §4.3.1: a public client identifies itself with client_id, and
    // the token must have been issued to that client.
    return oauthError('invalid_request', 'refresh_token and client_id are required');
  }

  const db = getSupabaseClient();
  const now = new Date();

  // Looked up regardless of state: a consumed or revoked token must still be
  // found, because presenting one is the reuse signal.
  const { data: token } = await db
    .from('oauth_refresh_tokens')
    .select('*')
    .eq('token_hash', sha256(presented))
    .maybeSingle();

  // Unknown, revoked and expired are one answer (invalid_grant), which is what
  // tells the client to send the user back through consent rather than retry.
  if (!token) return oauthError('invalid_grant', 'Invalid refresh token');

  if (token.consumed_at) {
    // REUSE. This token was already rotated away, so whoever holds it now
    // either kept a copy after rotation or intercepted it. Either way the
    // legitimate client's current token is no longer trustworthy: revoke the
    // whole family, and the access token that goes with it, rather than merely
    // refusing this request.
    await revokeFamily(db, token.family_id, now);
    return oauthError('invalid_grant', 'Refresh token reuse detected; the grant has been revoked');
  }
  if (token.revoked_at) return oauthError('invalid_grant', 'Refresh token revoked');
  if (new Date(token.expires_at) < now) return oauthError('invalid_grant', 'Refresh token expired');
  if (token.client_id !== clientId) {
    return oauthError('invalid_grant', 'Refresh token was not issued to this client');
  }

  // Revoking the access token from the dashboard or CLI ends the grant too.
  // Otherwise "revoke" would be undone by the very next refresh.
  if (token.access_token_id) {
    const { data: access } = await db
      .from('connector_tokens')
      .select('revoked_at')
      .eq('id', token.access_token_id)
      .maybeSingle();
    if (access?.revoked_at) {
      await revokeFamily(db, token.family_id, now);
      return oauthError('invalid_grant', 'Grant revoked');
    }
  }

  // Consume atomically. Two refreshes racing on the same token (claude.ai
  // refreshes proactively before expiry and reactively on a 401, and the two
  // can coincide) both pass the checks above; only one wins this update. The
  // loser is refused but does NOT trigger family revocation — at read time the
  // token was unconsumed, so this is a race, not a replay. Replay is a token
  // that was already consumed when it was presented, handled above.
  const { data: consumed } = await db
    .from('oauth_refresh_tokens')
    .update({ consumed_at: now.toISOString() })
    .eq('id', token.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();
  if (!consumed) return oauthError('invalid_grant', 'Refresh token already used');

  // One live access token per grant: retire the one this refresh token was
  // issued with. The client is about to receive its replacement.
  if (token.access_token_id) {
    await db
      .from('connector_tokens')
      .update({ revoked_at: now.toISOString() })
      .eq('id', token.access_token_id)
      .is('revoked_at', null);
  }

  return issueTokenPair(db, {
    agentId: token.agent_id,
    userId: token.user_id,
    clientId: token.client_id,
    scope: token.scope === 'read-write' ? 'read-write' : 'read',
    // The audience travels with the grant. Re-deriving it from this request
    // would let a refresh move a grant to whatever host the request named.
    audience: token.audience,
    familyId: token.family_id,
  });
}

/** Revoke every refresh token in a family and every access token they issued. */
async function revokeFamily(db: Db, familyId: string, now: Date): Promise<void> {
  const stamp = now.toISOString();
  const { data: members } = await db
    .from('oauth_refresh_tokens')
    .select('access_token_id')
    .eq('family_id', familyId);

  await db
    .from('oauth_refresh_tokens')
    .update({ revoked_at: stamp })
    .eq('family_id', familyId)
    .is('revoked_at', null);

  const accessIds = (members ?? [])
    .map((m: { access_token_id: string | null }) => m.access_token_id)
    .filter((id): id is string => typeof id === 'string');
  if (accessIds.length > 0) {
    await db
      .from('connector_tokens')
      .update({ revoked_at: stamp })
      .in('id', accessIds)
      .is('revoked_at', null);
  }
}

// ── issuance ────────────────────────────────────────────────────────────────

/**
 * Mint an access token and the refresh token that goes with it, and build the
 * RFC 6749 §5.1 token response. Shared by both grants so the two can never
 * drift in what they store or return.
 */
async function issueTokenPair(db: Db, grant: GrantContext): Promise<Response> {
  const accessToken = CONNECTOR_TOKEN_PREFIX + randomToken(32);
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_DAYS * 86_400_000);

  const { data: accessRow, error: accessError } = await db
    .from('connector_tokens')
    .insert({
      agent_id: grant.agentId,
      token_hash: sha256(accessToken),
      name: `claude.ai connector (${grant.clientId})`,
      scope: grant.scope,
      client_id: grant.clientId,
      audience: grant.audience,
      granted_by_user_id: grant.userId,
      expires_at: accessExpiresAt.toISOString(),
    })
    .select('id')
    .single();

  if (accessError || !accessRow) {
    console.error('[oauth] could not issue access token:', accessError?.message ?? 'no row returned');
    return oauthError('server_error', 'Could not issue access token', 500);
  }

  const refreshToken = REFRESH_TOKEN_PREFIX + randomToken(32);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const { error: refreshError } = await db.from('oauth_refresh_tokens').insert({
    token_hash: sha256(refreshToken),
    family_id: grant.familyId,
    client_id: grant.clientId,
    agent_id: grant.agentId,
    user_id: grant.userId,
    scope: grant.scope,
    audience: grant.audience,
    access_token_id: accessRow.id,
    expires_at: refreshExpiresAt.toISOString(),
  });

  if (refreshError) {
    // Do not hand out an access token whose refresh half failed to store: the
    // client would believe it holds a renewable grant and discover otherwise
    // in 30 days, which is the silent failure this endpoint exists to end.
    await db.from('connector_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', accessRow.id);
    console.error('[oauth] could not issue refresh token:', refreshError.message);
    return oauthError('server_error', 'Could not issue refresh token', 500);
  }

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_DAYS * 86_400,
      refresh_token: refreshToken,
      // The granted set as a list, not the single stored value. See
      // grantedScopeString: echoing "read-write" to a client that asked for
      // "read read-write" reads as a partial grant.
      scope: grantedScopeString(grant.scope),
    },
    // A token response must never be cached — by the client, or anything between.
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  );
}
