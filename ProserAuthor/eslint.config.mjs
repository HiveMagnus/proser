// ESLint v9 flat config for the ProserAuthor monorepo.
//
// Single shared config consumed by every workspace package. ESLint walks up
// from each package's cwd to find this file, so each package's `lint` script
// can simply run `eslint .` and inherit these rules.
//
// Goals:
//   - Catch real bugs (typescript-eslint recommended + React hooks rules).
//   - Enforce strict typing: `any` is disallowed, unused symbols are errors.
//   - Keep it fast: no type-aware linting (no parserOptions.project), so the
//     gate stays quick and does not require building project references first.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // ── Global ignores ────────────────────────────────────────────────
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/build/**',
      '**/generated/**',
      'packages/canvas-engine/src/editor/**',
      '**/*.d.ts',
      'apps/web/playwright-report/**',
      'apps/web/test-results/**',
    ],
  },

  // ── Base rules for all linted source ──────────────────────────────
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // TypeScript's compiler already reports undefined identifiers, and the
      // base rule produces false positives on types/global DOM APIs.
      'no-undef': 'off',

      // Strict typing.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // ESLint 10 added this rule to the recommended preset. Enable it in a
      // dedicated cleanup rather than changing retry/control-flow semantics as
      // a side effect of the security upgrade.
      'no-useless-assignment': 'off',
    },
  },

  // ── Web app: React hooks rules + browser globals ──────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // React Hooks 7 expanded its recommended preset with React Compiler
      // rules. Preserve the existing hook-safety contract during this
      // dependency upgrade; compiler adoption remains an explicit project.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── Backend + shared packages: node globals ───────────────────────
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'packages/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ── Tests: relax strictness for mocks/fixtures ────────────────────
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', 'apps/web/e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },

  // ── Config + script files: node context, allow `any` ──────────────
  {
    files: [
      '**/*.config.{js,mjs,cjs,ts}',
      '**/scripts/**/*.{ts,js,mjs,cjs}',
      'apps/web/server.js',
      'apps/web/trusted-auth-source.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
