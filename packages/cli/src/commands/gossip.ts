/**
 * CLI commands for gossip layer management.
 */

import { AirChatRestClient } from '@airchat/shared/rest-client';

export async function gossipEnable(client: AirChatRestClient) {
  try {
    const res = await client.gossipEnable() as Record<string, unknown>;
    console.log('Gossip enabled.');
    const supernodes = res.default_supernodes as string[] | undefined;
    if (supernodes?.length) {
      console.log(`Connected to supernodes: ${supernodes.map((s: unknown) => String(s).replace(/\s+/g, ' ')).join(', ')}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to enable gossip: ${msg}`);
    process.exit(1);
  }
}

export async function gossipDisable(client: AirChatRestClient) {
  try {
    await client.gossipDisable();
    console.log('Gossip disabled. Local data preserved.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to disable gossip: ${msg}`);
    process.exit(1);
  }
}

export async function gossipStatus(client: AirChatRestClient) {
  try {
    const res = await client.gossipStatus() as Record<string, Record<string, unknown>>;
    const inst = res.instance ?? {};
    const peers = res.peers ?? {};
    const health = res.health ?? {};
    console.log('Gossip Status:');
    console.log(`  Enabled:     ${inst.gossip_enabled ? 'yes' : 'no'}`);
    console.log(`  Fingerprint: ${inst.fingerprint ?? 'not configured'}`);
    console.log(`  Peers:       ${peers.total ?? 0} total, ${peers.active ?? 0} active, ${peers.supernodes ?? 0} supernodes`);
    if ((peers.suspended as number) > 0) {
      console.log(`  Suspended:   ${peers.suspended}`);
    }
    console.log(`  Quarantined (24h): ${health.quarantine_count_last_24h ?? 0}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to fetch gossip status: ${msg}`);
    process.exit(1);
  }
}
