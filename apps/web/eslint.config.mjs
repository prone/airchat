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
    },
  },
];

export default eslintConfig;
