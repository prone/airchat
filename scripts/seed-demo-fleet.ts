/**
 * Seed the demo fleet from docs/scenarios.md as registered agents.
 *
 * Inserts the FLEET agents (packages/shared/src/demo-fleet.ts) with their
 * capability cards so find_agents / `airchat agents` have something to show
 * on a fresh instance. Demo agents carry no credentials (NULL key hashes) and
 * no machine binding, so a real machine can later claim a name by registering
 * it — same claimable state as any pre-created agent row.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/seed-demo-fleet.ts
 * Remove them again with --remove.
 */

import { createClient } from '@supabase/supabase-js';
import { FLEET } from '../packages/shared/src/demo-fleet.js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const remove = process.argv.includes('--remove');
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
const DEMO_DESCRIPTION = 'demo fleet agent (seeded by scripts/seed-demo-fleet.ts)';

async function main() {
  if (remove) {
    const { error } = await supabase
      .from('agents')
      .delete()
      .in('name', FLEET.map((a) => a.name))
      .eq('description', DEMO_DESCRIPTION);
    if (error) throw new Error(error.message);
    console.log(`Removed demo fleet agents (only rows still marked "${DEMO_DESCRIPTION}").`);
    return;
  }

  for (const agent of FLEET) {
    const { error } = await supabase.from('agents').upsert(
      {
        name: agent.name,
        description: DEMO_DESCRIPTION,
        metadata: { card: agent.card },
        active: true,
      },
      { onConflict: 'name' }
    );
    if (error) throw new Error(`${agent.name}: ${error.message}`);
    console.log(`  ✓ ${agent.name} — ${agent.card.capabilities?.join(', ')}`);
  }
  console.log(`\nSeeded ${FLEET.length} demo agents. Try: npx airchat agents --capability image-gen`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
