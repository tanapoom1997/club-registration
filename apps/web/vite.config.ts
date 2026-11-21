import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@club-registration/source', ...defaultClientConditions],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // React is about 40% of the entry and changes only on an upgrade: in its own chunk it
            // stays cached across deploys, and the entry keeps room under Vite's 500 kB warning.
            // Both load in parallel on the first visit (Vite preloads it from index.html).
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    // Mirrors production, where Caddy serves the SPA and proxies /api from one origin. The E2E
    // run points it at its own api (e2e/global-setup.ts), so it never talks to a dev server on 3000.
    proxy: { '/api': env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    setupFiles: ['src/test-support/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.tsx', 'src/test-support/**'],
      reporter: ['text-summary', 'html'],
      // Floors at the last measured level (rounded down): CI fails if a change lowers coverage.
      // Raise them when tests are added; never lower them to pass.
      thresholds: { statements: 94, branches: 87, functions: 95, lines: 96 },
    },
  },
});
