import type { NextConfig } from 'next';
import path from 'path';

/**
 * The Content-Security-Policy header.
 *
 * `'unsafe-eval'` lets a page turn strings into code (eval, new Function).
 * Only the development server needs it: React and the dev overlay use eval
 * for debugging and hot reload. A production build does not, so it is left
 * out there, which removes one of the ways an injected string could become
 * running script.
 *
 * `'unsafe-inline'` stays in both. Next.js writes small inline scripts into
 * every page to start the app, and allowing only those would need a fresh
 * nonce per request, which means rendering every page dynamically through a
 * proxy. That is a larger change than this header.
 */
export function contentSecurityPolicy(production: boolean): string {
  const scriptSrc = production
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
  ].join('; ');
}

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@airchat/shared'],
  // Next 16 removed built-in linting from `next build`, so the old
  // `eslint: { ignoreDuringBuilds: true }` escape hatch is gone -- and no
  // longer needed. Lint still runs in CI via `npm run lint`, and the NAS
  // build can't fail on a missing eslint.config.mjs because it never lints.
  headers: async () => [{
    source: '/(.*)',
    headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-DNS-Prefetch-Control', value: 'on' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      { key: 'Content-Security-Policy', value: contentSecurityPolicy(process.env.NODE_ENV === 'production') },
    ],
  }],
};

export default nextConfig;
