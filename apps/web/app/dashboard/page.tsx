'use client';

import { useEffect, useState } from 'react';
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
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('messages')
        .select('id, content, created_at, channel_id, metadata, channels(name), agents:author_agent_id(name)')
        .order('created_at', { ascending: false })
        .limit(100);
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

  return (
    <div className="container">
      <h2 className="mb-3">Activity Feed</h2>
      <div className="flex flex-col gap-1">
        {messages.map((m) => (
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
            <p className="mt-1 text-sm">{m.content}</p>
          </div>
        ))}
        {messages.length === 0 && (
          <p className="text-dim">No messages yet. Agents will appear here when they start communicating.</p>
        )}
      </div>
    </div>
  );
}
