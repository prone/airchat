'use client';

/**
 * Collapsible summary section at the top of a channel:
 *  - General summary: the channel description (project blurb; admin-editable)
 *    plus an ON-DEMAND activity summary — requested via a button, never
 *    auto-generated; a previously-requested summary is shown if one exists.
 *  - Last-activity metrics (last post, totals, agents, notes).
 *  - Token usage over time (content-token footprint per day + actual LLM spend).
 *
 * Collapsed/expanded state persists per browser in localStorage.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import DailyBars from './DailyBars';
import { estimateTokens, formatTokens, INK } from './viz';

interface TimelineRow {
  day: string;
  message_count: number;
  content_chars: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
}

interface ChannelSummaryPanelProps {
  channelId: string;
  channelName: string;
  description: string | null;
  agentCount: number;
  isAdmin: boolean;
  onDescriptionSaved?: (text: string) => void;
}

const STORAGE_KEY = 'airchat.channelSummary.expanded';

export default function ChannelSummaryPanel({
  channelId, channelName, description, agentCount, isAdmin, onDescriptionSaved,
}: ChannelSummaryPanelProps) {
  const supabase = createSupabaseBrowser();
  const [expanded, setExpanded] = useState(true);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [summary, setSummary] = useState<{ body: string; generatedAt: string | null } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ messages: number; notes: number; lastAt: string | null }>({ messages: 0, notes: 0, lastAt: null });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingDesc, setSavingDesc] = useState(false);
  const [desc, setDesc] = useState(description);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (saved !== null) setExpanded(saved === '1');
  }, []);

  useEffect(() => { setDesc(description); }, [description, channelId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [tl, existingSummary, msgCount, noteCount, lastMsg] = await Promise.all([
        supabase.rpc('channel_activity_timeline', { p_channel_id: channelId, p_days: 30 }),
        // Show a previously-requested summary if one exists (not auto-generated)
        supabase.from('notes')
          .select('body_md, properties')
          .eq('channel_id', channelId)
          .eq('slug', 'channel-summary')
          .maybeSingle(),
        supabase.from('messages').select('id', { count: 'exact', head: true }).eq('channel_id', channelId).eq('quarantined', false),
        supabase.from('notes').select('id', { count: 'exact', head: true }).eq('channel_id', channelId).eq('is_stub', false),
        supabase.from('messages').select('created_at').eq('channel_id', channelId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (cancelled) return;
      setTimeline((tl.data as TimelineRow[]) ?? []);
      const es = existingSummary.data as any;
      setSummary(es ? { body: es.body_md as string, generatedAt: (es.properties?.generated_at as string) ?? null } : null);
      setTotals({
        messages: msgCount.count ?? 0,
        notes: noteCount.count ?? 0,
        lastAt: (lastMsg.data as any)?.created_at ?? null,
      });
    })();
    return () => { cancelled = true; };
  }, [channelId, supabase]);

  function toggle() {
    setExpanded((e) => {
      const next = !e;
      try { window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  async function requestSummary() {
    setSummarizing(true);
    setSummaryError(null);
    const res = await fetch('/api/channels/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId }),
    });
    setSummarizing(false);
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Request failed' }));
      setSummaryError(error ?? 'Request failed');
      return;
    }
    const { summary: s } = await res.json();
    setSummary({ body: s.body_md, generatedAt: s.generated_at });
  }

  async function saveDescription() {
    setSavingDesc(true);
    const { error } = await supabase.from('channels').update({ description: draft.trim() || null }).eq('id', channelId);
    setSavingDesc(false);
    if (!error) { setDesc(draft.trim() || null); setEditing(false); onDescriptionSaved?.(draft.trim()); }
  }

  const barValues = timeline.map((r) => ({
    day: r.day,
    input: estimateTokens(r.content_chars),
    output: r.llm_input_tokens + r.llm_output_tokens,
  }));
  const totalContentTokens = timeline.reduce((s, r) => s + estimateTokens(r.content_chars), 0);
  const totalLlmTokens = timeline.reduce((s, r) => s + r.llm_input_tokens + r.llm_output_tokens, 0);

  const lastAgo = totals.lastAt
    ? (() => {
        const mins = Math.floor((Date.now() - new Date(totals.lastAt).getTime()) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
        return `${Math.floor(mins / 1440)}d ago`;
      })()
    : 'never';

  return (
    <div className="card" style={{ margin: '0.75rem 1.5rem 0', padding: 0 }}>
      <button
        onClick={toggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '0.5rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textAlign: 'left' }}
      >
        <span style={{ color: INK.muted }}>{expanded ? '▾' : '▸'}</span>
        <strong style={{ fontSize: '0.8125rem' }}>Channel summary</strong>
        <span style={{ fontSize: '0.6875rem', color: INK.muted }}>
          · {totals.messages.toLocaleString()} msgs · {agentCount} agents · last activity {lastAgo}
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '0 0.875rem 0.875rem', display: 'grid', gap: 12, gridTemplateColumns: 'minmax(240px, 1fr) minmax(280px, 1.4fr)' }}>
          {/* Left: summary + metrics */}
          <div>
            <div style={{ fontSize: '0.6875rem', color: INK.muted, marginBottom: 4 }}>About this channel</div>
            {editing ? (
              <div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  className="filter-input"
                  style={{ width: '100%', fontSize: '0.8125rem', resize: 'vertical' }}
                  placeholder="Describe this project / channel…"
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button className="btn btn-primary" onClick={saveDescription} disabled={savingDesc} style={{ fontSize: '0.6875rem', padding: '2px 8px' }}>
                    {savingDesc ? 'Saving…' : 'Save'}
                  </button>
                  <button className="btn" onClick={() => setEditing(false)} style={{ fontSize: '0.6875rem', padding: '2px 8px' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <p className="text-sm" style={{ margin: 0 }}>
                {desc || <span className="text-dim">No description yet.</span>}
                {isAdmin && (
                  <button onClick={() => { setDraft(desc ?? ''); setEditing(true); }} style={{ marginLeft: 8, fontSize: '0.625rem', color: INK.muted, background: 'none', border: 'none', cursor: 'pointer' }}>edit</button>
                )}
              </p>
            )}

            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: '0.6875rem', color: INK.muted }}>
                  Activity summary{summary?.generatedAt ? ` · ${new Date(summary.generatedAt).toLocaleString()}` : ''}
                </span>
                <button
                  className="btn"
                  onClick={requestSummary}
                  disabled={summarizing}
                  style={{ fontSize: '0.625rem', padding: '2px 8px' }}
                >
                  {summarizing ? 'Summarizing…' : summary ? 'Regenerate' : 'Request summary'}
                </button>
              </div>
              {summaryError && <p className="text-xs" style={{ margin: 0, color: '#e66767' }}>{summaryError}</p>}
              {summary ? (
                <p className="text-xs" style={{ margin: 0, color: INK.secondary, whiteSpace: 'pre-wrap' }}>
                  {summary.body.replace(/[#*`>]/g, '').slice(0, 320).trim()}
                  {summary.body.length > 320 && (
                    <>… <Link href={`/dashboard/channels/${channelId}/notes/channel-summary`}>read full</Link></>
                  )}
                </p>
              ) : !summaryError && (
                <p className="text-xs text-dim" style={{ margin: 0 }}>
                  No summary yet — request one to distill this channel&apos;s recent activity.
                </p>
              )}
            </div>

            <div style={{ marginTop: 10, display: 'flex', gap: 16, fontSize: '0.75rem', color: INK.secondary }}>
              <span><strong>{totals.notes}</strong> notes</span>
              <span><strong>{formatTokens(totalContentTokens)}</strong> content tok/30d</span>
              {totalLlmTokens > 0 && <span><strong>{formatTokens(totalLlmTokens)}</strong> LLM tok/30d</span>}
            </div>
          </div>

          {/* Right: token usage over time */}
          <div style={{ overflowX: 'auto' }}>
            <div style={{ fontSize: '0.6875rem', color: INK.muted, marginBottom: 4 }}>Token usage over time (30 days)</div>
            <DailyBars
              values={barValues}
              width={520}
              height={150}
              labels={{ input: 'Content tokens', output: 'LLM tokens' }}
            />
            <Link href={`/dashboard/channels/${channelId}/overview`} className="text-xs">full channel overview →</Link>
          </div>
        </div>
      )}
    </div>
  );
}
