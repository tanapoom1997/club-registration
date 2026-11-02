import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
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
    files: ['**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
