import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// dns is consulted for any hostname that isn't an IP literal, so it is mocked
// per-test rather than hitting a real resolver.
vi.mock('dns/promises', () => ({
  default: {
    resolve4: vi.fn(async () => [] as string[]),
    resolve6: vi.fn(async () => [] as string[]),
    // Only used by ALLOW_PRIVATE_PEER_ENDPOINTS mode, which needs /etc/hosts.
    lookup: vi.fn(async () => ({ address: '127.0.0.1', family: 4 })),
  },
}));

// fetchPeerUrl issues requests through node:http(s) rather than fetch, because
// only those expose the `lookup` hook used to pin the validated address.
vi.mock('node:https', () => ({ default: { request: vi.fn() } }));
vi.mock('node:http', () => ({ default: { request: vi.fn() } }));

import { EventEmitter } from 'node:events';
import dns from 'dns/promises';
import https from 'node:https';
import { validatePeerEndpoint, fetchPeerUrl, isPrivateIp, MAX_PEER_RESPONSE_BYTES } from '../url-validation';

const mockDns = (v4: string[], v6: string[] = []) => {
  vi.mocked(dns.resolve4).mockResolvedValue(v4 as never);
  vi.mocked(dns.resolve6).mockResolvedValue(v6 as never);
};

interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Send the body as this many chunks of `chunkBytes`, instead of `body`. */
  chunks?: number;
  chunkBytes?: number;
  /** Never finish the response (to exercise the deadline). */
  hang?: boolean;
}

/** Captured request options, so tests can assert what address was dialled. */
let requestOptions: Record<string, unknown>[] = [];

/** Stub node:https.request with a canned reply (or a per-call sequence). */
const stubHttps = (replies: StubReply | StubReply[]) => {
  const queue = Array.isArray(replies) ? [...replies] : null;
  vi.mocked(https.request).mockImplementation(((options: never, callback: never) => {
    requestOptions.push(options as unknown as Record<string, unknown>);
    const reply = (queue ? (queue.shift() ?? {}) : (replies as StubReply)) ?? {};
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.setTimeout = vi.fn();
    req.write = vi.fn();
    req.destroy = vi.fn();
    req.end = vi.fn(() => {
      const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
      res.statusCode = reply.status ?? 200;
      res.headers = reply.headers ?? {};
      (callback as unknown as (r: unknown) => void)(res);
      setImmediate(() => {
        if (reply.body) res.emit('data', Buffer.from(reply.body));
        for (let i = 0; i < (reply.chunks ?? 0); i++) res.emit('data', Buffer.alloc(reply.chunkBytes ?? 1));
        if (!reply.hang) res.emit('end');
      });
    });
    return req;
  }) as never);
};

/** Resolve the pinned address the implementation actually dialled. */
const dialledAddress = async (index = 0): Promise<string> => {
  const lookup = requestOptions[index].lookup as (
    h: string,
    o: unknown,
    cb: (e: null, a: string, f: number) => void,
  ) => void;
  return new Promise((resolve) => lookup('ignored.example', {}, (_e, addr) => resolve(addr)));
};

beforeEach(() => {
  vi.restoreAllMocks();
  // Module mocks created by vi.mock keep their call history across tests;
  // restoreAllMocks does not clear it, and several assertions here count calls.
  vi.clearAllMocks();
  delete process.env.ALLOW_PRIVATE_PEER_ENDPOINTS;
  mockDns([]);
  requestOptions = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validatePeerEndpoint', () => {
  it('accepts a public https endpoint and returns the address to pin', async () => {
    mockDns(['93.184.216.34']);
    expect(await validatePeerEndpoint('https://example.com')).toEqual({
      valid: true,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('returns an IP literal as its own pinned address', async () => {
    expect(await validatePeerEndpoint('http://93.184.216.34')).toEqual({
      valid: true,
      address: '93.184.216.34',
      family: 4,
    });
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
    ['http://100.64.0.1', 'CGNAT / Tailscale'],
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

  // The WHATWG URL parser rewrites an IPv4-mapped literal into hex groups
  // ([::ffff:169.254.169.254] becomes [::ffff:a9fe:a9fe]), which a check
  // written against dotted quads never matches.
  it.each([
    ['http://[::ffff:169.254.169.254]', 'IPv4-mapped cloud metadata'],
    ['http://[::ffff:a9fe:a9fe]', 'the same address in hex groups'],
    ['http://[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
    ['http://[::ffff:10.0.0.1]', 'IPv4-mapped RFC1918'],
    ['http://[::]', 'unspecified address'],
    ['http://[::1]', 'loopback'],
    ['http://[::127.0.0.1]', 'IPv4-compatible loopback'],
    ['http://[64:ff9b::169.254.169.254]', 'NAT64 to cloud metadata'],
    ['http://[64:ff9b::a00:1]', 'NAT64 to RFC1918'],
    ['http://[2002:a9fe:a9fe::1]', '6to4 to cloud metadata'],
    ['http://[2002:7f00:1::]', '6to4 to loopback'],
    ['http://[fe80::1]', 'link-local'],
    ['http://[fd12:3456::1]', 'unique local'],
    ['http://[ff02::1]', 'multicast'],
    ['http://[2001:db8::1]', 'documentation range'],
    ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]', 'Teredo'],
    ['http://224.0.0.1', 'IPv4 multicast'],
    ['http://239.255.255.250', 'IPv4 multicast (upper)'],
    ['http://240.0.0.1', 'reserved'],
    ['http://250.1.2.3', 'reserved (upper)'],
    ['http://255.255.255.255', 'broadcast'],
    ['http://198.18.0.1', 'benchmarking range'],
    ['http://198.19.255.254', 'benchmarking range (upper)'],
    ['http://192.88.99.1', '6to4 relay anycast'],
  ])('rejects %s (%s)', async (url) => {
    expect((await validatePeerEndpoint(url)).valid).toBe(false);
  });

  it.each([
    'http://[2606:4700:4700::1111]',
    'http://[::ffff:8.8.8.8]',
    'http://[64:ff9b::808:808]',
    'http://[2002:808:808::1]',
    'http://198.17.255.255',
    'http://198.20.0.1',
    'http://223.255.255.254',
  ])('still accepts the public address %s', async (url) => {
    expect((await validatePeerEndpoint(url)).valid).toBe(true);
  });

  it('rejects a hostname whose AAAA record is an IPv4-mapped private address', async () => {
    mockDns([], ['::ffff:a9fe:a9fe']);
    expect((await validatePeerEndpoint('https://mapped.example.com')).valid).toBe(false);
  });

  it('treats anything that is not an IP address as unsafe', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('fe80::1%eth0')).toBe(true);
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
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
    expect(await validatePeerEndpoint('http://127.0.0.1:3003')).toEqual({
      valid: true,
      address: '127.0.0.1',
      family: 4,
    });
  });

  // Development mode differs only in which addresses are allowed -- it still
  // returns an address, so the caller pins exactly as it does in production
  // and there is no unpinned transport anywhere.
  it('still returns an address to pin in development mode', async () => {
    process.env.ALLOW_PRIVATE_PEER_ENDPOINTS = 'true';
    const res = await validatePeerEndpoint('http://localhost:3003');
    expect(res.valid).toBe(true);
    expect(res.address).toBe('127.0.0.1');
  });

  it('rejects a non-http protocol even in development mode', async () => {
    process.env.ALLOW_PRIVATE_PEER_ENDPOINTS = 'true';
    expect((await validatePeerEndpoint('file:///etc/passwd')).valid).toBe(false);
  });
});

describe('fetchPeerUrl', () => {
  it('returns the response body and status', async () => {
    mockDns(['93.184.216.34']);
    stubHttps({ status: 200, body: '{"ok":true}' });

    const res = await fetchPeerUrl('https://example.com/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses to connect to an endpoint that fails validation', async () => {
    stubHttps({ status: 200 });

    await expect(fetchPeerUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /Blocked peer request/,
    );
    expect(https.request).not.toHaveBeenCalled();
  });

  // The redirect bypass: the initial URL is public and passes validation, but
  // the peer answers 302 pointing at cloud metadata. Redirects are not
  // followed, so no second request is ever made.
  it('does not follow a redirect to a private address', async () => {
    vi.mocked(dns.resolve4).mockImplementation(async (host: string) =>
      (host === 'evil.example.com' ? ['93.184.216.34'] : []) as never,
    );
    vi.mocked(dns.resolve6).mockResolvedValue([] as never);
    stubHttps({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });

    await expect(fetchPeerUrl('https://evil.example.com')).rejects.toThrow(/redirect/);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  // DNS rebinding: the validator sees a public address, but a second lookup at
  // connect time would return loopback. The connection must use the address
  // that was validated, so the second answer is never consulted.
  it('dials the validated address, not a re-resolved one', async () => {
    let lookups = 0;
    vi.mocked(dns.resolve4).mockImplementation(async () => {
      lookups++;
      return (lookups === 1 ? ['93.184.216.34'] : ['127.0.0.1']) as never;
    });
    stubHttps({ status: 200, body: 'ok' });

    const res = await fetchPeerUrl('https://rebind.example.com');
    expect(res.status).toBe(200);
    // The pinned lookup hook hands back the validated address, never 127.0.0.1.
    expect(await dialledAddress()).toBe('93.184.216.34');
    expect(lookups).toBe(1);
  });

  it('keeps the original hostname for Host header and TLS, pinning only the address', async () => {
    mockDns(['93.184.216.34']);
    stubHttps({ status: 200, body: 'ok' });

    await fetchPeerUrl('https://example.com/api/v2/gossip/identity');
    expect(requestOptions[0]).toMatchObject({
      hostname: 'example.com',
      path: '/api/v2/gossip/identity',
    });
  });

  // A redirect to another public host would carry the request's signed
  // headers and body to a server the operator never added as a peer.
  it('does not follow a redirect to another public host', async () => {
    mockDns(['93.184.216.34']);
    stubHttps([
      { status: 302, headers: { location: 'https://second.example.com/moved' } },
      { status: 200, body: 'landed' },
    ]);

    await expect(
      fetchPeerUrl('https://first.example.com/api/v2/gossip/push', {
        method: 'POST',
        headers: { 'x-gossip-signature-v2': 'sig' },
        body: '{"messages":[]}',
      }),
    ).rejects.toThrow(/redirects are not followed/);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])('treats HTTP %i as an error even on the same host', async (status) => {
    mockDns(['93.184.216.34']);
    stubHttps({ status, headers: { location: '/elsewhere' } });

    await expect(fetchPeerUrl('https://example.com')).rejects.toThrow(/redirect/);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  it('accepts a response body up to the size cap', async () => {
    mockDns(['93.184.216.34']);
    stubHttps({ status: 200, chunks: 2, chunkBytes: MAX_PEER_RESPONSE_BYTES / 2 });

    const res = await fetchPeerUrl('https://example.com');
    expect((await res.arrayBuffer()).byteLength).toBe(MAX_PEER_RESPONSE_BYTES);
  });

  it('abandons a response body larger than the size cap', async () => {
    mockDns(['93.184.216.34']);
    stubHttps({ status: 200, chunks: 3, chunkBytes: MAX_PEER_RESPONSE_BYTES / 2 });

    await expect(fetchPeerUrl('https://example.com')).rejects.toThrow(/exceeded \d+ bytes/);
  });

  // A peer that keeps the connection busy with a trickle of bytes never trips
  // an idle timeout; the deadline covers the whole request.
  it('gives up at the deadline even while data keeps arriving', async () => {
    mockDns(['93.184.216.34']);
    stubHttps({ status: 200, chunks: 5, hang: true });

    await expect(fetchPeerUrl('https://example.com', { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
