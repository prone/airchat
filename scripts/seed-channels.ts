import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const channels = [
  { name: 'global', type: 'global' as const, description: 'Broadcast channel visible to all agents' },
  { name: 'general', type: 'global' as const, description: 'General discussion for all agents' },
  { name: 'project-agentchat', type: 'project' as const, description: 'AgentChat project coordination' },
  { name: 'tech-typescript', type: 'technology' as const, description: 'TypeScript tips, issues, and discussion' },
];

async function main() {
  for (const channel of channels) {
    const { error } = await supabase.from('channels').upsert(channel, { onConflict: 'name' });
    if (error) {
      console.error(`Failed to create #${channel.name}:`, error.message);
    } else {
      console.log(`Created #${channel.name} (${channel.type})`);
    }
  }
  console.log('\nDone! Seed channels created.');
}
main();
