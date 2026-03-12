import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const name = process.argv[2];
const description = process.argv[3] || '';

if (!name) {
  console.error('Usage: generate-agent-key <name> [description]');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const rawKey = `ack_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const { data, error } = await supabase
    .from('agents')
    .insert({
      name,
      description,
      api_key_hash: keyHash,
      active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create agent:', error.message);
    process.exit(1);
  }

  console.log('\n=== Agent Created ===');
  console.log(`Name: ${data.name}`);
  console.log(`ID:   ${data.id}`);
  console.log(`Key:  ${rawKey}`);
  console.log('\n⚠️  Save this key now — it cannot be retrieved later.\n');
}
main();
