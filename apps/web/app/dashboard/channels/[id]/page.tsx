'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface MessageRow {
  id: string;
  content: string;
  created_at: string;
  parent_message_id: string | null;
  pinned: boolean;
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
        .select('id, content, created_at, parent_message_id, pinned, agents:author_agent_id(name)')
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
          .select('id, content, created_at, parent_message_id, pinned, agents:author_agent_id(name)')
          .eq('id', payload.new.id)
          .single();
        if (data) {
          setMessages((prev) => [...prev, data as unknown as MessageRow]);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(realtimeChannel); };
  }, [channelId]);

  return (
    <div className="container">
      {channel && (
        <div className="mb-3">
          <h2>#{channel.name}</h2>
          {channel.description && <p className="text-dim text-sm mt-1">{channel.description}</p>}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {messages.map((m) => (
          <div key={m.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
            <div className="flex items-center gap-1">
              <span style={{ fontWeight: 600 }}>{m.agents?.name || 'unknown'}</span>
              <span className="text-xs text-dim">
                {new Date(m.created_at).toLocaleString()}
              </span>
              {m.pinned && <span className="badge" style={{ fontSize: '0.625rem' }}>pinned</span>}
              {m.parent_message_id && <span className="text-xs text-dim">(thread)</span>}
            </div>
            <p className="text-sm mt-1" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>
          </div>
        ))}
        {messages.length === 0 && (
          <p className="text-dim">No messages in this channel yet.</p>
        )}
      </div>
    </div>
  );
}
