import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkGossipNonce, resetGossipNonces, MAX_TRACKED_NONCES } from '../gossip-nonce';

/**
 * The record of peer requests already accepted. It is written only for
 * requests whose signature verified (see gossip-auth), and it must stay
 * bounded whatever is put into it.
 */

beforeEach(() => {
  resetGossipNonces();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkGossipNonce', () => {
  it('accepts a request once and rejects the repeat', () => {
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'sig-1')).toBe(false);
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'sig-1')).toBe(true);
  });

  it('keeps peers and requests apart', () => {
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'sig-1')).toBe(false);
    expect(checkGossipNonce('bbbbbbbbbbbbbbbb', 'sig-1')).toBe(false);
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'sig-2')).toBe(false);
  });

  it('does not confuse values that would run together if simply joined', () => {
    expect(checkGossipNonce('ab', 'c')).toBe(false);
    expect(checkGossipNonce('a', 'bc')).toBe(false);
  });

  it('forgets a request once its window has passed', () => {
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'sig-1')).toBe(false);
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'sig-1')).toBe(false);
  });

  it('stops accepting when it is full, rather than growing or forgetting live entries', () => {
    for (let i = 0; i < MAX_TRACKED_NONCES; i++) {
      expect(checkGossipNonce('aaaaaaaaaaaaaaaa', `sig-${i}`)).toBe(false);
    }
    // Full: a new request cannot be remembered, so it is not accepted.
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'one-too-many')).toBe(true);
    // And nothing already recorded was dropped to make room.
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'sig-0')).toBe(true);

    // Once the old entries expire there is room again.
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(checkGossipNonce('aaaaaaaaaaaaaaaa', 'one-too-many')).toBe(false);
  });
});
