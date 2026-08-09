import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/__tests__/integration/**/*.test.ts'],
    // The server's rate limiter uses a 60s sliding window, so a key that has
    // spent its write budget must wait out most of a minute before anything
    // succeeds. The retry helper now honours the server's Retry-After, and a
    // 30s timeout would kill the test partway through an entirely correct
    // wait — turning working backoff into a failure.
    testTimeout: 150_000,
    alias: {
      '@airchat/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@/': resolve(__dirname, 'apps/web/'),
    },
  },
});
