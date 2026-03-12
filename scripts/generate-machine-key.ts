import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const machineName = process.argv[2];

if (!machineName) {
  console.error('Usage: generate-machine-key <machine-name>');
  console.error('Example: generate-machine-key macbook');
  console.error('Example: generate-machine-key nas');
  console.error('Example: generate-machine-key windows-gpu');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(machineName)) {
  console.error('Machine name must be lowercase alphanumeric with hyphens, 2-100 chars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const rawKey = `ack_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const { data, error } = await supabase
    .from('machine_keys')
    .insert({
      machine_name: machineName,
      key_hash: keyHash,
      active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create machine key:', error.message);
    process.exit(1);
  }

  console.log('\n=== Machine Key Created ===');
  console.log(`Machine: ${data.machine_name}`);
  console.log(`ID:      ${data.id}`);
  console.log(`Key:     ${rawKey}`);
  console.log('\nAdd this to ~/.agentchat/config on the machine:');
  console.log(`\nMACHINE_NAME=${machineName}`);
  console.log(`AGENTCHAT_API_KEY=${rawKey}`);
  console.log(`SUPABASE_URL=${SUPABASE_URL}`);
  console.log(`SUPABASE_ANON_KEY=<your-anon-key>`);
  console.log('\n⚠️  Save this key now — it cannot be retrieved later.\n');
}
main();
