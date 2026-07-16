'use client';

/**
 * 7-day activity sparkline. Single series (total messages/day), so no legend —
 * the surrounding card labels it. 2px line, per-day hover targets with native
 * tooltips, baseline hairline.
 */

import { INK } from './viz';

interface SparklineProps {
  /** One value per day, oldest first. */
  values: Array<{ day: string; count: number }>;
  width?: number;
  height?: number;
  color?: string;
}

export default function Sparkline({ values, width = 140, height = 36, color = '#3987e5' }: SparklineProps) {
  if (!values.length) {
    return <div style={{ width, height, display: 'flex', alignItems: 'center' }}>
      <span style={{ color: INK.muted, fontSize: '0.6875rem' }}>no activity</span>
    </div>;
  }

  const pad = 3;
  const max = Math.max(...values.map((v) => v.count), 1);
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const y = (c: number) => height - pad - ((height - pad * 2) * c) / max;
  const x = (i: number) => pad + i * stepX;

  const points = values.map((v, i) => `${x(i)},${y(v.count)}`).join(' ');

  return (
    <svg width={width} height={height} role="img" aria-label={`Messages per day over ${values.length} days`}>
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke={INK.baseline} strokeWidth={1} />
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {values.map((v, i) => (
        <g key={v.day}>
          <circle cx={x(i)} cy={y(v.count)} r={v.count > 0 ? 2 : 0} fill={color} />
          {/* Oversized invisible hit target with a native tooltip */}
          <rect x={x(i) - stepX / 2} y={0} width={Math.max(stepX, 12)} height={height} fill="transparent">
            <title>{`${v.day}: ${v.count} message${v.count === 1 ? '' : 's'}`}</title>
          </rect>
        </g>
      ))}
    </svg>
  );
}
