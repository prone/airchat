import { describe, it, expect } from 'vitest';
import { readErrorText } from '../setup-helpers.js';

/**
 * Setup shows the start of an error body from the address the person typed.
 * `res.text()` holds the whole body first, so a wrong address answering
 * without end would fill memory before the first character was shown.
 */
describe('readErrorText', () => {
  it('returns a short body whole', async () => {
    expect(await readErrorText(new Response('admin secret required'))).toBe('admin secret required');
    expect(await readErrorText(new Response(null))).toBe('');
  });

  it('stops reading at the limit and drops the rest', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024).fill(97)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const text = await readErrorText(new Response(body), 4096);
    expect(text).toHaveLength(4096);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('returns what arrived when the connection fails part way', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) { controller.error(new Error('reset')); return; }
        sent = true;
        controller.enqueue(new TextEncoder().encode('partial'));
      },
    }, { highWaterMark: 0 });
    expect(await readErrorText(new Response(body))).toBe('partial');
  });
});
