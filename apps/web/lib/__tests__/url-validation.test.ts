import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// dns is consulted for any hostname that isn't an IP literal, so it is mocked
// per-test rather than hitting a real resolver.
vi.mock('dns/promises', () => ({
  default: {
    resolve4: vi.fn(async () => [] as string[]),
    resolve6: vi.fn(async () => [] as string[]),
  },
}));

import dns from 'dns/promises';
import { validatePeerEndpoint, fetchPeerUrl } from '../url-validation';

const mockDns = (v4: string[], v6: string[] = []) => {
  vi.mocked(dns.resolve4).mockResolvedValue(v4 as never);
  vi.mocked(dns.resolve6).mockResolvedValue(v6 as never);
};

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.ALLOW_PRIVATE_PEER_ENDPOINTS;
  mockDns([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validatePeerEndpoint', () => {
  it('accepts a public https endpoint', async () => {
    mockDns(['93.184.216.34']);
    expect(await validatePeerEndpoint('https://example.com')).toEqual({ valid: true });
  });

  it.each([
    ['file:///etc/passwd', 'non-http protocol'],
    ['ftp://example.com', 'non-http protocol'],
  ])('rejects %s (%s)', async (url) => {
    const res = await validatePeerEndpoint(url);
    expect(res.valid).toBe(false);
  });

  it.each([
    'http://localhost',
    'http://metadata.google.internal',
    'http://0.0.0.0',
  ])('rejects blocked hostname %s', async (url) => {
    expect((await validatePeerEndpoint(url)).valid).toBe(false);
  });

  it.each([
    ['http://127.0.0.1', 'loopback'],
    ['http://10.1.2.3', 'RFC1918'],
    ['http://192.168.1.1', 'RFC1918'],
    ['http://169.254.169.254', 'cloud metadata'],
    ['http://100.99.11.124', 'CGNAT / Tailscale'],
  ])('rejects IP literal %s (%s)', async (url) => {
    expect((await validatePeerEndpoint(url)).valid).toBe(false);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    mockDns(['127.0.0.1']);
    const res = await validatePeerEndpoint('https://rebind.example.com');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/private address/);
  });

  it('rejects when any resolved address is private, even if others are public', async () => {
    mockDns(['93.184.216.34', '10.0.0.5']);
    expect((await validatePeerEndpoint('https://mixed.example.com')).valid).toBe(false);
  });

  // Regression: previously returned valid:true, so an unresolvable name was
  // treated as safe.
  it('fails closed when the hostname does not resolve', async () => {
    mockDns([], []);
    const res = await validatePeerEndpoint('https://nxdomain.example.com');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/could not be resolved/);
  });

  // Pins behaviour rather than fixing a bug: the WHATWG URL parser normalises
  // these to 127.0.0.1, so the dotted-quad check catches them. Worth locking
  // in, since a hand-rolled host check would miss them.
  it.each(['http://2130706433', 'http://0x7f000001', 'http://017700000001', 'http://127.1'])(
    'rejects numeric-literal host %s',
    async (url) => {
      expect((await validatePeerEndpoint(url)).valid).toBe(false);
    },
  );

  it('allows private endpoints when ALLOW_PRIVATE_PEER_ENDPOINTS is set', async () => {
    process.env.ALLOW_PRIVATE_PEER_ENDPOINTS = 'true';
    expect(await validatePeerEndpoint('http://127.0.0.1:3003')).toEqual({ valid: true });
  });
});

describe('fetchPeerUrl', () => {
  it('fetches a valid endpoint with redirects disabled', async () => {
    mockDns(['93.184.216.34']);
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchPeerUrl('https://example.com/api');
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses to fetch an endpoint that fails validation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPeerUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /Blocked peer request/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The core bypass: the initial URL is public and passes validation, but the
  // peer answers 302 pointing at cloud metadata.
  it('re-validates redirect targets and blocks a redirect to a private address', async () => {
    vi.mocked(dns.resolve4).mockImplementation(async (host: string) =>
      (host === 'evil.example.com' ? ['93.184.216.34'] : []) as never,
    );
    vi.mocked(dns.resolve6).mockResolvedValue([] as never);

    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPeerUrl('https://evil.example.com')).rejects.toThrow(/Blocked peer request/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when a redirect has no Location header', async () => {
    mockDns(['93.184.216.34']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302 })));

    await expect(fetchPeerUrl('https://example.com')).rejects.toThrow(/no Location header/);
  });

  it('gives up after too many redirects', async () => {
    mockDns(['93.184.216.34']);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://example.com/next' },
          }),
      ),
    );

    await expect(fetchPeerUrl('https://example.com')).rejects.toThrow(/exceeded \d+ redirects/);
  });
});
