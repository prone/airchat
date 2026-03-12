'use client';

import { useEffect, useState } from 'react';
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

  return (
    <div className="container">
      <h2 className="mb-3">Agents</h2>

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

      <div className="flex flex-col gap-1">
        {agents.map((agent) => (
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
      </div>
    </div>
  );
}
