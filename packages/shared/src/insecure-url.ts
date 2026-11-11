/**
 * Warning for a server URL that sends credentials unencrypted.
 *
 * An agent authenticates with a key derived from its machine key, sent in a
 * header on every request. Over `http://` anyone on the path between the
 * agent and the server can read that key and act as the agent.
 *
 * Plain http is still accepted, because it is the normal setup when the
 * network itself is private or already encrypted: localhost, a home or office
 * LAN, a container network, or a tailnet (WireGuard encrypts underneath). The
 * warning is only for an http URL whose host is a public address or public
 * name, where nothing else is protecting the traffic.
 *
 * Browser-safe: no Node.js imports.
 */

/** Hostname endings that only resolve on a private network. */
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.ts.net'];

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10                              // 10.0.0.0/8
    || a === 127                               // loopback
    || (a === 172 && b >= 16 && b <= 31)       // 172.16.0.0/12
    || (a === 192 && b === 168)                // 192.168.0.0/16
    || (a === 169 && b === 254)                // link-local
    || (a === 100 && b >= 64 && b <= 127);     // 100.64.0.0/10, used by tailnets
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return false;
  return h === '::1'
    || /^f[cd][0-9a-f]{2}:/.test(h)            // fc00::/7 unique local (tailnets use fd7a:...)
    || /^fe[89ab][0-9a-f]:/.test(h);           // fe80::/10 link-local
}

/**
 * True when `webUrl` is plain http to a host that is not loopback, not in a
 * private address range, and not a private-network name.
 */
export function isPlaintextPublicUrl(webUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(webUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || isPrivateIpv4(host) || isPrivateIpv6(host)) return false;
  const isIpLiteral = /^[\d.]+$/.test(host) || host.includes(':');
  if (!isIpLiteral) {
    // A name with no dot (`nas`, a container service name) only resolves locally.
    if (!host.includes('.')) return false;
    if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  }
  return true;
}

const warned = new Set<string>();

/**
 * Print the warning once per URL per process. Written to stderr: stdout
 * belongs to the MCP protocol when this runs inside the MCP server.
 * Returns whether a warning was printed.
 */
export function warnIfPlaintextPublicUrl(
  webUrl: string,
  print: (message: string) => void = (message) => console.error(message),
): boolean {
  if (!isPlaintextPublicUrl(webUrl) || warned.has(webUrl)) return false;
  warned.add(webUrl);
  print(
    `[airchat] WARNING: AIRCHAT_WEB_URL is ${webUrl}, which is plain http to a public address. ` +
    `Your agent key is sent with every request and can be read by anyone on the network path. ` +
    `Use https, or reach the server over a private network such as a tailnet.`,
  );
  return true;
}

/** Test hook: forget which URLs have been warned about. */
export function resetPlaintextUrlWarnings(): void {
  warned.clear();
}
