/**
 * Consent approval — issues the authorization code.
 *
 * Separated from the authorize endpoint so granting is a POST: a GET that
 * grants access can be triggered by any page that makes the browser navigate,
 * so consent has to be an action the user takes deliberately.
 *
 * Being a POST is not by itself the CSRF defence — a POST is forgeable too.
 * Three things protect this endpoint, and it is worth naming them because two
 * are easy to remove by accident:
 *
 *   1. An explicit Origin check (below).
 *   2. `@supabase/ssr` sets its session cookie SameSite=Lax, so a cross-site
 *      POST carries no session and getUser() returns null. A library default,
 *      not a decision made here.
 *   3. Admin-only: the consenting user must be in admin_users.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseClient, isDashboardAdmin } from '@/lib/api-v2-auth';
import { CONNECTOR_AGENT_SUFFIX } from '@airchat/shared';
import {
  randomToken,
  sha256,
  oauthError,
  connectorAgentNameFor,
  AUTHORIZATION_CODE_TTL_MS,
} from '@/lib/oauth-server';
import { validateAuthorizeRequest } from '../route';
import { publicOrigin } from '@/lib/oauth-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Find or create the credential-less connector agent for this user.
 *
 * Deliberately holds no derived_key_hash or api_key_hash, so it can never
 * authenticate to /api/v2 by any path. Migration 00023 enforces that with a
 * trigger, so even a bug here cannot bind a grant to a real Claude Code agent —
 * the database refuses the insert.
 */
async function resolveConnectorAgent(email: string): Promise<{ id: string; name: string } | null> {
  const db = getSupabaseClient();
  const name = connectorAgentNameFor(email);

  const { data: existing } = await db
    .from('agents')
    .select('id, name, derived_key_hash, api_key_hash')
    .eq('name', name)
    .maybeSingle();

  if (existing) {
    if (existing.derived_key_hash || existing.api_key_hash) return null;
    return { id: existing.id, name };
  }

  const { data: created } = await db
    .from('agents')
    .insert({ name, active: true })
    .select('id')
    .single();

  return created ? { id: created.id, name } : null;
}

export async function POST(request: NextRequest) {
  // Reject a cross-origin submission before doing anything else.
  //
  // The header comment above says this endpoint is a POST *because* a GET that
  // grants access is CSRF-able. That reasoning is incomplete: a POST is
  // CSRF-able too. What has actually been protecting it is that @supabase/ssr
  // sets its session cookie SameSite=Lax, so a cross-site form POST carries no
  // session and getUser() returns null.
  //
  // That is a library default, not a decision made here, and it matters because
  // client registration is open: anyone can register a client with their own
  // redirect_uri and then try to get a signed-in admin's browser to approve it.
  // Checking Origin makes the protection explicit and survives a cookie policy
  // change.
  //
  // Origin is sent on every cross-origin POST and cannot be forged by page
  // script. A same-origin form may omit it in some browsers, so absence is
  // allowed — this narrows the attack surface without breaking the real flow.
  const origin = request.headers.get('origin');
  if (origin && origin !== publicOrigin(request) && origin !== request.nextUrl.origin) {
    return oauthError('invalid_request', 'Cross-origin approval refused', 403);
  }

  const form = await request.formData().catch(() => null);
  if (!form) return oauthError('invalid_request', 'Expected a form submission');

  const params = new URLSearchParams();
  for (const [k, v] of form.entries()) if (typeof v === 'string') params.set(k, v);

  // Re-validate rather than trusting the submitted values. The form is
  // user-controlled; nothing it carries may be taken on faith.
  const validated = await validateAuthorizeRequest(params);
  if (!validated.ok) return validated.response;
  const authReq = validated.request;

  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return oauthError('access_denied', 'Not signed in', 401);
  if (!(await isDashboardAdmin(user.id))) {
    return oauthError('access_denied', 'Admin account required', 403);
  }

  const agent = await resolveConnectorAgent(user.email ?? user.id);
  if (!agent) {
    return oauthError(
      'server_error',
      `A non-connector agent already holds the name derived for this account. ` +
      `Rename it or grant from a different account.`,
      500,
    );
  }

  const code = randomToken(32);
  const { error } = await getSupabaseClient().from('oauth_authorization_codes').insert({
    code_hash: sha256(code),
    client_id: authReq.clientId,
    user_id: user.id,
    agent_id: agent.id,
    redirect_uri: authReq.redirectUri,
    scope: authReq.scope,
    resource: authReq.resource,
    code_challenge: authReq.codeChallenge,
    code_challenge_method: 'S256',
    expires_at: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
  });

  if (error) {
    console.error('[oauth] could not issue authorization code:', error.message);
    return oauthError('server_error', 'Could not issue authorization code', 500);
  }

  const redirect = new URL(authReq.redirectUri);
  redirect.searchParams.set('code', code);
  // Echoed back untouched: the client compares it to what it sent, which is how
  // it detects a response injected by someone else.
  if (authReq.state) redirect.searchParams.set('state', authReq.state);

  return NextResponse.redirect(redirect, { status: 303 });
}
