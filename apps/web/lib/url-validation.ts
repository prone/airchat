/**
 * URL validation for gossip peer endpoints.
 *
 * Prevents SSRF by blocking requests to private/internal networks.
 *
 * Use `fetchPeerUrl` for any request to a peer-controlled URL: it validates
 * every hop, including redirect targets. `validatePeerEndpoint` on its own
 * only judges the URL you hand it, so validating once and then calling bare
 * `fetch` is not sufficient -- fetch follows redirects.
 */

import dns from 'dns/promises';
import http from 'node:http';
import https from 'node:https';

/**
 * Check if an IP address is in a private, loopback, or reserved range.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4 private/reserved ranges
  const patterns = [
    /^127\./, // Loopback
    /^10\./, // RFC 1918
    /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918
    /^192\.168\./, // RFC 1918
    /^169\.254\./, // Link-local / cloud metadata
    /^0\./, // "This" network
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT (RFC 6598)
    /^192\.0\.0\./, // IETF protocol assignments
    /^192\.0\.2\./, // TEST-NET-1
    /^198\.51\.100\./, // TEST-NET-2
    /^203\.0\.113\./, // TEST-NET-3
    /^224\./, // Multicast
    /^240\./, // Reserved
    /^255\.255\.255\.255$/, // Broadcast
  ];

  // IPv6 private/reserved
  const ipv6Patterns = [
    /^::1$/, // Loopback
    /^fe80:/i, // Link-local
    /^fc/i, // Unique local (RFC 4193)
    /^fd/i, // Unique local (RFC 4193)
    /^::ffff:127\./i, // IPv4-mapped loopback
    /^::ffff:10\./i, // IPv4-mapped private
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./i, // IPv4-mapped private
    /^::ffff:192\.168\./i, // IPv4-mapped private
    /^::ffff:169\.254\./i, // IPv4-mapped link-local
  ];

  return patterns.some((p) => p.test(ip)) || ipv6Patterns.some((p) => p.test(ip));
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
  // Allow private endpoints in development
  if (process.env.ALLOW_PRIVATE_PEER_ENDPOINTS === 'true') {
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { valid: false, error: 'Endpoint must use http:// or https://' };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid URL' };
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

  // 3. Direct IP check (if hostname is an IP literal)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[')) {
    const ip = hostname.replace(/^\[|\]$/g, '');
    if (isPrivateIp(ip)) {
      return { valid: false, error: 'Endpoint resolves to a private address' };
    }
    // Literal address: nothing to re-resolve, so it is already pinned.
    return { valid: true, address: ip, family: ip.includes(':') ? 6 : 4 };
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

/** Maximum redirects followed by fetchPeerUrl, each re-validated. */
const MAX_REDIRECTS = 3;

/** Statuses whose Response must be constructed with a null body. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

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
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          const status = res.statusCode ?? 502;
          resolve(
            new Response(NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks), {
              status,
              headers: responseHeaders,
            }),
          );
        });
      },
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Peer request timed out: ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Fetch a peer URL with SSRF protection applied to every hop.
 *
 * Closes three separate holes:
 *
 * 1. Redirects. Bare `fetch` follows them, so validating only the initial URL
 *    is not enough -- a peer that passes validation can answer 302 with
 *    `Location: http://169.254.169.254/` and the request is made anyway.
 *    Redirects are followed manually here, re-validating each Location.
 *
 * 2. DNS rebinding. Validation and connection would otherwise resolve the
 *    hostname independently, letting an attacker with a low-TTL record answer
 *    public for the check and private for the connection. The address checked
 *    is the address dialled.
 *
 * 3. Unbounded requests. Every hop carries an explicit timeout.
 *
 * Throws on an unsafe URL, too many redirects, or a redirect with no usable
 * Location. Network errors propagate.
 */
export async function fetchPeerUrl(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15000, ...requestInit } = init;
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await validatePeerEndpoint(current);
    if (!check.valid) {
      throw new Error(`Blocked peer request to ${current}: ${check.error}`);
    }

    // No address means ALLOW_PRIVATE_PEER_ENDPOINTS is on and nothing was
    // resolved, so there is nothing to pin. That path is development only.
    const res = check.address
      ? await requestPinned(current, check.address, check.family ?? 4, requestInit, timeoutMs)
      : await fetch(current, {
          ...requestInit,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });

    if (res.status < 300 || res.status > 399) return res;

    const location = res.headers.get('location');
    if (!location) {
      throw new Error(`Peer redirect from ${current} had no Location header`);
    }
    // Resolve relative Locations against the current URL before re-checking.
    current = new URL(location, current).toString();
  }

  throw new Error(`Peer request exceeded ${MAX_REDIRECTS} redirects: ${rawUrl}`);
}
