import { describe, it, expect } from 'vitest';
import {
  fileKind, inlineDownload, linkOnly, mediaType,
  MAX_INLINE_IMAGE_BYTES, MAX_INLINE_TEXT_BYTES,
} from '../file-download.js';

const URL = 'https://files.example/signed';
const bytes = (text: string) => new TextEncoder().encode(text);

describe('fileKind', () => {
  it.each([
    ['text/plain; charset=utf-8', 'text'],
    ['TEXT/Markdown', 'text'],
    ['application/json', 'text'],
    ['application/vnd.api+json', 'text'],
    ['image/svg+xml', 'text'],
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/tiff', 'binary'],
    ['application/pdf', 'binary'],
    ['application/zip', 'binary'],
    ['', 'binary'],
    [null, 'binary'],
  ])('%s is %s', (type, kind) => {
    expect(fileKind(type)).toBe(kind);
  });
});

describe('inlineDownload', () => {
  it('returns text as text', () => {
    expect(inlineDownload('general/a.txt', 'text/plain; charset=utf-8', bytes('héllo'), URL))
      .toEqual({ path: 'general/a.txt', type: 'text/plain', size: 6, content: 'héllo' });
  });

  it('returns an image as base64, byte for byte', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe]);
    const out = inlineDownload('general/a.png', 'image/png', png, URL) as { content_base64: string; size: number };
    expect(out.size).toBe(7);
    expect([...Buffer.from(out.content_base64, 'base64')]).toEqual([...png]);
    expect(out).not.toHaveProperty('content');
  });

  it('returns only a link for other binaries, never their bytes as text', () => {
    const out = inlineDownload('general/a.pdf', 'application/pdf', new Uint8Array([0x25, 0x50, 0xff]), URL);
    expect(out).toMatchObject({ path: 'general/a.pdf', type: 'application/pdf', size: 3, signed_url: URL });
    expect(out).not.toHaveProperty('content');
    expect(out).not.toHaveProperty('content_base64');
  });

  it('returns only a link for text or an image that is too large', () => {
    expect(inlineDownload('a.txt', 'text/plain', new Uint8Array(MAX_INLINE_TEXT_BYTES + 1), URL)).toHaveProperty('signed_url', URL);
    expect(inlineDownload('a.png', 'image/png', new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1), URL)).toHaveProperty('signed_url', URL);
  });
});

describe('linkOnly', () => {
  it('names the type and leaves the size out when it is not known', () => {
    expect(linkOnly('a.bin', null, URL)).toEqual({
      path: 'a.bin', type: 'application/octet-stream', signed_url: URL, note: expect.stringContaining('signed_url'),
    });
    expect(mediaType(' Image/PNG ; q=1')).toBe('image/png');
  });
});
