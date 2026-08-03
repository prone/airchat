/**
 * OAuth 2.1 authorization endpoint.
 *
 * The expensive part of an authorization server is authenticating a human and
 * getting consent, and that already exists here: the dashboard has Supabase
 * Auth, a login page and session middleware. This endpoint reuses all of it
 * rather than building a second identity system.
 *
 * Access is admin-only (decided 2026-08-02). Every person who connects
 * claude.ai must be in admin_users. That is the honest constraint for a
 * single-operator instance, and widening it later is the "human user model"
 * work — nothing here forecloses it.
 *
 * This is the GET half: validate the request, confirm the user, and render
 * consent. The POST half (approval) issues the code.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseClient, isDashboardAdmin } from '@/lib/api-v2-auth';
import {
  oauthError,
  isRegisteredRedirectUri,
  SUPPORTED_SCOPES,
} from '@/lib/oauth-server';
import { publicOrigin } from '@/lib/oauth-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface AuthorizeRequest {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  scope: 'read' | 'read-write';
  state: string | null;
  resource: string | null;
  codeChallenge: string;
}

/**
 * Validate an authorization request.
 *
 * Order matters. Anything wrong with `client_id` or `redirect_uri` is returned
 * as an error page, never redirected — redirecting to an unverified URI is how
 * an open redirect turns into stolen authorization codes. Only once the
 * redirect URI is confirmed registered may other errors travel back to it.
 */
export async function validateAuthorizeRequest(
  params: URLSearchParams,
): Promise<{ ok: true; request: AuthorizeRequest } | { ok: false; response: Response }> {
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');

  if (!clientId || !redirectUri) {
    return { ok: false, response: oauthError('invalid_request', 'client_id and redirect_uri are required') };
  }

  const { data: client } = await getSupabaseClient()
    .from('oauth_clients')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();

  if (!client) {
    return { ok: false, response: oauthError('invalid_client', 'Unknown client') };
  }

  // Exact match against the registered set. Never a prefix, never a wildcard.
  if (!isRegisteredRedirectUri(redirectUri, client.redirect_uris ?? [])) {
    return { ok: false, response: oauthError('invalid_request', 'redirect_uri is not registered for this client') };
  }

  // From here the redirect URI is trusted, so remaining errors could be
  // redirected. They are still returned directly: this endpoint is reached by a
  // human in a browser, and an error page says more than a silent bounce.
  if (params.get('response_type') !== 'code') {
    return { ok: false, response: oauthError('unsupported_response_type', 'Only response_type=code is supported') };
  }

  const codeChallenge = params.get('code_challenge');
  const method = params.get('code_challenge_method');
  if (!codeChallenge) {
    // PKCE is mandatory in OAuth 2.1, and doubly so for a public client that
    // holds no secret: it is the only thing binding a code to its requester.
    return { ok: false, response: oauthError('invalid_request', 'code_challenge is required (PKCE)') };
  }
  if (method !== 'S256') {
    return { ok: false, response: oauthError('invalid_request', 'code_challenge_method must be S256') };
  }

  const requested = params.get('scope') ?? 'read';
  if (!(SUPPORTED_SCOPES as readonly string[]).includes(requested)) {
    return { ok: false, response: oauthError('invalid_scope', `scope must be one of: ${SUPPORTED_SCOPES.join(', ')}`) };
  }

  return {
    ok: true,
    request: {
      clientId,
      clientName: client.client_name ?? null,
      redirectUri,
      scope: requested as 'read' | 'read-write',
      state: params.get('state'),
      resource: params.get('resource'),
      codeChallenge,
    },
  };
}

export async function GET(request: NextRequest) {
  const validated = await validateAuthorizeRequest(request.nextUrl.searchParams);
  if (!validated.ok) return validated.response;

  // Consent requires a signed-in human. Bounce to the existing login page and
  // come back here afterwards.
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // publicOrigin, not request.nextUrl.origin. Inside the container the
    // request's own origin is the bind address — http://0.0.0.0:3002 — which a
    // browser cannot reach. These redirects are followed by a person, so they
    // have to name the address the instance is reachable at.
    const next = encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(new URL(`/login?next=${next}`, publicOrigin(request)));
  }

  if (!(await isDashboardAdmin(user.id))) {
    return oauthError(
      'access_denied',
      'Connecting an MCP client requires a dashboard admin account on this instance.',
      403,
    );
  }

  // The consent screen itself is a page, not this route handler.
  const consent = new URL('/oauth/consent', publicOrigin(request));
  consent.search = request.nextUrl.search;
  return NextResponse.redirect(consent);
}
