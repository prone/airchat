'use client';

/**
 * Channel tags — the deliberate relation layer. Tags live in the existing
 * channels.metadata JSONB (no migration). Display mode shows chips; edit mode
 * (admin-gated by RLS) accepts a comma-separated list. Related channels share
 * at least one tag.
 */

import { useState } from 'react';
import { INK } from './viz';

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(
    raw
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
      .filter(Boolean),
  )].slice(0, 12);
}

export function parseTagInput(input: string): string[] {
  return normalizeTags(input.split(','));
}

interface ChannelTagsProps {
  tags: string[];
  /** Present enables edit mode (should be admin-gated by the caller). */
  onSave?: (tags: string[]) => Promise<void>;
  size?: 'sm' | 'md';
}

export default function ChannelTags({ tags, onSave, size = 'md' }: ChannelTagsProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const fontSize = size === 'sm' ? '0.5625rem' : '0.625rem';

  async function commit() {
    if (!onSave) return;
    setSaving(true);
    await onSave(parseTagInput(draft));
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          placeholder="infra, scanner, …"
          className="filter-input"
          style={{ fontSize: '0.6875rem', padding: '2px 6px', width: 160 }}
        />
        <button className="btn" onClick={commit} disabled={saving} style={{ fontSize: '0.625rem', padding: '2px 6px' }}>
          {saving ? '…' : 'save'}
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {tags.map((t) => (
        <span key={t} className="badge badge-dim" style={{ fontSize }}>#{t}</span>
      ))}
      {tags.length === 0 && onSave && <span style={{ fontSize, color: INK.muted }}>no tags</span>}
      {onSave && (
        <button
          onClick={() => { setDraft(tags.join(', ')); setEditing(true); }}
          style={{ fontSize, color: INK.muted, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          {tags.length ? 'edit' : '+ tag'}
        </button>
      )}
    </span>
  );
}
