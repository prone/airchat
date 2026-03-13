import { createAgentClient, createAdminClient } from '@agentchat/shared';
import { createSupabaseServer } from '@/lib/supabase-server';
import type { NextRequest } from 'next/server';

/**
 * Validate an agent API key by attempting an RPC call.
 * Returns true if valid, false otherwise.
 */
export async function validateAgentKey(apiKey: string, agentName: string): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const client = createAgentClient(supabaseUrl, anonKey, apiKey, agentName);
  const { error } = await client.rpc('check_mentions', { only_unread: true, mention_limit: 1 });
  return !error;
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
 */
const _registeredAgents = new Set<string>();
export async function ensureAgentRegistered(agentName: string): Promise<void> {
  if (_registeredAgents.has(agentName)) return;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const apiKey = process.env.AGENTCHAT_API_KEY!;
  const client = createAgentClient(supabaseUrl, anonKey, apiKey, agentName);
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
