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
  githubRepo?: string | null;
  detectedRepos?: string[];
  detectedTasks?: Array<{ key: string; url: string; kind: 'issue' | 'pr' }>;
  onDescriptionSaved?: (text: string) => void;
  onRepoSaved?: (repo: string | null) => void;
}

interface SummaryState { body: string; generatedAt: string | null }

const STORAGE_KEY = 'airchat.channelSummary.expanded';

export default function ChannelSummaryPanel({
  channelId, channelName, description, agentCount, isAdmin,
  githubRepo, detectedRepos = [], detectedTasks = [], onDescriptionSaved, onRepoSaved,
}: ChannelSummaryPanelProps) {
  const supabase = createSupabaseBrowser();
  const [expanded, setExpanded] = useState(true);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [projectSummary, setProjectSummary] = useState<SummaryState | null>(null);
  const [busyKind, setBusyKind] = useState<'activity' | 'project' | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [repoEditing, setRepoEditing] = useState(false);
  const [repoDraft, setRepoDraft] = useState('');
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
      const [tl, actNote, projNote, msgCount, noteCount, lastMsg] = await Promise.all([
        supabase.rpc('channel_activity_timeline', { p_channel_id: channelId, p_days: 30 }),
        // Previously-requested summaries (not auto-generated)
        supabase.from('notes').select('body_md, properties').eq('channel_id', channelId).eq('slug', 'channel-summary').maybeSingle(),
        supabase.from('notes').select('body_md, properties').eq('channel_id', channelId).eq('slug', 'project-summary').maybeSingle(),
        supabase.from('messages').select('id', { count: 'exact', head: true }).eq('channel_id', channelId).eq('quarantined', false),
        supabase.from('notes').select('id', { count: 'exact', head: true }).eq('channel_id', channelId).eq('is_stub', false),
        supabase.from('messages').select('created_at').eq('channel_id', channelId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (cancelled) return;
      setTimeline((tl.data as TimelineRow[]) ?? []);
      const act = actNote.data as any, proj = projNote.data as any;
      setSummary(act ? { body: act.body_md as string, generatedAt: (act.properties?.generated_at as string) ?? null } : null);
      setProjectSummary(proj ? { body: proj.body_md as string, generatedAt: (proj.properties?.generated_at as string) ?? null } : null);
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

  async function requestSummary(kind: 'activity' | 'project') {
    setBusyKind(kind);
    setSummaryError(null);
    const res = await fetch('/api/channels/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, kind }),
    });
    setBusyKind(null);
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Request failed' }));
      setSummaryError(`${kind}: ${error ?? 'Request failed'}`);
      return;
    }
    const { summary: s } = await res.json();
    const next = { body: s.body_md, generatedAt: s.generated_at };
    if (kind === 'project') setProjectSummary(next); else setSummary(next);
  }

  async function saveRepo() {
    const repo = repoDraft.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '') || null;
    const { data: cur } = await supabase.from('channels').select('metadata').eq('id', channelId).single();
    const metadata = { ...(cur?.metadata ?? {}), github_repo: repo };
    const { error } = await supabase.from('channels').update({ metadata }).eq('id', channelId);
    if (!error) { setRepoEditing(false); onRepoSaved?.(repo); }
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

            {/* Project summary — describes what the project IS (not the activity) */}
            <SummarySection
              label="Project summary"
              slug="project-summary"
              state={projectSummary}
              busy={busyKind === 'project'}
              onRequest={() => requestSummary('project')}
              emptyText="Describe what this project is — its purpose, components, and current state."
              channelId={channelId}
            />

            {/* Activity summary — recent decisions and blockers */}
            <SummarySection
              label="Activity summary"
              slug="channel-summary"
              state={summary}
              busy={busyKind === 'activity'}
              onRequest={() => requestSummary('activity')}
              emptyText="Distill this channel's recent activity."
              channelId={channelId}
            />

            {summaryError && <p className="text-xs" style={{ margin: '4px 0 0', color: '#e66767' }}>{summaryError}</p>}

            {/* Repos & tasks referenced in this channel */}
            {(detectedRepos.length > 0 || detectedTasks.length > 0 || isAdmin) && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '0.6875rem', color: INK.muted }}>Repos</span>
                  {isAdmin && !repoEditing && (
                    <button onClick={() => { setRepoDraft(githubRepo ?? ''); setRepoEditing(true); }} style={{ fontSize: '0.5625rem', color: INK.muted, background: 'none', border: 'none', cursor: 'pointer' }}>
                      {githubRepo ? 'edit linked' : '+ link repo'}
                    </button>
                  )}
                </div>
                {repoEditing ? (
                  <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                    <input value={repoDraft} onChange={(e) => setRepoDraft(e.target.value)} placeholder="owner/repo" className="filter-input" style={{ fontSize: '0.6875rem', padding: '2px 6px', width: 180 }} />
                    <button className="btn" onClick={saveRepo} style={{ fontSize: '0.625rem', padding: '2px 6px' }}>save</button>
                    <button className="btn" onClick={() => setRepoEditing(false)} style={{ fontSize: '0.625rem', padding: '2px 6px' }}>cancel</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                    {[...new Set([githubRepo, ...detectedRepos].filter(Boolean) as string[])].map((r) => (
                      <a key={r} href={`https://github.com/${r}`} target="_blank" rel="noopener noreferrer" className="badge badge-dim" style={{ fontSize: '0.5625rem', textDecoration: 'none' }} title={r === githubRepo ? 'linked repo' : 'referenced in channel'}>
                        {r}{r === githubRepo ? ' ★' : ''}
                      </a>
                    ))}
                    {githubRepo === null && detectedRepos.length === 0 && <span className="text-xs text-dim">none</span>}
                  </div>
                )}
                {detectedTasks.length > 0 && (
                  <>
                    <div style={{ fontSize: '0.6875rem', color: INK.muted, marginTop: 6 }}>Tasks</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                      {detectedTasks.slice(0, 12).map((t) => (
                        <a key={t.key} href={t.url} target="_blank" rel="noopener noreferrer" className="badge badge-dim" style={{ fontSize: '0.5625rem', textDecoration: 'none' }} title={t.kind === 'pr' ? 'pull request' : 'issue'}>
                          {t.kind === 'pr' ? '⇅ ' : '◦ '}{t.key}
                        </a>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

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

function SummarySection({ label, slug, state, busy, onRequest, emptyText, channelId }: {
  label: string;
  slug: string;
  state: SummaryState | null;
  busy: boolean;
  onRequest: () => void;
  emptyText: string;
  channelId: string;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: '0.6875rem', color: INK.muted }}>
          {label}{state?.generatedAt ? ` · ${new Date(state.generatedAt).toLocaleDateString()}` : ''}
        </span>
        <button className="btn" onClick={onRequest} disabled={busy} style={{ fontSize: '0.625rem', padding: '2px 8px' }}>
          {busy ? 'Generating…' : state ? 'Regenerate' : 'Request'}
        </button>
      </div>
      {state ? (
        <p className="text-xs" style={{ margin: 0, color: INK.secondary, whiteSpace: 'pre-wrap' }}>
          {state.body.replace(/[#*`>]/g, '').slice(0, 320).trim()}
          {state.body.length > 320 && (
            <>… <Link href={`/dashboard/channels/${channelId}/notes/${slug}`}>read full</Link></>
          )}
        </p>
      ) : (
        <p className="text-xs text-dim" style={{ margin: 0 }}>{emptyText}</p>
      )}
    </div>
  );
}
