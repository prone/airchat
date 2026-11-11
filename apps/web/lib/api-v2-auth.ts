// Every database call from the API goes through the service role, which
// bypasses row-level security; the checks in the storage adapter and the routes
// are what decide who may read or write what. Migration 00008 also defines
// narrower Postgres roles (airchat_agent_api, airchat_registrar). Nothing uses
// them: supabase-js cannot switch role per request. An operator hosting several
// tenants on one database should not rely on them as a boundary.

import { AsyncLocalStorage } from 'node:async_hooks';
import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hashKey } from '@airchat/shared/crypto';
import { loadPatternSet } from '@airchat/shared/safety';
import {
  SupabaseStorageAdapter,
  DASHBOARD_ADMIN_AGENT,
} from '@airchat/shared';
import { SupabaseGossipAdapter } from '@airchat/shared/supabase-gossip-adapter';
import type { Agent, AgentContext, StorageAdapter, GossipStorageAdapter } from '@airchat/shared';
import { fetchWithTimeout } from '@/lib/supabase-fetch';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { READ_TOKEN_HEADER, findLiveReadToken } from '@/lib/read-tokens';

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
    // No call to the database may wait forever; see lib/supabase-fetch.
    global: { fetch: fetchWithTimeout() },
  });
  return _supabaseClient;
}

// ── Storage adapter singleton ───────────────────────────────────────────────

let _storageAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (_storageAdapter) return _storageAdapter;
  // With a pattern set, a post to a gossip-* or shared-* channel is classified
  // as it is written, so one the classifier would quarantine is held back from
  // local readers as well as from peers. Posts to local channels are not
  // classified.
  _storageAdapter = new SupabaseStorageAdapter(getSupabaseClient(), { patternSet: loadPatternSet() });
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
 * - the Slack bridge, recognised by the `trusted_source` flag an admin set on
 *   its agent row.
 *
 * Everyone else gets undefined, and their messages stay unmarked.
 *
 * This also repairs the Slack bridge. It sends `source: 'slack'` in metadata
 * (slack-bridge/src/index.ts:298) via AirChatRestClient, which posts to
 * /api/v2/messages — where the key has always been stripped. So the marking
 * never landed, and the echo-loop guard in /api/slack/forward, which tests
 * `metadata.source === 'slack'`, could never fire.
 */
/** Sources an agent may be flagged to relay. Anything else in the column is ignored. */
const RELAY_SOURCES = new Set(['slack']);

function trustedSourceOf(permissions: unknown): { trustedSource?: string } {
  const value = permissions && typeof permissions === 'object'
    ? (permissions as Record<string, unknown>).trusted_source
    : undefined;
  return typeof value === 'string' && RELAY_SOURCES.has(value) ? { trustedSource: value } : {};
}

export function resolveTrustedSource(ctx: AgentContext): string | undefined {
  const inProcess = inProcessAgentContext.getStore();
  if (inProcess?.source) return inProcess.source;
  // Not by name: any machine can register an agent called "<x>-slack-bridge".
  // The flag lives in agents.permissions, which only an instance admin can
  // write (migration 00032 sets it for the bridge that already existed).
  if (ctx.trustedSource) return ctx.trustedSource;
  return undefined;
}

// ── Liveness ────────────────────────────────────────────────────────────────

// last_seen_at used to move only on message INSERT (00001_create_schema.sql
// trigger), so an agent that authenticated, polled tasks, and wrote notes but
// never posted a message stayed invisible to find_agents forever — a freshly
// started model worker could not be discovered until it served a task it had
// to be discovered to receive. Bump on any authenticated request instead,
// throttled per agent: an unthrottled version would turn every poll into a
// WAL write, which is the disk-IO-budget churn this codebase just spent a
// release removing.
const LAST_SEEN_BUMP_INTERVAL_MS = 5 * 60 * 1000;
const lastSeenBumpedAt = new Map<string, number>();

function noteAgentActivity(agentId: string): void {
  const now = Date.now();
  if (now - (lastSeenBumpedAt.get(agentId) ?? 0) < LAST_SEEN_BUMP_INTERVAL_MS) return;
  lastSeenBumpedAt.set(agentId, now);
  try {
    // Fire-and-forget: liveness is best-effort and must not add latency or a
    // failure mode to authentication.
    void getSupabaseClient()
      .from('agents')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', agentId)
      .then(({ error }) => {
        if (error) console.error(`[auth] last_seen_at bump failed: ${error.message}`);
      });
  } catch {
    // No Supabase env (unit tests) — skip silently.
  }
}

// ── Read tokens ─────────────────────────────────────────────────────────────

/**
 * The only requests a read token is accepted for: GET on these exact paths.
 *
 * An allow-list, checked here rather than in each route, so that a route added
 * later is closed to read tokens until someone decides otherwise. Every v2
 * route authenticates through authenticateAgent, so this is the one gate.
 *
 * Before adding a path, check what its GET handler does with the caller's
 * identity. A read token's `agentId` is the token's id and matches no agent:
 * anything that writes a row for the caller would fail or, worse, succeed.
 */
export const READ_TOKEN_ROUTES: ReadonlySet<string> = new Set([
  '/api/v2/agents',
  '/api/v2/channels',
  '/api/v2/messages',
  '/api/v2/search',
]);

const READ_TOKEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const readTokenTouchedAt = new Map<string, number>();

function noteReadTokenUse(tokenId: string): void {
  const now = Date.now();
  if (now - (readTokenTouchedAt.get(tokenId) ?? 0) < READ_TOKEN_TOUCH_INTERVAL_MS) return;
  readTokenTouchedAt.set(tokenId, now);
  try {
    // Best-effort, like last_seen_at: never adds latency or a failure mode.
    void getSupabaseClient()
      .from('read_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', tokenId)
      .then(({ error }) => {
        if (error) console.error(`[auth] read token last_used_at failed: ${error.message}`);
      });
  } catch {
    // No Supabase env (unit tests) — skip silently.
  }
}

async function authenticateReadToken(
  request: NextRequest,
  token: string,
): Promise<AgentContext | NextResponse> {
  // Refuse by method and path before looking anything up, so a write attempt
  // costs no database call and gets the same answer for any token.
  const pathname = request.nextUrl.pathname.replace(/\/+$/, '');
  if (request.method !== 'GET' || !READ_TOKEN_ROUTES.has(pathname)) {
    return NextResponse.json(
      { error: 'A read token cannot be used for this request. It reads agents, channels, messages and search only.' },
      { status: 403 },
    );
  }

  let row;
  try {
    row = await findLiveReadToken(getSupabaseClient(), token);
  } catch {
    // Unknown is not the same as invalid: do not tell a valid holder that its
    // token is bad because the database hiccuped.
    return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
  }
  if (!row) {
    return NextResponse.json({ error: 'Invalid read token' }, { status: 401 });
  }

  noteReadTokenUse(row.id);
  return {
    agentId: row.id,
    agentName: `read-token:${row.name}`,
    machineId: '',
    readOnly: true,
    includeDirectMessages: row.include_dms === true,
  };
}

// ── Agent lookup cache ──────────────────────────────────────────────────────

/**
 * Agent rows by key hash, each for 30 seconds.
 *
 * Every API request used to start with a database read to turn the key into
 * an agent. An agent makes several requests per turn (the work check alone
 * runs about twice), so nearly all of those reads returned the row the
 * previous one had returned a moment earlier. With this cache an agent costs
 * at most one lookup per 30 seconds however often it calls.
 *
 * The trade-off is that a change made to the agent row behind this process's
 * back is seen up to 30 seconds late:
 *   - an agent deactivated from the dashboard (which writes to the database
 *     directly) keeps authenticating for up to 30 seconds;
 *   - so does a trusted_source flag an admin changed.
 * Changes that go through this API drop the entry at once (forgetCachedAgent):
 * a re-registration, which installs a new key and must stop the old one
 * working, and a capability-card update. A new key never waits either:
 * unknown keys are not cached, so they are always looked up.
 * 30 seconds is short enough that turning an agent off is still, in practice,
 * immediate, and long enough to cover the burst of requests around one turn.
 *
 * Only successful lookups are stored. Caching failures would let a key that
 * was tried before its agent registered stay rejected after registration.
 *
 * Bounded at 2000 entries, several times the number of agents an instance
 * has; expired entries are dropped first and, if it is still full, the oldest.
 * Keyed by the SHA-256 of the key, never the key itself.
 */
const AGENT_CACHE_TTL_MS = 30_000;
const AGENT_CACHE_MAX = 2000;
const agentsByKeyHash = new Map<string, { agent: Agent; expiresAt: number }>();

function cachedAgent(keyHash: string): Agent | null {
  const hit = agentsByKeyHash.get(keyHash);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    agentsByKeyHash.delete(keyHash);
    return null;
  }
  return hit.agent;
}

function rememberAgent(keyHash: string, agent: Agent): void {
  const now = Date.now();
  if (agentsByKeyHash.size >= AGENT_CACHE_MAX) {
    for (const [hash, entry] of agentsByKeyHash) {
      if (now >= entry.expiresAt) agentsByKeyHash.delete(hash);
    }
    // A Map iterates in insertion order, so the first key is the oldest.
    while (agentsByKeyHash.size >= AGENT_CACHE_MAX) {
      const oldest = agentsByKeyHash.keys().next().value;
      if (oldest === undefined) break;
      agentsByKeyHash.delete(oldest);
    }
  }
  agentsByKeyHash.set(keyHash, { agent, expiresAt: now + AGENT_CACHE_TTL_MS });
}

/**
 * Drop any cached lookup for this agent, so its next request reads the row
 * again. Called when this API changes the row: registration (new key, new
 * card) and card updates.
 */
export function forgetCachedAgent(agentId: string): void {
  for (const [hash, entry] of agentsByKeyHash) {
    if (entry.agent.id === agentId) agentsByKeyHash.delete(hash);
  }
}

/** Forget every cached agent lookup. For tests, which reuse keys across cases. */
export function clearAgentAuthCache(): void {
  agentsByKeyHash.clear();
}

/** The capability card on an agent row; undefined when the row came without metadata. */
function cardOf(agent: Agent): { card?: Record<string, unknown> | null } {
  const metadata = (agent as { metadata?: unknown }).metadata;
  if (metadata === undefined) return {};
  const card = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).card
    : null;
  return { card: card && typeof card === 'object' ? (card as Record<string, unknown>) : null };
}

/**
 * Authenticate a v2 API request using the derived key auth model.
 *
 * Reads `x-agent-api-key` header (the derived key), computes SHA256(derived_key),
 * looks up the hash in agents.derived_key_hash via StorageAdapter — or in the
 * 30-second cache above, which most requests hit.
 *
 * Returns AgentContext on success, or a NextResponse error on failure.
 */
export async function authenticateAgent(
  request: NextRequest
): Promise<AgentContext | NextResponse> {
  // An in-process caller that already verified a credential (currently only
  // /api/mcp) supplies the context directly. Unreachable for inbound HTTP.
  const injected = inProcessAgentContext.getStore();
  if (injected) {
    noteAgentActivity(injected.ctx.agentId);
    return injected.ctx;
  }

  // A read token is its own credential class. When the header is present the
  // request is judged as a read token and nothing else: it never falls through
  // to the agent-key path below.
  const readToken = request.headers.get(READ_TOKEN_HEADER);
  if (readToken !== null) return authenticateReadToken(request, readToken);

  const derivedKey = request.headers.get('x-agent-api-key');

  if (!derivedKey) {
    return NextResponse.json(
      { error: 'Missing x-agent-api-key header' },
      { status: 401 }
    );
  }

  const keyHash = hashKey(derivedKey);

  let agent = cachedAgent(keyHash);
  if (!agent) {
    agent = await getStorageAdapter().findAgentByDerivedKeyHash(keyHash);
    if (!agent) {
      return NextResponse.json(
        { error: 'Invalid API key' },
        { status: 401 }
      );
    }
    rememberAgent(keyHash, agent);
  }

  const ctx: AgentContext = {
    agentId: agent.id,
    agentName: agent.name,
    machineId: agent.machine_id ?? '',
    ...trustedSourceOf(agent.permissions),
    // Carried so routes that need the card (the work check) do not read the
    // agent row again.
    ...cardOf(agent),
  };

  noteAgentActivity(agent.id);
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
  operation: 'read' | 'write' | 'gossip_write' | 'telemetry'
): NextResponse | null {
  const limitMap = {
    read: RATE_LIMITS.read,
    write: RATE_LIMITS.write,
    gossip_write: RATE_LIMITS.gossip_write,
    telemetry: RATE_LIMITS.telemetry,
  };
  const limit = limitMap[operation];
  // Key includes the operation so each bucket has its own window — otherwise
  // high-volume telemetry flushes would consume the shared array and starve writes.
  const result = checkRateLimit(`${operation}:${agentId}`, limit.windowMs, limit.maxRequests);
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
