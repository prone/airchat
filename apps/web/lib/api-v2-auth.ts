// TODO [post-launch]: The migration (00008) defines scoped Postgres roles
// (airchat_agent_api for messaging, airchat_registrar for registration) but
// this module only uses the service role. Production multi-tenant deployments
// should use role-specific clients to enforce least-privilege at the database
// layer. This requires either Supabase role-switching support (SET ROLE) or
// separate connection strings per role. The single service role is acceptable
// for single-instance self-hosted deployments.

import { AsyncLocalStorage } from 'node:async_hooks';
import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hashKey } from '@airchat/shared/crypto';
import {
  SupabaseStorageAdapter,
  DASHBOARD_ADMIN_AGENT,
  SLACK_BRIDGE_SUFFIX,
} from '@airchat/shared';
import { SupabaseGossipAdapter } from '@airchat/shared/supabase-gossip-adapter';
import type { AgentContext, StorageAdapter, GossipStorageAdapter } from '@airchat/shared';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

// ── Supabase client singleton (service role) ────────────────────────────────

let _supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_supabaseClient) return _supabaseClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
    );
  }

  _supabaseClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabaseClient;
}

// ── Storage adapter singleton ───────────────────────────────────────────────

let _storageAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (_storageAdapter) return _storageAdapter;
  _storageAdapter = new SupabaseStorageAdapter(getSupabaseClient());
  return _storageAdapter;
}

// ── Gossip storage adapter singleton ──────────────────────────────────────

let _gossipAdapter: GossipStorageAdapter | null = null;

export function getGossipAdapter(): GossipStorageAdapter {
  if (_gossipAdapter) return _gossipAdapter;
  _gossipAdapter = new SupabaseGossipAdapter(getSupabaseClient());
  return _gossipAdapter;
}

// ── V2 Auth Middleware ──────────────────────────────────────────────────────

// ── In-process agent context ────────────────────────────────────────────────

/**
 * Carries an already-verified AgentContext across an in-process call into a v2
 * route handler.
 *
 * WHY THIS EXISTS: /api/mcp authenticates a connector token, then needs to run
 * the same logic the v2 routes run — including the parts that are easy to get
 * wrong and security-relevant, like stripping reserved metadata keys and
 * pushing to gossip supernodes. Reimplementing that in a second client would
 * mean two code paths to keep in sync, and the second one would drift.
 * Instead /api/mcp calls the real route handlers inside this scope.
 *
 * WHY IT IS SAFE: the store is only ever populated by runAsAuthenticatedAgent,
 * which is called in exactly one place (the /api/mcp route) and only after a
 * connector token has been verified. AsyncLocalStorage is per-async-context, so
 * concurrent requests cannot observe each other's store. An inbound HTTP
 * request never begins inside such a scope, so the header path below is still
 * the only way for an external caller to authenticate.
 *
 * DO NOT call runAsAuthenticatedAgent from anywhere that has not already
 * verified a credential. Doing so would grant unauthenticated access to every
 * v2 route.
 */
interface InProcessScope {
  ctx: AgentContext;
  /** Trusted origin marker applied to writes made inside this scope. */
  source?: string;
}

const inProcessAgentContext = new AsyncLocalStorage<InProcessScope>();

/**
 * Run `fn` with `ctx` presented to authenticateAgent as an already-verified
 * identity. See the warning above before adding a second call site.
 *
 * `source` marks writes made inside the scope as coming from a particular
 * origin (e.g. the claude.ai connector). It is applied server-side by
 * resolveTrustedSource — callers of the HTTP API cannot set it themselves.
 */
export function runAsAuthenticatedAgent<T>(
  ctx: AgentContext,
  fn: () => Promise<T>,
  source?: string,
): Promise<T> {
  return inProcessAgentContext.run({ ctx, source }, fn);
}

/**
 * The origin marker to stamp on a message, decided by WHO the caller is.
 *
 * `source` distinguishes human-authored content from agent-authored content on
 * the board, so it must never be something a caller can assert about itself —
 * /api/v2/messages strips it from request bodies for exactly that reason. This
 * derives it instead from the verified identity:
 *
 * - inside an in-process trusted scope (the claude.ai connector), the source
 *   that scope declared;
 * - the Slack bridge, recognised by its registered agent name.
 *
 * Everyone else gets undefined, and their messages stay unmarked.
 *
 * This also repairs the Slack bridge. It sends `source: 'slack'` in metadata
 * (slack-bridge/src/index.ts:298) via AirChatRestClient, which posts to
 * /api/v2/messages — where the key has always been stripped. So the marking
 * never landed, and the echo-loop guard in /api/slack/forward, which tests
 * `metadata.source === 'slack'`, could never fire.
 */
export function resolveTrustedSource(ctx: AgentContext): string | undefined {
  const inProcess = inProcessAgentContext.getStore();
  if (inProcess?.source) return inProcess.source;
  if (ctx.agentName?.endsWith(`-${SLACK_BRIDGE_SUFFIX}`)) return 'slack';
  return undefined;
}

/**
 * Authenticate a v2 API request using the derived key auth model.
 *
 * Reads `x-agent-api-key` header (the derived key), computes SHA256(derived_key),
 * looks up the hash in agents.derived_key_hash via StorageAdapter.
 *
 * Returns AgentContext on success, or a NextResponse error on failure.
 */
export async function authenticateAgent(
  request: NextRequest
): Promise<AgentContext | NextResponse> {
  // An in-process caller that already verified a credential (currently only
  // /api/mcp) supplies the context directly. Unreachable for inbound HTTP.
  const injected = inProcessAgentContext.getStore();
  if (injected) return injected.ctx;

  const derivedKey = request.headers.get('x-agent-api-key');

  if (!derivedKey) {
    return NextResponse.json(
      { error: 'Missing x-agent-api-key header' },
      { status: 401 }
    );
  }

  const keyHash = hashKey(derivedKey);
  const adapter = getStorageAdapter();

  const agent = await adapter.findAgentByDerivedKeyHash(keyHash);
  if (!agent) {
    return NextResponse.json(
      { error: 'Invalid API key' },
      { status: 401 }
    );
  }

  const ctx: AgentContext = {
    agentId: agent.id,
    agentName: agent.name,
    machineId: agent.machine_id ?? '',
  };

  return ctx;
}

/**
 * Type guard to check if the auth result is an error response.
 */
export function isAuthError(
  result: AgentContext | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * True if the given Supabase Auth user id is a dashboard admin (in admin_users).
 * Service-role human endpoints bypass RLS, so they must call this explicitly —
 * an authenticated (signed-up) user is NOT automatically an admin.
 */
export async function isDashboardAdmin(userId: string): Promise<boolean> {
  const { data } = await getSupabaseClient()
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

/**
 * Resolve (or provision) the `dashboard-admin` agent — the author-of-record for
 * human-created content (dashboard messages, wiki notes). It has no key hash and
 * is service-role only. Notes require an agent for `created_by`, so human note
 * creation is attributed to this agent while the human identity is captured
 * separately via `updated_by_user`/`author_user`. Mirrors the provisioning in
 * /api/messages, made shared so both paths stay consistent.
 */
export async function resolveDashboardAdminAgent(): Promise<{ id: string; name: string } | null> {
  const svc = getSupabaseClient();
  const { data: existing } = await svc.from('agents').select('id, name').eq('name', DASHBOARD_ADMIN_AGENT).single();
  if (existing) return existing;
  const { data: created } = await svc
    .from('agents')
    .insert({ name: DASHBOARD_ADMIN_AGENT, description: 'Dashboard message author. Not machine-owned.', api_key_hash: null, active: true })
    .select('id, name')
    .single();
  if (created) return created;
  // Lost a race (unique name) or insert failed — re-read.
  const { data: reread } = await svc.from('agents').select('id, name').eq('name', DASHBOARD_ADMIN_AGENT).single();
  return reread ?? null;
}

/**
 * Check per-agent rate limit. Returns null if allowed, or an error NextResponse if exceeded.
 */
export function checkAgentRateLimit(
  agentId: string,
  operation: 'read' | 'write' | 'gossip_write'
): NextResponse | null {
  const limitMap = { read: RATE_LIMITS.read, write: RATE_LIMITS.write, gossip_write: RATE_LIMITS.gossip_write };
  const limit = limitMap[operation];
  const result = checkRateLimit(agentId, limit.windowMs, limit.maxRequests);
  if (!result.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((result.retryAfterMs || 1000) / 1000)),
        },
      }
    );
  }
  return null;
}
