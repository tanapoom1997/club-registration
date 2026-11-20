import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// A regex because gitignore-style groups match any path segment, so 'api' would also ban '@/lib/api'.
const restrictImports = (forbiddenApp) => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          regex: `^(${forbiddenApp}(/.*)?|(\\.\\./)+(apps/)?${forbiddenApp}(/.*)?|.*/apps/${forbiddenApp}(/.*)?)$`,
          message: 'apps/web and apps/api talk over HTTP and packages/shared only.',
        },
      ],
    },
  ],
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: restrictImports('web'),
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    rules: restrictImports('api'),
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // A missing dependency shows stale data (e.g. a poll for the wrong round); as a warning it
      // would never fail `pnpm lint` or CI.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Students and teachers use whatever device the school has, keyboards and screen readers
    // included. eslint-plugin-jsx-a11y declares ESLint <= 9 as its peer but runs on 10
    // (pnpm-workspace.yaml peerDependencyRules).
    ...jsxA11y.flatConfigs.recommended,
    files: ['apps/web/**/*.tsx'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/label-has-associated-control': [
        'error',
        {
          // Checks every <Label> usage too, not only raw <label>.
          labelComponents: ['Label'],
          // Radio cards put their text in label > span > span (admin export page).
          depth: 3,
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
