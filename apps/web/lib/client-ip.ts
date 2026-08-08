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
 * ── Order of preference ─────────────────────────────────────────────────────
 *
 * 1. `CF-Connecting-IP` — set by Cloudflare on every request that reaches the
 *    tunnel, and overwritten rather than appended to, so a client cannot forge
 *    it. All public traffic arrives this way, because the tunnel is the only
 *    public path to this instance.
 *
 * 2. `X-Real-IP` — the single-value convention a reverse proxy sets. Same
 *    property as above when a proxy is in front: it is assigned, not appended.
 *
 * 3. The RIGHTMOST `X-Forwarded-For` entry — the one appended by the nearest
 *    proxy, rather than the leftmost one the client authored. This is a
 *    best-effort fallback, not a guarantee: with no trusted proxy in front,
 *    every entry is caller-supplied and no choice is safe. It is still strictly
 *    better than trusting the leftmost.
 *
 * 4. `unknown` — one shared bucket. Deliberately not a random value: an
 *    unidentifiable caller should contend with other unidentifiable callers,
 *    not get a private allowance.
 *
 * Direct access over the tailnet skips 1 and 2 and is trusted by network
 * position, which is the same assumption /api/v2 already makes.
 */

export interface HasHeaders {
  headers: { get(name: string): string | null };
}

export function clientIp(request: HasHeaders): string {
  const cf = request.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;

  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // Rightmost non-empty entry: appended by the closest proxy.
    const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return 'unknown';
}
