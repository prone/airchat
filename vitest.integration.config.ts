import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/__tests__/integration/**/*.test.ts'],
    testTimeout: 30000,
    alias: {
      '@airchat/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@/': resolve(__dirname, 'apps/web/'),
    },
  },
});
