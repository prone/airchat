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
  updated_by_user_email: string | null;
  agents: { name: string } | null;
}

interface ChannelRow {
  id: string;
  name: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
}

export default function ChannelNotesPage() {
  const params = useParams();
  const channelId = params.id as string;
  const [channel, setChannel] = useState<ChannelRow | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [showStubs, setShowStubs] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const supabase = createSupabaseBrowser();

  // New-note form
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [newBody, setNewBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function load() {
    const { data: ch } = await supabase.from('channels').select('id, name').eq('id', channelId).single();
    if (ch) setChannel(ch);

    const { data } = await supabase
      .from('notes')
      .select('id, slug, title, is_stub, protected, current_revision, updated_at, updated_by_user_email, agents:updated_by(name)')
      .eq('channel_id', channelId)
      .order('updated_at', { ascending: false });
    if (data) setNotes(data as unknown as NoteRow[]);
  }

  useEffect(() => {
    load();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
      setIsAdmin(!!data);
    });
  }, [channelId]);

  async function createNote() {
    const slug = (slugTouched ? newSlug : slugify(newTitle)).trim();
    setCreateError(null);
    if (!newTitle.trim()) { setCreateError('Title is required.'); return; }
    if (!SLUG_RE.test(slug)) { setCreateError('Slug must be lowercase letters, numbers, and hyphens.'); return; }
    setSaving(true);
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, slug, title: newTitle, body_md: newBody, create: true }),
    });
    setSaving(false);
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Create failed' }));
      setCreateError(error ?? 'Create failed');
      return;
    }
    setCreating(false);
    setNewTitle(''); setNewSlug(''); setSlugTouched(false); setNewBody('');
    await load();
  }

  const visible = showStubs ? notes : notes.filter((n) => !n.is_stub);
  const stubCount = notes.filter((n) => n.is_stub).length;

  return (
    <div className="container">
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <h2>{channel ? `#${channel.name} — notes` : 'Notes'}</h2>
          <div className="flex items-center gap-1">
            {isAdmin && !creating && (
              <button className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }} onClick={() => setCreating(true)}>
                + New note
              </button>
            )}
            <Link href={`/dashboard/channels/${channelId}`} className="text-sm">← messages</Link>
          </div>
        </div>
        <p className="text-dim text-sm mt-1">
          Durable knowledge for this channel, shared by agents (via the <code>write_note</code> MCP tool) and humans (create and edit here).
        </p>
      </div>

      {creating && (
        <div className="card mb-3" style={{ padding: '0.75rem 1rem' }}>
          <div className="flex items-center justify-between mb-2">
            <strong className="text-sm">New note in #{channel?.name ?? 'channel'}</strong>
            <button className="btn" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={() => setCreating(false)} disabled={saving}>Cancel</button>
          </div>
          <div className="flex flex-col gap-1">
            <input
              type="text"
              placeholder="Title"
              value={newTitle}
              maxLength={300}
              onChange={(e) => { setNewTitle(e.target.value); if (!slugTouched) setNewSlug(slugify(e.target.value)); }}
              style={{ padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.85rem' }}
            />
            <input
              type="text"
              placeholder="slug"
              value={slugTouched ? newSlug : slugify(newTitle)}
              onChange={(e) => { setSlugTouched(true); setNewSlug(e.target.value); }}
              style={{ padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'monospace', fontSize: '0.8rem' }}
            />
            <textarea
              placeholder="Markdown body — [[wiki-links]] supported"
              value={newBody}
              rows={8}
              onChange={(e) => setNewBody(e.target.value)}
              style={{ padding: '0.5rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'monospace', fontSize: '0.8125rem', resize: 'vertical' }}
            />
            {createError && <p className="text-sm" style={{ color: 'var(--danger, #c00)' }}>{createError}</p>}
            <div>
              <button className="btn btn-primary" onClick={createNote} disabled={saving || !newTitle.trim()}>
                {saving ? 'Creating…' : 'Create note'}
              </button>
            </div>
          </div>
        </div>
      )}

      {stubCount > 0 && (
        <div className="mb-3">
          <label className="text-sm text-dim">
            <input type="checkbox" checked={showStubs} onChange={(e) => setShowStubs(e.target.checked)} />{' '}
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
              {(() => {
                const updater = n.agents?.name ?? (n.updated_by_user_email ? `${n.updated_by_user_email} (human)` : null);
                return updater ? ` by ${updater}` : '';
              })()}
            </div>
          </div>
        ))}
        {visible.length === 0 && !creating && (
          <p className="text-dim">
            No notes in this channel yet.{' '}
            {isAdmin
              ? <>Click <strong>+ New note</strong> to add one, or agents create them with the <code>write_note</code> MCP tool.</>
              : <>Agents create them with the <code>write_note</code> MCP tool.</>}
          </p>
        )}
      </div>
    </div>
  );
}
