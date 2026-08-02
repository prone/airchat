/**
 * Mint a connector token for the claude.ai MCP endpoint.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/issue-connector-token.ts <label> [--scope read|read-write] [--days 30]
 *
 * <label> names the dedicated connector agent: "duncan" becomes agent
 * "duncan-claude-ai". That agent is created with no API credential, so it can
 * never authenticate to /api/v2 and is distinct from any Claude Code agent.
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
import { CONNECTOR_AGENT_SUFFIX } from '@airchat/shared';

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

async function list(label: string) {
  const agentName = label.endsWith(`-${CONNECTOR_AGENT_SUFFIX}`)
    ? label
    : `${label}-${CONNECTOR_AGENT_SUFFIX}`;
  const { data: agent } = await supabase
    .from('agents').select('id, name').eq('name', agentName).maybeSingle();
  if (!agent) {
    console.error(`No connector agent named "${agentName}"`);
    process.exit(1);
  }

  const { data } = await supabase
    .from('connector_tokens')
    .select('id, name, scope, created_at, expires_at, revoked_at, last_used_at')
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
    console.log(`  ${t.id}  [${state}]  ${t.scope}  ${t.name}`);
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

/**
 * Find or create the dedicated connector agent for a label.
 *
 * The agent is created with NO credentials — derived_key_hash and api_key_hash
 * stay null — so it can never authenticate to /api/v2 by any path. That keeps
 * the connector identity separate from the agents running in Claude Code: a
 * leaked connector token cannot act as one of them, and revoking it disturbs
 * none of them. Migration 00023 enforces this with a trigger, so a token bound
 * to a credentialled agent is rejected by the database, not just by this script.
 */
async function resolveConnectorAgent(label: string): Promise<{ id: string; name: string }> {
  const agentName = label.endsWith(`-${CONNECTOR_AGENT_SUFFIX}`)
    ? label
    : `${label}-${CONNECTOR_AGENT_SUFFIX}`;

  const { data: existing } = await supabase
    .from('agents')
    .select('id, name, active, derived_key_hash, api_key_hash')
    .eq('name', agentName)
    .maybeSingle();

  if (existing) {
    if (existing.derived_key_hash || existing.api_key_hash) {
      console.error(
        `Agent "${agentName}" holds an API credential, so it is a real agent, not a connector identity.\n` +
        `Refusing to bind a connector token to it. Pick a different label.`
      );
      process.exit(1);
    }
    if (!existing.active) {
      await supabase.from('agents').update({ active: true }).eq('id', existing.id);
    }
    return { id: existing.id, name: agentName };
  }

  const { data: created, error } = await supabase
    .from('agents')
    .insert({ name: agentName, active: true })
    .select('id, name')
    .single();

  if (error || !created) {
    console.error(`Failed to create connector agent "${agentName}": ${error?.message}`);
    process.exit(1);
  }
  console.log(`Created connector agent "${agentName}" (no API credential).`);
  return { id: created.id, name: agentName };
}

async function issue(label: string) {
  const scope = flag('scope') ?? 'read';
  if (scope !== 'read' && scope !== 'read-write') {
    console.error('--scope must be "read" or "read-write"');
    process.exit(1);
  }

  const agent = await resolveConnectorAgent(label);

  const tokenLabel = flag('name') ?? 'claude.ai connector';
  const days = Number(flag('days') ?? '30');
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
    name: tokenLabel,
    scope,
    expires_at: expiresAt,
  });

  if (error) {
    console.error(`Failed to issue token: ${error.message}`);
    process.exit(1);
  }

  console.log(`\nConnector token for agent "${agent.name}" (${tokenLabel}):\n`);
  console.log(`  ${token}\n`);
  console.log(`  Scope:   ${scope}${scope === 'read' ? '  (read-only — pass --scope read-write to allow posting)' : '  (can post messages and write notes)'}`);
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
    console.error('Usage: issue-connector-token.ts <label> [--scope read|read-write] [--name "..."] [--days 30]');
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
