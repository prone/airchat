import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout, SUPABASE_REQUEST_TIMEOUT_MS, SUPABASE_STORAGE_TIMEOUT_MS } from '@/lib/supabase-fetch';

/**
 * Server-side Supabase clients get a fetch that gives up after 10 seconds.
 * Without it a database that stops answering holds every API request open
 * until the socket dies.
 */

/** A fetch that never answers, and rejects the way fetch does when aborted. */
function hangingFetch() {
  const signals: AbortSignal[] = [];
  const base = vi.fn((_input: unknown, init?: RequestInit) => {
    const signal = init!.signal!;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  return { base: base as unknown as typeof fetch, signals, calls: base };
}

afterEach(() => vi.useRealTimers());

describe('fetchWithTimeout', () => {
  it('uses 10 seconds by default', () => {
    expect(SUPABASE_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('aborts a request that has not answered within the limit', async () => {
    const { base, signals } = hangingFetch();
    const outcome = fetchWithTimeout(30, base)('http://db.test/rest/v1/agents').then(
      () => 'answered',
      (e: Error) => e.name,
    );
    expect(await outcome).toBe('TimeoutError');
    expect(signals[0].aborted).toBe(true);
  });

  it('does not abort a request that answers in time', async () => {
    const base = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const response = await fetchWithTimeout(1000, base)('http://db.test/rest/v1/agents');
    expect(await response.text()).toBe('ok');
  });

  it('passes the URL and the rest of the request through unchanged', async () => {
    const base = vi.fn(async () => new Response('ok'));
    await fetchWithTimeout(1000, base as unknown as typeof fetch)('http://db.test/rest/v1/rpc/board_summary', {
      method: 'POST',
      headers: { apikey: 'k' },
      body: '{"p_agent_id":"a"}',
    });
    const [url, init] = base.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://db.test/rest/v1/rpc/board_summary');
    expect(init).toMatchObject({ method: 'POST', headers: { apikey: 'k' }, body: '{"p_agent_id":"a"}' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('still honours a signal the caller passed', async () => {
    const { base } = hangingFetch();
    const caller = new AbortController();
    const outcome = fetchWithTimeout(60_000, base)('http://db.test/rest/v1/agents', { signal: caller.signal }).then(
      () => 'answered',
      (e: Error) => e.name,
    );
    caller.abort();
    expect(await outcome).toBe('AbortError');
  });

  it('times out even when the caller passed a signal that never fires', async () => {
    const { base } = hangingFetch();
    const caller = new AbortController();
    const outcome = fetchWithTimeout(30, base)('http://db.test/rest/v1/agents', { signal: caller.signal }).then(
      () => 'answered',
      (e: Error) => e.name,
    );
    expect(await outcome).toBe('TimeoutError');
  });

  it('gives file transfers through Storage two minutes, not ten seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const base = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const wrapped = fetchWithTimeout(undefined, base);

    await wrapped('http://db.test/storage/v1/object/files/a.png');
    await wrapped(new URL('http://db.test/rest/v1/messages'));

    expect(timeout.mock.calls.map((c) => c[0])).toEqual([SUPABASE_STORAGE_TIMEOUT_MS, SUPABASE_REQUEST_TIMEOUT_MS]);
    expect(SUPABASE_STORAGE_TIMEOUT_MS).toBe(120_000);
    timeout.mockRestore();
  });
});

describe('the server-side clients are built with it', () => {
  it('passes a timeout fetch to createClient for the service-role and admin clients', async () => {
    const createClient = vi.fn<(...args: unknown[]) => object>(() => ({}));
    vi.resetModules();
    vi.doMock('@supabase/supabase-js', () => ({ createClient }));
    vi.doMock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');

    const { getSupabaseClient } = await import('@/lib/api-v2-auth');
    const { createSupabaseAdmin } = await import('@/lib/supabase-server');
    getSupabaseClient();
    createSupabaseAdmin();

    expect(createClient).toHaveBeenCalledTimes(2);
    for (const call of createClient.mock.calls) {
      const options = call[2] as { global?: { fetch?: unknown } };
      expect(typeof options.global?.fetch).toBe('function');
    }

    vi.doUnmock('@supabase/supabase-js');
    vi.doUnmock('next/headers');
    vi.resetModules();
  });
});
