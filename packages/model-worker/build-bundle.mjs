// Bundle the worker into a single self-contained file for machines that run
// it without a repo checkout or npm install (e.g. the always-on NAS). Follows
// packages/create-airchat/build.mjs: everything bundled, ESM output with a
// real require shim for CJS deps, Node 20 floor (the NAS ships v20).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/worker-bundle.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // No shebang here: src/index.ts already carries one and esbuild hoists it
  // to line 1 — a second copy in the banner would land on line 2 and break
  // parsing. The require shim lets bundled CJS deps require() Node builtins.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
