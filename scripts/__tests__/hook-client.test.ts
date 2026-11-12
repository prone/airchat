import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs, no types
import { readCapped, readJsonBody, MAX_HOOK_RESPONSE_BYTES } from '../hook-client.mjs';

/**
 * Hooks run on every prompt of every session, unattended. `res.json()` reads
 * a whole body into memory before it returns, so a server that sends one
 * without end would fill the machine's memory from a process nobody watches.
 */

/** A body of `chunks` pieces of `size` bytes, counting how many were asked for. */
function streamed(chunks: number, size: number, headers: Record<string, string> = {}) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) { controller.close(); return; }
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { res: new Response(body, { headers }), pulled: () => pulled, cancelled: () => cancelled };
}

describe('readCapped', () => {
  it('returns a body that fits', async () => {
    expect(await readCapped(new Response('{"ok":true}'))).toBe('{"ok":true}');
    expect(await readCapped(new Response(null))).toBe('');
  });

  it('stops reading, and drops the connection, once past the limit', async () => {
    const s = streamed(1_000_000, 64 * 1024);
    expect(await readCapped(s.res, 1024 * 1024)).toBeNull();
    expect(s.cancelled()).toBe(true);
    // 1 MB at 64 KB a piece: seventeen pieces or so, not a million.
    expect(s.pulled()).toBeLessThan(40);
  });

  it('refuses a body that declares itself too large without reading it', async () => {
    const s = streamed(10, 1024, { 'content-length': String(MAX_HOOK_RESPONSE_BYTES + 1) });
    expect(await readCapped(s.res)).toBeNull();
    expect(s.pulled()).toBeLessThan(3);
  });

  it('does not trust a small declared length', async () => {
    const s = streamed(1_000_000, 64 * 1024, { 'content-length': '10' });
    expect(await readCapped(s.res, 1024 * 1024)).toBeNull();
  });

  it('keeps characters split across pieces whole', async () => {
    const bytes = new TextEncoder().encode('é'.repeat(3));
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); },
    });
    expect(await readCapped(new Response(body))).toBe('ééé');
  });
});

describe('readJsonBody', () => {
  it('parses a body that fits', async () => {
    expect(await readJsonBody(new Response('{"data":{"mentions":[]}}'))).toEqual({ data: { mentions: [] } });
  });

  it('throws on one that is too large, or is not JSON', async () => {
    await expect(readJsonBody(streamed(1000, 64 * 1024).res, 1024)).rejects.toThrow(/larger than/);
    await expect(readJsonBody(new Response('<html>'))).rejects.toThrow();
  });
});
