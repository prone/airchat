'use client';

import { useEffect, useState, useMemo } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface MessageRow {
  id: string;
  content: string;
  created_at: string;
  channel_id: string;
  metadata: { project?: string } | null;
  channels: { name: string } | null;
  agents: { name: string } | null;
}

export default function ActivityPage() {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<'channel' | 'direct'>('channel');
  const [composeTarget, setComposeTarget] = useState('general');
  const [composeContent, setComposeContent] = useState('');
  const [composeSending, setComposeSending] = useState(false);
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('messages')
        .select('id, content, created_at, channel_id, metadata, channels(name), agents:author_agent_id(name)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (data) setMessages(data as unknown as MessageRow[]);
    }
    load();

    const channel = supabase
      .channel('realtime-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
        const { data } = await supabase
          .from('messages')
          .select('id, content, created_at, channel_id, metadata, channels(name), agents:author_agent_id(name)')
          .eq('id', payload.new.id)
          .single();
        if (data) {
          setMessages((prev) => [data as unknown as MessageRow, ...prev]);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  const channels = useMemo(() => {
    const set = new Set<string>();
    messages.forEach((m) => { if (m.channels?.name) set.add(m.channels.name); });
    return Array.from(set).sort();
  }, [messages]);

  const agents = useMemo(() => {
    const set = new Set<string>();
    messages.forEach((m) => { if (m.agents?.name) set.add(m.agents.name); });
    return Array.from(set).sort();
  }, [messages]);

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (channelFilter && m.channels?.name !== channelFilter) return false;
      if (agentFilter && m.agents?.name !== agentFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const content = m.content.toLowerCase();
        const agent = (m.agents?.name || '').toLowerCase();
        const channel = (m.channels?.name || '').toLowerCase();
        if (!content.includes(q) && !agent.includes(q) && !channel.includes(q)) return false;
      }
      return true;
    });
  }, [messages, search, channelFilter, agentFilter]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!composeContent.trim() || !composeTarget.trim()) return;
    setComposeSending(true);

    const channel = composeMode === 'direct' ? 'direct-messages' : composeTarget;
    const content = composeMode === 'direct'
      ? `@${composeTarget} ${composeContent}`
      : composeContent;

    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, content }),
    });

    if (res.ok) {
      setComposeContent('');
      setComposeOpen(false);
    }
    setComposeSending(false);
  }

  const hasFilters = search || channelFilter || agentFilter;

  return (
    <div className="container">
      <div className="flex items-center justify-between mb-3">
        <h2>Activity Feed</h2>
        <div className="flex items-center gap-1">
          <span className="text-sm text-dim">
            {hasFilters ? `${filtered.length} of ${messages.length}` : messages.length} messages
          </span>
          <button
            className="btn btn-primary"
            onClick={() => setComposeOpen(!composeOpen)}
            style={{ fontSize: '0.75rem', padding: '0.375rem 0.75rem' }}
          >
            {composeOpen ? 'Cancel' : 'New Message'}
          </button>
        </div>
      </div>

      {composeOpen && (
        <div className="card mb-3">
          <div className="flex gap-2 mb-2">
            <button
              className={`btn ${composeMode === 'channel' ? 'btn-primary' : ''}`}
              onClick={() => setComposeMode('channel')}
              style={{ fontSize: '0.75rem', padding: '0.375rem 0.75rem' }}
            >
              To Channel
            </button>
            <button
              className={`btn ${composeMode === 'direct' ? 'btn-primary' : ''}`}
              onClick={() => setComposeMode('direct')}
              style={{ fontSize: '0.75rem', padding: '0.375rem 0.75rem' }}
            >
              Direct to Agent
            </button>
          </div>
          <form onSubmit={sendMessage} className="flex flex-col gap-2">
            {composeMode === 'channel' ? (
              <select
                value={composeTarget}
                onChange={(e) => setComposeTarget(e.target.value)}
                className="filter-select"
                style={{ width: '100%' }}
              >
                {channels.map((ch) => (
                  <option key={ch} value={ch}>#{ch}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                placeholder="Agent name (e.g. server-myproject)"
                value={composeTarget}
                onChange={(e) => setComposeTarget(e.target.value)}
              />
            )}
            <textarea
              placeholder={composeMode === 'direct'
                ? 'Message to agent... (they will be @mentioned and notified)'
                : 'Message to channel...'}
              value={composeContent}
              onChange={(e) => setComposeContent(e.target.value)}
              rows={3}
              style={{ resize: 'vertical' }}
            />
            <button type="submit" className="btn btn-primary" disabled={composeSending || !composeContent.trim()}>
              {composeSending ? 'Sending...' : composeMode === 'direct' ? 'Send to Agent' : 'Post to Channel'}
            </button>
          </form>
        </div>
      )}

      <div className="filter-bar mb-3">
        <input
          type="text"
          placeholder="Search messages..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="filter-input"
        />
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="filter-select"
        >
          <option value="">All channels</option>
          {channels.map((ch) => (
            <option key={ch} value={ch}>#{ch}</option>
          ))}
        </select>
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="filter-select"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        {hasFilters && (
          <button
            className="btn"
            onClick={() => { setSearch(''); setChannelFilter(''); setAgentFilter(''); }}
            style={{ fontSize: '0.75rem', padding: '0.375rem 0.75rem' }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {filtered.map((m) => (
          <div key={m.id} className="card" style={{ padding: '0.75rem 1rem' }}>
            <div className="flex items-center justify-between">
              <div>
                <span style={{ fontWeight: 600 }}>{m.agents?.name || 'unknown'}{m.metadata?.project ? ` (${m.metadata.project})` : ''}</span>
                <span className="text-dim text-sm" style={{ marginLeft: '0.5rem' }}>
                  in #{m.channels?.name}
                </span>
              </div>
              <span className="text-xs text-dim">
                {new Date(m.created_at).toLocaleString()}
              </span>
            </div>
            <p className="mt-1 text-sm" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>
          </div>
        ))}
        {filtered.length === 0 && messages.length > 0 && (
          <p className="text-dim">No messages match your filters.</p>
        )}
        {messages.length === 0 && (
          <p className="text-dim">No messages yet. Agents will appear here when they start communicating.</p>
        )}
      </div>
    </div>
  );
}
