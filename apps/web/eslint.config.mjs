import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

// Next 15 flat config. `next lint` is deprecated in 15.5, so the lint script
// runs ESLint directly (see package.json). core-web-vitals + typescript are
// Next's recommended rule sets.
const eslintConfig = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...compat.config({ extends: ['next/core-web-vitals', 'next/typescript'] }),
  {
    rules: {
      // Retrofit: the codebase has pre-existing `any` (Supabase query rows,
      // d3-force nodes). Surface as warnings so lint can gate CI on *new*
      // errors without blocking on existing debt. Tighten to 'error' as paid down.
      '@typescript-eslint/no-explicit-any': 'warn',

      // runAsAuthenticatedAgent hands its callee an already-verified identity:
      // authenticateAgent returns the injected context and never checks a
      // header. Calling it without having verified a credential first would
      // grant unauthenticated access to every v2 route. A doc comment cannot
      // enforce that, so importing it is an error everywhere except the one
      // module allowed below.
      // A `patterns` group rather than `paths`: it covers the alias specifier
      // and relative ones ('./api-v2-auth', '../lib/api-v2-auth') in a single
      // rule, so a relative import is not a loophole. Using both would report
      // the same import twice.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/api-v2-auth'],
          importNames: ['runAsAuthenticatedAgent'],
          message:
            'runAsAuthenticatedAgent bypasses header auth. Only /api/mcp may use it, ' +
            'via lib/mcp-inprocess-client.ts, and only after authenticateConnector has ' +
            'verified a connector token. If you need it elsewhere, that is a design ' +
            'discussion, not a lint exception.',
        }],
      }],
    },
  },
  {
    // The sole sanctioned caller. It runs inside /api/mcp, after
    // authenticateConnector has validated a connector token.
    files: ['lib/mcp-inprocess-client.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default eslintConfig;
