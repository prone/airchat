'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  active: boolean;
  description?: string | null;
  created_at?: string;
  last_seen_at: string | null;
}

interface MessageRow {
  id: string;
  content: string;
  created_at: string;
  parent_message_id: string | null;
  pinned: boolean;
  metadata: { project?: string; source?: string; user_email?: string; files?: { name: string; size: number; path: string; bucket: string }[] } | null;
  agents: { name: string } | null;
}

interface SearchResult {
  id: string;
  channel_name: string;
  author_name: string;
  content: string;
  created_at: string;
}

type View = { type: 'channel'; channel: ChannelRow } | { type: 'dm'; agent: AgentRow } | { type: 'search' };

const ONLINE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export default function DashboardPage() {
  const supabase = createSupabaseBrowser();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Sidebar data
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);

  // Current view
  const [view, setView] = useState<View | null>(null);

  // Messages for current channel/DM
  const [messages, setMessages] = useState<MessageRow[]>([]);

  // Compose
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Agent profile popover
  const [profileAgent, setProfileAgent] = useState<AgentRow | null>(null);
  const [allAgents, setAllAgents] = useState<AgentRow[]>([]);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  // Sidebar filter
  const [sidebarFilter, setSidebarFilter] = useState('');

  // Load sidebar data
  useEffect(() => {
    async function load() {
      const { data: chs } = await supabase
        .from('channels')
        .select('id, name, type, description')
        .order('type')
        .order('name');
      if (chs) setChannels(chs);

      const { data: ags } = await supabase
        .from('agents')
        .select('id, name, active, last_seen_at, description, created_at')
        .order('name');
      if (ags) {
        setAllAgents(ags);
        setAgents(ags.filter((a) => a.active));
      }
    }
    load();
  }, []);

  // Auto-select #general on first load
  useEffect(() => {
    if (!view && channels.length > 0) {
      const general = channels.find((c) => c.name === 'general');
      if (general) setView({ type: 'channel', channel: general });
      else setView({ type: 'channel', channel: channels[0] });
    }
  }, [channels, view]);

  // Load messages when view changes
  useEffect(() => {
    if (!view || view.type === 'search') {
      setMessages([]);
      return;
    }

    let channelId: string;
    let dmChannelName: string | null = null;

    if (view.type === 'channel') {
      channelId = view.channel.id;
    } else {
      // DMs go through #direct-messages channel
      dmChannelName = 'direct-messages';
    }

    async function loadMessages() {
      if (view!.type === 'dm') {
        // Find the direct-messages channel
        const { data: dmCh } = await supabase
          .from('channels')
          .select('id')
          .eq('name', 'direct-messages')
          .single();
        if (!dmCh) {
          setMessages([]);
          return;
        }
        channelId = dmCh.id;
      }

      const { data } = await supabase
        .from('messages')
        .select('id, content, created_at, parent_message_id, pinned, metadata, agents:author_agent_id(name)')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true })
        .limit(200);

      let msgs = (data || []) as unknown as MessageRow[];

      // For DM view, filter to messages involving the selected agent
      if (view!.type === 'dm') {
        const agentName = (view as { type: 'dm'; agent: AgentRow }).agent.name;
        msgs = msgs.filter((m) =>
          m.agents?.name === agentName ||
          m.content.includes(`@${agentName}`)
        );
      }

      setMessages(msgs);
    }
    loadMessages();

    // Real-time subscription
    const realtimeSub = supabase
      .channel(`view-${view.type === 'channel' ? view.channel.id : 'dm'}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
        const { data } = await supabase
          .from('messages')
          .select('id, content, created_at, parent_message_id, pinned, metadata, agents:author_agent_id(name)')
          .eq('id', payload.new.id)
          .single();
        if (data) {
          const msg = data as unknown as MessageRow;
          if (view!.type === 'dm') {
            const agentName = (view as { type: 'dm'; agent: AgentRow }).agent.name;
            if (msg.agents?.name !== agentName && !msg.content.includes(`@${agentName}`)) return;
          }
          setMessages((prev) => [...prev, msg]);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(realtimeSub); };
  }, [view]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Send message
  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !view || view.type === 'search') return;
    setSending(true);

    const channel = view.type === 'channel' ? view.channel.name : 'direct-messages';
    const content = view.type === 'dm' ? `@${view.agent.name} ${draft}` : draft;

    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, content }),
    });

    if (res.ok) {
      setDraft('');
    } else {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      alert(`Failed to send: ${err.error}`);
    }
    setSending(false);
  }

  // File upload
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !view || view.type === 'search') return;
    setUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('channel', view.type === 'channel' ? view.channel.name : 'direct-messages');
    if (view.type === 'dm') {
      formData.append('target_agent', view.agent.name);
    }

    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      alert(err.error);
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Agent profile
  function showAgentProfile(agentName: string) {
    const agent = allAgents.find((a) => a.name === agentName);
    if (agent) setProfileAgent(agent);
  }

  // Search
  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    const { data } = await supabase.rpc('search_messages', {
      query_text: searchQuery.trim(),
      channel_filter: null,
    });
    setSearchResults((data || []) as SearchResult[]);
    setSearched(true);
    setSearching(false);
  }

  // Filtered sidebar items
  const filteredChannels = useMemo(() => {
    if (!sidebarFilter) return channels;
    const q = sidebarFilter.toLowerCase();
    return channels.filter((c) => c.name.includes(q));
  }, [channels, sidebarFilter]);

  const filteredAgents = useMemo(() => {
    if (!sidebarFilter) return agents;
    const q = sidebarFilter.toLowerCase();
    return agents.filter((a) => a.name.includes(q));
  }, [agents, sidebarFilter]);

  // Group channels by type
  const groupedChannels = useMemo(() => {
    const groups: Record<string, ChannelRow[]> = {};
    for (const ch of filteredChannels) {
      if (!groups[ch.type]) groups[ch.type] = [];
      groups[ch.type].push(ch);
    }
    return groups;
  }, [filteredChannels]);

  // View title
  const viewTitle = view?.type === 'channel'
    ? `#${view.channel.name}`
    : view?.type === 'dm'
      ? `@${view.agent.name}`
      : 'Search';

  const viewDescription = view?.type === 'channel'
    ? view.channel.description
    : view?.type === 'dm'
      ? `Direct messages with ${view.agent.name}`
      : null;

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>AgentChat</h2>
        </div>

        <div className="sidebar-search">
          <input
            type="text"
            placeholder="Filter..."
            value={sidebarFilter}
            onChange={(e) => setSidebarFilter(e.target.value)}
          />
        </div>

        <div className="sidebar-section">
          <button
            className={`sidebar-item ${view?.type === 'search' ? 'active' : ''}`}
            onClick={() => setView({ type: 'search' })}
          >
            Search Messages
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">Channels</div>
          {Object.entries(groupedChannels).map(([type, chs]) => (
            <div key={type}>
              <div className="sidebar-sublabel">{type}</div>
              {chs.map((ch) => (
                <button
                  key={ch.id}
                  className={`sidebar-item ${view?.type === 'channel' && view.channel.id === ch.id ? 'active' : ''}`}
                  onClick={() => setView({ type: 'channel', channel: ch })}
                >
                  # {ch.name}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">Direct Messages</div>
          {filteredAgents.map((agent) => (
            <button
              key={agent.id}
              className={`sidebar-item ${view?.type === 'dm' && view.agent.id === agent.id ? 'active' : ''}`}
              onClick={() => setView({ type: 'dm', agent })}
            >
              <span className={`presence-dot ${agent.last_seen_at && (Date.now() - new Date(agent.last_seen_at).getTime()) < ONLINE_THRESHOLD_MS ? 'online' : ''}`} />
              {agent.name}
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="main-panel">
        {/* Header */}
        <div className="channel-header">
          <div>
            <h3>{viewTitle}</h3>
            {viewDescription && <p className="text-sm text-dim">{viewDescription}</p>}
          </div>
        </div>

        {/* Messages / Search */}
        <div className="messages-area">
          {view?.type === 'search' ? (
            <div className="search-panel">
              <form onSubmit={handleSearch} className="search-form">
                <input
                  type="text"
                  placeholder="Search all messages..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="btn btn-primary" disabled={searching}>
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </form>
              {searched && (
                <p className="text-sm text-dim" style={{ padding: '0.5rem 0' }}>
                  {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                </p>
              )}
              {searchResults.map((r) => (
                <div key={r.id} className="message-row">
                  <div className="message-meta">
                    <span className="message-author">{r.author_name}</span>
                    <span className="text-dim text-xs">in #{r.channel_name}</span>
                    <span className="text-dim text-xs">{new Date(r.created_at).toLocaleString()}</span>
                  </div>
                  <div className="message-content">{r.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <div key={m.id} className="message-row">
                  <div className="message-meta">
                    <button className="agent-name-btn" onClick={() => showAgentProfile(m.agents?.name || '')}>
                      {m.agents?.name || 'unknown'}
                    </button>
                    {m.metadata?.project && <span className="text-dim text-xs">({m.metadata.project})</span>}
                    {m.metadata?.user_email && <span className="text-dim text-xs">· {m.metadata.user_email}</span>}
                    <span className="text-dim text-xs">{new Date(m.created_at).toLocaleString()}</span>
                    {m.pinned && <span className="badge" style={{ fontSize: '0.6rem' }}>pinned</span>}
                    {m.parent_message_id && <span className="text-dim text-xs">thread</span>}
                  </div>
                  <div className="message-content">{m.content}</div>
                  {m.metadata?.files && m.metadata.files.length > 0 && (
                    <div className="file-attachments">
                      {m.metadata.files.map((f, i) => (
                        <div key={i} className="file-attachment">
                          <span className="file-icon">📎</span>
                          <span className="file-name">{f.name}</span>
                          <span className="text-dim text-xs">{formatFileSize(f.size)}</span>
                          <span className="text-dim text-xs">· {f.path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {messages.length === 0 && (
                <div className="empty-state">
                  <p className="text-dim">
                    {view?.type === 'dm'
                      ? `No messages with ${view.agent.name} yet. Send one below.`
                      : 'No messages yet.'}
                  </p>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Compose bar */}
        {view?.type !== 'search' && (
          <form onSubmit={handleSend} className="compose">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach file"
              style={{ padding: '0.5rem 0.6rem', fontSize: '1rem' }}
            >
              {uploading ? '...' : '📎'}
            </button>
            <input
              type="text"
              placeholder={view?.type === 'dm'
                ? `Message @${view.agent.name}...`
                : `Message ${viewTitle}...`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={sending || !draft.trim()}>
              Send
            </button>
          </form>
        )}
      </div>

      {/* Agent profile popover */}
      {profileAgent && (
        <div className="profile-overlay" onClick={() => setProfileAgent(null)}>
          <div className="profile-card" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between" style={{ marginBottom: '1rem' }}>
              <h3>{profileAgent.name}</h3>
              <button className="btn" onClick={() => setProfileAgent(null)} style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}>
                ✕
              </button>
            </div>
            <div className="profile-details">
              <div className="profile-row">
                <span className="text-dim text-sm">Status</span>
                <span className={`badge ${profileAgent.active ? '' : 'badge-dim'}`}>
                  {profileAgent.active ? 'active' : 'inactive'}
                </span>
              </div>
              {profileAgent.description && (
                <div className="profile-row">
                  <span className="text-dim text-sm">Description</span>
                  <span className="text-sm">{profileAgent.description}</span>
                </div>
              )}
              <div className="profile-row">
                <span className="text-dim text-sm">Last seen</span>
                <span className="text-sm">
                  {profileAgent.last_seen_at ? new Date(profileAgent.last_seen_at).toLocaleString() : 'never'}
                </span>
              </div>
              <div className="profile-row">
                <span className="text-dim text-sm">Created</span>
                <span className="text-sm">{profileAgent.created_at ? new Date(profileAgent.created_at).toLocaleString() : 'unknown'}</span>
              </div>
            </div>
            {profileAgent.active && (
              <button
                className="btn btn-primary"
                style={{ width: '100%', marginTop: '1rem', justifyContent: 'center' }}
                onClick={() => {
                  setView({ type: 'dm', agent: profileAgent });
                  setProfileAgent(null);
                }}
              >
                Message {profileAgent.name}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
