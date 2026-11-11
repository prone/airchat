import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPlaintextPublicUrl, resetPlaintextUrlWarnings, warnIfPlaintextPublicUrl } from '../insecure-url.js';

/**
 * The agent key travels in a header on every request. Over http to a public
 * host it is readable in transit, so the client says so. It does not refuse:
 * http is the normal setup on a tailnet or a LAN.
 */
describe('isPlaintextPublicUrl', () => {
  it('flags http to a public name or address', () => {
    for (const url of [
      'http://airchat.example.com',
      'http://airchat.example.com:3003/',
      'http://203.0.113.10:3003',
      'http://8.8.8.8',
      'http://[2001:db8::1]:3003',
      'http://172.32.0.1',
      'http://100.128.0.1',
    ]) {
      expect(isPlaintextPublicUrl(url), url).toBe(true);
    }
  });

  it('never flags https', () => {
    expect(isPlaintextPublicUrl('https://airchat.example.com')).toBe(false);
    expect(isPlaintextPublicUrl('https://203.0.113.10')).toBe(false);
  });

  it('accepts loopback', () => {
    for (const url of ['http://localhost:3003', 'http://127.0.0.1:3003', 'http://[::1]:3003']) {
      expect(isPlaintextPublicUrl(url), url).toBe(false);
    }
  });

  it('accepts private address ranges, including the one tailnets use', () => {
    for (const url of [
      'http://10.0.0.5:3003',
      'http://172.16.4.4',
      'http://172.31.255.255',
      'http://192.168.1.20:3003',
      'http://169.254.1.1',
      'http://100.64.0.12:3003',
      'http://100.127.255.254',
      'http://[fd7a:115c:a1e0::1]:3003',
      'http://[fe80::1]',
    ]) {
      expect(isPlaintextPublicUrl(url), url).toBe(false);
    }
  });

  it('accepts names that only resolve on a private network', () => {
    for (const url of [
      'http://nas:3003',
      'http://web',
      'http://nas.local:3003',
      'http://nas.tail1234.ts.net:3003',
      'http://airchat.internal',
      'http://server.lan',
    ]) {
      expect(isPlaintextPublicUrl(url), url).toBe(false);
    }
  });

  it('is not fooled by a private-looking name on a public domain', () => {
    expect(isPlaintextPublicUrl('http://localhost.example.com')).toBe(true);
    expect(isPlaintextPublicUrl('http://10.0.0.1.example.com')).toBe(true);
    expect(isPlaintextPublicUrl('http://ts.net.example.com')).toBe(true);
  });

  it('says nothing about something that is not a URL', () => {
    expect(isPlaintextPublicUrl('not a url')).toBe(false);
  });
});

describe('warnIfPlaintextPublicUrl', () => {
  beforeEach(() => resetPlaintextUrlWarnings());

  it('warns once per URL, not on every client', () => {
    const print = vi.fn();
    expect(warnIfPlaintextPublicUrl('http://airchat.example.com', print)).toBe(true);
    expect(warnIfPlaintextPublicUrl('http://airchat.example.com', print)).toBe(false);
    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0][0]).toMatch(/plain http/);
    expect(print.mock.calls[0][0]).toContain('http://airchat.example.com');
  });

  it('stays silent for https and for private hosts', () => {
    const print = vi.fn();
    warnIfPlaintextPublicUrl('https://airchat.example.com', print);
    warnIfPlaintextPublicUrl('http://100.64.0.12:3003', print);
    warnIfPlaintextPublicUrl('http://localhost:3003', print);
    expect(print).not.toHaveBeenCalled();
  });
});

describe('AirChatRestClient', () => {
  beforeEach(() => resetPlaintextUrlWarnings());

  it('warns on construction with a public http URL, and still constructs', async () => {
    const { AirChatRestClient } = await import('../rest-client.js');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const make = () => new AirChatRestClient({
        webUrl: 'http://airchat.example.com',
        machineName: 'macbook',
        privateKeyHex: '00'.repeat(32),
        agentName: 'macbook-test',
        cacheDir: '/nonexistent/airchat-test',
      });
      expect(make).not.toThrow();
      make();
      const warnings = error.mock.calls.filter((c) => String(c[0]).includes('plain http'));
      expect(warnings).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });
});
