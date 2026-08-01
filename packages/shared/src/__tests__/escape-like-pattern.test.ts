import { describe, it, expect } from 'vitest';
import { escapeLikePattern } from '../supabase-gossip-adapter.js';

describe('escapeLikePattern', () => {
  it('leaves an ordinary UUID suffix untouched', () => {
    const suffix = '4f2a-11ee-b962-0242ac120002';
    expect(escapeLikePattern(suffix)).toBe(suffix);
  });

  it('escapes the percent wildcard', () => {
    expect(escapeLikePattern('a%b')).toBe('a\\%b');
  });

  it('escapes the underscore wildcard', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  // Regression: escaping % and _ before \ double-escapes the backslashes just
  // introduced, and a literal backslash in the input escapes whatever follows,
  // breaking out of the intended pattern.
  it('escapes the backslash itself, and does so first', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('handles a backslash immediately before a wildcard', () => {
    // Input \% must become \\\% : an escaped backslash, then an escaped percent.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('does not double-escape the escapes it introduces', () => {
    // If % were escaped before \, the resulting backslash would itself be
    // escaped on the later pass and the wildcard would come back to life.
    const out = escapeLikePattern('%');
    expect(out).toBe('\\%');
    expect(out).not.toBe('\\\\%');
  });

  it('escapes every wildcard in a mixed string', () => {
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\');
  });

  it('preserves an empty string', () => {
    expect(escapeLikePattern('')).toBe('');
  });
});
