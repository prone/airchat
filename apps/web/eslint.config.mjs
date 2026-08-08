import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// Next 16 flat config, imported directly.
//
// eslint-config-next 16 ships native flat config and can no longer be loaded
// through FlatCompat: the eslintrc bridge tries to JSON.stringify it for schema
// validation and dies on a circular reference (the react plugin refers back to
// its own configs). The failure is "Converting circular structure to JSON" from
// @eslint/eslintrc, which does not obviously point at the config file, so it is
// worth naming here.
//
// `next lint` is deprecated since 15.5, so the lint script runs ESLint directly
// (see package.json). core-web-vitals + typescript are Next's recommended sets.
const eslintConfig = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Retrofit: the codebase has pre-existing `any` (Supabase query rows,
      // d3-force nodes). Surface as warnings so lint can gate CI on *new*
      // errors without blocking on existing debt. Tighten to 'error' as paid down.
      '@typescript-eslint/no-explicit-any': 'warn',

      // React Compiler rules, new in eslint-config-next 16 and errors by
      // default. They found 13 real issues in the dashboard on first run:
      //
      //   9x set-state-in-effect  — setState called synchronously in an effect,
      //                             which can cascade renders
      //   3x purity               — Date.now() during render, so a render is
      //                             not a pure function of its inputs
      //   1x immutability         — a variable used before its declaration
      //
      // These are new DIAGNOSTICS, not new bugs: the code has behaved this way
      // all along. They are downgraded to warnings so the config-next 16
      // upgrade can land on its own, rather than being bundled with a
      // behavioural refactor of dashboard components that have no UI tests to
      // catch a regression.
      //
      // Tracked for a dedicated pass. Restore to 'error' as they are paid down,
      // and do not add new ones in the meantime.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',

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
