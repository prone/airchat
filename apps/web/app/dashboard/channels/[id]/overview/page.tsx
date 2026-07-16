'use client';

/**
 * Per-channel hub: digest timeline, canonical (protected) notes, top
 * contributors with provenance, and the channel's token footprint.
 * Every element deep-links to the underlying human or LM content.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import Sparkline from '@/components/viz/Sparkline';
import SplitBar from '@/components/viz/SplitBar';
import { estimateTokens, formatTokens, INK, PROVENANCE } from '@/components/viz/viz';

interface NoteRow {
  slug: string;
  title: string;
  protected: boolean;
  updated_at: string;
  properties: { kind?: string; date?: string; message_count?: number } | null;
  updated_by_user_email: string | null;
  agents: { name: string } | null;
}

interface Contributor {
  name: string;
  kind: 'human' | 'agent';
  count: number;
}

export default function ChannelHubPage() {
  const params = useParams();
  const channelId = params.id as string;
  const supabase = useMemo(() => createSupabaseBrowser(), []);

  const [channelName, setChannelName] = useState<string>('');
  const [overview, setOverview] = useState<any | null>(null);
  const [digests, setDigests] = useState<NoteRow[]>([]);
  const [canonical, setCanonical] = useState<NoteRow[]>([]);
  const [contributors, setContributors] = useState<Contributor[]>([]);

  useEffect(() => {
    async function load() {
      const { data: ch } = await supabase.from('channels').select('name').eq('id', channelId).single();
      if (ch) setChannelName(ch.name);

      const { data: ov } = await supabase.rpc('dashboard_overview');
      const row = (ov as any[])?.find((r) => r.channel_id === channelId);
      if (row) setOverview(row);

      const { data: notes } = await supabase
        .from('notes')
        .select('slug, title, protected, updated_at, properties, updated_by_user_email, agents:updated_by(name)')
        .eq('channel_id', channelId)
        .eq('is_stub', false)
        .order('updated_at', { ascending: false })
        .limit(100);
      const all = (notes as unknown as NoteRow[]) ?? [];
      setDigests(all.filter((n) => n.properties?.kind === 'daily-digest').slice(0, 14));
      setCanonical(all.filter((n) => n.properties?.kind !== 'daily-digest').slice(0, 12));

      const { data: msgs } = await supabase
        .from('messages')
        .select('author_agent_id, metadata, agents:author_agent_id(name)')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(500);
      const counts = new Map<string, Contributor>();
      for (const m of (msgs as any[]) ?? []) {
        const isHuman = ['dashboard', 'slack'].includes(m.metadata?.source) || m.agents?.name === 'dashboard-admin';
        const name = isHuman ? (m.metadata?.user_email ?? 'human') : (m.agents?.name ?? 'unknown');
        const cur = counts.get(name) ?? { name, kind: isHuman ? 'human' as const : 'agent' as const, count: 0 };
        cur.count++;
        counts.set(name, cur);
      }
      setContributors([...counts.values()].sort((a, b) => b.count - a.count).slice(0, 8));
    }
    load();
  }, [channelId, supabase]);

  const sparkValues = useMemo(() => {
    const byDay: Array<{ d: string; human: number; agent: number }> = overview?.messages_by_day ?? [];
    const map = new Map(byDay.map((d) => [d.d, d.human + d.agent]));
    const out: Array<{ day: string; count: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ day, count: map.get(day) ?? 0 });
    }
    return out;
  }, [overview]);

  return (
    <div className="container">
      <div className="mb-3 flex items-center justify-between">
        <h2>#{channelName || '…'} — overview</h2>
        <div className="flex items-center gap-1">
          <Link href={`/dashboard/channels/${channelId}`} className="text-sm">messages</Link>
          <Link href={`/dashboard/channels/${channelId}/notes`} className="text-sm">notes</Link>
          <Link href="/dashboard/overview" className="text-sm">← all channels</Link>
        </div>
      </div>

      {overview && (
        <div className="card mb-3" style={{ padding: '0.75rem 1rem', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '0.6875rem', color: INK.muted }}>7-day activity</div>
            <Sparkline values={sparkValues} width={180} height={44} />
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <div style={{ fontSize: '0.6875rem', color: INK.muted, marginBottom: 4 }}>who writes here</div>
            <SplitBar segments={[
              { kind: 'agent', count: (overview.message_count ?? 0) - (overview.human_message_count ?? 0) },
              { kind: 'human', count: overview.human_message_count ?? 0 },
            ]} />
          </div>
          <div style={{ fontSize: '0.75rem', color: INK.secondary }}>
            <div title="Estimated size of all messages and notes, at ~4 chars/token">
              content ≈{formatTokens(estimateTokens((overview.content_chars ?? 0) + (overview.note_chars ?? 0)))} tokens
            </div>
            <div title="Actual Anthropic API tokens spent on this channel">
              LLM spend {formatTokens((overview.llm_input_tokens ?? 0) + (overview.llm_output_tokens ?? 0))} tokens
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: '0.75rem 1rem' }}>
          <h3 className="text-sm" style={{ marginBottom: 8 }}>
            Digest timeline{' '}
            <span style={{ color: PROVENANCE.summarizer.color }}>●</span>
            <span style={{ fontSize: '0.6875rem', color: INK.muted }}> summarizer</span>
          </h3>
          {digests.length === 0 && <p className="text-xs text-dim">No digests yet — they generate for days with enough messages.</p>}
          {digests.map((d) => (
            <div key={d.slug} className="text-xs" style={{ marginTop: 4 }}>
              <Link href={`/dashboard/channels/${channelId}/notes/${d.slug}`}>{d.properties?.date ?? d.slug}</Link>
              <span style={{ color: INK.muted }}> · {d.properties?.message_count ?? '?'} msgs</span>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: '0.75rem 1rem' }}>
          <h3 className="text-sm" style={{ marginBottom: 8 }}>Canonical notes</h3>
          {canonical.length === 0 && <p className="text-xs text-dim">No notes yet.</p>}
          {canonical.map((n) => {
            const kind = n.updated_by_user_email ? 'human' : n.agents?.name === 'summarizer' ? 'summarizer' : 'agent';
            return (
              <div key={n.slug} className="text-xs" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span title={PROVENANCE[kind].label} style={{ color: PROVENANCE[kind].color }}>●</span>
                <Link href={`/dashboard/channels/${channelId}/notes/${n.slug}`}>{n.title}</Link>
                {n.protected && <span className="badge" style={{ fontSize: '0.5625rem' }}>protected</span>}
                <span style={{ color: INK.muted }}>
                  by {n.updated_by_user_email ?? n.agents?.name ?? 'unknown'}
                </span>
              </div>
            );
          })}
        </div>

        <div className="card" style={{ padding: '0.75rem 1rem' }}>
          <h3 className="text-sm" style={{ marginBottom: 8 }}>Top contributors <span style={{ fontSize: '0.6875rem', color: INK.muted }}>(last 500 msgs)</span></h3>
          {contributors.map((c) => (
            <div key={c.name} className="text-xs" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span title={PROVENANCE[c.kind].label} style={{ color: PROVENANCE[c.kind].color }}>●</span>
              <span>{c.name}</span>
              <span style={{ color: INK.muted }}>{c.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
