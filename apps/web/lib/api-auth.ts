import { createClient } from '@supabase/supabase-js';

/**
 * Validate an agent API key by attempting an RPC call.
 * Returns true if valid, false otherwise.
 */
export async function validateAgentKey(apiKey: string, agentName: string): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return false;
  }

  const agentClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        'x-agent-api-key': apiKey,
        'x-agent-name': agentName,
      },
    },
  });

  const { error } = await agentClient.rpc('check_mentions', {
    only_unread: true,
    mention_limit: 1,
  });

  return !error;
}

/**
 * Get the storage client (service role) or null if no service key is configured.
 * Caller should fall back to session client when null is returned.
 */
export function getStorageClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
}
