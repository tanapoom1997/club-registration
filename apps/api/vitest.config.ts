import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // An alias rather than resolve.conditions: Vitest would forward those to Node, where a custom
    // list changes how CommonJS dependencies such as pg-pool resolve.
    alias: {
      '@club-registration/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Each file starts its own Postgres container.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // Every source file, so one that no test imports counts as uncovered rather than vanishing.
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html'],
      // Floors at the last measured level (rounded down): CI fails if a change lowers coverage.
      // Raise them when tests are added; never lower them to pass.
      thresholds: { statements: 91, branches: 84, functions: 96, lines: 93 },
    },
  },
});
