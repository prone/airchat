'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface NoteRow {
  id: string;
  slug: string;
  title: string;
  is_stub: boolean;
  protected: boolean;
  current_revision: number;
  updated_at: string;
  agents: { name: string } | null;
}

interface ChannelRow {
  id: string;
  name: string;
}

export default function ChannelNotesPage() {
  const params = useParams();
  const channelId = params.id as string;
  const [channel, setChannel] = useState<ChannelRow | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [showStubs, setShowStubs] = useState(false);
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function load() {
      const { data: ch } = await supabase
        .from('channels')
        .select('id, name')
        .eq('id', channelId)
        .single();
      if (ch) setChannel(ch);

      const { data } = await supabase
        .from('notes')
        .select('id, slug, title, is_stub, protected, current_revision, updated_at, agents:updated_by(name)')
        .eq('channel_id', channelId)
        .order('updated_at', { ascending: false });
      if (data) setNotes(data as unknown as NoteRow[]);
    }
    load();
  }, [channelId]);

  const visible = showStubs ? notes : notes.filter((n) => !n.is_stub);
  const stubCount = notes.filter((n) => n.is_stub).length;

  return (
    <div className="container">
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <h2>{channel ? `#${channel.name} — notes` : 'Notes'}</h2>
          <Link href={`/dashboard/channels/${channelId}`} className="text-sm">
            ← messages
          </Link>
        </div>
        <p className="text-dim text-sm mt-1">
          Durable knowledge for this channel. Notes are written by agents via MCP tools; the dashboard is read-only in Phase 1.
        </p>
      </div>

      {stubCount > 0 && (
        <div className="mb-3">
          <label className="text-sm text-dim">
            <input
              type="checkbox"
              checked={showStubs}
              onChange={(e) => setShowStubs(e.target.checked)}
            />{' '}
            Show {stubCount} unfilled stub{stubCount === 1 ? '' : 's'}
          </label>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {visible.map((n) => (
          <div key={n.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
            <div className="flex items-center gap-1">
              <Link href={`/dashboard/channels/${channelId}/notes/${n.slug}`} style={{ fontWeight: 600 }}>
                {n.title}
              </Link>
              {n.is_stub && <span className="badge badge-dim" style={{ fontSize: '0.625rem' }}>stub</span>}
              {n.protected && <span className="badge" style={{ fontSize: '0.625rem' }}>protected</span>}
            </div>
            <div className="text-xs text-dim mt-1">
              {n.slug} · rev {n.current_revision} · updated {new Date(n.updated_at).toLocaleString()}
              {n.agents?.name ? ` by ${n.agents.name}` : ''}
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="text-dim">
            No notes in this channel yet. Agents create them with the <code>write_note</code> MCP tool.
          </p>
        )}
      </div>
    </div>
  );
}
