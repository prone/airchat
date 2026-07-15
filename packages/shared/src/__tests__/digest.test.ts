import { describe, expect, it } from 'vitest';
import {
  buildDigestUserPrompt,
  dayBounds,
  digestSlug,
  formatMessagesForDigest,
  previousUtcDay,
} from '../digest.js';

describe('digest windowing', () => {
  it('computes the previous UTC day', () => {
    expect(previousUtcDay(new Date('2026-07-14T23:59:00Z'))).toBe('2026-07-13');
    expect(previousUtcDay(new Date('2026-07-14T00:00:00Z'))).toBe('2026-07-13');
    expect(previousUtcDay(new Date('2026-01-01T05:00:00Z'))).toBe('2025-12-31');
  });

  it('computes [start, end) bounds for a day', () => {
    const { start, end } = dayBounds('2026-07-13');
    expect(start).toBe('2026-07-13T00:00:00.000Z');
    expect(end).toBe('2026-07-14T00:00:00.000Z');
  });

  it('produces valid note slugs', () => {
    expect(digestSlug('2026-07-13')).toBe('daily-2026-07-13');
    expect(digestSlug('2026-07-13')).toMatch(/^[a-z0-9][a-z0-9-]{0,199}$/);
  });
});

describe('formatMessagesForDigest', () => {
  it('renders author, timestamp, and content', () => {
    const { transcript, included } = formatMessagesForDigest([
      { author: 'nas-scanner', content: 'scan finished', created_at: '2026-07-13T10:00:00Z' },
    ]);
    expect(transcript).toBe('[2026-07-13T10:00:00Z] nas-scanner: scan finished');
    expect(included).toBe(1);
  });

  it('truncates long individual messages', () => {
    const { transcript } = formatMessagesForDigest([
      { author: 'a', content: 'x'.repeat(5000), created_at: 't' },
    ]);
    expect(transcript.length).toBeLessThan(700);
    expect(transcript.endsWith('…')).toBe(true);
  });

  it('caps the total transcript size and reports how many made it in', () => {
    const messages = Array.from({ length: 500 }, (_, i) => ({
      author: `agent-${i}`,
      content: 'y'.repeat(500),
      created_at: '2026-07-13T10:00:00Z',
    }));
    const { transcript, included } = formatMessagesForDigest(messages);
    expect(transcript.length).toBeLessThanOrEqual(60_000);
    expect(included).toBeLessThan(500);
    expect(included).toBeGreaterThan(0);
  });
});

describe('buildDigestUserPrompt', () => {
  it('wraps the transcript in an untrusted boundary', () => {
    const prompt = buildDigestUserPrompt('project-x', '2026-07-13', 'line1\nline2', 42);
    expect(prompt).toContain('<untrusted_transcript>');
    expect(prompt).toContain('</untrusted_transcript>');
    expect(prompt).toContain('Channel: #project-x');
    expect(prompt).toContain('Messages in window: 42');
  });
});
