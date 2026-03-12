'use client';

import { useEffect, useState, useMemo } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  created_at: string;
  last_seen_at: string | null;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [generatedKey, setGeneratedKey] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'inactive'>('');
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    const { data } = await supabase
      .from('agents')
      .select('id, name, description, active, created_at, last_seen_at')
      .order('created_at');
    if (data) setAgents(data);
  }

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setGeneratedKey('');

    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });

    const result = await res.json();
    if (result.error) {
      alert(result.error);
    } else {
      setGeneratedKey(result.apiKey);
      setName('');
      setDescription('');
      loadAgents();
    }
    setCreating(false);
  }

  async function toggleAgent(id: string, active: boolean) {
    await supabase.from('agents').update({ active: !active }).eq('id', id);
    loadAgents();
  }

  const filtered = useMemo(() => {
    return agents.filter((a) => {
      if (statusFilter === 'active' && !a.active) return false;
      if (statusFilter === 'inactive' && a.active) return false;
      if (search) {
        const q = search.toLowerCase();
        const n = a.name.toLowerCase();
        const d = (a.description || '').toLowerCase();
        if (!n.includes(q) && !d.includes(q)) return false;
      }
      return true;
    });
  }, [agents, search, statusFilter]);

  const hasFilters = search || statusFilter;

  return (
    <div className="container">
      <div className="flex items-center justify-between mb-3">
        <h2>Agents</h2>
        <span className="text-sm text-dim">
          {hasFilters ? `${filtered.length} of ${agents.length}` : agents.length} agents
        </span>
      </div>

      <div className="card mb-3">
        <h3 style={{ marginBottom: '1rem' }}>Create Agent</h3>
        <form onSubmit={createAgent} className="flex flex-col gap-2">
          <input placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Creating...' : 'Create Agent'}
          </button>
        </form>
        {generatedKey && (
          <div className="mt-2 card" style={{ background: 'var(--bg)', border: '2px solid var(--success)' }}>
            <p className="text-sm" style={{ marginBottom: '0.5rem', color: 'var(--success)' }}>
              API Key (save now — shown only once):
            </p>
            <code style={{ wordBreak: 'break-all', fontSize: '0.8rem' }}>{generatedKey}</code>
          </div>
        )}
      </div>

      <div className="filter-bar mb-3">
        <input
          type="text"
          placeholder="Search agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="filter-input"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as '' | 'active' | 'inactive')}
          className="filter-select"
        >
          <option value="">All status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {hasFilters && (
          <button
            className="btn"
            onClick={() => { setSearch(''); setStatusFilter(''); }}
            style={{ fontSize: '0.75rem', padding: '0.375rem 0.75rem' }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {filtered.map((agent) => (
          <div key={agent.id} className="card flex items-center justify-between" style={{ padding: '0.75rem 1rem' }}>
            <div>
              <div className="flex items-center gap-1">
                <span style={{ fontWeight: 600 }}>{agent.name}</span>
                <span className={`badge ${agent.active ? '' : 'badge-dim'}`}>
                  {agent.active ? 'active' : 'inactive'}
                </span>
              </div>
              {agent.description && <p className="text-sm text-dim mt-1">{agent.description}</p>}
              <p className="text-xs text-dim mt-1">
                Last seen: {agent.last_seen_at ? new Date(agent.last_seen_at).toLocaleString() : 'never'}
              </p>
            </div>
            <button
              className={`btn ${agent.active ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => toggleAgent(agent.id, agent.active)}
              style={{ fontSize: '0.75rem' }}
            >
              {agent.active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        ))}
        {filtered.length === 0 && agents.length > 0 && (
          <p className="text-dim">No agents match your filters.</p>
        )}
      </div>
    </div>
  );
}
