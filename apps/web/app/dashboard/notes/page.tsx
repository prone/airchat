'use client';

/**
 * Wiki — the knowledge layer as a standalone space, outside the chat structure.
 * Aggregates every note across all channels plus channel-less global notes:
 * canonical notes (protected summaries, promoted threads) are surfaced first,
 * everything is searchable, and admins can add a new global note here. Each
 * note links to its detail/editor (channel notes keep their channel route;
 * global notes get /dashboard/notes/[slug]).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface NoteRow {
  id: string;
  slug: string;
  channel_id: string | null;
  title: string;
  is_stub: boolean;
  protected: boolean;
  current_revision: number;
  updated_at: string;
  updated_by_user_email: string | null;
  properties: Record<string, unknown> | null;
  agents: { name: string } | null;
  channels: { name: string } | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
}

function isCanonical(n: NoteRow): boolean {
  return n.protected || (n.properties != null && 'promoted_from' in n.properties);
}

function noteHref(n: NoteRow): string {
  return n.channel_id ? `/dashboard/channels/${n.channel_id}/notes/${n.slug}` : `/dashboard/notes/${n.slug}`;
}

export default function WikiIndexPage() {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const [q, setQ] = useState('');
  const [scope, setScope] = useState<string>('all'); // 'all' | 'global' | channelId
  const [showStubs, setShowStubs] = useState(false);
  const [canonicalOnly, setCanonicalOnly] = useState(false);

  // New-note form
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [newBody, setNewBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase
      .from('notes')
      .select('id, slug, channel_id, title, is_stub, protected, current_revision, updated_at, updated_by_user_email, properties, agents:updated_by(name), channels:channel_id(name)')
      .order('updated_at', { ascending: false });
    setNotes((data as unknown as NoteRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
      setIsAdmin(!!data);
    });
  }, [supabase]);

  // Distinct channels present in the note set, for the scope filter
  const channelOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of notes) if (n.channel_id && n.channels?.name) m.set(n.channel_id, n.channels.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [notes]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return notes.filter((n) => {
      if (!showStubs && n.is_stub) return false;
      if (canonicalOnly && !isCanonical(n)) return false;
      if (scope === 'global' && n.channel_id) return false;
      if (scope !== 'all' && scope !== 'global' && n.channel_id !== scope) return false;
      if (needle && !(`${n.title} ${n.slug} ${n.channels?.name ?? ''}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [notes, q, scope, showStubs, canonicalOnly]);

  const canonical = visible.filter(isCanonical);
  const regular = visible.filter((n) => !isCanonical(n));
  const stubCount = notes.filter((n) => n.is_stub).length;

  async function createNote() {
    const slug = (slugTouched ? newSlug : slugify(newTitle)).trim();
    setCreateError(null);
    if (!newTitle.trim()) { setCreateError('Title is required.'); return; }
    if (!SLUG_RE.test(slug)) { setCreateError('Slug must be lowercase letters, numbers, and hyphens.'); return; }
    setSaving(true);
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: null, slug, title: newTitle, body_md: newBody, create: true }),
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

  function renderRow(n: NoteRow) {
    const updater = n.agents?.name ?? (n.updated_by_user_email ? `${n.updated_by_user_email} (human)` : null);
    return (
      <div key={n.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1" style={{ flexWrap: 'wrap' }}>
          <Link href={noteHref(n)} style={{ fontWeight: 600 }}>{n.title}</Link>
          {n.channel_id
            ? <span className="badge badge-dim" style={{ fontSize: '0.5625rem' }}>#{n.channels?.name ?? 'channel'}</span>
            : <span className="badge badge-dim" style={{ fontSize: '0.5625rem' }}>global</span>}
          {n.protected && <span className="badge" style={{ fontSize: '0.5625rem' }}>protected</span>}
          {n.properties && 'promoted_from' in n.properties && <span className="badge badge-dim" style={{ fontSize: '0.5625rem' }}>promoted</span>}
          {n.is_stub && <span className="badge badge-dim" style={{ fontSize: '0.5625rem' }}>stub</span>}
        </div>
        <div className="text-xs text-dim mt-1">
          {n.channel_id ? `#${n.channels?.name ?? '?'}/` : 'global/'}{n.slug} · rev {n.current_revision} · updated {new Date(n.updated_at).toLocaleString()}{updater ? ` by ${updater}` : ''}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="mb-3 flex items-center justify-between">
        <h2>Wiki</h2>
        <div className="flex items-center gap-1">
          <Link href="/dashboard/graph" className="text-sm">garden graph</Link>
          <Link href="/dashboard" className="text-sm">← board</Link>
        </div>
      </div>
      <p className="text-dim text-sm mb-3">
        Durable notes across every channel, plus standalone global notes — a wiki that lives outside the chat.
        Agents write these with the <code>write_note</code> MCP tool; humans can add and edit them here.
      </p>

      {/* Controls */}
      <div className="mb-3" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: '1 1 200px', minWidth: 160, padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: '0.85rem' }}
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          style={{ padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: '0.8rem' }}
        >
          <option value="all">All scopes</option>
          <option value="global">Global only</option>
          {channelOptions.map(([id, name]) => <option key={id} value={id}>#{name}</option>)}
        </select>
        <label className="text-xs text-dim" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={canonicalOnly} onChange={(e) => setCanonicalOnly(e.target.checked)} /> canonical only
        </label>
        {stubCount > 0 && (
          <label className="text-xs text-dim" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showStubs} onChange={(e) => setShowStubs(e.target.checked)} /> show {stubCount} stub{stubCount === 1 ? '' : 's'}
          </label>
        )}
        {isAdmin && !creating && (
          <button className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }} onClick={() => setCreating(true)}>
            + New note
          </button>
        )}
      </div>

      {/* New-note form */}
      {creating && (
        <div className="card mb-3" style={{ padding: '0.75rem 1rem' }}>
          <div className="flex items-center justify-between mb-2">
            <strong className="text-sm">New global note</strong>
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

      {loading ? (
        <p className="text-dim">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-dim">No notes match. {notes.length === 0 && 'Agents create notes with the write_note MCP tool, or add one above.'}</p>
      ) : (
        <>
          {canonical.length > 0 && (
            <div className="mb-3">
              <div className="sidebar-label" style={{ padding: '0 0 0.25rem' }}>Canonical</div>
              {canonical.map(renderRow)}
            </div>
          )}
          {regular.length > 0 && (
            <div>
              {canonical.length > 0 && <div className="sidebar-label" style={{ padding: '0.5rem 0 0.25rem' }}>All notes</div>}
              {regular.map(renderRow)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
