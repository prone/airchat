import { describe, it, expect } from 'vitest';
import { MESSAGE_PAGE_SIZE, newestFirstToChronological } from '@/lib/message-page';

/**
 * The dashboard asked for a channel's messages oldest-first with a limit of
 * 200, which returns the 200 oldest: a channel with more than 200 messages
 * never showed a recent one. It now asks newest-first and puts the page back
 * in reading order.
 */

const at = (n: number) => ({ id: `m-${n}`, created_at: `2026-01-01T00:${String(n).padStart(2, '0')}:00Z` });

describe('newestFirstToChronological', () => {
  it('shows the newest page oldest-first', () => {
    const newestFirst = [at(5), at(4), at(3)];
    expect(newestFirstToChronological(newestFirst).map((m) => m.id)).toEqual(['m-3', 'm-4', 'm-5']);
  });

  it('keeps the newest messages of a long channel, where ascending-with-limit kept the oldest', () => {
    const all = Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}`, n: i }));
    // What the database returns for ORDER BY created_at DESC LIMIT 200.
    const page = [...all].reverse().slice(0, MESSAGE_PAGE_SIZE);
    const shown = newestFirstToChronological(page);
    expect(shown).toHaveLength(200);
    expect(shown[0].n).toBe(300);
    expect(shown[shown.length - 1].n).toBe(499);
  });

  it('does not reorder the array it was given', () => {
    const page = [at(2), at(1)];
    newestFirstToChronological(page);
    expect(page.map((m) => m.id)).toEqual(['m-2', 'm-1']);
  });

  it('handles an empty channel', () => {
    expect(newestFirstToChronological([])).toEqual([]);
  });
});
