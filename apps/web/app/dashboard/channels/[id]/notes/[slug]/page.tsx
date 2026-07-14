'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import SafeMarkdown from '@/components/SafeMarkdown';

interface NoteRow {
  id: string;
  slug: string;
  channel_id: string | null;
  title: string;
  body_md: string;
  properties: Record<string, unknown>;
  is_stub: boolean;
  protected: boolean;
  current_revision: number;
  created_at: string;
  updated_at: string;
  updated_by_user_email: string | null;
  creator: { name: string } | null;
  updater: { name: string } | null;
}

interface RevisionRow {
  revision: number;
  created_at: string;
  author_user_email: string | null;
  agents: { name: string } | null;
}

interface BacklinkRow {
  source_type: 'note' | 'message';
  source_id: string;
}

interface BacklinkDisplay {
  key: string;
  label: string;
  href: string | null;
  kind: string;
}

export default function NoteViewPage() {
  const params = useParams();
  const channelId = params.id as string;
  const slug = params.slug as string;
  const [note, setNote] = useState<NoteRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [backlinks, setBacklinks] = useState<BacklinkDisplay[]>([]);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const supabase = createSupabaseBrowser();

  async function loadRevisions(noteId: string) {
    const { data: revs } = await supabase
      .from('note_revisions')
      .select('revision, created_at, author_user_email, agents:author_agent_id(name)')
      .eq('note_id', noteId)
      .order('revision', { ascending: false })
      .limit(20);
    if (revs) setRevisions(revs as unknown as RevisionRow[]);
  }

  function startEditing() {
    if (!note) return;
    setDraftTitle(note.title);
    setDraftBody(note.body_md);
    setSaveError(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!note) return;
    setSaving(true);
    setSaveError(null);
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: note.channel_id,
        slug: note.slug,
        title: draftTitle,
        body_md: draftBody,
        expected_revision: note.current_revision,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Save failed' }));
      setSaveError(error ?? 'Save failed');
      return;
    }
    const { note: savedNote } = await res.json();
    setNote({ ...note, ...savedNote, updater: null });
    setEditing(false);
    loadRevisions(note.id);
  }

  useEffect(() => {
    async function load() {
      const { data: ch } = await supabase
        .from('channels')
        .select('name')
        .eq('id', channelId)
        .single();
      if (ch) setChannelName(ch.name);

      const { data: n } = await supabase
        .from('notes')
        .select('*, creator:created_by(name), updater:updated_by(name)')
        .eq('channel_id', channelId)
        .eq('slug', slug)
        .single();

      if (!n) {
        setNotFound(true);
        return;
      }
      setNote(n as unknown as NoteRow);

      const [, { data: links }] = await Promise.all([
        loadRevisions(n.id),
        supabase
          .from('note_links')
          .select('source_type, source_id')
          .eq('target_channel_id', channelId)
          .eq('target_slug', slug)
          .limit(50),
      ]);

      if (links?.length) {
        const noteIds = (links as BacklinkRow[]).filter((l) => l.source_type === 'note').map((l) => l.source_id);
        const messageIds = (links as BacklinkRow[]).filter((l) => l.source_type === 'message').map((l) => l.source_id);
        const display: BacklinkDisplay[] = [];

        if (noteIds.length) {
          const { data: srcNotes } = await supabase
            .from('notes')
            .select('id, slug, title, channel_id')
            .in('id', noteIds);
          for (const s of srcNotes ?? []) {
            display.push({
              key: `n-${s.id}`,
              label: s.title,
              href: s.channel_id ? `/dashboard/channels/${s.channel_id}/notes/${s.slug}` : null,
              kind: 'note',
            });
          }
        }
        if (messageIds.length) {
          const { data: srcMsgs } = await supabase
            .from('messages')
            .select('id, content, channel_id, agents:author_agent_id(name)')
            .in('id', messageIds);
          for (const s of srcMsgs ?? []) {
            const author = (s as unknown as { agents: { name: string } | null }).agents?.name;
            display.push({
              key: `m-${s.id}`,
              label: `${author ? author + ': ' : ''}${(s.content as string).slice(0, 80)}`,
              href: `/dashboard/channels/${s.channel_id}`,
              kind: 'message',
            });
          }
        }
        setBacklinks(display);
      }
    }
    load();
  }, [channelId, slug]);

  if (notFound) {
    return (
      <div className="container">
        <p className="text-dim">
          Note <code>{slug}</code> does not exist in this channel.
        </p>
        <Link href={`/dashboard/channels/${channelId}/notes`} className="text-sm">← all notes</Link>
      </div>
    );
  }

  if (!note) return <div className="container"><p className="text-dim">Loading…</p></div>;

  const propEntries = Object.entries(note.properties ?? {}).filter(([k]) => k !== 'promoted_from');
  const promotedFrom = (note.properties as { promoted_from?: { channel: string; message_id: string } })?.promoted_from;

  return (
    <div className="container">
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <h2>{note.title}</h2>
          <Link href={`/dashboard/channels/${channelId}/notes`} className="text-sm">
            ← all notes {channelName ? `in #${channelName}` : ''}
          </Link>
        </div>
        <div className="flex items-center gap-1 mt-1">
          <span className="text-xs text-dim">
            {note.slug} · rev {note.current_revision} · updated {new Date(note.updated_at).toLocaleString()}
            {(() => {
              const updater = note.updater?.name ?? (note.updated_by_user_email ? `${note.updated_by_user_email} (human)` : null);
              return updater ? ` by ${updater}` : '';
            })()} · created by {note.creator?.name ?? 'unknown'}
          </span>
          {note.is_stub && <span className="badge badge-dim" style={{ fontSize: '0.625rem' }}>stub</span>}
          {note.protected && <span className="badge" style={{ fontSize: '0.625rem' }}>protected</span>}
          {!editing && (
            <button className="btn" style={{ fontSize: '0.75rem', padding: '0.25rem 0.625rem' }} onClick={startEditing}>
              Edit
            </button>
          )}
        </div>
        {promotedFrom && (
          <p className="text-xs text-dim mt-1">
            Promoted from a thread in #{promotedFrom.channel}
          </p>
        )}
      </div>

      {propEntries.length > 0 && (
        <div className="card mb-3" style={{ padding: '0.5rem 0.75rem' }}>
          {propEntries.map(([k, v]) => (
            <div key={k} className="text-xs">
              <span className="text-dim">{k}:</span> {typeof v === 'string' ? v : JSON.stringify(v)}
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="filter-input"
            placeholder="Note title"
            maxLength={300}
          />
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            className="filter-input"
            rows={16}
            style={{ fontFamily: 'monospace', fontSize: '0.8125rem', resize: 'vertical' }}
            placeholder="Markdown body — [[wiki-links]] supported"
          />
          {saveError && <p className="text-sm" style={{ color: 'var(--danger, #c00)' }}>{saveError}</p>}
          <div className="flex items-center gap-1">
            <button className="btn btn-primary" onClick={saveEdit} disabled={saving || !draftTitle.trim()}>
              {saving ? 'Saving…' : `Save as rev ${note.current_revision + 1}`}
            </button>
            <button className="btn" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      ) : note.is_stub ? (
        <p className="text-dim">
          This is an unfilled stub — it was created by a wiki-link and has no content yet. Use Edit to fill it in.
        </p>
      ) : (
        <SafeMarkdown markdown={note.body_md} channelId={channelId} />
      )}

      <div className="mt-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
        <h3 className="text-sm">Backlinks</h3>
        {backlinks.length === 0 && <p className="text-xs text-dim">Nothing links here yet.</p>}
        {backlinks.map((b) => (
          <div key={b.key} className="text-xs mt-1">
            <span className="badge badge-dim" style={{ fontSize: '0.625rem' }}>{b.kind}</span>{' '}
            {b.href ? <Link href={b.href}>{b.label}</Link> : b.label}
          </div>
        ))}
      </div>

      <div className="mt-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
        <h3 className="text-sm">Revision history</h3>
        {revisions.map((r) => (
          <div key={r.revision} className="text-xs text-dim mt-1">
            rev {r.revision} · {new Date(r.created_at).toLocaleString()} ·{' '}
            {r.agents?.name ?? (r.author_user_email ? `${r.author_user_email} (human)` : 'unknown')}
          </div>
        ))}
      </div>
    </div>
  );
}
