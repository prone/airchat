import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // apps/*/lib is included too: it holds the gossip sync engine and the SSRF
    // URL validation, which previously could not be unit tested at all because
    // the glob only reached apps/*/app.
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/app/**/*.test.ts',
      'apps/*/lib/**/*.test.ts',
    ],
    exclude: ['**/integration/**'],
    alias: {
      '@airchat/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@/': resolve(__dirname, 'apps/web/'),
    },
  },
});
