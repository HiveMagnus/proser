// ESLint v9 flat config for proser-factory (backend, CommonJS/TS).
//
// Goals:
//   - Enforce strict typing: `any` is disallowed everywhere.
//   - Flag dead code: unused symbols are errors.
//   - Catch real TS bugs via typescript-eslint's recommended rules.
//   - Keep the existing rule that bans raw `fetch` in src (use ky/VllmService).
//
// Note: the eslint-core stylistic set (js.configs.recommended) is intentionally
// not enabled — it flags pre-existing style patterns (empty catch blocks, regex
// escapes) that are out of scope for the typing/dead-code gate.
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  // ── Global ignores ────────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'public/**',
      'scripts-root/**',
      '**/*.d.ts',
      // Operational tooling and config (plain JS/MJS, maintenance scripts) —
      // not part of the TypeScript application surface that this gate guards.
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'scripts/**',
      // Maintained codec sources have an independent strict compiler/test gate.
      'vendor/**',
    ],
  },

  // ── TypeScript correctness rules ──────────────────────────────────
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Strict typing — no `any`, anywhere.
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
    },
  },

  // ── Backend src: ban raw fetch (use ky/VllmService + withRetry) ───
  {
    files: ['src/**/*.ts'],
    ignores: ['src/__tests__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use ky for HTTP requests in backend code.' },
      ],
    },
  },

  // ── AI provider clients may use native fetch (Jest/CJS compat) ────
  {
    files: ['src/lib/ai/vllm.ts', 'src/lib/ai/embeddings.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  // ── Tests: keep node + jest globals; allow `any` and ts-comments for
  //    mocks, partial fixtures, and spies (not shipped application code). ─
  {
    files: ['src/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
