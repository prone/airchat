/**
 * The Content-Security-Policy header.
 *
 * Pages get a policy with a nonce: a random value made for that one response.
 * A script runs only if it carries the nonce, which Next.js puts on the
 * scripts it writes itself, or was loaded by a script that does
 * ('strict-dynamic'). Text that reaches a page some other way and tries to be
 * a script has no nonce and does not run. The middleware makes the nonce and
 * sets this header for every page.
 *
 * Without a nonce (API responses, files, anything the middleware does not
 * handle) the policy allows no inline script at all. Those responses are not
 * pages, so nothing in them needs to run.
 *
 * `'unsafe-eval'` lets a page turn strings into code (eval, new Function).
 * Only the development server needs it: React and the dev overlay use eval
 * for debugging and hot reload. A production build does not.
 *
 * `connect-src` names where the dashboard's browser code may send requests:
 * this server and the Supabase project.
 *
 * `style-src` keeps `'unsafe-inline'`: React writes `style` attributes, which
 * a nonce cannot cover, and a style cannot run code.
 *
 * Kept free of imports so that both next.config.ts and the middleware (which
 * runs on the edge runtime) can use it.
 */
export function contentSecurityPolicy(
  production: boolean,
  nonce?: string,
  supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string {
  const evalForDev = production ? '' : " 'unsafe-eval'";
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${evalForDev}`
    : `script-src 'self'${evalForDev}`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co${supabaseOrigins(supabaseUrl)}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The configured Supabase project as connect-src entries (its address, and the
 * same address over WebSocket), when it is not a *.supabase.co host already
 * covered: a self-hosted Supabase, or the local one used in development. The
 * dashboard's browser code talks to it directly.
 */
function supabaseOrigins(supabaseUrl: string | undefined): string {
  if (!supabaseUrl) return '';
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.endsWith('.supabase.co')) return '';
  return ` ${url.origin} ${url.origin.replace(/^http/, 'ws')}`;
}

/** A fresh nonce: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
