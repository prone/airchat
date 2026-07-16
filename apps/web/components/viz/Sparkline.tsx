'use client';

/**
 * 7-day activity sparkline. A smooth (Catmull-Rom) curve with a soft gradient
 * area fill and a highlighted end point. Single series, so no legend — the
 * surrounding card labels it. Per-day hover targets with native tooltips.
 */

import { useId } from 'react';
import { INK } from './viz';

interface SparklineProps {
  /** One value per day, oldest first. */
  values: Array<{ day: string; count: number }>;
  width?: number;
  height?: number;
  color?: string;
}

/** Catmull-Rom spline → cubic-bezier path for a smooth line through the points. */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]},${pts[0][1]}`;
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export default function Sparkline({ values, width = 140, height = 40, color = '#3987e5' }: SparklineProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `spark-${rawId}`;

  if (!values.length) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center' }}>
        <span style={{ color: INK.muted, fontSize: '0.6875rem' }}>no activity</span>
      </div>
    );
  }

  const pad = 4;
  const max = Math.max(...values.map((v) => v.count), 1);
  const n = values.length;
  const stepX = n > 1 ? (width - pad * 2) / (n - 1) : 0;
  const x = (i: number) => pad + i * stepX;
  const y = (c: number) => height - pad - ((height - pad * 2) * c) / max;
  const pts: Array<[number, number]> = values.map((v, i) => [x(i), y(v.count)]);

  const line = smoothPath(pts);
  const base = height - pad;
  const area = `${line} L ${pts[n - 1][0].toFixed(1)},${base} L ${pts[0][0].toFixed(1)},${base} Z`;
  const last = pts[n - 1];

  return (
    <svg width={width} height={height} role="img" aria-label={`Messages per day over ${n} days`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.38" />
          <stop offset="70%" stopColor={color} stopOpacity="0.06" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      <line x1={pad} y1={base} x2={width - pad} y2={base} stroke={INK.baseline} strokeWidth={1} opacity={0.5} />
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {/* Highlighted latest point with a soft halo */}
      <circle cx={last[0]} cy={last[1]} r={4.5} fill={color} opacity={0.22} />
      <circle cx={last[0]} cy={last[1]} r={2.4} fill={color} stroke="var(--bg-card, #141414)" strokeWidth={1} />

      {values.map((v, i) => (
        <rect key={v.day} x={x(i) - stepX / 2} y={0} width={Math.max(stepX, 12)} height={height} fill="transparent">
          <title>{`${v.day}: ${v.count} message${v.count === 1 ? '' : 's'}`}</title>
        </rect>
      ))}
    </svg>
  );
}
