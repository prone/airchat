import { createAgentClient, createAdminClient } from '@airchat/shared/supabase';
import { createSupabaseServer } from '@/lib/supabase-server';
import crypto from 'crypto';
import type { NextRequest } from 'next/server';

/**
 * Validate an agent API key with a lightweight query through RLS.
 * Results are cached for 1 minute to avoid per-request DB round-trips.
 */
const _keyCache = new Map<string, { valid: boolean; expires: number }>();
const KEY_CACHE_TTL_MS = 60_000; // 1 minute

export async function validateAgentKey(apiKey: string, agentName: string): Promise<boolean> {
  const cacheKey = crypto.createHash('sha256').update(`${apiKey}\0${agentName}`).digest('hex');
  const cached = _keyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.valid;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const client = createAgentClient(supabaseUrl, anonKey, apiKey, agentName);
  const { error } = await client.from('agents').select('id').limit(1);
  const valid = !error;

  _keyCache.set(cacheKey, { valid, expires: Date.now() + KEY_CACHE_TTL_MS });
  return valid;
}

/**
 * Cached storage client singleton (service role).
 * Returns null if SUPABASE_SERVICE_ROLE_KEY is not set.
 */
let _storageClient: ReturnType<typeof createAdminClient> | null = null;
export function getStorageClient() {
  if (_storageClient) return _storageClient;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  _storageClient = createAdminClient(supabaseUrl, serviceKey);
  return _storageClient;
}

/**
 * Cached ensure_agent_exists — only calls the RPC once per agent name per process.
 * Validates name format and enforces a per-key registration cap (DB-backed).
 * Uses the caller's API key to preserve RLS identity.
 */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;
export { AGENT_NAME_RE };
const MAX_AGENTS_PER_KEY = 20;

const _registeredAgents = new Set<string>();

export async function ensureAgentRegistered(
  agentName: string,
  callerApiKey: string,
): Promise<void> {
  // Validate name format before hitting DB
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(`Invalid agent name format: must match ${AGENT_NAME_RE}`);
  }

  if (_registeredAgents.has(agentName)) return;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Use the caller's API key to preserve RLS identity
  const client = createAgentClient(supabaseUrl, anonKey, callerApiKey, agentName);

  // DB-backed registration cap: count existing agents for this key
  const { count } = await client
    .from('agents')
    .select('id', { count: 'exact', head: true });

  if ((count || 0) >= MAX_AGENTS_PER_KEY) {
    // Check if this specific agent already exists (allow re-registration)
    const { data: existing } = await client
      .from('agents')
      .select('id')
      .eq('name', agentName)
      .limit(1);

    if (!existing?.length) {
      throw new Error(`Registration cap reached: max ${MAX_AGENTS_PER_KEY} agents per API key`);
    }
  }

  await client.rpc('ensure_agent_exists', { p_agent_name: agentName });
  _registeredAgents.add(agentName);
}

/**
 * Authenticate a request via agent API key header or Supabase session cookie.
 * Returns true if authenticated, false otherwise.
 */
export async function authenticateRequest(request: NextRequest): Promise<boolean> {
  const agentApiKey = request.headers.get('x-agent-api-key');
  if (agentApiKey) {
    const agentName = request.headers.get('x-agent-name') || '';
    return validateAgentKey(agentApiKey, agentName);
  }
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  return !!user;
}
