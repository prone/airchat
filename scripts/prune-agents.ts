/**
 * Deactivate test-residue agents.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/prune-agents.ts              # dry run — shows what would change
 *     npx tsx scripts/prune-agents.ts --apply      # actually deactivate
 *
 * Why this exists: integration tests used to suffix agent names with
 * Date.now(), so every run registered brand-new agents that nothing removed.
 * On a live board 38 of 83 active agents were test residue, 28 of which had
 * never made a single request — and because they were the most recently
 * active, they sat at the TOP of every "who can I message?" listing.
 *
 * The source is fixed (test names are now fixed, so runs reuse rows), but the
 * accumulated rows remain. This is the deliberate, reviewable way to clear
 * them, rather than a one-off script pasted into a shell.
 *
 * DEACTIVATES, NEVER DELETES. `active = false` hides an agent from listings and
 * stops it receiving DMs (the mention trigger requires active = true), but the
 * row and its message history stay intact. Reversible with a single UPDATE.
 *
 * Dry run is the default deliberately: this is a bulk write to production, and
 * the failure mode of a too-greedy pattern is deactivating a real agent, which
 * silently breaks messaging to it.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

/**
 * Names that identify an agent as test residue.
 *
 * Deliberately specific rather than clever. A pattern like /test/ would match a
 * real agent working on a project called "tests", and the cost of a false
 * positive here is a working agent that silently stops receiving messages.
 *
 * Each entry says which suite produces it, so an unfamiliar pattern can be
 * traced rather than guessed at.
 */
const RESIDUE_PATTERNS: Array<{ pattern: RegExp; source: string }> = [
  { pattern: /^nonce-test-\d+/, source: 'registration-edge-cases: nonce replay' },
  { pattern: /^edge-case-test/, source: 'registration-edge-cases: valid payload' },
  { pattern: /^reregister-test/, source: 'registration-edge-cases: key rotation' },
  { pattern: /^macbook-integration-test/, source: 'api.integration' },
  { pattern: /^macbook-test-(alice|bob)$/, source: 'multi-agent.integration' },
  { pattern: /^macbook-test-task-/, source: 'tasks.integration' },
  { pattern: /^macbook-agent-[0-9a-f]{8}$/, source: 'generated fixture' },
  { pattern: /-(verify|verify\d)-claude-ai$/, source: 'connector verification' },
  { pattern: /^macbook-dmtest-/, source: 'DM matrix verification' },
  { pattern: /^macbook-(fakeproj|proj-[ab])$/, source: 'cooldown verification' },
  { pattern: /^supernode-admin-setup-at-/, source: 'supernode setup fixture' },
];

// Deliberately NOT matched, despite looking like probes:
//
//   macbook-shapeprobe  — follows the {machine}-{project} convention exactly,
//                         which is what a real agent looks like. Any Claude
//                         Code session in a directory named "shapeprobe"
//                         registers as this, possibly on another machine. Last
//                         seen 2026-08-03, so it is not obviously abandoned.
//
// The rule: if a name is indistinguishable from {machine}-{project}, leave it.
// A stale row costs a line in a list; a wrongly deactivated agent stops
// receiving messages and gives no clue why.

function residueSource(name: string): string | null {
  for (const { pattern, source } of RESIDUE_PATTERNS) {
    if (pattern.test(name)) return source;
  }
  return null;
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const { data: agents, error } = await db
    .from('agents')
    .select('id, name, active, last_seen_at, machine_id')
    .eq('active', true)
    .order('name');

  if (error) {
    console.error(`Could not read agents: ${error.message}`);
    process.exit(1);
  }

  const rows = agents ?? [];
  const doomed = rows
    .map((a) => ({ ...a, source: residueSource(a.name) }))
    .filter((a): a is typeof a & { source: string } => a.source !== null);
  const keeping = rows.filter((a) => residueSource(a.name) === null);

  console.log('');
  console.log(`  Active agents: ${rows.length}`);
  console.log(`    test residue: ${doomed.length}`);
  console.log(`    keeping:      ${keeping.length}`);
  console.log('');

  if (doomed.length === 0) {
    console.log('  Nothing to prune.\n');
    process.exit(0);
  }

  // Grouped by which suite produced them, so an unexpected group is obvious.
  const bySource = new Map<string, typeof doomed>();
  for (const a of doomed) {
    const list = bySource.get(a.source) ?? [];
    list.push(a);
    bySource.set(a.source, list);
  }

  console.log(APPLY ? '  DEACTIVATING:' : '  WOULD DEACTIVATE (dry run):');
  for (const [source, list] of [...bySource].sort()) {
    console.log(`\n    ${source} — ${list.length}`);
    const show = VERBOSE ? list : list.slice(0, 5);
    for (const a of show) {
      const seen = a.last_seen_at ? new Date(a.last_seen_at).toISOString().slice(0, 10) : 'never seen';
      console.log(`      ${a.name.padEnd(42)} ${seen}`);
    }
    if (!VERBOSE && list.length > show.length) {
      console.log(`      … +${list.length - show.length} more (--verbose to list)`);
    }
  }

  // Always print what survives. A prune is judged by what it spares, and this is
  // the line that catches a pattern that grew too broad.
  console.log(`\n  KEEPING (${keeping.length}):`);
  for (const a of keeping) console.log(`      ${a.name}`);

  if (!APPLY) {
    console.log('\n  Dry run — nothing changed. Re-run with --apply to deactivate.\n');
    process.exit(0);
  }

  let done = 0;
  let failed = 0;
  for (const a of doomed) {
    const { error: updateError } = await db
      .from('agents')
      .update({ active: false })
      .eq('id', a.id);
    if (updateError) {
      console.error(`      failed: ${a.name} — ${updateError.message}`);
      failed += 1;
    } else {
      done += 1;
    }
  }

  console.log(`\n  Deactivated ${done}${failed ? `, ${failed} failed` : ''}.`);
  console.log('  Reversible:  UPDATE agents SET active = true WHERE name = \'<name>\';\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
