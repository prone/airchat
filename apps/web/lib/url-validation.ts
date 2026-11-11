/**
 * URL validation for gossip peer endpoints.
 *
 * Prevents SSRF by blocking requests to private/internal networks.
 *
 * Use `fetchPeerUrl` for any request to a peer-controlled URL: it connects to
 * the address that was validated and refuses redirects. `validatePeerEndpoint`
 * on its own only judges the URL you hand it, so validating once and then
 * calling bare `fetch` is not sufficient -- fetch resolves the name again and
 * follows redirects.
 */

import dns from 'dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/** IPv4 ranges a peer endpoint may never resolve to. */
const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "This" network
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (RFC 6598), includes Tailscale
  ['127.0.0.0', 8], // Loopback
  ['169.254.0.0', 16], // Link-local / cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // Benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // Multicast
  ['240.0.0.0', 4], // Reserved, includes broadcast
] as Array<[string, number]>) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}

/** IPv6 ranges that are blocked outright. */
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['64:ff9b:1::', 48], // Local-use NAT64
  ['100::', 64], // Discard-only
  ['2001::', 23], // IETF protocol assignments, includes Teredo
  ['2001:db8::', 32], // Documentation
  ['fc00::', 7], // Unique local (RFC 4193)
  ['fe80::', 10], // Link-local
  ['fec0::', 10], // Site-local (deprecated)
  ['ff00::', 8], // Multicast
] as Array<[string, number]>) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/**
 * Parse an IPv6 address into its 16 bytes, or null if it is not one.
 *
 * Handles `::` compression and a trailing dotted IPv4 part. Needed because the
 * same address has many spellings (`::ffff:169.254.169.254` and
 * `::ffff:a9fe:a9fe` are identical), and only the bytes can be range-checked
 * reliably.
 */
function parseIpv6(ip: string): Uint8Array | null {
  if (isIP(ip) !== 6 || ip.includes('%')) return null;

  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const [head, rest] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest ? rest.split(':') : [];
  const groups =
    rest === undefined
      ? headGroups
      : [...headGroups, ...new Array(8 - headGroups.length - restGroups.length).fill('0'), ...restGroups];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/**
 * The IPv4 address an IPv6 address stands for, when it is one of the forms
 * that carry an IPv4 address inside them. A connection to such an address ends
 * up at (or is translated to) the embedded IPv4 host, so that is the address
 * that has to pass the range check.
 */
function embeddedIpv4(bytes: Uint8Array): string | null {
  const dotted = (offset: number) => Array.from(bytes.slice(offset, offset + 4)).join('.');
  const zero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);

  // ::ffff:a.b.c.d — IPv4-mapped
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return dotted(12);
  // ::a.b.c.d — IPv4-compatible (deprecated). Also covers :: and ::1, which
  // come out as 0.0.0.0 and 0.0.0.1 and are blocked as the "this" network.
  if (zero(0, 12)) return dotted(12);
  // 64:ff9b::a.b.c.d — NAT64 well-known prefix
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) {
    return dotted(12);
  }
  // 2002:aabb:ccdd:: — 6to4, IPv4 address in the 32 bits after the prefix
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return dotted(2);
  return null;
}

/**
 * Check if an IP address is in a private, loopback, or reserved range.
 *
 * Anything that does not parse as an IP address counts as private: this
 * function answers "is it safe to connect here", and the answer for something
 * unrecognised is no.
 */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return BLOCKED_V4.check(ip, 'ipv4');
  if (version !== 6) return true;

  const bytes = parseIpv6(ip);
  if (!bytes) return true;
  const v4 = embeddedIpv4(bytes);
  if (v4) return BLOCKED_V4.check(v4, 'ipv4');
  return BLOCKED_V6.check(ip, 'ipv6');
}

/**
 * Blocked hostnames that should never be used as peer endpoints.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '[::1]',
  'metadata.google.internal',
  'metadata.google',
]);

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  /**
   * The specific IP that was validated, for the caller to connect to directly.
   *
   * Without this, validation and connection each resolve DNS independently,
   * and an attacker controlling a low-TTL record can answer with a public
   * address for the first lookup and a private one for the second. Connecting
   * to the address that was actually checked closes that window.
   *
   * Undefined only in ALLOW_PRIVATE_PEER_ENDPOINTS development mode, where no
   * resolution is performed.
   */
  address?: string;
  family?: 4 | 6;
}

/**
 * Validate a peer endpoint URL for SSRF safety.
 *
 * Checks:
 * 1. Must be http:// or https:// (no file://, ftp://, etc.)
 * 2. Hostname must not be a blocked name (localhost, metadata, etc.)
 * 3. Resolved IPs must not be in private/reserved ranges
 *
 * Note: Tailscale IPs (100.64-127.x.x) are blocked by the CGNAT range check.
 * This is intentional — peers should be publicly reachable. For local
 * development, set ALLOW_PRIVATE_PEER_ENDPOINTS=true.
 */
export async function validatePeerEndpoint(endpoint: string): Promise<UrlValidationResult> {
  // Allow private endpoints in development.
  //
  // Development differs only in WHICH addresses are permitted, never in how
  // the request is made: an address is still resolved and returned so the
  // caller pins it exactly as in production. Keeping one code path means the
  // transport being exercised locally is the transport that ships.
  //
  // dns.lookup rather than resolve4/resolve6 here because it consults
  // /etc/hosts, and "localhost" is the whole point of this mode. Production
  // deliberately uses resolve4/resolve6 so a hosts-file entry cannot redirect
  // a peer hostname at an internal address.
  if (process.env.ALLOW_PRIVATE_PEER_ENDPOINTS === 'true') {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return { valid: false, error: 'Invalid URL' };
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'Endpoint must use http:// or https://' };
    }
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.includes(':')) {
      return { valid: true, address: bare, family: bare.includes(':') ? 6 : 4 };
    }
    try {
      const resolved = await dns.lookup(url.hostname);
      return {
        valid: true,
        address: resolved.address,
        family: resolved.family === 6 ? 6 : 4,
      };
    } catch {
      return { valid: false, error: 'Endpoint hostname could not be resolved' };
    }
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }

  // 1. Protocol check
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, error: 'Endpoint must use http:// or https://' };
  }

  // 2. Hostname blocklist
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, error: 'Endpoint hostname is blocked' };
  }

  // 3. Direct IP check (if hostname is an IP literal). The URL parser has
  // already normalised the literal, e.g. [::ffff:169.254.169.254] arrives
  // here as [::ffff:a9fe:a9fe]; isPrivateIp works on the address bytes, so
  // the spelling does not matter.
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (hostname.startsWith('[') || isIP(literal) !== 0) {
    if (isPrivateIp(literal)) {
      return { valid: false, error: 'Endpoint resolves to a private address' };
    }
    // Literal address: nothing to re-resolve, so it is already pinned.
    return { valid: true, address: literal, family: isIP(literal) === 6 ? 6 : 4 };
  }

  // Note: integer/hex/octal host forms (http://2130706433, http://0x7f000001,
  // http://127.1) need no special handling -- the WHATWG URL parser normalises
  // all of them to dotted-quad before we get here, so the check above catches
  // them. There are tests pinning that behaviour.

  // 4. DNS resolution check
  const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
  const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
  const allAddresses = [...addresses, ...addresses6];

  // Fail closed. This previously allowed unresolvable hostnames through on the
  // theory that the fetch would fail anyway -- but validation and fetch run on
  // the same host, so anything genuinely unresolvable here cannot be fetched
  // either, and treating "no answer" as "safe" is a bypass rather than a
  // convenience.
  if (allAddresses.length === 0) {
    return { valid: false, error: 'Endpoint hostname could not be resolved' };
  }

  if (allAddresses.some((addr) => isPrivateIp(addr))) {
    return { valid: false, error: 'Endpoint resolves to a private address' };
  }

  // Every answer was checked, so any of them is safe to use. Return one for the
  // caller to pin, so the connection cannot land on a different address than
  // the one validated here.
  const chosen = addresses[0] ?? addresses6[0];
  return { valid: true, address: chosen, family: addresses[0] ? 4 : 6 };
}

/** Statuses whose Response must be constructed with a null body. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Largest response body accepted from a peer. A sync response is at most 100
 * short messages; anything near this size is not a legitimate answer, and
 * without a cap a peer could make this process buffer whatever it sends.
 */
export const MAX_PEER_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Issue a single request to an already-validated address.
 *
 * Uses node:http(s) rather than fetch because fetch offers no way to control
 * name resolution: it would resolve the hostname again, independently of the
 * lookup validatePeerEndpoint performed, which is the DNS-rebinding window
 * this function exists to close. The `lookup` hook returns the pre-validated
 * address and never consults DNS.
 *
 * The URL hostname is still used for the Host header, TLS SNI and certificate
 * verification -- only the address dialled is pinned -- so virtual hosting and
 * certificate validation behave normally.
 *
 * `timeoutMs` bounds the request twice: as an idle timeout on the socket, and
 * as a deadline for the whole exchange. The idle timeout alone is not enough,
 * because a peer that sends one byte every few seconds never trips it.
 */
async function requestPinned(
  url: string,
  address: string,
  family: 4 | 6,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;

  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, key) => {
    headers[key] = value;
  });

  const body =
    typeof init.body === 'string' ? Buffer.from(init.body) : (init.body as Buffer | undefined);
  if (body && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.byteLength);
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outcome();
    };
    const fail = (error: Error) => {
      finish(() => reject(error));
      req.destroy(error);
    };

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers,
        // The pin. Never re-resolves; hands back the address already checked.
        lookup: (_hostname, _options, callback) =>
          (callback as (e: null, a: string, f: number) => void)(null, address, family),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > MAX_PEER_RESPONSE_BYTES) {
            fail(new Error(`Peer response exceeded ${MAX_PEER_RESPONSE_BYTES} bytes: ${url}`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error: Error) => finish(() => reject(error)));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          const status = res.statusCode ?? 502;
          finish(() =>
            resolve(
              new Response(NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks), {
                status,
                headers: responseHeaders,
              }),
            ),
          );
        });
      },
    );

    deadline = setTimeout(() => fail(new Error(`Peer request timed out: ${url}`)), timeoutMs);
    req.setTimeout(timeoutMs, () => fail(new Error(`Peer request timed out: ${url}`)));
    req.on('error', (error: Error) => finish(() => reject(error)));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Fetch a peer URL with SSRF protection.
 *
 * Closes four separate holes:
 *
 * 1. Redirects. They are not followed at all: a 3xx answer is an error. A
 *    peer is a fixed API endpoint with no reason to redirect, and following
 *    one would mean sending the request -- its signed headers and its body --
 *    to wherever the peer points, including other hosts and internal
 *    addresses such as `http://169.254.169.254/`.
 *
 * 2. DNS rebinding. Validation and connection would otherwise resolve the
 *    hostname independently, letting an attacker with a low-TTL record answer
 *    public for the check and private for the connection. The address checked
 *    is the address dialled.
 *
 * 3. Unbounded time. `timeoutMs` is a deadline for the whole request as well
 *    as an idle timeout.
 *
 * 4. Unbounded size. The response body is capped at MAX_PEER_RESPONSE_BYTES.
 *
 * Throws on an unsafe URL, a redirect, a timeout or an oversized response.
 * Network errors propagate.
 */
export async function fetchPeerUrl(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15000, ...requestInit } = init;

  const check = await validatePeerEndpoint(rawUrl);
  if (!check.valid) {
    throw new Error(`Blocked peer request to ${rawUrl}: ${check.error}`);
  }

  // Every accepted endpoint carries a validated address, including in
  // development mode, so there is exactly one transport and no unpinned
  // fallback path.
  if (!check.address) {
    throw new Error(`Blocked peer request to ${rawUrl}: no validated address`);
  }
  const res = await requestPinned(rawUrl, check.address, check.family ?? 4, requestInit, timeoutMs);

  if (res.status >= 300 && res.status <= 399) {
    throw new Error(`Peer at ${rawUrl} answered with a redirect (HTTP ${res.status}); redirects are not followed`);
  }
  return res;
}
