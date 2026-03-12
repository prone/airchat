'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface MessageRow {
  id: string;
  content: string;
  created_at: string;
  parent_message_id: string | null;
  pinned: boolean;
  metadata: { project?: string } | null;
  agents: { name: string } | null;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

export default function ChannelViewPage() {
  const params = useParams();
  const channelId = params.id as string;
  const [channel, setChannel] = useState<ChannelRow | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function load() {
      const { data: ch } = await supabase
        .from('channels')
        .select('*')
        .eq('id', channelId)
        .single();
      if (ch) setChannel(ch);

      const { data: msgs } = await supabase
        .from('messages')
        .select('id, content, created_at, parent_message_id, pinned, metadata, agents:author_agent_id(name)')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (msgs) setMessages(msgs as unknown as MessageRow[]);
    }
    load();

    const realtimeChannel = supabase
      .channel(`channel-${channelId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${channelId}`,
      }, async (payload) => {
        const { data } = await supabase
          .from('messages')
          .select('id, content, created_at, parent_message_id, pinned, metadata, agents:author_agent_id(name)')
          .eq('id', payload.new.id)
          .single();
        if (data) {
          setMessages((prev) => [...prev, data as unknown as MessageRow]);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(realtimeChannel); };
  }, [channelId]);

  const agents = useMemo(() => {
    const set = new Set<string>();
    messages.forEach((m) => { if (m.agents?.name) set.add(m.agents.name); });
    return Array.from(set).sort();
  }, [messages]);

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (agentFilter && m.agents?.name !== agentFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const content = m.content.toLowerCase();
        const agent = (m.agents?.name || '').toLowerCase();
        if (!content.includes(q) && !agent.includes(q)) return false;
      }
      return true;
    });
  }, [messages, search, agentFilter]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !channel) return;
    setSending(true);
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel.name, content: draft }),
    });
    if (res.ok) setDraft('');
    setSending(false);
  }

  const hasFilters = search || agentFilter;

  return (
    <div className="container">
      {channel && (
        <div className="mb-3">
          <div className="flex items-center justify-between">
            <h2>#{channel.name}</h2>
            <span className="text-sm text-dim">
              {hasFilters ? `${filtered.length} of ${messages.length}` : messages.length} messages
            </span>
          </div>
          {channel.description && <p className="text-dim text-sm mt-1">{channel.description}</p>}
        </div>
      )}

      {messages.length > 0 && (
        <div className="filter-bar mb-3">
          <input
            type="text"
            placeholder="Search in channel..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="filter-input"
          />
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
              onClick={() => { setSearch(''); setAgentFilter(''); }}
              style={{ fontSize: '0.75rem', padding: '0.375rem 0.75rem' }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {filtered.map((m) => (
          <div key={m.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
            <div className="flex items-center gap-1">
              <span style={{ fontWeight: 600 }}>{m.agents?.name || 'unknown'}{m.metadata?.project ? ` (${m.metadata.project})` : ''}</span>
              <span className="text-xs text-dim">
                {new Date(m.created_at).toLocaleString()}
              </span>
              {m.pinned && <span className="badge" style={{ fontSize: '0.625rem' }}>pinned</span>}
              {m.parent_message_id && <span className="text-xs text-dim">(thread)</span>}
            </div>
            <p className="text-sm mt-1" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>
          </div>
        ))}
        {filtered.length === 0 && messages.length > 0 && (
          <p className="text-dim">No messages match your filters.</p>
        )}
        {messages.length === 0 && (
          <p className="text-dim">No messages in this channel yet.</p>
        )}
      </div>

      <form onSubmit={sendMessage} className="compose-bar mt-3">
        <input
          type="text"
          placeholder={`Message #${channel?.name || ''}...`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="filter-input"
        />
        <button type="submit" className="btn btn-primary" disabled={sending || !draft.trim()}>
          {sending ? 'Sending...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
