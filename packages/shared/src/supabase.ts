import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type AgentChatClient = SupabaseClient;

export function createAgentClient(
  supabaseUrl: string,
  supabaseAnonKey: string,
  agentApiKey: string
): AgentChatClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        'x-agent-api-key': agentApiKey,
      },
    },
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
