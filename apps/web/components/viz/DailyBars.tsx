'use client';

/**
 * Daily stacked bar chart for the usage page: input vs output tokens per day.
 * Thin bars with rounded data-ends anchored to the baseline, 2px gaps between
 * stack segments and adjacent bars, hairline gridlines, legend (2 series),
 * native hover tooltips on oversized hit targets.
 */

import { INK } from './viz';

const SERIES = {
  input: { color: '#3987e5', label: 'Input tokens' },
  output: { color: '#199e70', label: 'Output tokens' },
} as const;

interface DailyBarsProps {
  values: Array<{ day: string; input: number; output: number }>;
  width?: number;
  height?: number;
}

export default function DailyBars({ values, width = 640, height = 160 }: DailyBarsProps) {
  if (!values.length) {
    return <p style={{ color: INK.muted, fontSize: '0.8125rem' }}>No API usage recorded yet.</p>;
  }

  const padL = 44;
  const padB = 20;
  const padT = 8;
  const plotW = width - padL - 8;
  const plotH = height - padT - padB;
  const max = Math.max(...values.map((v) => v.input + v.output), 1);
  const barSlot = plotW / values.length;
  const barW = Math.min(Math.max(barSlot - 2, 3), 28);
  const yScale = (n: number) => (plotH * n) / max;

  const gridSteps = [0.5, 1];

  return (
    <div>
      <svg width={width} height={height} role="img" aria-label="LLM tokens per day">
        {gridSteps.map((g) => (
          <g key={g}>
            <line x1={padL} y1={padT + plotH - plotH * g} x2={width - 8} y2={padT + plotH - plotH * g} stroke={INK.grid} strokeWidth={1} />
            <text x={padL - 6} y={padT + plotH - plotH * g + 3} textAnchor="end" fontSize={10} fill={INK.muted}>
              {Math.round(max * g).toLocaleString()}
            </text>
          </g>
        ))}
        <line x1={padL} y1={padT + plotH} x2={width - 8} y2={padT + plotH} stroke={INK.baseline} strokeWidth={1} />

        {values.map((v, i) => {
          const cx = padL + i * barSlot + (barSlot - barW) / 2;
          const hIn = yScale(v.input);
          const hOut = yScale(v.output);
          const showLabel = values.length <= 14 || i % Math.ceil(values.length / 10) === 0;
          return (
            <g key={v.day}>
              {/* input anchored to baseline, output stacked above with 2px gap */}
              <rect x={cx} y={padT + plotH - hIn} width={barW} height={Math.max(hIn, v.input > 0 ? 2 : 0)} rx={2} fill={SERIES.input.color} />
              {v.output > 0 && (
                <rect x={cx} y={padT + plotH - hIn - 2 - hOut} width={barW} height={Math.max(hOut, 2)} rx={2} fill={SERIES.output.color} />
              )}
              {showLabel && (
                <text x={cx + barW / 2} y={height - 6} textAnchor="middle" fontSize={9} fill={INK.muted}>
                  {v.day.slice(5)}
                </text>
              )}
              <rect x={padL + i * barSlot} y={0} width={barSlot} height={height} fill="transparent">
                <title>{`${v.day}\nInput: ${v.input.toLocaleString()} tokens\nOutput: ${v.output.toLocaleString()} tokens`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
        {Object.values(SERIES).map((s) => (
          <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.6875rem', color: INK.secondary }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
