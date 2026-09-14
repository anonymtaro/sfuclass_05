/**
 * Shared ESLint base  (F7)
 *
 * Flat config. Every workspace re-exports this and adds at most a couple of
 * project-specific rules.
 *
 * The rule set is small on purpose. Formatting is Prettier's job and is
 * switched off here entirely — a lint error about a comma is noise that trains
 * people to run --fix without reading. What is left are rules that catch bugs:
 * floating promises, unawaited async work, accidental `any` leaking through a
 * boundary.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/.turbo/**', '**/node_modules/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        // Type-aware linting. Slower, and worth it: the rules below cannot
        // work without types.
        projectService: true,
      },
    },

    rules: {
      // --- the ones that actually catch bugs -----------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // A promise-returning function passed to onClick is normal in React;
        // one passed where a boolean is expected is a bug.
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/require-await': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',

      // --- typing discipline ---------------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        // A leading underscore is the agreed way to say "deliberately unused".
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // --- unsafe-* stay off ----------------------------------------------
      // mediasoup payloads and socket acks are genuinely unknown at the
      // boundary, and these four rules fire on every single one of them.
      // Validation is zod's job, and it is done at the boundary already.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Test files loosen exactly two things and nothing else.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Must stay last: switches off everything Prettier owns.
  prettier,
);