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
    // Array form, because the object form cannot express these three rules.
    // The previous object form had two latent faults, both invisible until a
    // test in apps/web imported through them:
    //   - '@/' as a key never matched anything. Alias matching is
    //     `importee === key || importee.startsWith(key + '/')`, and resolve()
    //     strips the trailing slash, so `@/lib/x` became `apps/weblib/x`.
    //   - '@airchat/shared' rewrote subpaths too, turning
    //     `@airchat/shared/crypto` into `.../src/index.ts/crypto`.
    alias: [
      {
        find: /^@airchat\/shared$/,
        replacement: resolve(__dirname, 'packages/shared/src/index.ts'),
      },
      {
        // No extension: Vite resolves both `crypto` -> crypto.ts and
        // `gossip` -> gossip/index.ts.
        find: /^@airchat\/shared\/(.*)$/,
        replacement: resolve(__dirname, 'packages/shared/src') + '/$1',
      },
      {
        find: /^@airchat\/mcp-server\/(.*)$/,
        replacement: resolve(__dirname, 'packages/mcp-server/src') + '/$1',
      },
      {
        find: /^@\//,
        replacement: resolve(__dirname, 'apps/web') + '/',
      },
    ],
  },
});
