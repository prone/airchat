import type { NextConfig } from 'next';
import path from 'path';
import { contentSecurityPolicy } from './lib/csp';

// The policy itself, and why each part is there, is in lib/csp.ts. This is
// the fallback for responses the middleware does not handle; pages get a
// per-response policy with a nonce from the middleware.
export { contentSecurityPolicy };

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
