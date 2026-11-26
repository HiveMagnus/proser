import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    // next-auth imports `next/server` without an extension, which Node's ESM
    // resolver refuses; Vite resolves it when the package is inlined.
    server: { deps: { inline: ['next-auth'] } },
  },
});
