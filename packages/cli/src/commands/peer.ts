/**
 * CLI commands for peer management.
 */

import { AirChatRestClient, readBodyCapped } from '@airchat/shared/rest-client';
import { oneLine } from '../terminal.js';

/** An instance identity is a few hundred bytes. */
const MAX_IDENTITY_BYTES = 64 * 1024;

export async function peerAdd(client: AirChatRestClient, endpoint: string, opts: { type?: string; scope?: string }) {
  console.log(`Fetching identity from ${endpoint}...`);

  let fingerprint: string;
  let displayName: string | undefined;
  try {
    // The address was typed by the user, but what answers there is a stranger:
    // no following it elsewhere, a time limit, and a small cap on what is read.
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/v2/gossip/identity`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`Remote instance at ${endpoint} did not respond (HTTP ${res.status}).`);
      process.exit(1);
    }
    // The endpoint wraps its answer: the fields are under `data`. An older
    // server answers with them at the top level.
    const identity = identityFields(JSON.parse(await readBodyCapped(res, MAX_IDENTITY_BYTES, 'throw')));
    if (!identity) {
      console.error(`${endpoint} did not answer with an instance identity. Is it an AirChat server with gossip enabled?`);
      process.exit(1);
    }
    fingerprint = identity.fingerprint;
    displayName = identity.displayName;
    console.log(`  Fingerprint: ${oneLine(fingerprint)}`);
    if (displayName) console.log(`  Display name: ${oneLine(displayName)}`);
  } catch {
    console.error(`Could not reach ${endpoint}. Check the URL and try again.`);
    process.exit(1);
  }

  try {
    const res = await client.addPeer(
      endpoint.replace(/\/$/, ''),
      fingerprint,
      opts.type,
      opts.scope,
      displayName,
    ) as Record<string, Record<string, string>>;
    console.log(`\nPeer added: ${oneLine(res.peer?.endpoint)} (${oneLine(res.peer?.fingerprint)})`);
    console.log('Note: The remote instance must also add you for sync to activate.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to add peer: ${msg}`);
    process.exit(1);
  }
}

export async function peerRemove(client: AirChatRestClient, endpoint: string) {
  try {
    await client.removePeer(endpoint.replace(/\/$/, ''));
    console.log(`Peer removed: ${endpoint}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to remove peer: ${msg}`);
    process.exit(1);
  }
}

export async function peerList(client: AirChatRestClient) {
  try {
    const res = await client.listPeers() as Record<string, Array<Record<string, unknown>>>;
    const peers = res.peers ?? [];

    if (peers.length === 0) {
      console.log('No peers configured. Use `airchat peer add --endpoint URL` to add one.');
      return;
    }

    console.log(`Peers (${peers.length}):\n`);
    for (const p of peers) {
      const status = p.suspended ? 'SUSPENDED' : p.active ? 'active' : 'inactive';
      const type = p.is_default_supernode ? 'supernode (default)' : p.peer_type;
      console.log(`  ${oneLine(p.endpoint)}`);
      console.log(`    Fingerprint: ${oneLine(p.fingerprint)}  Type: ${oneLine(type)}  Status: ${status}`);
      if (p.last_sync_at) console.log(`    Last sync: ${oneLine(p.last_sync_at)}`);
      if ((p.messages_received as number) > 0) {
        console.log(`    Messages: ${p.messages_received} received, ${p.messages_quarantined} quarantined`);
      }
      console.log('');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to list peers: ${msg}`);
    process.exit(1);
  }
}

/**
 * The fingerprint and display name from a /api/v2/gossip/identity answer, or
 * null when it carries no fingerprint. Without this check a wrapped answer
 * was read as having no fingerprint and the peer was added with none.
 */
export function identityFields(json: unknown): { fingerprint: string; displayName?: string } | null {
  const top = (json ?? {}) as { data?: unknown };
  const fields = (typeof top.data === 'object' && top.data !== null ? top.data : top) as Record<string, unknown>;
  if (typeof fields.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fields.fingerprint)) return null;
  return {
    fingerprint: fields.fingerprint,
    ...(typeof fields.display_name === 'string' && fields.display_name ? { displayName: fields.display_name } : {}),
  };
}
