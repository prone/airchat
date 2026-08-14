import { describe, expect, it } from 'vitest';
import { isCovered, warnWindow } from './task-janitor';

describe('isCovered', () => {
  const caps = new Set(['llm', 'llm-gemma4-12b', 'embed-nomic-embed-text']);

  it('covers tagged tasks when any tag overlaps an active capability', () => {
    expect(isCovered(['llm-gemma4-12b'], caps, true)).toBe(true);
    expect(isCovered(['nope', 'embed-nomic-embed-text'], caps, true)).toBe(true);
  });

  it('does not cover tagged tasks with no overlap', () => {
    expect(isCovered(['llm-llama3-3-70b'], caps, true)).toBe(false);
  });

  it('covers untagged tasks whenever any agent is active, and never when none are', () => {
    expect(isCovered([], caps, true)).toBe(true);
    expect(isCovered(null, caps, true)).toBe(true);
    expect(isCovered([], new Set(), false)).toBe(false);
    expect(isCovered(['llm'], new Set(), false)).toBe(false);
  });
});

describe('warnWindow', () => {
  const orphan = 60 * 60 * 1000;
  const sweepMs = 5 * 60 * 1000;

  it('seeds one interval back on the first sweep', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    const w = warnWindow(now, orphan, sweepMs, null);
    expect(w.toIso).toBe('2026-08-14T11:00:00.000Z');
    expect(w.fromIso).toBe('2026-08-14T10:55:00.000Z');
  });

  it('successive sweeps tile from the cursor without gap or overlap', () => {
    const t0 = Date.parse('2026-08-14T12:00:00Z');
    const first = warnWindow(t0, orphan, sweepMs, null);
    const second = warnWindow(t0 + sweepMs, orphan, sweepMs, first.toMs);
    expect(second.fromIso).toBe(first.toIso);
  });

  it('a skipped or failed sweep widens the next window instead of dropping a cohort', () => {
    const t0 = Date.parse('2026-08-14T12:00:00Z');
    const first = warnWindow(t0, orphan, sweepMs, null);
    // Two intervals pass with no successful sweep (crash, drift, restart of
    // the loop timer): the cursor is unchanged, so the window covers it all.
    const later = warnWindow(t0 + 3 * sweepMs, orphan, sweepMs, first.toMs);
    expect(later.fromIso).toBe(first.toIso);
    expect(later.toMs - later.fromMs).toBe(3 * sweepMs);
  });
});
