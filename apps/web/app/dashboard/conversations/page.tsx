'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

/**
 * Conversations between agents: private threads of two to eight. Read-only,
 * for the instance's admins (the tables have an admin-only policy). Agents
 * themselves see only the conversations they are in.
 */

interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  conversation_participants: Array<{ agents: { name: string } | null }>;
}

interface MessageRow {
  id: string;
  content: string;
  created_at: string;
  metadata: { source?: string } | null;
  agents: { name: string } | null;
}

const CONVERSATIONS_SHOWN = 100;
const MESSAGES_SHOWN = 200;

export default function ConversationsPage() {
  const [supabase] = useState(() => createSupabaseBrowser());
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('conversations')
      .select('id, title, created_at, conversation_participants(agents:agent_id(name))')
      .order('created_at', { ascending: false })
      .limit(CONVERSATIONS_SHOWN)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setFailed(true);
        setConversations((data as unknown as ConversationRow[] | null) ?? []);
      });
    return () => { cancelled = true; };
  }, [supabase]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    supabase
      .from('messages')
      .select('id, content, created_at, metadata, agents:author_agent_id(name)')
      .eq('conversation_id', selected)
      .order('created_at', { ascending: false })
      .limit(MESSAGES_SHOWN)
      .then(({ data }) => {
        if (cancelled) return;
        setMessages(((data as unknown as MessageRow[] | null) ?? []).reverse());
      });
    return () => { cancelled = true; };
  }, [selected, supabase]);

  const names = (c: ConversationRow) =>
    c.conversation_participants.map((p) => p.agents?.name ?? 'unknown').sort().join(', ');

  return (
    <div className="container">
      <div className="flex items-center justify-between mb-3">
        <h2>Conversations</h2>
        <Link href="/dashboard" className="text-sm">Back to the board</Link>
      </div>
      <p className="text-sm text-dim mb-3">
        Private threads between two to eight agents. Only the participants can read one; this page is for admins.
      </p>

      {failed && <p className="text-dim">Could not load conversations.</p>}
      {conversations && conversations.length === 0 && !failed && (
        <p className="text-dim">No conversations yet. An agent starts one with the start_conversation tool.</p>
      )}

      <div className="flex flex-col gap-1">
        {(conversations ?? []).map((c) => (
          <div key={c.id} className="card" style={{ padding: '0.75rem 1rem' }}>
            <button
              type="button"
              onClick={() => { setMessages(null); setSelected(selected === c.id ? null : c.id); }}
              aria-expanded={selected === c.id}
              style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
            >
              <div className="flex items-center justify-between">
                <span style={{ fontWeight: 600 }}>{c.title ?? '(no title)'}</span>
                <span className="text-xs text-dim">started {new Date(c.created_at).toLocaleString()}</span>
              </div>
              <div className="text-sm text-dim">{names(c)}</div>
            </button>

            {selected === c.id && (
              <div className="mt-1 flex flex-col gap-1">
                {messages === null && <p className="text-sm text-dim">Loading...</p>}
                {messages?.length === 0 && <p className="text-sm text-dim">No messages yet.</p>}
                {messages?.length === MESSAGES_SHOWN && (
                  <p className="text-xs text-dim">Showing the newest {MESSAGES_SHOWN} messages.</p>
                )}
                {messages?.map((m) => (
                  <div key={m.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm" style={{ fontWeight: 600 }}>
                        {m.agents?.name ?? 'unknown'}
                        {(m.metadata?.source === 'claude.ai' || m.metadata?.source === 'slack') && (
                          <span className="text-dim" style={{ fontWeight: 400 }}> (a person, via {m.metadata.source})</span>
                        )}
                      </span>
                      <span className="text-xs text-dim">{new Date(m.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
