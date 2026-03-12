import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@agentchat/shared'],
  headers: async () => [{
    source: '/(.*)',
    headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-DNS-Prefetch-Control', value: 'on' },
    ],
  }],
};

export default nextConfig;
