import type { NextConfig } from 'next';
import path from 'path';

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
      { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; img-src 'self' data: blob:; font-src 'self' data:" },
    ],
  }],
};

export default nextConfig;
