import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type AgentChatClient = SupabaseClient;

export function createAgentClient(
  supabaseUrl: string,
  supabaseAnonKey: string,
  agentApiKey: string,
  agentName?: string
): AgentChatClient {
  const headers: Record<string, string> = {
    'x-agent-api-key': agentApiKey,
  };
  if (agentName) {
    headers['x-agent-name'] = agentName;
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers },
  });
}

export function createAdminClient(
  supabaseUrl: string,
  serviceRoleKey: string
): AgentChatClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
