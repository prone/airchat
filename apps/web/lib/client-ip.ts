/**
 * The caller's IP address, for rate limiting.
 *
 * ── Why this is not just `x-forwarded-for` ──────────────────────────────────
 *
 * Every route here previously read:
 *
 *     request.headers.get('x-forwarded-for')?.split(',')[0]
 *
 * `X-Forwarded-For` is a comma-separated trail, appended to by each proxy. The
 * LEFTMOST entry is whatever the original client sent — a proxy adds to the
 * list, it does not verify what is already in it. So any caller could send
 * `X-Forwarded-For: <random>` and land in a fresh rate-limit bucket on every
 * request, which makes an IP limit built on it decorative.
 *
 * That was largely theoretical while /api/v2 was LAN-only. It stopped being
 * theoretical when /api/mcp and /api/oauth/* went onto the public internet:
 * `POST /api/oauth/register` is unauthenticated and writes the one publicly
 * writable table in the schema, and its IP limit was the only bound on that.
 *
 * ── Which headers are believed ──────────────────────────────────────────────
 *
 * `CF-Connecting-IP` and `X-Real-IP` are only meaningful when a proxy in front
 * of the app sets them. With no such proxy they are ordinary request headers:
 * whoever connects can write any value and so choose their own bucket. They
 * are therefore ignored unless the operator says a proxy is there, with the
 * environment variable AIRCHAT_TRUSTED_PROXY:
 *
 *   (unset)      No proxy is assumed. Neither header is read.
 *   cloudflare   Every public request arrives through Cloudflare (for example
 *                a Cloudflare tunnel). `CF-Connecting-IP` is believed:
 *                Cloudflare overwrites it on every request, so a client behind
 *                it cannot forge it.
 *   true         Some other reverse proxy is in front and sets `X-Real-IP`
 *                (nginx, Caddy, Traefik). `X-Real-IP` is believed.
 *
 * Only turn a mode on when the app cannot be reached except through that
 * proxy. If part of the traffic bypasses it (for example agents that reach the
 * app directly over a private network while the public side goes through a
 * tunnel), those direct callers can write the header themselves; that is
 * acceptable only if they are trusted by where they sit on the network.
 *
 * ── Without a believed header ───────────────────────────────────────────────
 *
 * The RIGHTMOST `X-Forwarded-For` entry is used. Next.js fills this header
 * with the address of the connecting socket when a request arrives without
 * one, and a proxy appends the address it saw to the end of the list, so the
 * rightmost entry is the nearest hop's view of the caller rather than the
 * leftmost one the client authored.
 *
 * This is the best the framework offers, not a guarantee: Next.js does not
 * expose the socket address to a route handler, and it leaves the header
 * alone when the caller sent one. A caller connecting directly can therefore
 * still name its own bucket by sending `X-Forwarded-For`. An instance exposed
 * to an untrusted network should sit behind a proxy that overwrites the
 * header and set AIRCHAT_TRUSTED_PROXY accordingly.
 *
 * Failing all of that the answer is `unknown`: one shared bucket. Deliberately
 * not a random value: an unidentifiable caller should contend with other
 * unidentifiable callers, not get a private allowance.
 */

export interface HasHeaders {
  headers: { get(name: string): string | null };
}

export type TrustedProxyMode = 'none' | 'cloudflare' | 'generic';

/**
 * Read AIRCHAT_TRUSTED_PROXY. Anything unrecognised means "none", so a typo
 * leaves the safe default in place rather than switching header trust on.
 */
export function trustedProxyMode(): TrustedProxyMode {
  const raw = (process.env.AIRCHAT_TRUSTED_PROXY ?? '').trim().toLowerCase();
  if (raw === 'cloudflare') return 'cloudflare';
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'generic';
  return 'none';
}

export function clientIp(request: HasHeaders): string {
  const mode = trustedProxyMode();

  if (mode === 'cloudflare') {
    const cf = request.headers.get('cf-connecting-ip')?.trim();
    if (cf) return cf;
  }

  if (mode === 'generic') {
    const real = request.headers.get('x-real-ip')?.trim();
    if (real) return real;
  }

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // Rightmost non-empty entry: appended by the closest proxy, or written by
    // the framework from the socket address.
    const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return 'unknown';
}
