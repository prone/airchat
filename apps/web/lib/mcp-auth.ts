/**
 * Bearer authentication for the /api/mcp connector endpoint.
 *
 * Two things here are deliberate and load-bearing:
 *
 * 1. Connector tokens are a SEPARATE credential class from the agent derived
 *    key. Nothing under /api/v2 consults `connector_tokens`, and this module is
 *    never imported by a v2 route. That is what audience-binds the token to
 *    this endpoint — it is a property of the code paths, not a claim inside the
 *    token that some future check has to remember to validate.
 *
 * 2. Failures return 401 WITH a `WWW-Authenticate` header pointing at this
 *    server's RFC 9728 protected-resource metadata.
 *
 *    This reverses the original design, which advertised no OAuth at all. That
 *    reasoning came from cloudflare/mcp#95: MCP clients begin OAuth discovery
 *    before sending custom headers, so advertising discovery would stop a
 *    client ever sending a bearer. It is correct for a client that sends
 *    headers first, and wrong for claude.ai — which has no bearer path at all.
 *
 *    The spike settled it. claude.ai connected, received the challenge-less
 *    401, then probed /.well-known/oauth-protected-resource (both path forms),
 *    /.well-known/oauth-authorization-server and POST /register. All 404'd and
 *    it failed. It never sent `Authorization` once. Silence did not preserve a
 *    bearer flow; it produced an error.
 *
 *    Static bearer tokens remain supported here for CLI-issued credentials and
 *    for clients that do send them. The challenge is additive: it gives a
 *    discovery-only client somewhere to go.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hashKey } from '@airchat/shared/crypto';
import type { AgentContext, ConnectorScope } from '@airchat/shared';
import { getStorageAdapter, getSupabaseClient } from '@/lib/api-v2-auth';
import { checkRateLimit, checkIpRateLimit } from '@/lib/rate-limit';
import { wwwAuthenticateValue } from '@/lib/oauth-metadata';

/** Tokens are minted as `acx_` + 64 hex chars. The prefix aids leak scanning. */
export const CONNECTOR_TOKEN_PREFIX = 'acx_';

export interface ConnectorAuth {
  ctx: AgentContext;
  tokenId: string;
  /** Decides the tool surface. Read-only unless issued read-write. */
  scope: ConnectorScope;
}

/**
 * 401 carrying the RFC 9728 discovery pointer. See note 2 above.
 *
 * `error` is the OAuth 2.1 code, not the human message: a client parses the
 * former and shows the latter.
 */
function unauthorized(request: NextRequest, message: string, error = 'invalid_token'): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticateValue(request, error) } },
  );
}

function rateLimited(retryAfterMs?: number): NextResponse {
  return NextResponse.json(
    { error: 'Rate limit exceeded' },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil((retryAfterMs || 1000) / 1000)) },
    },
  );
}

/**
 * Extract a bearer token from the Authorization header.
 *
 * The scheme match is case-insensitive because RFC 7235 defines auth schemes as
 * case-insensitive and clients do vary ("Bearer" vs "bearer").
 */
export function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const match = /^bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Authenticate an /api/mcp request.
 *
 * Returns the agent context the connector acts as, or a NextResponse to return
 * directly. Success also stamps `last_used_at` best-effort.
 */
export async function authenticateConnector(
  request: NextRequest
): Promise<ConnectorAuth | NextResponse> {
  // IP limit FIRST, before anything token-derived.
  //
  // A per-token limit alone is no protection here: every distinct bearer value
  // gets its own fresh bucket, so an attacker rotating random tokens is never
  // throttled and each attempt still costs a database lookup. The risk is not
  // credential guessing — a 256-bit token is unguessable — it is unauthenticated
  // DB-query amplification against an endpoint meant to face the internet.
  // /api/v2 has no IP limit because it is LAN-only; this endpoint is not, so it
  // follows the v1 pattern instead (see api-v1-auth.ts).
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  const ipLimited = checkIpRateLimit(ip);
  if (!ipLimited.allowed) {
    return rateLimited(ipLimited.retryAfterMs);
  }

  const token = extractBearerToken(request);
  if (!token) {
    return unauthorized(request, 'Missing bearer token', 'invalid_request');
  }

  // Then the per-token limit, which bounds a single valid credential's usage.
  // Keyed on the token itself; checkRateLimit hashes it internally, so no
  // plaintext is retained in the window map.
  const limited = checkRateLimit(`mcp:${token}`, 60_000, 120);
  if (!limited.allowed) {
    return rateLimited(limited.retryAfterMs);
  }

  const adapter = getStorageAdapter();
  const record = await adapter.findConnectorTokenByHash(hashKey(token));

  // Unknown, revoked and expired tokens are all indistinguishable here.
  if (!record) {
    return unauthorized(request, 'Invalid token');
  }

  const agent = await lookupAgent(record.agent_id);
  if (!agent) {
    return unauthorized(request, 'Invalid token');
  }

  void adapter.touchConnectorToken(record.id);

  return {
    ctx: {
      agentId: agent.id,
      agentName: agent.name,
      machineId: agent.machine_id ?? '',
    },
    tokenId: record.id,
    // Anything unrecognised degrades to read-only rather than opening up.
    scope: record.scope === 'read-write' ? 'read-write' : 'read',
  };
}

/**
 * Resolve the agent a token belongs to.
 *
 * Deactivating an agent must also disable its connector tokens, so `active` is
 * filtered here rather than trusting the token row alone.
 */
async function lookupAgent(
  agentId: string
): Promise<{ id: string; name: string; machine_id: string | null } | null> {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('id, name, machine_id')
    .eq('id', agentId)
    .eq('active', true)
    .single();

  if (error || !data) return null;
  return data as { id: string; name: string; machine_id: string | null };
}

export function isConnectorAuthError(
  result: ConnectorAuth | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}
