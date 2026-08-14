'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { formatSize, marginalCostUsd, totalTokens } from '@airchat/shared';
import type { BillingPlan, ModelPrice, TokenCounts, UsageSource } from '@airchat/shared';
import { formatTokens, formatUsd } from '@/components/viz/viz';
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
  plan?: BillingPlan;
}

interface AgentRow {
  id: string;
  name: string;
  active: boolean;
  description: string | null;
  created_at: string;
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

/** One row of agent_usage_rollup(p_days) — per (agent, day, model, source). */
interface RollupRow extends TokenCounts {
  agent_id: string;
  day: string;
  model: string;
  source: UsageSource;
}

interface UsageBreakdownRow extends TokenCounts {
  model: string;
  source: UsageSource;
  est: number | null;
}

/** Per-agent aggregate for the chips + expanded breakdown. All estimates. */
interface AgentUsage {
  tokensToday: number;
  tokens7d: number;
  /** Sum of priced rows; null when no row could be priced (unknown ≠ free). */
  cost7d: number | null;
  breakdown: UsageBreakdownRow[];
}

const ONLINE_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_INVENTORY_MS = 2 * 60 * 60 * 1000;
/** "Recently active" for the default fleet view: one-off session agents and
 *  test residue age out of sight after a day; the toggles bring them back. */
const RECENT_AGENT_MS = 24 * 60 * 60 * 1000;

/** recent = seen in the last 24h and not deactivated (the default view);
 *  inactive = has been seen at some point but is stale or deactivated;
 *  never = registered but never authenticated (mostly test residue). */
type AgentTier = 'recent' | 'inactive' | 'never';

function agentTier(a: { active: boolean; last_seen_at: string | null }, now: number): AgentTier {
  if (a.last_seen_at === null) return 'never';
  if (a.active && now - new Date(a.last_seen_at).getTime() < RECENT_AGENT_MS) return 'recent';
  return 'inactive';
}

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

function AgentLine({ a, now, expanded, onToggle, activeCap, onSelectCap, usage }: {
  a: AgentRow; now: number; expanded: boolean; onToggle: () => void;
  activeCap: string | null; onSelectCap: (cap: string) => void;
  usage?: AgentUsage;
}) {
  const online = a.last_seen_at !== null && now - new Date(a.last_seen_at).getTime() < ONLINE_THRESHOLD_MS;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="flex items-center"
        style={{ gap: 8, padding: '0.3rem 0', flexWrap: 'wrap', cursor: 'pointer' }}
        title={expanded ? undefined : 'click for details'}
      >
        <StatusDot lastSeen={a.last_seen_at} now={now} />
        <strong style={{ opacity: a.active ? 1 : 0.5 }}>{a.name}</strong>
        {!a.active && <span className="text-sm text-dim">deactivated</span>}
        {a.metadata?.card?.harness && (
          <span className="text-sm text-dim" title="harness — the runtime this agent reported it runs in (claude-code, opencode, python-sdk, …)">
            {a.metadata.card.harness}
          </span>
        )}
        <span className="text-sm text-dim">{a.last_seen_at ? timeAgo(a.last_seen_at, now) : 'never seen'}</span>
        {usage && usage.tokens7d > 0 && (
          <span className="text-sm text-dim" title="estimated token usage and marginal cost over the last 7 days">
            {formatTokens(usage.tokens7d)} tok{usage.cost7d !== null ? ` · ${formatUsd(usage.cost7d)}` : ''} (7d)
          </span>
        )}
        <CapChips card={a.metadata?.card} activeCap={activeCap} onSelect={onSelectCap} />
      </div>
      {expanded && (
        <div
          className="text-sm"
          style={{
            margin: '0 0 0.5rem 14px', padding: '0.5rem 0.75rem',
            background: 'var(--bg)', borderRadius: 6,
            display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px',
          }}
        >
          <span className="text-dim">status</span>
          <span>
            {!a.active
              ? 'deactivated — will not authenticate or appear in find_agents'
              : a.last_seen_at === null
                ? 'registered but never authenticated — usually residue from tests or an aborted setup'
                : online ? 'online (seen in the last 10 minutes)' : 'idle'}
          </span>
          <span className="text-dim">last seen</span>
          <span>{a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : 'never'}</span>
          <span className="text-dim">registered</span>
          <span>{new Date(a.created_at).toLocaleString()}</span>
          {a.description && (<><span className="text-dim">description</span><span>{a.description}</span></>)}
          {a.metadata?.card?.harness && (
            <><span className="text-dim">harness</span><span>{a.metadata.card.harness} — the runtime the agent reported it runs in</span></>
          )}
          {a.metadata?.card?.model && (<><span className="text-dim">model</span><span>{a.metadata.card.model}</span></>)}
          {a.metadata?.card?.plan && (
            <><span className="text-dim">plan</span><span>{a.metadata.card.plan}{a.metadata.card.plan !== 'api' ? ' — $0 marginal token cost' : ''}</span></>
          )}
          <span className="text-dim">id</span>
          <span><code style={{ fontSize: '0.75rem' }}>{a.id}</code></span>
          {usage && usage.breakdown.length > 0 && (
            <>
              <span className="text-dim">usage (7d)</span>
              <span>
                {formatTokens(usage.tokensToday)} tok today · {formatTokens(usage.tokens7d)} tok 7d
                {usage.cost7d !== null ? ` · ${formatUsd(usage.cost7d)}` : ''} — estimated
              </span>
              <div style={{ gridColumn: '1 / -1', overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr className="text-dim" style={{ textAlign: 'left' }}>
                      <th style={{ padding: '2px 8px 2px 0' }}>model</th>
                      <th style={{ padding: '2px 8px' }}>source</th>
                      <th style={{ padding: '2px 8px' }}>input</th>
                      <th style={{ padding: '2px 8px' }}>output</th>
                      <th style={{ padding: '2px 8px' }}>cache r/w</th>
                      <th style={{ padding: '2px 8px', textAlign: 'right' }}>est $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.breakdown.map((row) => (
                      <tr key={`${row.model} ${row.source}`}>
                        <td style={{ padding: '2px 8px 2px 0' }}><code style={{ fontSize: '0.7rem' }}>{row.model}</code></td>
                        <td style={{ padding: '2px 8px' }}>{row.source}</td>
                        <td style={{ padding: '2px 8px', fontVariantNumeric: 'tabular-nums' }}>{formatTokens(row.input_tokens)}</td>
                        <td style={{ padding: '2px 8px', fontVariantNumeric: 'tabular-nums' }}>{formatTokens(row.output_tokens)}</td>
                        <td style={{ padding: '2px 8px', fontVariantNumeric: 'tabular-nums' }}>{formatTokens(row.cache_read_tokens)} / {formatTokens(row.cache_creation_tokens)}</td>
                        <td style={{ padding: '2px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.est === null ? '—' : formatUsd(row.est)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CapChips({ card, activeCap, onSelect }: {
  card?: AgentCard; activeCap?: string | null; onSelect?: (cap: string) => void;
}) {
  if (!card?.capabilities?.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {card.capabilities.map((c) => (
        <code
          key={c}
          className="text-sm"
          title={onSelect ? 'filter fleet by this capability' : undefined}
          onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(c); } : undefined}
          style={{
            padding: '0 4px', borderRadius: 4, fontSize: '0.7rem',
            background: c === activeCap ? 'var(--accent)' : 'var(--bg)',
            cursor: onSelect ? 'pointer' : undefined,
          }}
        >
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
  const [rollup, setRollup] = useState<RollupRow[]>([]);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [showNever, setShowNever] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [capFilter, setCapFilter] = useState<string | null>(null);
  const now = useNow();
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function load() {
      const [m, a, n, u, p] = await Promise.all([
        supabase.from('machine_keys').select('id, machine_name, active, created_at').order('machine_name'),
        supabase.from('agents').select('id, name, active, description, created_at, last_seen_at, machine_id, metadata').order('last_seen_at', { ascending: false, nullsFirst: false }),
        supabase.from('notes').select('slug, updated_at, properties').contains('properties', { type: 'model-inventory' }),
        // Both admin-gated server-side; on error the usage chips just don't render.
        supabase.rpc('agent_usage_rollup', { p_days: 7 }),
        supabase.from('model_prices').select('*'),
      ]);
      if (m.data) setMachines(m.data);
      if (a.data) setAgents(a.data);
      if (n.data) setInventories(n.data);
      if (u.data) setRollup(u.data as RollupRow[]);
      if (p.data) setPrices(p.data as ModelPrice[]);
      setLoaded(true);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Per-agent usage aggregates from the rollup: today / 7d totals, and a
   *  model×source breakdown priced by the agent's card plan. All estimates. */
  const usageByAgent = useMemo(() => {
    const priceMap = new Map<string, ModelPrice>(prices.map((p) => [p.model, p]));
    const planById = new Map<string, BillingPlan | undefined>(
      agents.map((a) => [a.id, a.metadata?.card?.plan]),
    );
    const today = new Date().toISOString().slice(0, 10);
    const map = new Map<string, AgentUsage>();
    for (const r of rollup) {
      let agg = map.get(r.agent_id);
      if (!agg) {
        agg = { tokensToday: 0, tokens7d: 0, cost7d: null, breakdown: [] };
        map.set(r.agent_id, agg);
      }
      const total = totalTokens(r);
      agg.tokens7d += total;
      if (r.day === today) agg.tokensToday += total;
      const row = agg.breakdown.find((b) => b.model === r.model && b.source === r.source);
      if (row) {
        row.input_tokens += r.input_tokens;
        row.output_tokens += r.output_tokens;
        row.cache_read_tokens += r.cache_read_tokens;
        row.cache_creation_tokens += r.cache_creation_tokens;
      } else {
        agg.breakdown.push({
          model: r.model, source: r.source,
          input_tokens: r.input_tokens, output_tokens: r.output_tokens,
          cache_read_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
          est: null,
        });
      }
    }
    for (const [agentId, agg] of map) {
      const plan = planById.get(agentId);
      agg.breakdown.sort((a, b) => totalTokens(b) - totalTokens(a));
      for (const row of agg.breakdown) {
        row.est = marginalCostUsd(row, row.model, plan, priceMap);
        if (row.est !== null) agg.cost7d = (agg.cost7d ?? 0) + row.est;
      }
    }
    return map;
  }, [rollup, prices, agents]);

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

  const tierShown = (tier: AgentTier): boolean =>
    tier === 'recent' || (tier === 'inactive' && showInactive) || (tier === 'never' && showNever);

  /** A capability filter answers "who can run X?" — it searches every tier,
   *  so a stale-but-capable worker still turns up. */
  const agentShown = (a: AgentRow): boolean => {
    if (capFilter !== null) {
      return (a.metadata?.card?.capabilities ?? []).includes(capFilter) || a.metadata?.card?.model === capFilter;
    }
    return tierShown(agentTier(a, now));
  };

  /** Split a card's agents into what the current filters show, counting what they hide. */
  const splitByTier = (list: AgentRow[]): { shown: AgentRow[]; hidden: number } => {
    const shown = list.filter(agentShown);
    return { shown, hidden: list.length - shown.length };
  };

  const toggleCapFilter = (cap: string) => setCapFilter((cur) => (cur === cap ? null : cap));

  const counts = useMemo(() => {
    let inactive = 0;
    let never = 0;
    for (const a of agents) {
      const t = agentTier(a, now);
      if (t === 'inactive') inactive += 1;
      else if (t === 'never') never += 1;
    }
    return { inactive, never };
  }, [agents, now]);

  const totals = useMemo(() => ({
    machines: machines.length,
    agents: agents.filter(agentShown).length,
    online: agents.filter((a) => a.last_seen_at && now - new Date(a.last_seen_at).getTime() < ONLINE_THRESHOLD_MS).length,
    models: inventories.reduce((sum, n) => sum + (n.properties?.models?.length ?? 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [machines, agents, inventories, now, showInactive, showNever, capFilter]);

  const unattachedAll = byMachine.get(null) ?? [];
  const unattached = splitByTier(unattachedAll);

  return (
    <div className="container">
      <div className="flex items-center justify-between mb-3">
        <h2>Fleet</h2>
        <span className="text-sm text-dim" style={{ display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          {capFilter !== null && (
            <button
              onClick={() => setCapFilter(null)}
              title="Showing only agents advertising this model/capability, in any state. Click to clear."
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                background: 'var(--accent)', color: 'inherit', border: 'none',
                borderRadius: 4, padding: '1px 8px', font: 'inherit',
              }}
            >
              <code style={{ fontSize: '0.75rem', background: 'transparent' }}>{capFilter}</code> ✕
            </button>
          )}
          {capFilter === null && counts.inactive > 0 && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="Also show deactivated agents and agents not seen in 24 hours">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              show inactive ({counts.inactive})
            </label>
          )}
          {capFilter === null && counts.never > 0 && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="Also show agents that registered but never authenticated — usually test residue">
              <input
                type="checkbox"
                checked={showNever}
                onChange={(e) => setShowNever(e.target.checked)}
              />
              show never-seen ({counts.never})
            </label>
          )}
          <span>
            {totals.machines} machines · {totals.agents} agents ({totals.online} online) · {totals.models} models
          </span>
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
        const machineAll = byMachine.get(machine.id) ?? [];
        const { shown: machineAgents, hidden: machineHidden } = splitByTier(machineAll);
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
                {machineAgents.length} agents{machineHidden > 0 ? ` (${machineHidden} hidden)` : ''}{models.length > 0 ? ` · ${models.length} models` : ''}
              </span>
            </div>

            {machineAll.length === 0 && (
              <p className="text-sm text-dim">No agents registered from this machine.</p>
            )}
            {machineAll.length > 0 && machineAgents.length === 0 && (
              <p className="text-sm text-dim">
                {capFilter !== null
                  ? `No agents here advertise ${capFilter} — ${machineHidden} filtered out.`
                  : `No agents active in the last 24 hours — ${machineHidden} hidden by the filters above.`}
              </p>
            )}
            {machineAgents.map((a) => (
              <AgentLine
                key={a.id}
                a={a}
                now={now}
                expanded={expanded === a.id}
                onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                activeCap={capFilter}
                onSelectCap={toggleCapFilter}
                usage={usageByAgent.get(a.id)}
              />
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
                          <td style={{ padding: '2px 8px 2px 0' }}>
                            <code
                              title="filter fleet to agents serving this model"
                              onClick={() => toggleCapFilter(mo.capability)}
                              style={{ cursor: 'pointer', background: mo.capability === capFilter ? 'var(--accent)' : undefined, borderRadius: 4, padding: '0 4px' }}
                            >
                              {mo.name}
                            </code>
                          </td>
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

      {unattachedAll.length > 0 && (
        <div className="card mb-3">
          <div className="flex items-center justify-between" style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0 }}>No machine</h3>
            <span className="text-sm text-dim">
              {unattached.shown.length} agents{unattached.hidden > 0 ? ` (${unattached.hidden} hidden)` : ''}
            </span>
          </div>
          <p className="text-sm text-dim" style={{ marginBottom: '0.5rem' }}>
            Connector identities (claude.ai) and dashboard-created agents — not bound to a machine key.
          </p>
          {unattached.shown.length === 0 && (
            <p className="text-sm text-dim">
              {capFilter !== null
                ? `None advertise ${capFilter} — ${unattached.hidden} filtered out.`
                : `None active in the last 24 hours — ${unattached.hidden} hidden by the filters above.`}
            </p>
          )}
          {unattached.shown.map((a) => (
            <AgentLine
              key={a.id}
              a={a}
              now={now}
              expanded={expanded === a.id}
              onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
              activeCap={capFilter}
              onSelectCap={toggleCapFilter}
              usage={usageByAgent.get(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
