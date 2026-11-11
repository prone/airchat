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
import { createHmac, randomUUID } from 'node:crypto';
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
  const { data: token, error: lookupError } = await db
    .from('oauth_refresh_tokens')
    .select('*')
    .eq('token_hash', sha256(presented))
    .maybeSingle();

  // "The database did not answer" is not "this token is invalid". invalid_grant
  // tells the client to throw the grant away and send the user back through
  // consent; answering it for an outage would destroy a good grant.
  if (lookupError) return unavailable('refresh token lookup', lookupError.message);

  // Unknown, revoked and expired are one answer (invalid_grant), which is what
  // tells the client to send the user back through consent rather than retry.
  if (!token) return oauthError('invalid_grant', 'Invalid refresh token');

  if (token.client_id !== clientId) {
    return oauthError('invalid_grant', 'Refresh token was not issued to this client');
  }
  if (token.revoked_at) {
    // Idempotent: if an earlier revocation got as far as the refresh tokens
    // but failed before the access tokens, this finishes it.
    const failed = await revokeFamily(db, token.family_id, now);
    if (failed) return unavailable('grant revocation', failed);
    return oauthError('invalid_grant', 'Refresh token revoked');
  }
  if (token.consumed_at) return handleConsumedToken(db, token, now);
  if (new Date(token.expires_at) < now) return oauthError('invalid_grant', 'Refresh token expired');

  // Revoking the access token from the dashboard or CLI ends the grant too.
  // Otherwise "revoke" would be undone by the very next refresh.
  if (token.access_token_id) {
    const { data: access, error: accessError } = await db
      .from('connector_tokens')
      .select('revoked_at')
      .eq('id', token.access_token_id)
      .maybeSingle();
    // Fail closed: if we cannot tell whether the grant was revoked, do not
    // extend it. The client retries.
    if (accessError) return unavailable('access token revocation check', accessError.message);
    if (access?.revoked_at) {
      // Rotation itself retires the old access token. So a revoked access
      // token can also mean a concurrent refresh of this same token got there
      // first, between our read above and this check. Re-read before treating
      // it as a deliberate revocation: revoking the family here would destroy
      // the pair that other request just issued to the same client.
      const { data: fresh, error: freshError } = await db
        .from('oauth_refresh_tokens')
        .select('consumed_at, revoked_at')
        .eq('id', token.id)
        .maybeSingle();
      if (freshError) return unavailable('refresh token re-read', freshError.message);
      if (fresh?.consumed_at && !fresh.revoked_at) {
        return handleConsumedToken(db, { ...token, consumed_at: fresh.consumed_at }, now);
      }
      const failed = await revokeFamily(db, token.family_id, now);
      if (failed) return unavailable('grant revocation', failed);
      return oauthError('invalid_grant', 'Grant revoked');
    }
  }

  // Consume atomically. Two refreshes racing on the same token (claude.ai
  // refreshes proactively before expiry and reactively on a 401, and the two
  // can coincide) both pass the checks above; only one wins this update.
  const { data: consumed, error: consumeError } = await db
    .from('oauth_refresh_tokens')
    .update({ consumed_at: now.toISOString() })
    .eq('id', token.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();
  if (consumeError) return unavailable('refresh token consume', consumeError.message);

  // Lost the race: the other request consumed it a moment ago. That is the
  // same situation as a retry, so it gets the same answer — the successor pair.
  if (!consumed) return handleConsumedToken(db, { ...token, consumed_at: now.toISOString() }, now);

  return rotate(db, token, now);
}

/**
 * How long after rotation the SAME refresh token may be presented again and
 * still be treated as a retry rather than as theft.
 */
const ROTATION_RETRY_WINDOW_MS = 60_000;

/**
 * A refresh token that was already rotated has been presented again.
 *
 * Long after rotation, that is the reuse signal: whoever holds it either kept
 * a copy or intercepted it, so the whole family is revoked.
 *
 * Within a minute of rotation it is almost always the legitimate client: the
 * response to its first attempt was lost, or its proactive and reactive
 * refreshes overlapped. Rotation had already consumed its only refresh token,
 * so treating the retry as theft revoked the grant and sent the user back to
 * consent — the silent expiry refresh tokens exist to prevent, now triggered
 * by a dropped packet.
 *
 * A retry inside the window gets the SAME successor pair the first attempt
 * produced (see successorTokens). Nothing new is minted, so the window does not
 * weaken reuse detection: a thief replaying inside it ends up holding the same
 * pair as the client, and whichever of them refreshes second, later, is
 * presenting a consumed token outside any window and revokes the family.
 */
async function handleConsumedToken(db: Db, token: RefreshRow, now: Date): Promise<Response> {
  const consumedAt = new Date(token.consumed_at as string).getTime();
  const withinWindow = now.getTime() - consumedAt <= ROTATION_RETRY_WINDOW_MS;
  const successor = successorTokens(token);

  if (!successor) {
    return reuseDetected(db, token, now);
  }

  const { data: next, error } = await db
    .from('oauth_refresh_tokens')
    .select('consumed_at, revoked_at')
    .eq('token_hash', sha256(successor.refresh))
    .maybeSingle();
  if (error) return unavailable('successor lookup', error.message);

  // The rotation never finished: this token was consumed, but its successor
  // was never stored (the database failed in between, as it did for hours at a
  // time in September 2026). Nobody holds anything newer than this token, so
  // presenting it again is not reuse of a superseded credential — at any
  // distance from the first attempt. Finish the job. Without this, an outage
  // longer than the retry window turned every in-flight refresh into a revoked
  // grant once the database came back.
  if (!next) return rotate(db, token, now);

  // A successor exists. Outside the window that is the reuse signal. Inside
  // it, the successor must still be untouched: if it has itself been rotated
  // or revoked, this is an old token being replayed, not a retry.
  if (!withinWindow || next.consumed_at || next.revoked_at) {
    return reuseDetected(db, token, now);
  }

  // A live successor is about to be handed out a second time. That is allowed
  // ONCE per token: a lost response or two overlapping refreshes produce one
  // extra presentation, not several. Without the limit, anyone holding a copy
  // of the token could keep collecting the current pair for as long as they
  // replayed inside the window. The claim is atomic, so of several replays
  // arriving together exactly one is served.
  const { data: claimed, error: claimError } = await db
    .from('oauth_refresh_tokens')
    .update({ retry_served_at: now.toISOString() })
    .eq('id', token.id)
    .is('retry_served_at', null)
    .select('id')
    .maybeSingle();
  if (claimError) return unavailable('retry claim', claimError.message);
  if (!claimed) return reuseDetected(db, token, now);

  // Logged because a retry on every rotation of one grant is what a second
  // holder of the token would look like.
  console.warn(`[oauth] refresh retry inside the rotation window (family ${token.family_id})`);
  return rotate(db, token, now);
}

/** A superseded refresh token was presented: end the grant. */
async function reuseDetected(db: Db, token: RefreshRow, now: Date): Promise<Response> {
  const failed = await revokeFamily(db, token.family_id, now);
  // Not revoked means not safe to say so; the client retries and we try again.
  if (failed) return unavailable('grant revocation', failed);
  return oauthError('invalid_grant', 'Refresh token reuse detected; the grant has been revoked');
}

/** Retire the access token a refresh token was issued with, and issue its successor pair. */
async function rotate(db: Db, token: RefreshRow, now: Date): Promise<Response> {
  // One live access token per grant: retire the one this refresh token was
  // issued with. The client is about to receive its replacement.
  if (token.access_token_id) {
    const { error } = await db
      .from('connector_tokens')
      .update({ revoked_at: now.toISOString() })
      .eq('id', token.access_token_id)
      .is('revoked_at', null);
    if (error) return unavailable('previous access token retirement', error.message);
  }

  const issued = await issueTokenPair(
    db,
    {
      agentId: token.agent_id,
      userId: token.user_id,
      clientId: token.client_id,
      scope: token.scope === 'read-write' ? 'read-write' : 'read',
      // The audience travels with the grant. Re-deriving it from this request
      // would let a refresh move a grant to whatever host the request named.
      audience: token.audience,
      familyId: token.family_id,
    },
    successorTokens(token) ?? undefined,
  );
  if (!issued.ok) return issued;

  // The family may have been revoked while this pair was being written (reuse
  // detected on a parallel request, or a revocation that read the family just
  // before our insert). A pair issued into a revoked family must not survive.
  const { data: revokedMember, error: checkError } = await db
    .from('oauth_refresh_tokens')
    .select('id')
    .eq('family_id', token.family_id)
    .not('revoked_at', 'is', null)
    .limit(1);
  if (checkError) return unavailable('family revocation check', checkError.message);
  if (revokedMember && revokedMember.length > 0) {
    const failed = await revokeFamily(db, token.family_id, now);
    if (failed) return unavailable('grant revocation', failed);
    return oauthError('invalid_grant', 'Grant revoked');
  }
  return issued;
}

/** The columns of an oauth_refresh_tokens row this file relies on. */
interface RefreshRow {
  id: string;
  token_hash: string;
  family_id: string;
  client_id: string;
  agent_id: string;
  user_id: string;
  scope: string;
  audience: string;
  access_token_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  retry_served_at?: string | null;
}

interface TokenPair {
  access: string;
  refresh: string;
}

/**
 * The token pair that rotating `parent` produces — always the same pair.
 *
 * Only hashes are stored, so a retried rotation could not otherwise return
 * what the first attempt issued. Deriving the successor from the parent with a
 * server-held key makes rotation repeatable: the retry recomputes the same two
 * values.
 *
 * The key never leaves the server, so holding the parent token (or the whole
 * database) is not enough to compute its successor; the values are as
 * unguessable as random ones. Returns null when no key is configured, in which
 * case rotation falls back to random tokens and a retry cannot be answered.
 */
function successorTokens(parent: Pick<RefreshRow, 'id' | 'token_hash'>): TokenPair | null {
  const key = process.env.OAUTH_ROTATION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const derive = (label: string) =>
    createHmac('sha256', key).update(`${label}\0${parent.id}\0${parent.token_hash}`).digest('hex');
  return {
    access: CONNECTOR_TOKEN_PREFIX + derive('airchat-oauth-access-v1'),
    refresh: REFRESH_TOKEN_PREFIX + derive('airchat-oauth-refresh-v1'),
  };
}

/** A dependency failed. The client should retry; its grant is untouched. */
function unavailable(what: string, detail: string): Response {
  console.error(`[oauth] ${what} failed: ${detail}`);
  const res = oauthError('temporarily_unavailable', 'The authorization server is temporarily unavailable', 503);
  res.headers.set('Retry-After', '5');
  return res;
}

/**
 * Revoke every refresh token in a family and every access token they issued.
 *
 * Returns null on success, or a description of what failed. A failure must
 * not be reported to the client as a completed revocation: the grant would
 * still be live. Safe to repeat — each step only touches rows not yet revoked,
 * and the members are read AFTER the refresh tokens are revoked, so a member
 * added in between is still found.
 */
async function revokeFamily(db: Db, familyId: string, now: Date): Promise<string | null> {
  const stamp = now.toISOString();

  const { error: refreshError } = await db
    .from('oauth_refresh_tokens')
    .update({ revoked_at: stamp })
    .eq('family_id', familyId)
    .is('revoked_at', null);
  if (refreshError) return `refresh tokens: ${refreshError.message}`;

  const { data: members, error: membersError } = await db
    .from('oauth_refresh_tokens')
    .select('access_token_id')
    .eq('family_id', familyId);
  if (membersError) return `family members: ${membersError.message}`;

  const accessIds = (members ?? [])
    .map((m: { access_token_id: string | null }) => m.access_token_id)
    .filter((id): id is string => typeof id === 'string');
  if (accessIds.length > 0) {
    const { error: accessError } = await db
      .from('connector_tokens')
      .update({ revoked_at: stamp })
      .in('id', accessIds)
      .is('revoked_at', null);
    if (accessError) return `access tokens: ${accessError.message}`;
  }
  return null;
}

// ── issuance ────────────────────────────────────────────────────────────────

/**
 * Mint an access token and the refresh token that goes with it, and build the
 * RFC 6749 §5.1 token response. Shared by both grants so the two can never
 * drift in what they store or return.
 */
async function issueTokenPair(db: Db, grant: GrantContext, fixed?: TokenPair): Promise<Response> {
  // A rotation passes the pair derived from its parent, and may be the second
  // attempt at storing it: an insert that collides on the token hash then
  // means "already issued", which is success, not failure.
  const accessToken = fixed?.access ?? CONNECTOR_TOKEN_PREFIX + randomToken(32);
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_DAYS * 86_400_000);

  let accessId: string | null = null;
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
  accessId = accessRow?.id ?? null;

  if (!accessId && fixed) {
    const { data: existing } = await db
      .from('connector_tokens')
      .select('id, revoked_at')
      .eq('token_hash', sha256(accessToken))
      .maybeSingle();
    if (existing && !existing.revoked_at) accessId = existing.id;
  }

  if (!accessId) {
    // On a rotation the refresh token is already consumed, and a retry will
    // finish the job (handleConsumedToken) — so tell the client to retry.
    if (fixed) return unavailable('successor access token issue', accessError?.message ?? 'no row returned');
    console.error('[oauth] could not issue access token:', accessError?.message ?? 'no row returned');
    return oauthError('server_error', 'Could not issue access token', 500);
  }

  const refreshToken = fixed?.refresh ?? REFRESH_TOKEN_PREFIX + randomToken(32);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const { error: refreshError } = await db.from('oauth_refresh_tokens').insert({
    token_hash: sha256(refreshToken),
    family_id: grant.familyId,
    client_id: grant.clientId,
    agent_id: grant.agentId,
    user_id: grant.userId,
    scope: grant.scope,
    audience: grant.audience,
    access_token_id: accessId,
    expires_at: refreshExpiresAt.toISOString(),
  });

  let refreshStored = !refreshError;
  if (refreshError && fixed) {
    const { data: existing } = await db
      .from('oauth_refresh_tokens')
      .select('consumed_at, revoked_at')
      .eq('token_hash', sha256(refreshToken))
      .maybeSingle();
    refreshStored = !!existing && !existing.consumed_at && !existing.revoked_at;
  }

  if (!refreshStored) {
    // Do not hand out an access token whose refresh half failed to store: the
    // client would believe it holds a renewable grant and discover otherwise
    // in 30 days, which is the silent failure this endpoint exists to end.
    // (A rotation leaves its access token alone: a retry will reuse it.)
    if (!fixed) {
      await db.from('connector_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', accessId);
    }
    if (fixed) return unavailable('successor refresh token issue', refreshError?.message ?? 'successor not live');
    console.error('[oauth] could not issue refresh token:', refreshError?.message ?? 'no row stored');
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
