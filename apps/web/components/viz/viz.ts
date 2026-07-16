/**
 * Shared visualization tokens and helpers.
 *
 * The dashboard is dark-only (globals.css :root), so these are the dark-mode
 * steps of the reference dataviz palette, validated against the card surface
 * (#141414): lightness band, chroma floor, CVD separation, and 3:1 contrast
 * all pass. Provenance hues are assigned in fixed order and never cycled.
 */

/** Provenance classes — the core visual encoding across all views. */
export const PROVENANCE = {
  agent: { color: '#3987e5', label: 'Agent' },
  human: { color: '#199e70', label: 'Human' },
  summarizer: { color: '#c98500', label: 'Summarizer' },
} as const;

export type ProvenanceKind = keyof typeof PROVENANCE;

/** Chart chrome (dark surface). */
export const INK = {
  primary: '#ffffff',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  baseline: '#383835',
} as const;

/** Rough content-size estimate; honest label is "≈ N tokens" (chars / 4). */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** $ per million tokens, keyed by model. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export function formatUsd(n: number): string {
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`;
}

/** Legend chip row — identity is never color-alone. */
export function legendEntries(kinds: ProvenanceKind[]): Array<{ color: string; label: string }> {
  return kinds.map((k) => ({ color: PROVENANCE[k].color, label: PROVENANCE[k].label }));
}

/**
 * Recency status by last-activity time. A hot→cold scale (validated status
 * colors on the dark surface) so a channel's freshness is readable at a
 * glance. Always paired with a text label — never color alone.
 */
export type RecencyKey = 'active' | 'today' | 'week' | 'idle';

export const RECENCY_TIERS: Array<{ key: RecencyKey; color: string; label: string }> = [
  { key: 'active', color: '#0ca30c', label: '< 1 hour' },
  { key: 'today', color: '#fab219', label: '< 24 hours' },
  { key: 'week', color: '#ec835a', label: '< 7 days' },
  { key: 'idle', color: '#898781', label: 'older / none' },
];

export function recencyTier(lastAt: string | null): { key: RecencyKey; color: string; label: string } {
  const byKey = (k: RecencyKey) => RECENCY_TIERS.find((t) => t.key === k)!;
  if (!lastAt) return byKey('idle');
  const mins = (Date.now() - new Date(lastAt).getTime()) / 60000;
  if (mins < 60) return byKey('active');
  if (mins < 1440) return byKey('today');
  if (mins < 10080) return byKey('week');
  return byKey('idle');
}

/** Short "how long ago" label, e.g. "3m", "5h", "2d", "never". */
export function agoLabel(lastAt: string | null): string {
  if (!lastAt) return 'never';
  const mins = Math.floor((Date.now() - new Date(lastAt).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}
