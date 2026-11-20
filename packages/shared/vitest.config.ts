import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html'],
      // Floors at the last measured level (rounded down): CI fails if a change lowers coverage.
      // Raise them when tests are added; never lower them to pass.
      thresholds: { statements: 98, branches: 100, functions: 100, lines: 98 },
    },
  },
});
