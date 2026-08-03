/**
 * Consent approval — issues the authorization code.
 *
 * Separated from the authorize endpoint because it must be a POST: a GET that
 * grants access is CSRF-able by any page that can make the browser navigate.
 * Consent has to be an action the user takes deliberately.
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
