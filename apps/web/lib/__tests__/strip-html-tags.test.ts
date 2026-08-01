import { describe, it, expect } from 'vitest';
import { stripHtmlTags } from '../sanitize';

/** No `<` remains, so no element can be formed from the output. */
const isInert = (s: string) => !s.includes('<');

describe('stripHtmlTags', () => {
  it('leaves plain text untouched', () => {
    expect(stripHtmlTags('hello world')).toBe('hello world');
  });

  it('strips a simple tag', () => {
    expect(stripHtmlTags('<b>bold</b>')).toBe('bold');
  });

  it('strips a script element', () => {
    expect(stripHtmlTags('<script>alert(1)</script>')).toBe('alert(1)');
  });

  it('keeps text content around stripped tags', () => {
    expect(stripHtmlTags('before <em>middle</em> after')).toBe('before middle after');
  });

  // The class of input CodeQL's js/incomplete-sanitization warns about. A
  // single pass does handle these: the leftovers are inert text, not tags.
  it.each([
    ['<<script>script>', 'script>'],
    ['<scri<script>pt>', 'pt>'],
    ['<<img >src=x onerror=alert(1)>', 'src=x onerror=alert(1)>'],
  ])('reduces %s to inert text', (input, expected) => {
    const out = stripHtmlTags(input);
    expect(out).toBe(expected);
    expect(isInert(out)).toBe(true);
  });

  // The property that actually matters, over the shapes most likely to slip
  // through a hand-rolled stripper.
  it('leaves no complete tag behind, for any nesting of brackets', () => {
    const alphabet = '<>abc/ ';
    for (let i = 0; i < 2000; i++) {
      let s = '';
      const n = 2 + (i % 12);
      for (let j = 0; j < n; j++) {
        s += alphabet[Math.floor((i * 31 + j * 7) % alphabet.length)];
      }
      expect(stripHtmlTags(s)).not.toMatch(/<[^>]*>/);
    }
  });

  it('preserves an empty string', () => {
    expect(stripHtmlTags('')).toBe('');
  });

  it('leaves a bare less-than that opens nothing', () => {
    expect(stripHtmlTags('2 < 3')).toBe('2 < 3');
  });
});
