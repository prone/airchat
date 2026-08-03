/**
 * Canonical server identity and OAuth metadata documents.
 *
 * The MCP authorization spec requires this server, acting as an OAuth 2.1
 * resource server, to publish RFC 9728 protected-resource metadata and to point
 * at it from a `WWW-Authenticate` header on every 401.
 *
 * That reverses the endpoint's original design, which deliberately advertised
 * no OAuth at all. The reasoning then was that MCP clients begin discovery
 * before sending custom headers, so advertising would stop a client ever
 * sending a bearer (cloudflare/mcp#95). Correct for a client that sends headers
 * first; wrong for claude.ai, which has no bearer path — discovery is its only
 * route. The spike proved it: claude.ai probed for these documents, got 404s,
 * and gave up.
 */

import type { NextRequest } from 'next/server';

/** Path of the MCP endpoint, which is also the OAuth resource being protected. */
export const MCP_RESOURCE_PATH = '/api/mcp';

/**
 * The public origin of this deployment, e.g. `https://mcp.airchat.work`.
 *
 * Configured rather than derived from the request. The canonical resource URI
 * ends up inside issued tokens as their audience, and a `Host` header is
 * attacker-influenceable — deriving from it would let a crafted request cause
 * this server to advertise, and mint tokens for, an identity that is not its
 * own. Configuration is the only source that cannot be spoofed by a caller.
 *
 * Falls back to the request origin when unset, because the endpoint is reached
 * over a tunnel or the tailnet during development where the public hostname is
 * not known in advance. That fallback is fine for a spike and is not fine for
 * production; setting AIRCHAT_PUBLIC_URL is what makes the audience trustworthy.
 */
export function publicOrigin(request: NextRequest): string {
  const configured = process.env.AIRCHAT_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return request.nextUrl.origin;
}

/**
 * The canonical URI identifying this MCP server, per RFC 8707 §2.
 *
 * No fragment, and no trailing slash — RFC 9728 and the MCP spec both call for
 * the form without one, and an audience comparison is an exact string match, so
 * a stray slash is a rejected token rather than a cosmetic difference.
 */
export function canonicalResourceUri(request: NextRequest): string {
  return `${publicOrigin(request)}${MCP_RESOURCE_PATH}`;
}

/**
 * URL of the protected-resource metadata document for this server.
 *
 * RFC 9728 §3.1 inserts the resource's path *after* the well-known segment, so
 * a resource at /api/mcp is described at
 * /.well-known/oauth-protected-resource/api/mcp. Clients also try the bare
 * /.well-known/oauth-protected-resource — claude.ai requested both during the
 * spike — so both are served.
 */
export function resourceMetadataUrl(request: NextRequest): string {
  return `${publicOrigin(request)}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

/**
 * The `WWW-Authenticate` value for a 401 from the MCP endpoint (RFC 9728 §5.1).
 *
 * `resource_metadata` is what a client follows to discover the authorization
 * server. Without it a compliant client has nowhere to go, which is exactly the
 * failure the spike observed.
 */
export function wwwAuthenticateValue(request: NextRequest, error?: string): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl(request)}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

/**
 * RFC 9728 protected-resource metadata.
 *
 * `authorization_servers` MUST contain at least one entry. This server hosts
 * its own — the MCP spec permits the authorization server to live with the
 * resource server, and doing so lets the consent step reuse the dashboard's
 * existing Supabase Auth session rather than building a second identity system.
 *
 * `scopes_supported` are the connector scopes that already exist, so an OAuth
 * grant maps onto the same read / read-write distinction the CLI issues today
 * rather than introducing a second vocabulary.
 */
export function protectedResourceMetadata(request: NextRequest): ProtectedResourceMetadata {
  const origin = publicOrigin(request);
  return {
    resource: canonicalResourceUri(request),
    authorization_servers: [origin],
    scopes_supported: ['read', 'read-write'],
    bearer_methods_supported: ['header'],
  };
}
