'use client';

/**
 * API usage — visibility into every Anthropic API call the server makes
 * (currently the daily-digest summarizer). Hero totals, tokens-per-day
 * stacked bars, and a per-channel breakdown with estimated cost.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import DailyBars from '@/components/viz/DailyBars';
import { estimateCostUsd, formatTokens, formatUsd, INK } from '@/components/viz/viz';

interface UsageRow {
  id: string;
  purpose: string;
  channel_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  metadata: { note_slug?: string; date?: string } | null;
  created_at: string;
  channels: { name: string } | null;
}

export default function UsagePage() {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    supabase
      .from('llm_usage')
      .select('id, purpose, channel_id, model, input_tokens, output_tokens, metadata, created_at, channels:channel_id(name)')
      .order('created_at', { ascending: false })
      .limit(1000)
      .then(({ data }) => {
        setRows((data as unknown as UsageRow[]) ?? []);
        setLoaded(true);
      });
  }, [supabase]);

  const totals = useMemo(() => {
    let input = 0, output = 0, cost = 0, costKnown = true;
    for (const r of rows) {
      input += r.input_tokens;
      output += r.output_tokens;
      const c = estimateCostUsd(r.model, r.input_tokens, r.output_tokens);
      if (c === null) costKnown = false; else cost += c;
    }
    return { input, output, cost, costKnown, calls: rows.length };
  }, [rows]);

  const byDay = useMemo(() => {
    const map = new Map<string, { input: number; output: number }>();
    for (const r of rows) {
      const day = r.created_at.slice(0, 10);
      const cur = map.get(day) ?? { input: 0, output: 0 };
      cur.input += r.input_tokens;
      cur.output += r.output_tokens;
      map.set(day, cur);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }));
  }, [rows]);

  const byChannel = useMemo(() => {
    const map = new Map<string, { name: string; channelId: string | null; input: number; output: number; calls: number; model: string }>();
    for (const r of rows) {
      const key = r.channels?.name ?? '(deleted channel)';
      const cur = map.get(key) ?? { name: key, channelId: r.channel_id, input: 0, output: 0, calls: 0, model: r.model };
      cur.input += r.input_tokens;
      cur.output += r.output_tokens;
      cur.calls++;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
  }, [rows]);

  return (
    <div className="container">
      <div className="mb-3 flex items-center justify-between">
        <h2>API usage</h2>
        <Link href="/dashboard/overview" className="text-sm">← overview</Link>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {[
          { label: 'API calls', value: totals.calls.toLocaleString() },
          { label: 'Input tokens', value: formatTokens(totals.input) },
          { label: 'Output tokens', value: formatTokens(totals.output) },
          { label: 'Est. cost', value: totals.costKnown ? formatUsd(totals.cost) : `≥${formatUsd(totals.cost)}` },
        ].map((t) => (
          <div key={t.label} className="card" style={{ padding: '0.625rem 1rem', minWidth: 120 }}>
            <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>{t.value}</div>
            <div style={{ fontSize: '0.6875rem', color: INK.muted }}>{t.label}</div>
          </div>
        ))}
      </div>

      <div className="card mb-3" style={{ padding: '0.75rem 1rem', overflowX: 'auto' }}>
        <h3 className="text-sm" style={{ marginBottom: 8 }}>Tokens per day</h3>
        <DailyBars values={byDay} />
      </div>

      <div className="card" style={{ padding: '0.75rem 1rem', overflowX: 'auto' }}>
        <h3 className="text-sm" style={{ marginBottom: 8 }}>By channel</h3>
        {loaded && rows.length === 0 && (
          <p className="text-xs text-dim">
            No API usage recorded yet. Usage appears here once the digest summarizer runs
            (every call the server makes to Anthropic is ledgered in llm_usage).
          </p>
        )}
        {byChannel.length > 0 && (
          <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: INK.muted }}>
                <th style={{ padding: '4px 8px 4px 0' }}>Channel</th>
                <th style={{ padding: '4px 8px' }}>Calls</th>
                <th style={{ padding: '4px 8px' }}>Input</th>
                <th style={{ padding: '4px 8px' }}>Output</th>
                <th style={{ padding: '4px 8px' }}>Model</th>
                <th style={{ padding: '4px 8px', textAlign: 'right' }}>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {byChannel.map((c) => {
                const cost = estimateCostUsd(c.model, c.input, c.output);
                return (
                  <tr key={c.name} style={{ borderTop: `1px solid ${INK.grid}` }}>
                    <td style={{ padding: '4px 8px 4px 0' }}>
                      {c.channelId ? <Link href={`/dashboard/channels/${c.channelId}/overview`}>#{c.name}</Link> : c.name}
                    </td>
                    <td style={{ padding: '4px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.calls}</td>
                    <td style={{ padding: '4px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.input.toLocaleString()}</td>
                    <td style={{ padding: '4px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.output.toLocaleString()}</td>
                    <td style={{ padding: '4px 8px', color: INK.secondary }}>{c.model}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {cost === null ? '—' : formatUsd(cost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
