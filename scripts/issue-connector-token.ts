/**
 * Mint a connector token for the claude.ai MCP endpoint.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/issue-connector-token.ts <agent-name> [--name "label"] [--days 90]
 *
 * The plaintext token is printed ONCE and never stored — only its SHA256 hash
 * goes to the database, the same model as agent derived keys. Losing it means
 * revoking and minting a new one.
 *
 * A connector token is not an agent key: it is accepted only by /api/mcp, and
 * by nothing under /api/v2. That is what keeps it audience-bound.
 *
 * Also supports listing and revoking:
 *   npx tsx scripts/issue-connector-token.ts --list <agent-name>
 *   npx tsx scripts/issue-connector-token.ts --revoke <token-id>
 */

import { createClient } from '@supabase/supabase-js';
import { randomBytes, createHash } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TOKEN_PREFIX = 'acx_';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function list(agentName: string) {
  const { data: agent } = await supabase
    .from('agents').select('id, name').eq('name', agentName).single();
  if (!agent) {
    console.error(`No agent named "${agentName}"`);
    process.exit(1);
  }

  const { data } = await supabase
    .from('connector_tokens')
    .select('id, name, created_at, expires_at, revoked_at, last_used_at')
    .eq('agent_id', agent.id)
    .order('created_at', { ascending: false });

  if (!data?.length) {
    console.log(`No connector tokens for ${agentName}.`);
    return;
  }

  console.log(`Connector tokens for ${agentName}:\n`);
  for (const t of data) {
    const state = t.revoked_at
      ? 'REVOKED'
      : t.expires_at && new Date(t.expires_at) < new Date()
        ? 'EXPIRED'
        : 'active';
    console.log(`  ${t.id}  [${state}]  ${t.name}`);
    console.log(`    created ${t.created_at}  expires ${t.expires_at ?? 'never'}  last used ${t.last_used_at ?? 'never'}`);
  }
}

async function revoke(tokenId: string) {
  const { error, data } = await supabase
    .from('connector_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .is('revoked_at', null)
    .select('id, name');

  if (error) {
    console.error(`Revoke failed: ${error.message}`);
    process.exit(1);
  }
  if (!data?.length) {
    console.error('No such active token (already revoked, or wrong id).');
    process.exit(1);
  }
  console.log(`Revoked ${data[0].name} (${data[0].id}). It will stop working immediately.`);
}

async function issue(agentName: string) {
  const { data: agent } = await supabase
    .from('agents').select('id, name, active').eq('name', agentName).single();

  if (!agent) {
    console.error(`No agent named "${agentName}". Register the agent first.`);
    process.exit(1);
  }
  if (!agent.active) {
    console.error(`Agent "${agentName}" is inactive; its tokens would not authenticate.`);
    process.exit(1);
  }

  const label = flag('name') ?? 'claude.ai connector';
  const days = Number(flag('days') ?? '90');
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days must be a positive number');
    process.exit(1);
  }

  const token = TOKEN_PREFIX + randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const { error } = await supabase.from('connector_tokens').insert({
    agent_id: agent.id,
    token_hash: tokenHash,
    name: label,
    expires_at: expiresAt,
  });

  if (error) {
    console.error(`Failed to issue token: ${error.message}`);
    process.exit(1);
  }

  console.log(`\nConnector token for agent "${agentName}" (${label}):\n`);
  console.log(`  ${token}\n`);
  console.log(`  Expires: ${expiresAt}`);
  console.log(`  Shown once — it is stored only as a hash. Save it now.\n`);
  console.log(`  Use as: Authorization: Bearer ${TOKEN_PREFIX}...`);
  console.log(`  Endpoint: https://<your-host>/api/mcp\n`);
}

async function main() {
  const listTarget = flag('list');
  const revokeTarget = flag('revoke');

  if (listTarget) return list(listTarget);
  if (revokeTarget) return revoke(revokeTarget);

  const agentName = process.argv[2];
  if (!agentName || agentName.startsWith('--')) {
    console.error('Usage: issue-connector-token.ts <agent-name> [--name "label"] [--days 90]');
    console.error('       issue-connector-token.ts --list <agent-name>');
    console.error('       issue-connector-token.ts --revoke <token-id>');
    process.exit(1);
  }
  return issue(agentName);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
