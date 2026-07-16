'use client';

/**
 * Channel overview — "my channels" at a glance. One card per channel:
 * 7-day activity sparkline, human/agent provenance split, garden stats,
 * token footprint (estimated content tokens + actual LLM spend), and links
 * into the stream, garden, and hub for each channel.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import Sparkline from '@/components/viz/Sparkline';
import SplitBar from '@/components/viz/SplitBar';
import { estimateTokens, formatTokens, INK } from '@/components/viz/viz';

interface OverviewRow {
  channel_id: string;
  channel_name: string;
  channel_type: string;
  federation_scope: string;
  message_count: number;
  human_message_count: number;
  last_message_at: string | null;
  content_chars: number;
  messages_by_day: Array<{ d: string; human: number; agent: number }>;
  note_count: number;
  stub_count: number;
  digest_count: number;
  latest_digest_slug: string | null;
  note_chars: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
}

/** Fill the last 7 days so quiet days render as zeros, not gaps. */
function last7Days(byDay: OverviewRow['messages_by_day']): Array<{ day: string; count: number }> {
  const map = new Map(byDay.map((d) => [d.d, d.human + d.agent]));
  const out: Array<{ day: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, count: map.get(day) ?? 0 });
  }
  return out;
}

export default function OverviewPage() {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [lastArchived, setLastArchived] = useState<Array<{ id: string; name: string }>>([]);

  function refresh() {
    supabase.rpc('dashboard_overview').then(({ data, error: err }) => {
      if (err) setError(err.message);
      else setRows((data as OverviewRow[]) ?? []);
    });
  }

  useEffect(refresh, [supabase]);

  // "Unused" = nothing in it at all: no messages, no notes, not even stubs
  const unused = useMemo(
    () => rows.filter((r) => r.message_count === 0 && r.note_count === 0 && r.stub_count === 0),
    [rows],
  );

  async function archiveUnused() {
    if (!unused.length) return;
    const names = unused.map((u) => `#${u.channel_name}`).join(', ');
    if (!window.confirm(
      `Archive ${unused.length} empty channel${unused.length === 1 ? '' : 's'}?\n\n${names}\n\n` +
      'Non-destructive: nothing is deleted — archived channels are hidden from the dashboard and can be restored with Undo.'
    )) return;
    setCleaning(true);
    const ids = unused.map((u) => u.channel_id);
    const { error: err } = await supabase.from('channels').update({ archived: true }).in('id', ids);
    setCleaning(false);
    if (err) { setError(err.message); return; }
    setLastArchived(unused.map((u) => ({ id: u.channel_id, name: u.channel_name })));
    refresh();
  }

  async function undoArchive() {
    const ids = lastArchived.map((c) => c.id);
    const { error: err } = await supabase.from('channels').update({ archived: false }).in('id', ids);
    if (err) { setError(err.message); return; }
    setLastArchived([]);
    refresh();
  }

  return (
    <div className="container">
      <div className="mb-3 flex items-center justify-between">
        <h2>Channels overview</h2>
        <div className="flex items-center gap-1">
          <Link href="/dashboard/graph" className="text-sm">garden graph</Link>
          <Link href="/dashboard/usage" className="text-sm">API usage</Link>
          <Link href="/dashboard" className="text-sm">← board</Link>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: '#e66767' }}>Failed to load: {error}</p>}
      {!error && rows.length === 0 && lastArchived.length === 0 && <p className="text-dim">Loading…</p>}

      {unused.length > 0 && (
        <div className="card mb-3" style={{ padding: '0.625rem 1rem', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="text-sm text-dim">
            {unused.length} empty channel{unused.length === 1 ? '' : 's'} (no messages or notes)
          </span>
          <button className="btn" onClick={archiveUnused} disabled={cleaning} style={{ fontSize: '0.75rem', padding: '0.25rem 0.75rem' }}>
            {cleaning ? 'Archiving…' : 'Archive empty channels'}
          </button>
        </div>
      )}
      {lastArchived.length > 0 && (
        <div className="card mb-3" style={{ padding: '0.625rem 1rem', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="text-sm text-dim">
            Archived {lastArchived.map((c) => `#${c.name}`).join(', ')} — nothing was deleted.
          </span>
          <button className="btn" onClick={undoArchive} style={{ fontSize: '0.75rem', padding: '0.25rem 0.75rem' }}>
            Undo
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {rows.map((r) => {
          const contentTokens = estimateTokens(r.content_chars + r.note_chars);
          const llmTokens = r.llm_input_tokens + r.llm_output_tokens;
          return (
            <div key={r.channel_id} className="card" style={{ padding: '0.75rem 1rem' }}>
              <div className="flex items-center justify-between">
                <Link href={`/dashboard/channels/${r.channel_id}/overview`} style={{ fontWeight: 600 }}>
                  #{r.channel_name}
                </Link>
                <span className="badge badge-dim" style={{ fontSize: '0.625rem' }}>{r.channel_type}</span>
              </div>

              <div className="flex items-center justify-between" style={{ marginTop: 8 }}>
                <Sparkline values={last7Days(r.messages_by_day)} />
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>{r.message_count.toLocaleString()}</div>
                  <div style={{ fontSize: '0.6875rem', color: INK.muted }}>messages</div>
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <SplitBar segments={[
                  { kind: 'agent', count: r.message_count - r.human_message_count },
                  { kind: 'human', count: r.human_message_count },
                ]} />
              </div>

              <div style={{ marginTop: 8, fontSize: '0.6875rem', color: INK.secondary, display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                <span>{r.note_count} note{r.note_count === 1 ? '' : 's'}{r.stub_count > 0 ? ` (+${r.stub_count} stubs)` : ''}</span>
                <span>{r.digest_count} digest{r.digest_count === 1 ? '' : 's'}</span>
                <span title="Estimated size of all messages and notes, at ~4 chars/token">content ≈{formatTokens(contentTokens)} tok</span>
                <span title="Actual Anthropic API tokens spent on this channel (digests)">LLM spend {formatTokens(llmTokens)} tok</span>
              </div>

              <div style={{ marginTop: 8, display: 'flex', gap: 12, fontSize: '0.75rem' }}>
                <Link href={`/dashboard/channels/${r.channel_id}`}>messages</Link>
                <Link href={`/dashboard/channels/${r.channel_id}/notes`}>notes</Link>
                {r.latest_digest_slug && (
                  <Link href={`/dashboard/channels/${r.channel_id}/notes/${r.latest_digest_slug}`}>latest digest</Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
