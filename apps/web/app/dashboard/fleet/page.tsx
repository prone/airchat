'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { formatSize } from '@airchat/shared';
import { useNow } from '@/lib/use-now';

/**
 * Fleet view: one page to understand your machines, the agents on them, and
 * the models they serve. Read-only — management actions live on the Agents
 * page; this answers "what is my fleet, and is it alive?"
 *
 * Model inventories come from the models-<machine> notes that model workers
 * publish (properties.type = 'model-inventory'), the same source the
 * list_models MCP tool reads. Machines and agents come straight from the
 * admin-readable tables.
 */

interface MachineRow {
  id: string;
  machine_name: string;
  active: boolean;
  created_at: string;
}

interface AgentCard {
  model?: string;
  harness?: string;
  capabilities?: string[];
}

interface AgentRow {
  id: string;
  name: string;
  active: boolean;
  description: string | null;
  last_seen_at: string | null;
  machine_id: string | null;
  metadata: { card?: AgentCard } | null;
}

interface InventoryModel {
  name: string;
  capability: string;
  kind: string;
  backend: string;
  location: string;
  endpoint: string;
  size_bytes?: number;
  quantization?: string;
}

interface InventoryNote {
  slug: string;
  updated_at: string;
  properties: { machine?: string; models?: InventoryModel[] } | null;
}

const ONLINE_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_INVENTORY_MS = 2 * 60 * 60 * 1000;

function timeAgo(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function StatusDot({ lastSeen, now }: { lastSeen: string | null; now: number }) {
  const online = lastSeen !== null && now - new Date(lastSeen).getTime() < ONLINE_THRESHOLD_MS;
  return (
    <span
      title={online ? 'seen in the last 10 minutes' : 'not recently seen'}
      style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: online ? 'var(--success)' : 'var(--text-dim)',
        marginRight: 6, flexShrink: 0,
      }}
    />
  );
}

function CapChips({ card }: { card?: AgentCard }) {
  if (!card?.capabilities?.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {card.capabilities.map((c) => (
        <code key={c} className="text-sm" style={{ padding: '0 4px', borderRadius: 4, background: 'var(--bg)', fontSize: '0.7rem' }}>
          {c}
        </code>
      ))}
    </span>
  );
}

export default function FleetPage() {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [inventories, setInventories] = useState<InventoryNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const now = useNow();
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function load() {
      const [m, a, n] = await Promise.all([
        supabase.from('machine_keys').select('id, machine_name, active, created_at').order('machine_name'),
        supabase.from('agents').select('id, name, active, description, last_seen_at, machine_id, metadata').order('last_seen_at', { ascending: false, nullsFirst: false }),
        supabase.from('notes').select('slug, updated_at, properties').contains('properties', { type: 'model-inventory' }),
      ]);
      if (m.data) setMachines(m.data);
      if (a.data) setAgents(a.data);
      if (n.data) setInventories(n.data);
      setLoaded(true);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byMachine = useMemo(() => {
    const map = new Map<string | null, AgentRow[]>();
    for (const a of agents) {
      const key = a.machine_id;
      map.set(key, [...(map.get(key) ?? []), a]);
    }
    return map;
  }, [agents]);

  const inventoryFor = (machineName: string): InventoryNote | undefined =>
    inventories.find((n) => n.properties?.machine === machineName || n.slug === `models-${machineName}`);

  const totals = useMemo(() => ({
    machines: machines.length,
    agents: agents.length,
    online: agents.filter((a) => a.last_seen_at && now - new Date(a.last_seen_at).getTime() < ONLINE_THRESHOLD_MS).length,
    models: inventories.reduce((sum, n) => sum + (n.properties?.models?.length ?? 0), 0),
  }), [machines, agents, inventories, now]);

  const unattached = byMachine.get(null) ?? [];

  return (
    <div className="container">
      <div className="flex items-center justify-between mb-3">
        <h2>Fleet</h2>
        <span className="text-sm text-dim">
          {totals.machines} machines · {totals.agents} agents ({totals.online} online) · {totals.models} models
        </span>
      </div>

      <p className="text-sm text-dim mb-3">
        Machines, the agents on them, and the models they serve. Online = seen in the
        last 10 minutes. Model inventories are published by each machine&apos;s model
        worker; a stale one usually means that machine is asleep.{' '}
        <Link href="/dashboard/agents">Manage agents →</Link>
      </p>

      {!loaded && <div className="card">Loading fleet…</div>}

      {machines.map((machine) => {
        const machineAgents = byMachine.get(machine.id) ?? [];
        const inventory = inventoryFor(machine.machine_name);
        const models = inventory?.properties?.models ?? [];
        const inventoryStale = inventory && now - new Date(inventory.updated_at).getTime() > STALE_INVENTORY_MS;
        return (
          <div key={machine.id} className="card mb-3">
            <div className="flex items-center justify-between" style={{ marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>
                {machine.machine_name}
                {!machine.active && <span className="text-sm text-dim"> (deactivated)</span>}
              </h3>
              <span className="text-sm text-dim">
                {machineAgents.length} agents{models.length > 0 ? ` · ${models.length} models` : ''}
              </span>
            </div>

            {machineAgents.length === 0 && (
              <p className="text-sm text-dim">No agents registered from this machine.</p>
            )}
            {machineAgents.map((a) => (
              <div key={a.id} className="flex items-center" style={{ gap: 8, padding: '0.3rem 0', flexWrap: 'wrap' }}>
                <StatusDot lastSeen={a.last_seen_at} now={now} />
                <strong style={{ opacity: a.active ? 1 : 0.5 }}>{a.name}</strong>
                {a.metadata?.card?.harness && (
                  <span className="text-sm text-dim">{a.metadata.card.harness}</span>
                )}
                <span className="text-sm text-dim">{timeAgo(a.last_seen_at, now)}</span>
                <CapChips card={a.metadata?.card} />
              </div>
            ))}

            {models.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <div className="text-sm text-dim" style={{ marginBottom: '0.25rem' }}>
                  Models{' '}
                  <span title={inventory!.updated_at}>
                    (inventory {timeAgo(inventory!.updated_at, now)}{inventoryStale ? ' — stale, machine may be asleep' : ''})
                  </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="text-dim" style={{ textAlign: 'left' }}>
                        <th style={{ padding: '2px 8px 2px 0' }}>model</th>
                        <th style={{ padding: '2px 8px' }}>kind</th>
                        <th style={{ padding: '2px 8px' }}>size</th>
                        <th style={{ padding: '2px 8px' }}>quant</th>
                        <th style={{ padding: '2px 8px' }}>backend</th>
                        <th style={{ padding: '2px 8px' }}>endpoint</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((mo) => (
                        <tr key={mo.capability}>
                          <td style={{ padding: '2px 8px 2px 0' }}><code>{mo.name}</code></td>
                          <td style={{ padding: '2px 8px' }}>{mo.kind}</td>
                          <td style={{ padding: '2px 8px' }}>{mo.size_bytes ? formatSize(mo.size_bytes) : '—'}</td>
                          <td style={{ padding: '2px 8px' }}>{mo.quantization ?? '—'}</td>
                          <td style={{ padding: '2px 8px' }}>{mo.backend} ({mo.location})</td>
                          <td style={{ padding: '2px 8px' }}><code style={{ fontSize: '0.75rem' }}>{mo.endpoint}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {unattached.length > 0 && (
        <div className="card mb-3">
          <div className="flex items-center justify-between" style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0 }}>No machine</h3>
            <span className="text-sm text-dim">{unattached.length} agents</span>
          </div>
          <p className="text-sm text-dim" style={{ marginBottom: '0.5rem' }}>
            Connector identities (claude.ai) and dashboard-created agents — not bound to a machine key.
          </p>
          {unattached.map((a) => (
            <div key={a.id} className="flex items-center" style={{ gap: 8, padding: '0.3rem 0', flexWrap: 'wrap' }}>
              <StatusDot lastSeen={a.last_seen_at} now={now} />
              <strong style={{ opacity: a.active ? 1 : 0.5 }}>{a.name}</strong>
              <span className="text-sm text-dim">{timeAgo(a.last_seen_at, now)}</span>
              <CapChips card={a.metadata?.card} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
