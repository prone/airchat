// Bundle the installer + the folded-in CLI (@airchat/cli, which pulls in
// @airchat/shared) into a single self-contained dist/index.js, so the published
// `airchat` package has no unpublished workspace deps at runtime. Only
// @supabase/supabase-js stays external (a real, published runtime dependency).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

// The version the installer prints is read from package.json and injected at
// build time (see `define` below), so it always matches the published package.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Shebang (source has none) + a real `require` so bundled CJS deps like
  // commander can require() Node builtins in an ESM output. esbuild's require
  // shim uses this real require when it's defined.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  define: { __AIRCHAT_VERSION__: JSON.stringify(version) },
  external: ['@supabase/supabase-js'],
  logLevel: 'info',
});
