'use client';

/**
 * Horizontal provenance split bar: stacked segments with 2px surface gaps,
 * direct labels (count per segment — the relief for sub-3:1 hues), and a
 * legend row since there are >= 2 series. Text wears ink tokens, never the
 * series color.
 */

import { INK, PROVENANCE, type ProvenanceKind } from './viz';

interface SplitBarProps {
  segments: Array<{ kind: ProvenanceKind; count: number }>;
  height?: number;
}

export default function SplitBar({ segments, height = 8 }: SplitBarProps) {
  const visible = segments.filter((s) => s.count > 0);
  const total = visible.reduce((sum, s) => sum + s.count, 0);

  if (total === 0) {
    return <span style={{ color: INK.muted, fontSize: '0.6875rem' }}>no messages</span>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 2, height, borderRadius: 4, overflow: 'hidden' }}>
        {visible.map((s) => (
          <div
            key={s.kind}
            title={`${PROVENANCE[s.kind].label}: ${s.count} (${Math.round((s.count / total) * 100)}%)`}
            style={{
              width: `${(s.count / total) * 100}%`,
              minWidth: 3,
              background: PROVENANCE[s.kind].color,
              borderRadius: 2,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
        {visible.map((s) => (
          <span key={s.kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.6875rem', color: INK.secondary }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: PROVENANCE[s.kind].color, display: 'inline-block' }} />
            {PROVENANCE[s.kind].label} {s.count}
          </span>
        ))}
      </div>
    </div>
  );
}
